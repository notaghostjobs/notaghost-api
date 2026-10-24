// Careers pages without a JSON feed: JSON-LD job lists when present, else a browser render and a careful link harvest.
// Also: finding the hiring system a careers page points at (iframes, embeds, "apply" links).
import { getText, getJson } from "../http.js";
import type { Feed, FeedJob, System } from "./types.js";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Every hiring-system URL mentioned anywhere in a page (links, iframes, scripts, inline config). */
export function atsLinksIn(html: string): string[] {
  const out = new Set<string>();
  const pats = [
    /https?:\/\/(?:boards|job-boards|boards-api)\.greenhouse\.io\/[a-z0-9_\-/?=&.]+/gi,
    /https?:\/\/(?:jobs|api)\.lever\.co\/[a-z0-9\-/]+/gi,
    /https?:\/\/(?:jobs|api)\.ashbyhq\.com\/[a-z0-9._\-/]+/gi,
    /https?:\/\/(?:careers|jobs|api)\.smartrecruiters\.com\/[A-Za-z0-9\-/]+/g,
    /https?:\/\/[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com\/[a-z0-9_\-/]+/gi,
    /https?:\/\/[a-z0-9-]+\.darwinbox\.in\/[a-z0-9_\-/]*/gi,
    /https?:\/\/[a-z0-9-]+\.keka\.com\/careers[a-z0-9_\-/]*/gi,
    /https?:\/\/[a-z0-9-]+\.zohorecruit\.(?:com|in)\/[a-z0-9_\-/]*/gi,
    /https?:\/\/[a-z0-9-]+\.freshteam\.com\/jobs[a-z0-9_\-/]*/gi,
    /https?:\/\/[a-z0-9.-]+\.eightfold\.ai\/careers[a-z0-9_\-/?=&]*/gi,
    /https?:\/\/[a-z0-9.-]+\.successfactors\.(?:com|eu)\/[a-z0-9_\-/?=&]*/gi,
    /https?:\/\/[a-z0-9.-]+\.oraclecloud\.com\/[a-z0-9_\-/]*/gi,
    /https?:\/\/[a-z0-9.-]+\.icims\.com\/[a-z0-9_\-/]*/gi,
    /https?:\/\/[a-z0-9.-]+\.taleo\.net\/[a-z0-9_\-/]*/gi,
    /https?:\/\/[a-z0-9.-]+\.bamboohr\.com\/careers[a-z0-9_\-/]*/gi,
    /https?:\/\/[a-z0-9.-]+\.recruitee\.com\/?[a-z0-9_\-/]*/gi,
    /https?:\/\/[a-z0-9.-]+\.jobvite\.com\/[a-z0-9_\-/]*/gi,
  ];
  for (const p of pats) for (const m of html.matchAll(p)) out.add(m[0].replace(/[.,;)]+$/, ""));
  return [...out];
}

/** JSON-LD JobPosting objects on a page, if any. */
export function jsonLdJobs(html: string, pageUrl: string): FeedJob[] {
  const jobs: FeedJob[] = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1].trim());
      const nodes = [j, ...(j?.["@graph"] ?? []), ...(Array.isArray(j) ? j : []), ...(j?.itemListElement ?? []).map((e: any) => e.item ?? e)];
      for (const x of nodes.flat(2)) if (x?.["@type"] === "JobPosting") {
        const loc = x.jobLocation; const addr = (Array.isArray(loc) ? loc[0] : loc)?.address;
        jobs.push({ id: String(x.identifier?.value ?? x.identifier?.name ?? x.url ?? x.title), title: x.title ?? "", location: [addr?.addressLocality, addr?.addressRegion].filter(Boolean).join(", ") || (x.jobLocationType === "TELECOMMUTE" ? "Remote" : ""), url: x.url ?? pageUrl, posted_at: x.datePosted ? new Date(x.datePosted).toISOString() : null, updated_at: null, posted_text: null });
      }
    } catch { /* not json */ }
  }
  return jobs;
}

