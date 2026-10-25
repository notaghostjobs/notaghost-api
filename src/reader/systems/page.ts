// Careers pages without a JSON feed: JSON-LD job lists when present, else a browser render and a careful link harvest.
// Also: finding the hiring system a careers page points at (iframes, embeds, "apply" links).
import { getText, getJson, UA, robotsAllows, RobotsDisallowed } from "../http.js";
import type { Feed, FeedJob, System } from "./types.js";

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
    /https?:\/\/[a-z0-9.-]+\.eightfold\.ai\/careers[a-z0-9_\-/?=&.]*/gi,
    /https?:\/\/www\.amazon\.jobs\/[a-z0-9_\-/]*/gi,
    /https?:\/\/(?:www\.google\.com\/about\/careers|careers\.google\.com)[a-z0-9_\-/?=&.%]*/gi,
    /https?:\/\/(?:jobs\.)?careers\.microsoft\.com[a-z0-9_\-/?=&.%]*/gi,
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
  if (browserP) { try { const b = await browserP; if (!b.isConnected()) browserP = null; } catch { browserP = null; } }
  if (!browserP) {
    const { chromium } = await import("playwright-core");
    browserP = chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--renderer-process-limit=2", "--js-flags=--max-old-space-size=160", "--disable-extensions", "--mute-audio", "--disable-background-networking"] });
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
    if (!(await robotsAllows(url))) throw new RobotsDisallowed(url);
    const b = await getBrowser();
    const ctx = await b.newContext({ userAgent: UA });
    try {
      const p = await ctx.newPage();
      await p.route("**/*", (route) => (/\.(png|jpe?g|gif|webp|svg|woff2?|ttf|mp4|css)(\?|$)/i.test(route.request().url()) ? route.abort() : route.continue()));
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await p.waitForTimeout(2000);
      const html = await p.content();
      const links: { t: string; h: string; c: string }[] = await p.$$eval("a[href]", (as) => as.map((a) => {
        const card = a.closest("li, article, tr, [class*='card'], [class*='job'], [class*='result'], [class*='tile'], div");
        const c = card ? (card.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400) : "";
        return { t: (a.textContent || "").replace(/\s+/g, " ").trim(), h: (a as HTMLAnchorElement).href, c };
      }));
      const seen = new Set<string>(); const jobs: FeedJob[] = [];
      for (const l of links) {
        if (l.t.length < 6 || l.t.length > 90 || seen.has(l.h)) continue;
        if (!/\/(job|jobs|career|careers|position|positions|opening|openings|requisition|vacanc|opportunit)[a-z]*\/[^/]+/i.test(l.h) && !/[?&](job|jobid|req|requisition|id|gh_jid)=/i.test(l.h)) continue;
        if (/^(view all|see all|all jobs|careers|jobs|apply now|apply|learn more|read more|search|home)$/i.test(l.t)) continue;
        // the card's text is the best location we have without opening the job; keep the Bengaluru-bearing phrase if there is one
        const m = l.c.match(/[^.;|·]{0,40}(Bengaluru|Bangalore|Karnataka)[^.;|·]{0,40}/i);
        seen.add(l.h); jobs.push({ id: l.h, title: l.t, location: m ? m[0].trim() : "", url: l.h, posted_at: null, updated_at: null, posted_text: null });
      }
      return { jobs: jobs.slice(0, 500), html };
    } finally { await ctx.close().catch(() => {}); }
  });
}

/** Render a search page and collect links matching `link`, scrolling or paging until nothing new appears. Serialized on the shared browser. */
export async function renderAndCollect(url: string, link: RegExp, o: { next: "scroll" | "page"; pageParam?: string; maxPages: number }): Promise<{ links: { h: string; t: string; loc: string }[]; debug: string }> {
  try { return await renderOnce(url, link, o); }
  catch (e) { const msg = (e as Error).message; if (/closed|crashed|disconnected|Target page/i.test(msg)) { browserP = null; return renderOnce(url, link, o); } throw e; }
}
function renderOnce(url: string, link: RegExp, o: { next: "scroll" | "page"; pageParam?: string; maxPages: number }): Promise<{ links: { h: string; t: string; loc: string }[]; debug: string }> {
  return serial(async () => {
    if (!(await robotsAllows(url))) throw new RobotsDisallowed(url);
    const b = await getBrowser();
    const ctx = await b.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
    const out = new Map<string, { h: string; t: string; loc: string }>(); const diag: string[] = []; const sampled: string[] = [];
    try {
      const p = await ctx.newPage();
      await p.route("**/*", (route) => (/\.(png|jpe?g|gif|webp|svg|woff2?|ttf|mp4|css)(\?|$)/i.test(route.request().url()) ? route.abort() : route.continue()));
      const collect = async () => {
        const links: { h: string; t: string; loc: string }[] = await p.$$eval("a[href]", (as) => as.map((a) => {
          const card = a.closest("li, article, tr, [class*='card'], [class*='job'], [class*='result'], [class*='tile'], [role='listitem'], div");
          const c = card ? (card.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400) : "";
          const m = c.match(/[^.;|·]{0,40}(Bengaluru|Bangalore|Karnataka)[^.;|·]{0,40}/i);
          return { h: (a as HTMLAnchorElement).href, t: (a.textContent || "").replace(/\s+/g, " ").trim(), loc: m ? m[0].trim() : "" };
        }));
        let fresh = 0; for (const l of links) { if (!link.test(l.h) || l.t.length < 3 || l.t.length > 160 || out.has(l.h)) continue; out.set(l.h, l); fresh++; }
        if (!out.size && !sampled.length) for (const l of links) { if (l.t.length > 8 && l.t.length < 120 && !/^(home|login|sign|about|contact|privacy|cookie|terms)/i.test(l.t)) sampled.push(`${l.t.slice(0, 50)} → ${l.h.slice(0, 100)}`); if (sampled.length >= 12) break; }
        return fresh;
      };
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      // results load after first paint on most portals: wait up to 20s for a matching link, nudging with a scroll
      const t0 = Date.now(); let fresh = 0;
      while (Date.now() - t0 < 20000) {
        fresh = await collect(); if (fresh) break;
        await p.mouse.wheel(0, 800).catch(() => {}); await p.waitForTimeout(1500);
      }
      diag.push(`first ${fresh} after ${Math.round((Date.now() - t0) / 1000)}s`);
      if (o.next === "scroll") {
        for (let i = 0; i < 60 && fresh > 0; i++) {
          await p.mouse.wheel(0, 2400); await p.waitForTimeout(900);
          // "load more" buttons, if any
          const btn = await p.$("button:has-text('Load more'), button:has-text('Show more'), button:has-text('View more'), a:has-text('Load more')"); if (btn) { await btn.click().catch(() => {}); await p.waitForTimeout(1500); }
          fresh = await collect();
        }
      } else {
        for (let n = 2; n <= o.maxPages && fresh > 0; n++) {
          const u = new URL(url); const pp = o.pageParam ?? "page"; u.searchParams.set(pp, pp === "startrow" ? String((n - 1) * 25) : String(n));
          await p.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
          const t1 = Date.now(); fresh = 0;
          while (Date.now() - t1 < 12000) { fresh = await collect(); if (fresh) break; await p.waitForTimeout(1200); }
        }
      }
      diag.push(`total ${out.size}`);
      if (!out.size) diag.push(`links on page e.g. ${sampled.slice(0, 8).join(" | ")}`);
      return { links: [...out.values()], debug: diag.join("; ") };
    } catch (e) {
      throw new Error((e as Error).message.split("\n")[0].slice(0, 160));
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
