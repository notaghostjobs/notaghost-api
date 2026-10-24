// Naukri, Bengaluru: the search API the site itself uses. Two things come out of every page:
// employer names (the seed grows itself) and the listings as sightings. Polite: one page every ~1.5s.
import { db } from "../../lib/db.js";
import { getJson } from "../http.js";
import { companyKey } from "../../engine/ghost/canon.js";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const SEARCH = "jobapi/v3/search";

/** Open naukri.com in a browser, watch the request its own front-end makes to the search API, and keep those exact headers + cookies.
 *  Also returns the first page's data straight from the intercepted response, so page 1 never needs a replay. */
export interface DomJob { jobId: string; title: string; companyName: string; location: string; jdURL: string; posted: string | null; exp: string | null; salary: string | null }
/** Read job cards straight out of a rendered Naukri search page. Heuristic on purpose: anchors to job-listings-* are the cards. */
async function readCards(page: import("playwright-core").Page): Promise<DomJob[]> {
  return page.evaluate(() => {
    const out: any[] = []; const seen = new Set<string>();
    for (const a of Array.from(document.querySelectorAll('a[href*="job-listings-"]')) as HTMLAnchorElement[]) {
      const m = a.href.match(/-(\d{8,})(?:[?#]|$)/); if (!m || seen.has(m[1])) continue;
      const title = (a.textContent || "").trim(); if (title.length < 3) continue;
      seen.add(m[1]);
      const card = a.closest("article, .srp-jobtuple-wrapper, .jobTuple, [class*='jobTuple'], [class*='job-tuple'], li, div");
      const q = (sel: string) => { const el = card?.querySelector(sel) as HTMLElement | null; return el ? (el.textContent || "").trim() : null; };
      out.push({ jobId: m[1], title, jdURL: a.href,
        companyName: q('a[href*="-jobs-careers-"]') ?? q('[class*="comp-name"], [class*="companyName"], [class*="subTitle"]') ?? "",
        location: q('[class*="loc"]') ?? "", posted: q('[class*="job-post-day"], [class*="postDay"], [class*="posted"]'),
        exp: q('[class*="exp"]'), salary: q('[class*="sal"]') });
    }
    return out;
  });
}

async function captureFromBrowser(): Promise<{ headers: Record<string, string>; firstPage: any | null; url: string | null; cards: DomJob[]; diag: string }> {
  const { chromium } = await import("playwright-core");
  const b = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const ctx = await b.newContext({ userAgent: UA, locale: "en-IN" });
    const page = await ctx.newPage();
    let headers: Record<string, string> = {}; let url: string | null = null; let firstPage: any | null = null;
    const got = new Promise<void>((resolve) => {
      page.on("request", (req) => { if (req.url().includes(SEARCH) && !url) { url = req.url(); headers = req.headers(); } });
      page.on("response", async (res) => { if (res.url().includes(SEARCH) && !firstPage) { try { firstPage = await res.json(); } catch { /* not json */ } resolve(); } });
    });
    await page.goto("https://www.naukri.com/jobs-in-bangalore", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await Promise.race([got, new Promise((r) => setTimeout(r, 30000))]);
    await page.waitForTimeout(4000);
    const cards = await readCards(page).catch(() => [] as DomJob[]);
    const title = await page.title().catch(() => "");
    const text = await page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 160)).catch(() => "");
    const diag = `title="${title}" cards=${cards.length} xhr=${url ? "yes" : "no"} text="${text}"`;
    const cookies = await ctx.cookies("https://www.naukri.com");
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (!k.startsWith(":") && !["content-length", "host", "accept-encoding"].includes(k.toLowerCase())) clean[k] = v;
    if (cookies.length) clean["cookie"] = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    clean["user-agent"] ??= UA;
    return { headers: clean, firstPage, url, cards, diag };
  } finally { await b.close(); }
}

let captured: { headers: Record<string, string> } | null = null;
export interface NaukriStats { pages: number; jobs: number; employers_new: number; stopped: string; mode?: string }

/** One listing, whichever way we read it. */
interface Listing { jobId: string; title: string; companyName: string; location: string; url: string | null; posted_at: string | null; posted_text: string | null; salary: string | null; exp: string | null; skills: string | null; companyId: string | null }

const fromApi = (j: any): Listing => {
  const ph = (t: string) => (j.placeholders ?? []).find((p: any) => p.type === t)?.label ?? null;
  return { jobId: String(j.jobId ?? ""), title: j.title ?? "", companyName: (j.companyName ?? "").trim(), location: ph("location") ?? "", url: j.jdURL ? (j.jdURL.startsWith("http") ? j.jdURL : `https://www.naukri.com${j.jdURL}`) : null,
    posted_at: j.createdDate ? new Date(Number(j.createdDate)).toISOString() : null, posted_text: j.footerPlaceholderLabel ?? null, salary: ph("salary"), exp: ph("experience"), skills: j.tagsAndSkills ?? null, companyId: j.companyId ? String(j.companyId) : null };
};
const fromCard = (c: DomJob): Listing => ({ jobId: c.jobId, title: c.title, companyName: c.companyName.trim(), location: c.location, url: c.jdURL, posted_at: null, posted_text: c.posted, salary: c.salary, exp: c.exp, skills: null, companyId: null });

/** Write one page of listings: new employer names + sightings. Idempotent. */
async function store(list: Listing[], seenEmployers: Set<string>, stats: NaukriStats) {
  const emp = new Map<string, string>();
  for (const j of list) if (j.companyName && !/confidential/i.test(j.companyName)) emp.set(companyKey(j.companyName), j.companyName);
  const keys = [...emp.keys()].filter((k) => k && !seenEmployers.has(k));
  if (keys.length) {
    const { data: have } = await db.from("employers").select("key").in("key", keys);
    const haveSet = new Set((have ?? []).map((h) => h.key));
    const fresh = keys.filter((k) => !haveSet.has(k)).map((k) => ({ key: k, name: emp.get(k)!, source: "naukri" }));
    if (fresh.length) { const { error } = await db.from("employers").upsert(fresh, { onConflict: "key", ignoreDuplicates: true }); if (!error) stats.employers_new += fresh.length; }
    keys.forEach((k) => seenEmployers.add(k));
  }
  const now = new Date().toISOString();
  const rows = list.filter((j) => /^\d{6,}$/.test(j.jobId)).map((j) => {
    const key = companyKey(j.companyName) || null;
    return { source: "naukri", source_id: j.jobId, employer_key: key && emp.has(key) ? key : null, company_name: j.companyName || null,
      title: j.title.slice(0, 300), location: j.location.slice(0, 300), url: j.url, posted_at: j.posted_at, posted_text: j.posted_text, salary_text: j.salary,
      blr: true /* the search itself is Bengaluru-scoped */, raw: { exp: j.exp, skills: j.skills, companyId: j.companyId }, last_seen: now, gone_at: null };
  });
  if (!rows.length) return 0;
  const { error } = await db.from("sightings").upsert(rows, { onConflict: "source,source_id" });
  if (error) throw new Error(`db: ${error.message}`);
  stats.jobs += rows.length; stats.pages++;
  return rows.length;
}

/** Walk the Bengaluru search. Prefers the site's JSON API with headers learned from the site; falls back to reading the rendered pages. */
export async function harvestNaukri(opts: { maxPages?: number; startPage?: number; onPage?: (s: NaukriStats) => void } = {}): Promise<NaukriStats> {
  const stats: NaukriStats = { pages: 0, jobs: 0, employers_new: 0, stopped: "end" };
  const seen = new Set<string>();
  const maxPages = opts.maxPages ?? 1000;
  try {
    // 1. learn from the site (once per process)
    let first: any | null = null; let cards: DomJob[] = []; let diag = "";
    if (!captured) {
      const c = await captureFromBrowser(); diag = c.diag; cards = c.cards;
      if (c.url) { captured = { headers: c.headers }; first = c.firstPage; }
    }
    // 2. API path
    if (captured) {
      stats.mode = "api";
      for (let page = opts.startPage ?? 1; page <= maxPages; page++) {
        const url = `https://www.naukri.com/jobapi/v3/search?noOfResults=100&urlType=search_by_location&searchType=adv&location=bangalore&pageNo=${page}&seoKey=jobs-in-bangalore&src=jobsearchDesk`;
        const r = page === 1 && first?.jobDetails?.length ? { ok: true, status: 200, data: first } : await getJson<any>(url, { headers: captured.headers, gapMs: 1500, retries: 3 });
        if (!r.ok || !r.data) { stats.stopped = `HTTP ${r.status} at page ${page} (replaying captured headers: ${Object.keys(captured.headers).join(",")})`; break; }
        const jobs: any[] = r.data.jobDetails ?? [];
        if (!jobs.length) { stats.stopped = `empty page ${page}`; break; }
        await store(jobs.map(fromApi), seen, stats); opts.onPage?.(stats);
        if (jobs.length < 100 && page > 1) { stats.stopped = `short page ${page}`; break; }
      }
      return stats;
    }
    // 3. page path: the site rendered the cards into the HTML; read them page by page in the browser
    if (!cards.length) { stats.stopped = `no API call and no job cards on the page — ${diag}`; return stats; }
    stats.mode = "browser";
    await store(cards.map(fromCard), seen, stats); opts.onPage?.(stats);
    const { chromium } = await import("playwright-core");
    const b = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    try {
      const page = await (await b.newContext({ userAgent: UA, locale: "en-IN" })).newPage();
      for (let n = Math.max(2, opts.startPage ?? 2); n <= maxPages; n++) {
        await page.goto(`https://www.naukri.com/jobs-in-bangalore-${n}`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(2500);
        const pc = await readCards(page).catch(() => [] as DomJob[]);
        if (!pc.length) { stats.stopped = `no cards on page ${n}`; break; }
        await store(pc.map(fromCard), seen, stats); opts.onPage?.(stats);
      }
    } finally { await b.close(); }
    return stats;
  } catch (e) { stats.stopped = `error: ${(e as Error).message}`; return stats; }
}
