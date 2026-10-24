// Naukri, Bengaluru: the search API the site itself uses. Two things come out of every page:
// employer names (the seed grows itself) and the listings as sightings. Polite: one page every ~1.5s.
import { db } from "../../lib/db.js";
import { getJson } from "../http.js";
import { companyKey } from "../../engine/ghost/canon.js";

// the headers naukri.com's own front-end sends to this API; without them it answers 406
const HEADER_SETS: Record<string, string>[] = [
  { appid: "109", systemid: "Naukri", gid: "LOCATION,INDUSTRY,EDUCATION,FAREA_ROLE", clientid: "d3skt0p", accept: "application/json", referer: "https://www.naukri.com/jobs-in-bangalore" },
  { appid: "121", systemid: "Naukri", accept: "application/json", "content-type": "application/json", referer: "https://www.naukri.com/jobs-in-bangalore" },
];
let headerSet = 0;

export interface NaukriStats { pages: number; jobs: number; employers_new: number; stopped: string }

/** Walk the Bengaluru search, page by page. `maxPages` caps a run; the daily run only needs the first few hundred. */
export async function harvestNaukri(opts: { maxPages?: number; startPage?: number; onPage?: (s: NaukriStats) => void } = {}): Promise<NaukriStats> {
  const stats: NaukriStats = { pages: 0, jobs: 0, employers_new: 0, stopped: "end" };
  const seenEmployers = new Set<string>();
  for (let page = opts.startPage ?? 1; page <= (opts.maxPages ?? 1000); page++) {
    const url = `https://www.naukri.com/jobapi/v3/search?noOfResults=100&urlType=search_by_location&searchType=adv&location=bangalore&pageNo=${page}&seoKey=jobs-in-bangalore&src=jobsearchDesk`;
    let r = await getJson<any>(url, { headers: HEADER_SETS[headerSet], gapMs: 1500, retries: 3 });
    if ((r.status === 406 || r.status === 403) && headerSet === 0) { headerSet = 1; r = await getJson<any>(url, { headers: HEADER_SETS[headerSet], gapMs: 1500, retries: 3 }); }
    if (!r.ok || !r.data) { stats.stopped = `HTTP ${r.status} at page ${page} (headers set ${headerSet})`; break; }
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