// One shared browser for the whole process, and one render at a time: a 512 MB box cannot hold several Chromes.
let browserP: Promise<import("playwright-core").Browser> | null = null;
let renderLock: Promise<void> = Promise.resolve();
async function getBrowser() {
  if (!browserP) {
    const { chromium } = await import("playwright-core");
    browserP = chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
    browserP.then((b) => b.on("disconnected", () => { browserP = null; })).catch(() => { browserP = null; });
  }
  return browserP;
}
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = renderLock.then(fn, fn);
  renderLock = run.then(() => undefined, () => undefined);
  return run;
}

/** Render with a browser and collect links that look like individual jobs. Conservative: titles 6–90 chars, job-ish path. */
export function harvestLinks(url: string): Promise<{ jobs: FeedJob[]; html: string }> {
  return serial(async () => {
    const b = await getBrowser();
    const ctx = await b.newContext({ userAgent: UA });
    try {
      const p = await ctx.newPage();
      await p.route("**/*", (route) => (/\.(png|jpe?g|gif|webp|svg|woff2?|ttf|mp4|css)(\?|$)/i.test(route.request().url()) ? route.abort() : route.continue()));
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await p.waitForTimeout(2000);
      const html = await p.content();
      const links: { t: string; h: string }[] = await p.$$eval("a[href]", (as) => as.map((a) => ({ t: (a.textContent || "").replace(/\s+/g, " ").trim(), h: (a as HTMLAnchorElement).href })));
      const seen = new Set<string>(); const jobs: FeedJob[] = [];
      for (const l of links) {
        if (l.t.length < 6 || l.t.length > 90 || seen.has(l.h)) continue;
        if (!/\/(job|jobs|career|careers|position|positions|opening|openings|requisition|vacanc|opportunit)[a-z]*\/[^/]+/i.test(l.h) && !/[?&](job|jobid|req|requisition|id|gh_jid)=/i.test(l.h)) continue;
        if (/^(view all|see all|all jobs|careers|jobs|apply now|apply|learn more|read more|search|home)$/i.test(l.t)) continue;
        seen.add(l.h); jobs.push({ id: l.h, title: l.t, location: "", url: l.h, posted_at: null, updated_at: null, posted_text: null });
      }
      return { jobs: jobs.slice(0, 500), html };
    } finally { await ctx.close().catch(() => {}); }
  });
}

/** A plain careers page as a "system": ref is the page URL. */
export const page: System = {
  id: "page",
  detect: () => null,
  async read(url) {
    const r = await getText(url);
    if (r.status === 404 || r.status === 410) return null;
    let jobs = r.ok ? jsonLdJobs(r.text, url) : [];
    if (!jobs.length) jobs = (await harvestLinks(url)).jobs;
    return { system: "page", ref: url, board_url: url, company_name: null, jobs };
  },
};

/** Darwinbox and Keka: Indian HR suites with a careers page per tenant. Keka has a JSON endpoint; Darwinbox is read as a page. */
export const keka: System = {
  id: "keka",
  detect: (u) => u.match(/https?:\/\/([a-z0-9-]+)\.keka\.com/i)?.[1]?.toLowerCase() ?? null,
  async read(tenant) {
    const api = await getJson<any[]>(`https://${tenant}.keka.com/careers/api/embedjobs/active`);
    if (api.ok && Array.isArray(api.data)) {
      const jobs: FeedJob[] = api.data.map((x: any) => ({ id: String(x.id ?? x.jobId ?? x.title), title: x.title ?? x.jobTitle ?? "", location: [x.city, x.location, x.state].filter(Boolean).join(", "), url: `https://${tenant}.keka.com/careers/jobdetails/${x.id ?? x.jobId ?? ""}`, posted_at: x.postedOn ? new Date(x.postedOn).toISOString() : null, updated_at: null, posted_text: null }));
      return { system: "keka", ref: tenant, board_url: `https://${tenant}.keka.com/careers`, company_name: null, jobs };
    }
    const f = await page.read(`https://${tenant}.keka.com/careers`); return f && { ...f, system: "keka", ref: tenant };
  },
};
export const darwinbox: System = {
  id: "darwinbox",
  detect: (u) => u.match(/https?:\/\/([a-z0-9-]+)\.darwinbox\.in/i)?.[1]?.toLowerCase() ?? null,
  async read(tenant) { const f = await page.read(`https://${tenant}.darwinbox.in/ms/candidate/careers`); return f && { ...f, system: "darwinbox", ref: tenant }; },
};
