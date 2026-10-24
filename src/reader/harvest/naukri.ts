// Naukri, Bengaluru: the search API the site itself uses. Two things come out of every page:
// employer names (the seed grows itself) and the listings as sightings. Polite: one page every ~1.5s.
import { db } from "../../lib/db.js";
import { getJson } from "../http.js";
import { companyKey } from "../../engine/ghost/canon.js";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const SEARCH = "jobapi/v3/search";

/** Open naukri.com in a browser, watch the request its own front-end makes to the search API, and keep those exact headers + cookies.
 *  Also returns the first page's data straight from the intercepted response, so page 1 never needs a replay. */
async function captureFromBrowser(): Promise<{ headers: Record<string, string>; firstPage: any | null; url: string | null }> {
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
    const cookies = await ctx.cookies("https://www.naukri.com");
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (!k.startsWith(":") && !["content-length", "host", "accept-encoding"].includes(k.toLowerCase())) clean[k] = v;
    if (cookies.length) clean["cookie"] = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    clean["user-agent"] ??= UA;
    return { headers: clean, firstPage, url };
  } finally { await b.close(); }
}

let captured: { headers: Record<string, string> } | null = null;
export interface NaukriStats { pages: number; jobs: number; employers_new: number; stopped: string }

/** Walk the Bengaluru search, page by page. `maxPages` caps a run; the daily run only needs the first few hundred. */
export async function harvestNaukri(opts: { maxPages?: number; startPage?: number; onPage?: (s: NaukriStats) => void } = {}): Promise<NaukriStats> {
  const stats: NaukriStats = { pages: 0, jobs: 0, employers_new: 0, stopped: "end" };
  const seenEmployers = new Set<string>();
  // learn the real headers from the site itself (once per process)
  let first: any | null = null;
  if (!captured) {
    try { const c = await captureFromBrowser(); if (!c.url) { stats.stopped = "browser loaded naukri.com but saw no search request"; return stats; } captured = { headers: c.headers }; first = c.firstPage; }
    catch (e) { stats.stopped = `browser capture failed: ${(e as Error).message}`; return stats; }
  }
  for (let page = opts.startPage ?? 1; page <= (opts.maxPages ?? 1000); page++) {
    const url = `https://www.naukri.com/jobapi/v3/search?noOfResults=100&urlType=search_by_location&searchType=adv&location=bangalore&pageNo=${page}&seoKey=jobs-in-bangalore&src=jobsearchDesk`;
    let r: { ok: boolean; status: number; data: any } = { ok: false, status: 0, data: null };
    if (page === 1 && first?.jobDetails?.length) r = { ok: true, status: 200, data: first };
    else r = await getJson<any>(url, { headers: captured!.headers, gapMs: 1500, retries: 3 });
    if (!r.ok || !r.data) { stats.stopped = `HTTP ${r.status} at page ${page} (replaying captured headers: ${Object.keys(captured!.headers).join(",")})`; break; }
    const jobs: any[] = r.data.jobDetails ?? [];
    if (!jobs.length) { stats.stopped = `empty page ${page}`; break; }
    stats.pages++;
    // employers
    const emp = new Map<string, string>();
    for (const j of jobs) { const name = (j.companyName ?? "").trim(); if (name && !/confidential/i.test(name)) emp.set(companyKey(name), name); }
    const keys = [...emp.keys()].filter((k) => k && !seenEmployers.has(k));
    if (keys.length) {
      const { data: have } = await db.from("employers").select("key").in("key", keys);
      const haveSet = new Set((have ?? []).map((h) => h.key));
      const fresh = keys.filter((k) => !haveSet.has(k)).map((k) => ({ key: k, name: emp.get(k)!, source: "naukri" }));
      if (fresh.length) { const { error } = await db.from("employers").upsert(fresh, { onConflict: "key", ignoreDuplicates: true }); if (!error) stats.employers_new += fresh.length; }
      keys.forEach((k) => seenEmployers.add(k));
    }
    // sightings
    const now = new Date().toISOString();
    const rows = jobs.map((j) => {
      const ph = (t: string) => (j.placeholders ?? []).find((p: any) => p.type === t)?.label ?? null;
      const loc = ph("location") ?? "";
      return {
        source: "naukri", source_id: String(j.jobId), employer_key: companyKey(j.companyName ?? "") || null, company_name: j.companyName ?? null,
        title: (j.title ?? "").slice(0, 300), location: loc.slice(0, 300), url: j.jdURL ? `https://www.naukri.com${j.jdURL}` : null,
        posted_at: j.createdDate ? new Date(Number(j.createdDate)).toISOString() : null, posted_text: j.footerPlaceholderLabel ?? null, salary_text: ph("salary"),
        blr: true, /* the search itself is Bengaluru-scoped */ raw: { exp: ph("experience"), skills: j.tagsAndSkills ?? null, companyId: j.companyId ?? null },
        last_seen: now, gone_at: null,
      };
    }).filter((r) => r.source_id && r.source_id !== "undefined");
    // employer_key must exist in employers; drop the FK for names we could not key
    for (const row of rows) if (row.employer_key && !emp.has(row.employer_key)) row.employer_key = null;
    const { error } = await db.from("sightings").upsert(rows, { onConflict: "source,source_id" });
    if (error) { stats.stopped = `db: ${error.message}`; break; }
    stats.jobs += rows.length;
    opts.onPage?.(stats);
    if (jobs.length < 100 && page > 1) { stats.stopped = `short page ${page}`; break; }
  }
  return stats;
}
