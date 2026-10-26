// SAP SuccessFactors "Career Site Builder" sites: jobs.sap.com, jobs.siemens.com, jobs.ericsson.com, careers.ltimindtree.com, ...
// Public HTML search with a location box and 25 rows per page: /search/?q=&locationsearch=Bengaluru&startrow=N
// Each row carries title, link, location and date. Bengaluru-direct by construction.
import { getText, getJson, ROBOTS_STATUS } from "../http.js";
import { mode, progress, type Feed, type FeedJob, type System } from "./types.js";

/** The script-loaded theme's endpoint: POST /services/recruiting/v1/jobs, 10 rows a page.
 *  Wipro honours the location box (location: "Bengaluru" → 1,829). HCLTech ignores it, but takes a country facet
 *  (custCountryRegion: India → 12,388) and tags each row with its city, so we page the country and keep Bengaluru rows.
 *  Returns null when the host has no such endpoint. */
async function readApi(origin: string, diag: string[]): Promise<FeedJob[] | null> {
  const url = `${origin}/services/recruiting/v1/jobs`;
  const call = (o: Record<string, unknown>) => getJson<any>(url, { method: "POST", gapMs: 450, timeoutMs: 20000, headers: { accept: "application/json", referer: `${origin}/search/` },
    body: { locale: "en_US", pageNumber: 0, sortBy: "", keywords: "", location: "", facetFilters: {}, brand: "", skills: [], categoryId: 0, alertId: "", rcmCandidateId: "", ...o } });
  const probe = await call({ location: "Bengaluru" });
  // a refusal is not "no such endpoint": say so, and never fall through to an empty read
  if (!probe.ok && (probe.status === ROBOTS_STATUS || probe.status === 403 || probe.status === 429 || probe.status === 0)) throw new Error(`successfactors ${origin}: API HTTP ${probe.status}`);
  if (!probe.ok || !probe.data || typeof probe.data.totalJobs === "undefined") { diag.push(`api probe HTTP ${probe.status}`); return null; }
  const total = Number(probe.data.totalJobs ?? 0);
  // which query to page: the location box when it works, else the India facet (then filter rows by city)
  let q: Record<string, unknown>; let expect: number; let filter = false;
  if (total > 0) { q = { location: "Bengaluru" }; expect = total; diag.push(`api location=Bengaluru: ${total}`); }
  else {
    const india = await call({ facetFilters: { custCountryRegion: ["India"] } });
    const t2 = Number(india.data?.totalJobs ?? 0);
    if (!india.ok || t2 === 0) { diag.push("api: 0 for Bengaluru and no India facet"); return []; }
    q = { facetFilters: { custCountryRegion: ["India"] } }; expect = t2; filter = true; diag.push(`api facet India: ${t2}, filtering rows by city`);
  }
  const jobs: FeedJob[] = []; const seen = new Set<string>();
  const pages = Math.min(Math.ceil(expect / 10), mode.quick ? (filter ? 15 : 5) : 1400);
  let empty = 0; let slow = 0; const t0 = Date.now(); const budgetMs = 25 * 60000;
  for (let p = 0; p < pages; p++) {
    if (Date.now() - t0 > budgetMs) { diag.push(`stopped at page ${p}/${pages}: 25 min budget`); break; }
    if (p % 10 === 0) progress(`${origin.replace(/^https?:\/\//, "")} page ${p}/${pages}, ${jobs.length} Bengaluru so far${slow ? `, ${slow} slow/failed pages` : ""}`);
    const t1 = Date.now();
    const r = p === 0 && !filter ? probe : await call({ ...q, pageNumber: p });
    if (!r.ok || Date.now() - t1 > 4000) slow++;
    const rows: any[] = r.data?.jobSearchResult ?? [];
    if (!r.ok || rows.length === 0) { if (++empty >= 3) { diag.push(`stopped at page ${p} (empty)`); break; } continue; }
    for (const x of rows) {
      const j = x?.response ?? x; const id = String(j?.id ?? ""); if (!id || seen.has(id)) continue;
      const city = String(j.custprimecity ?? "").trim();
      const short = (Array.isArray(j.jobLocationShort) ? j.jobLocationShort : [j.jobLocationShort]).filter(Boolean).map((s: unknown) => String(s).replace(/<[^>]+>/g, " ").trim()).join(" | ");
      const state = [j.jobLocationState, j.jobLocationCountry].flat().filter(Boolean).join(", ");
      const location = short || [city, state || (Array.isArray(j.custCountryRegion) ? j.custCountryRegion.join(", ") : j.custCountryRegion)].filter(Boolean).join(", ");
      // when we page the whole country, only an explicit city counts — a blank or "Others" city is not Bengaluru
      if (filter && !/bengaluru|bangalore/i.test(`${city} ${short}`)) continue;
      seen.add(id);
      const d = String(j.unifiedStandardStart ?? ""); const m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
      const posted = m ? new Date(Date.UTC(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[1]) - 1, Number(m[2]))).toISOString() : null;
      jobs.push({ id, title: String(j.unifiedStandardTitle ?? j.urlTitle ?? "").replace(/&amp;/g, "&"), location, url: `${origin}/job/${j.urlTitle ?? j.unifiedUrlTitle ?? id}/${id}/`, posted_at: posted, updated_at: null, posted_text: d || null });
    }
  }
  diag.push(`api read ${jobs.length} of ${expect} rows${filter ? " (India, Bengaluru kept)" : ""}${mode.quick ? ", quick" : ""}`);
  return jobs;
}

