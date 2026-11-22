// Employers whose own careers site publishes a sitemap of its job pages (22 Nov): Hitachi, GE Vernova, Nike.
// Their roles used to come through Workday (*.myworkdayjobs.com), which now answers our named reader with a Cloudflare
// challenge on every request, and a challenge is not something we get past. Each of these employers also runs a careers
// site on its own domain, on one shared layout:
//   https://careers.hitachi.com/sitemap.xml                 an index, one file per language (sitemap-<n>-en.xml)
//   https://careers.hitachi.com/<title-words>/job/R0144242  one address per open posting, with a last-modified date
// and the id at the end is the requisition number Workday gave us, so what we already hold lines up with it.
//
// The sitemap says a posting is open; it does not say where the job is. That comes from:
//   1. what we already hold for that id (a title and a place read before), and
//   2. for an id we have never seen, the posting's own page (its schema.org JobPosting, or the place fields in the page).
//      One page a second, most recently changed first, at most SITEJOBS_DETAIL_CAP (600) pages in one read: the first days
//      work through the ids we have never seen (most of them other countries); after that only new postings are fetched.
// A posting that has left the sitemap is closed: it is simply absent from the feed, and the Reader marks it gone as it
// does for every system. robots.txt is honoured by the fetcher, as everywhere.
//
// ref: the careers host. Nothing detects this system from a URL: an employer is pointed at it by hand, one at a time.
import { getText } from "../http.js";
import { jsonLdJobs } from "./page.js";
import { mode, progress, type FeedJob, type System } from "./types.js";

/** host → the Workday ref its roles were read under before (their rows are where the titles and places we hold live). */
export const SITES: Record<string, { name: string; workday: string }> = {
  "careers.hitachi.com": { name: "Hitachi", workday: "hitachi/wd1/hitachi" },
  "careers.gevernova.com": { name: "GE Vernova", workday: "gevernova/wd5/Vernova_ExternalSite" },
  "careers.nike.com": { name: "Nike", workday: "nike/wd1/nke" },
};
const CAP = () => (mode.quick ? 5 : Math.max(0, Number(process.env.SITEJOBS_DETAIL_CAP ?? 600) || 600));

/** The English file(s) named by the index; a plain list of addresses is its own file. */
export function englishFiles(indexXml: string, host: string): string[] {
  if (!/<sitemapindex\b/i.test(indexXml)) return [];
  const locs = [...indexXml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&")).filter((u) => { try { return new URL(u).host === host; } catch { return false; } });
  const en = locs.filter((u) => /-en\.xml(?:$|\?)/i.test(u));
  return en.length ? en : [];
}
export interface Listed { id: string; url: string; lastmod: number }
/** Job pages in a sitemap file: https://<host>/<anything>/job/<id>. One entry per id (the most recently changed). */
export function jobPages(xml: string, host: string): Map<string, Listed> {
  const out = new Map<string, Listed>();
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/i.exec(m[1])?.[1]?.replace(/&amp;/g, "&"); if (!loc) continue;
    let u: URL; try { u = new URL(loc); } catch { continue; }
    if (u.host !== host) continue;
    const id = /\/job\/([A-Za-z0-9][A-Za-z0-9_-]{2,40})\/?$/.exec(u.pathname)?.[1]; if (!id) continue;
    const lastmod = Date.parse(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i.exec(m[1])?.[1] ?? "") || 0;
    const had = out.get(id); if (!had || lastmod > had.lastmod) out.set(id, { id, url: loc, lastmod });
  }
  return out;
}

export interface Known { title: string; location: string; posted_at: string | null }
/** What we already hold for this site's postings: the rows the Workday read left behind, then the rows this reader wrote. */
async function loadKnown(host: string): Promise<Map<string, Known>> {
  const { db } = await import("../../lib/db.js");
  const known = new Map<string, Known>();
  for (const [source, prefix] of [["workday", `${SITES[host]?.workday ?? "-"}:`], ["sitejobs", `${host}:`]] as const) {   // our own rows last: they win
    if (prefix === "-:") continue;
    for (let from = 0; from < 100000; from += 1000) {
      const { data, error } = await db.from("sightings").select("source_id, title, location, posted_at").eq("source", source).like("source_id", `${prefix}%`).order("id", { ascending: true }).range(from, from + 999);
      if (error) throw new Error(`sitejobs known rows: ${error.message}`);
      for (const r of (data ?? []) as { source_id: string; title: string | null; location: string | null; posted_at: string | null }[]) {
        const id = r.source_id.slice(prefix.length); const title = (r.title ?? "").trim(); if (!id || !title) continue;
        // the Workday read wrote the place as "Bengaluru (Bengaluru facet)" or "N Locations (incl. Bengaluru)": here it is said plainly
        const location = (r.location ?? "").replace(/\s*\((?:Bengaluru facet|incl\. Bengaluru)\)\s*$/i, (x) => (/incl/i.test(x) ? ", incl. Bengaluru" : "")).trim();
        known.set(id, { title, location, posted_at: r.posted_at });
      }
      if (!data || data.length < 1000) break;
    }
  }
  return known;
}
export const __deps = { loadKnown };

