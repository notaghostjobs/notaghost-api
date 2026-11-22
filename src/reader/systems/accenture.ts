// Accenture, read from Accenture's own careers site (22 Nov). Until now its roles came through Workday
// (accenture.wd103.myworkdayjobs.com), which answers our named reader with a Cloudflare challenge on every request, and a
// challenge is not something we get past. Accenture's own site publishes, in its robots.txt, a sitemap of every open job
// in each country: https://www.accenture.com/in-en/jobpostings-sitemap.xml lists one address per posting,
//   https://www.accenture.com/in-en/careers/jobdetails?id=ATCI-5440292-S1980130_en
// and the id in it is the same id Workday gave us (ATCI-5440292-S1980130), so what we already hold lines up with it.
//
// The sitemap says a posting is open; it does not say where the job is or what it is called. Those come from:
//   1. what we already hold for that id (a title and a place read before), and
//   2. for an id we have never seen, the posting's own page, which carries a schema.org JobPosting. One page a second,
//      newest ids first, and at most ACCENTURE_DETAIL_CAP (2,500) pages in one read: the first days work through the
//      backlog of ids we have never seen (most of them other cities); after that only the day's new postings are fetched.
// A posting that has left the sitemap is closed: it is simply absent from the feed, and the Reader marks it gone as it
// does for every system. robots.txt disallows "*/careers/jobsearch?" (the search with a query); nothing here uses it.
import { getText } from "../http.js";
import { jsonLdJobs } from "./page.js";
import { mode, progress, type Feed, type FeedJob, type System } from "./types.js";

const SITE = "https://www.accenture.com";
const CAP = () => (mode.quick ? 5 : Math.max(0, Number(process.env.ACCENTURE_DETAIL_CAP ?? 2500) || 2500));
/** The posting's id as Workday also had it: the sitemap's id without its language suffix. */
export const idOf = (raw: string) => raw.replace(/_[a-z]{2}(?:-[a-z]{2})?$/i, "");
/** Newest first: the running number at the end of the id grows with time. */
const ageKey = (id: string) => Number(/(\d+)\D*$/.exec(id)?.[1] ?? 0);
export function sitemapIds(xml: string, locale: string): Map<string, string> {
  const out = new Map<string, string>();   // id → the id exactly as the sitemap wrote it (needed for the link)
  const re = new RegExp(`<loc>\\s*https://www\\.accenture\\.com/${locale}/careers/jobdetails\\?id=([^<\\s&]+)\\s*</loc>`, "gi");
  for (const m of xml.matchAll(re)) { const raw = decodeURIComponent(m[1]); const id = idOf(raw); if (id && !out.has(id)) out.set(id, raw); }
  return out;
}

export interface Known { title: string; location: string; posted_at: string | null }
/** What we already hold for Accenture's postings: rows this reader wrote, and the rows the Workday read left behind. */
async function loadKnown(locale: string): Promise<Map<string, Known>> {
  const { db } = await import("../../lib/db.js");
  const known = new Map<string, Known>();
  for (const [source, prefix] of [["workday", "accenture/wd103/AccentureCareers:"], ["accenture", `${locale}:`]] as const) {   // our own rows last: they win
    for (let from = 0; from < 200000; from += 1000) {
      const { data, error } = await db.from("sightings").select("source_id, title, location, posted_at").eq("source", source).like("source_id", `${prefix}%`).order("id", { ascending: true }).range(from, from + 999);
      if (error) throw new Error(`accenture known rows: ${error.message}`);
      for (const r of (data ?? []) as { source_id: string; title: string | null; location: string | null; posted_at: string | null }[]) {
        const id = r.source_id.slice(prefix.length); const title = (r.title ?? "").trim(); if (!id || !title) continue;
        // the Workday read wrote the place as "Bengaluru (Bengaluru facet)" or "N Locations (incl. Bengaluru)": here it is said plainly
        const location = (r.location ?? "").replace(/\s*\((?:Bengaluru facet|incl\. Bengaluru)\)\s*$/i, (m) => (/incl/i.test(m) ? ", incl. Bengaluru" : "")).trim();
        known.set(id, { title, location, posted_at: r.posted_at });
      }
      if (!data || data.length < 1000) break;
    }
  }
  return known;
}
export const __deps = { loadKnown };

const link = (locale: string, raw: string) => `${SITE}/${locale}/careers/jobdetails?id=${encodeURIComponent(raw)}`;

export const accenture: System = {
  id: "accenture",
  detect: (url) => { const m = /^https?:\/\/(?:www\.)?accenture\.com\/([a-z]{2}-[a-z]{2})\/careers\b/i.exec(url); return m ? m[1].toLowerCase() : null; },
  async read(ref) {
    const locale = /^[a-z]{2}-[a-z]{2}$/.test(ref) ? ref : "in-en";
    const board_url = `${SITE}/${locale}/careers/jobsearch`;
    const map = await getText(`${SITE}/${locale}/jobpostings-sitemap.xml`, { timeoutMs: 60000, retries: 1 });
    if (map.status === 404) return null;
    if (!map.ok) throw new Error(`accenture ${locale}: sitemap HTTP ${map.status}`);
    const ids = sitemapIds(map.text, locale);
    if (!ids.size) throw new Error(`accenture ${locale}: sitemap lists no postings (${map.text.length} bytes)`);
    const known = await __deps.loadKnown(locale);
    const jobs: FeedJob[] = []; const fresh: string[] = [];
    for (const [id, raw] of ids) {
      const k = known.get(id);
      if (k) jobs.push({ id, title: k.title, location: k.location, url: link(locale, raw), posted_at: k.posted_at, updated_at: null, posted_text: null });
      else fresh.push(id);
    }
    // ids we have never seen: read the posting's own page, newest first, one a second, up to the cap
    fresh.sort((a, b) => ageKey(b) - ageKey(a));
    const todo = fresh.slice(0, CAP()); let read = 0, failed = 0, unreadable = 0;
    for (const id of todo) {
      const raw = ids.get(id)!; const url = link(locale, raw);
      const pg = await getText(url, { gapMs: 1000, retries: 0, timeoutMs: 20000 });
      if (!pg.ok) { failed++; if (failed >= 25 && failed > read) break; continue; }   // the site is refusing or failing: stop asking, try tomorrow
      const j = jsonLdJobs(pg.text, url)[0];
      const title = (j?.title || pg.text.match(/<title[^>]*>([^<]*)</i)?.[1] || "").replace(/\s+/g, " ").trim();
      // the place: the JobPosting's own address, or, where the block names it another way, the first place field in the page's data
      const place = j?.location || pg.text.match(/"addressLocality"\s*:\s*"([^"]{2,80})"/)?.[1] || pg.text.match(/"(?:jobLocation|primaryLocation|jobCity|cityName)"\s*:\s*"([^"]{2,80})"/i)?.[1] || "";
      // without a place we cannot say whether it is ours to show; it is left for a later read rather than stored half-known
      if (!title || !place) { unreadable++; continue; }
      jobs.push({ id, title, location: place, url, posted_at: j?.posted_at ?? null, updated_at: null, posted_text: null });
      if (++read % 50 === 0) progress(`accenture ${locale}: ${read}/${todo.length} new postings read`);
    }
    const debug = `sitemap ${ids.size}, known ${ids.size - fresh.length}, new ${fresh.length}: read ${read}, failed ${failed}, no place ${unreadable}, left for later ${Math.max(0, fresh.length - todo.length)}`;
    return { system: "accenture", ref: locale, board_url, company_name: "Accenture", jobs, debug };
  },
};