const ROW = /<tr[^>]*class="[^"]*data-row[^"]*"[\s\S]*?<\/tr>/gi;
const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

function parseRows(html: string, origin: string): FeedJob[] {
  const jobs: FeedJob[] = []; const seen = new Set<string>();
  // 1. the default theme: table rows with jobTitle-link / jobLocation / jobDate
  for (const m of html.matchAll(ROW)) {
    const row = m[0];
    const a = row.match(/<a[^>]+class="[^"]*jobTitle-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const href = a[1].startsWith("http") ? a[1] : origin + a[1];
    const id = href.match(/\/(\d+)\/?(?:[?#]|$)/)?.[1] ?? href;
    if (seen.has(id)) continue; seen.add(id);
    const loc = row.match(/<span[^>]+class="[^"]*jobLocation[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "";
    const date = row.match(/<span[^>]+class="[^"]*jobDate[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "";
    const d = strip(date); const parsed = d ? new Date(d) : null;
    jobs.push({ id, title: strip(a[2]), location: strip(loc), url: href, posted_at: parsed && !isNaN(parsed.getTime()) ? parsed.toISOString() : null, updated_at: null, posted_text: d || null });
  }
  if (jobs.length) return jobs;
  // 2. any theme: every SF job link looks like /job/<City>-<Title>-<Region>/<id>/ — the city is in the URL itself
  for (const m of html.matchAll(/<a[^>]+href="((?:https?:\/\/[^"/]+)?\/job\/([^"/]+)\/(\d{4,})\/?)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].startsWith("http") ? m[1] : origin + m[1]; const id = m[3];
    if (seen.has(id)) continue;
    const title = strip(m[4]); if (title.length < 3 || /^(apply|view|more)/i.test(title)) continue;
    seen.add(id);
    const slug = decodeURIComponent(m[2]).replace(/-/g, " ");
    const city = slug.match(/^(Bengaluru|Bangalore|Noida|Chennai|Pune|Hyderabad|Mumbai|Gurugram|Gurgaon|Kolkata|Delhi|[A-Z][a-z]+(?: [A-Z][a-z]+)?)\b/)?.[1] ?? "";
    jobs.push({ id, title, location: city, url: href, posted_at: null, updated_at: null, posted_text: null });
  }
  return jobs;
}

/** Is this HTML a SuccessFactors career site? */
export const isSuccessFactors = (html: string) => /jobTitle-link|class="[^"]*jobLocation|\/search\/\?q=|successfactors|rmk-|jobs\.sap|csb-/i.test(html) && /jobTitle-link|searchResults|data-row/i.test(html);

export const successfactors: System = {
  id: "successfactors",
  // ref is the site origin, e.g. "https://jobs.sap.com"
  detect: (u) => { const m = u.match(/^(https?:\/\/[a-z0-9.-]+)\/(?:search\/|job\/[^/]+\/\d+|go\/|content\/)/i); return m && /jobs\.|careers?\./i.test(m[1]) ? m[1] : null; },
  async read(origin) {
    const jobs: FeedJob[] = []; const seen = new Set<string>(); const diag: string[] = [];
    // 1. newer theme (HCLTech, Wipro): the list is fetched by script from a JSON endpoint on the same host
    const api = await readApi(origin, diag);
    if (api) return { system: "successfactors", ref: origin, board_url: `${origin}/search/?q=&locationsearch=Bengaluru`, company_name: null, jobs: api, debug: diag.join("; ") };
    // 2. classic theme: server-rendered rows
    for (const loc of ["Bengaluru", "Bangalore"]) {
      let got = 0;
      for (let start = 0; start < 2500; start += 25) {
        const r = await getText(`${origin}/search/?q=&locationsearch=${encodeURIComponent(loc)}&startrow=${start}`, { timeoutMs: 20000, gapMs: 700 });
        if (r.status === 404) { if (start === 0 && loc === "Bengaluru") return null; break; }
        if (!r.ok) { diag.push(`${loc}@${start} HTTP ${r.status}`); break; }
        if (start === 0 && loc === "Bengaluru" && !/jobTitle-link|\/job\/[^"/]+\/\d{4,}\/|rmkcdn\.successfactors|searchResults/i.test(r.text)) return null; // not a SuccessFactors site
        const rows = parseRows(r.text, origin);
        let fresh = 0; for (const j of rows) if (!seen.has(j.id)) { seen.add(j.id); jobs.push(j); fresh++; }
        got += rows.length;
        if (rows.length < 10 || fresh === 0) break;
      }
      diag.push(`${loc}: read ${got}`);
    }
    return { system: "successfactors", ref: origin, board_url: `${origin}/search/?q=&locationsearch=Bengaluru`, company_name: null, jobs, debug: diag.join("; ") };
  },
};