const clean = (s: string) => s.replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
/** Title and place from a posting's own page. Either may come back empty; the caller decides what to do then. */
export function fromPage(html: string, url: string): { title: string; place: string; posted_at: string | null } {
  const j = jsonLdJobs(html, url)[0];
  // the page's own title reads "Power Apps Developer | Chennai, Tamil Nadu | Hitachi": the role, the place, the employer
  const head = clean(/<title[^>]*>([^<]*)</i.exec(html)?.[1] ?? "").split(/\s+\|\s+/);
  const title = clean(j?.title || (head.length >= 2 ? head[0] : "") || /<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i.exec(html)?.[1]?.replace(/<[^>]+>/g, " ") || head[0] || "");
  // the place: the JobPosting's own address; where the block gives none, the page's place fields, then the place in the title
  const locality = /"addressLocality"\s*:\s*"([^"]{2,80})"/.exec(html)?.[1];
  const country = /"addressCountry"\s*:\s*(?:"([^"]{2,60})"|\{[^}]*"name"\s*:\s*"([^"]{2,60})")/.exec(html);
  const place = clean(j?.location || [locality, country?.[1] ?? country?.[2]].filter(Boolean).join(", ") || (head.length >= 3 ? head[1] : "") || "");
  return { title, place, posted_at: j?.posted_at ?? null };
}

export const sitejobs: System = {
  id: "sitejobs",
  detect: () => null,
  async read(host) {
    if (!SITES[host]) return null;
    const base = `https://${host}`;
    const idx = await getText(`${base}/sitemap.xml`, { timeoutMs: 60000, retries: 1 });
    if (idx.status === 404) return null;
    if (!idx.ok) throw new Error(`sitejobs ${host}: sitemap HTTP ${idx.status}`);
    const listed = new Map<string, Listed>(); let partial = false; const files = englishFiles(idx.text, host);
    if (!files.length) for (const [k, v] of jobPages(idx.text, host)) listed.set(k, v);
    for (const f of files) {
      const r = await getText(f, { timeoutMs: 60000, retries: 1, gapMs: 1000 });
      if (!r.ok) { partial = true; continue; }
      for (const [k, v] of jobPages(r.text, host)) { const had = listed.get(k); if (!had || v.lastmod > had.lastmod) listed.set(k, v); }
    }
    if (!listed.size) throw new Error(`sitejobs ${host}: sitemap lists no job pages (${files.length} files)`);
    const known = await __deps.loadKnown(host);
    const jobs: FeedJob[] = []; const fresh: Listed[] = [];
    for (const l of listed.values()) {
      const k = known.get(l.id);
      if (k) jobs.push({ id: l.id, title: k.title, location: k.location, url: l.url, posted_at: k.posted_at, updated_at: l.lastmod ? new Date(l.lastmod).toISOString() : null, posted_text: null });
      else fresh.push(l);
    }
    // ids we have never seen: read the posting's own page, most recently changed first, one a second, up to the cap
    fresh.sort((a, b) => b.lastmod - a.lastmod || (a.id < b.id ? 1 : -1));
    const todo = fresh.slice(0, CAP()); let read = 0, failed = 0, unreadable = 0;
    for (const l of todo) {
      const pg = await getText(l.url, { gapMs: 1000, retries: 0, timeoutMs: 20000 });
      if (!pg.ok) { failed++; if (failed >= 25 && failed > read) break; continue; }   // the site is refusing or failing: stop asking, try tomorrow
      const p = fromPage(pg.text, l.url);
      // without a place we cannot say whether it is ours to show; it is left for a later read rather than stored half-known
      if (!p.title || !p.place) { unreadable++; if (unreadable >= 20 && read === 0) break; continue; }   // twenty in a row with no place: the pages are not shaped as expected, stop asking
      jobs.push({ id: l.id, title: p.title, location: p.place, url: l.url, posted_at: p.posted_at, updated_at: l.lastmod ? new Date(l.lastmod).toISOString() : null, posted_text: null });
      if (++read % 50 === 0) progress(`sitejobs ${host}: ${read}/${todo.length} new postings read`);
    }
    const debug = `sitemap ${listed.size} (${files.length || 1} file${files.length > 1 ? "s" : ""}), known ${listed.size - fresh.length}, new ${fresh.length}: read ${read}, failed ${failed}, no place ${unreadable}, left for later ${Math.max(0, fresh.length - todo.length)}`;
    return { system: "sitejobs", ref: host, board_url: base, company_name: SITES[host].name, jobs, debug, partial: partial || undefined };
  },
};
