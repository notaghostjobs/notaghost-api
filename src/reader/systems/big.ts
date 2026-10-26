// The hiring systems of the largest Bengaluru employers. Every reader asks for Bengaluru directly; none crawls a global board.
// Each returns `debug` so the self-test shows how the read went.
import { getJson, getText, ROBOTS_STATUS } from "../http.js";
import type { Feed, FeedJob, System } from "./types.js";

const iso = (v: unknown): string | null => { if (!v) return null; const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v)); return isNaN(d.getTime()) ? null : d.toISOString(); };
const BROWSERISH = { accept: "application/json, text/plain, */*", "accept-language": "en-IN,en;q=0.9" };

/** amazon.jobs — public search JSON, filtered to Bengaluru. ref: "amazon" */
export const amazon: System = {
  id: "amazon",
  detect: (u) => (/amazon\.jobs/i.test(u) ? "amazon" : null),
  async read() {
    const jobs: FeedJob[] = []; const diag: string[] = []; let hits = 0;
    for (const city of ["Bengaluru", "Bangalore"]) {
      for (let offset = 0; offset < 3000; offset += 100) {
        const r = await getJson<any>(`https://www.amazon.jobs/en/search.json?normalized_country_code[]=IND&normalized_city_name[]=${encodeURIComponent(city)}&offset=${offset}&result_limit=100&sort=recent`, { headers: BROWSERISH, gapMs: 600 });
        if (!r.ok || !r.data) { if (offset === 0 && city === "Bengaluru") throw new Error(`amazon: HTTP ${r.status}`); diag.push(`${city}@${offset} HTTP ${r.status}`); break; }
        hits = r.data.hits ?? hits; const page: any[] = r.data.jobs ?? [];
        for (const x of page) jobs.push({ id: String(x.id_icims ?? x.id), title: x.title ?? "", location: x.normalized_location ?? [x.city, x.state, x.country_code].filter(Boolean).join(", "), url: `https://www.amazon.jobs${x.job_path}`, posted_at: iso(x.posted_date), updated_at: iso(x.updated_time), posted_text: null });
        if (page.length < 100 || offset + 100 >= hits) break;
      }
      diag.push(`${city}: hits ${hits}`);
    }
    const seen = new Set<string>(); const uniq = jobs.filter((j) => !seen.has(j.id) && seen.add(j.id));
    return { system: "amazon", ref: "amazon", board_url: "https://www.amazon.jobs/en/locations/bangalore-india", company_name: "Amazon", jobs: uniq, debug: diag.join("; ") };
  },
};

/** Google careers — the results page carries the listings (20 per page); the old JSON API is gone. ref: "google" */
export const google: System = {
  id: "google",
  detect: (u) => (/careers\.google\.com|google\.com\/about\/careers/i.test(u) ? "google" : null),
  async read() {
    const jobs: FeedJob[] = []; const diag: string[] = []; const seen = new Set<string>();
    for (let page = 1; page <= 60; page++) {
      const r = await getText(`https://www.google.com/about/careers/applications/jobs/results/?location=Bengaluru%2C%20Karnataka%2C%20India&page=${page}`, { headers: BROWSERISH, gapMs: 800, timeoutMs: 25000 });
      if (!r.ok) { if (page === 1) throw new Error(`google: HTTP ${r.status}`); diag.push(`page ${page} HTTP ${r.status}`); break; }
      let fresh = 0;
      for (const m of r.text.matchAll(/href="(?:https:\/\/www\.google\.com\/about\/careers\/applications)?\/?jobs\/results\/(\d+)-([^"?#]+)[^"]*"[^>]*>([\s\S]{0,400}?)<\/a>/gi)) {
        const id = m[1]; if (seen.has(id)) continue; seen.add(id); fresh++;
        const title = m[3].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || m[2].replace(/-/g, " ");
        jobs.push({ id, title, location: "Bengaluru, Karnataka, India", url: `https://www.google.com/about/careers/applications/jobs/results/${id}-${m[2]}`, posted_at: null, updated_at: null, posted_text: null });
      }
      if (!fresh) { diag.push(`stopped at page ${page}`); break; }
    }
    return { system: "google", ref: "google", board_url: "https://www.google.com/about/careers/applications/jobs/results/?location=Bengaluru", company_name: "Google", jobs, debug: diag.join("; ") || `read ${jobs.length}` };
  },
};

/** Microsoft — the careers site's own search service. ref: "microsoft" */
export const microsoft: System = {
  id: "microsoft",
  detect: (u) => (/careers\.microsoft\.com/i.test(u) ? "microsoft" : null),
  async read() {
    const jobs: FeedJob[] = []; const diag: string[] = []; let total = 0;
    for (let pg = 1; pg <= 200; pg++) {
      const r = await getJson<any>(`https://gcsservices.careers.microsoft.com/search/api/v1/search?lc=Bengaluru%2C%20Karnataka%2C%20India&l=en_us&pg=${pg}&pgSz=20&o=Recent&flt=true`, { headers: { ...BROWSERISH, origin: "https://jobs.careers.microsoft.com", referer: "https://jobs.careers.microsoft.com/" }, gapMs: 600 });
      if (!r.ok || !r.data) { diag.push(`page ${pg} HTTP ${r.status}`); break; }
      const res = r.data.operationResult?.result ?? {}; total = res.totalJobs ?? total; const list: any[] = res.jobs ?? [];
      for (const x of list) jobs.push({ id: String(x.jobId), title: x.title ?? "", location: (x.properties?.locations ?? [x.properties?.primaryLocation]).filter(Boolean).join(" · "), url: `https://jobs.careers.microsoft.com/global/en/job/${x.jobId}`, posted_at: iso(x.postingDate), updated_at: null, posted_text: null });
      if (list.length < 20 || jobs.length >= total) break;
    }
    diag.push(`total ${total}`);
    return { system: "microsoft", ref: "microsoft", board_url: "https://jobs.careers.microsoft.com/global/en/search?lc=Bengaluru%2C%20Karnataka%2C%20India", company_name: "Microsoft", jobs, debug: diag.join("; ") };
  },
};

/** Eightfold-powered career sites. ref: "host|domain" (e.g. "careers.tcs.com|tcs.com"). Location filter is server-side. */
export const eightfold: System = {
  id: "eightfold",
  detect: (u) => { const m = u.match(/^https?:\/\/([a-z0-9.-]+\.eightfold\.ai)\/careers(?:[?#].*?domain=([a-z0-9.-]+))?/i); return m ? `${m[1]}|${m[2] ?? ""}` : null; },
  async read(ref) {
    const [host, domainIn] = ref.split("|"); const domain = domainIn || host.replace(/^careers\./, "");
    const jobs: FeedJob[] = []; const diag: string[] = []; let count = 0;
    for (const loc of ["Bengaluru", "Bangalore"]) {
      for (let start = 0; start < 3000; start += 100) {
        const r = await getJson<any>(`https://${host}/api/apply/v2/jobs?domain=${encodeURIComponent(domain)}&location=${encodeURIComponent(loc)}&start=${start}&num=100&sort_by=timestamp`, { headers: BROWSERISH, gapMs: 600 });
        if (!r.ok || !r.data) { if (start === 0 && loc === "Bengaluru") return null; diag.push(`${loc}@${start} HTTP ${r.status}`); break; }
        if (start === 0 && loc === "Bengaluru" && !Array.isArray(r.data.positions)) return null;
        count = r.data.count ?? count; const list: any[] = r.data.positions ?? [];
        for (const x of list) jobs.push({ id: String(x.id ?? x.ats_job_id), title: x.name ?? x.title ?? "", location: x.location ?? (x.locations ?? []).join(" · "), url: x.canonicalPositionUrl ?? `https://${host}/careers?pid=${x.id}&domain=${domain}`, posted_at: iso(x.t_create ?? x.t_update), updated_at: iso(x.t_update), posted_text: null });
        if (list.length < 100 || start + 100 >= count) break;
      }
      diag.push(`${loc}: count ${count}`);
    }
    const seen = new Set<string>(); const uniq = jobs.filter((j) => !seen.has(j.id) && seen.add(j.id));
    return { system: "eightfold", ref, board_url: `https://${host}/careers?domain=${domain}&location=Bengaluru`, company_name: null, jobs: uniq, debug: diag.join("; ") };
  },
};

/** Phenom-powered career sites (Cognizant, Dell, Capgemini, Intel and many more). ref: the site host. Server-side city filter. */
export const phenom: System = {
  id: "phenom",
  detect: () => null, // recognised from the page, not the URL (see resolve)
  async read(host) {
    const jobs: FeedJob[] = []; const diag: string[] = []; let total = 0;
    const body = (from: number, city: string[]) => ({ lang: "en_us", deviceType: "desktop", country: "in", pageName: "search-results", ddoKey: "refineSearch", sortBy: "Most recent", subsearch: "", from, jobs: true, counts: true, all_fields: ["category", "country", "state", "city", "type"], size: 100, clearAll: false, jdsource: "facets", isSliderEnable: false, pageId: "page1", siteType: "external", keywords: "", global: true, selected_fields: { city }, locationData: {} });
    for (let from = 0; from < 3000; from += 100) {
      const r = await getJson<any>(`https://${host}/widgets`, { method: "POST", body: body(from, ["Bengaluru", "Bangalore", "Bengaluru, Karnataka", "Bangalore, Karnataka"]), headers: { ...BROWSERISH, origin: `https://${host}`, referer: `https://${host}/` }, gapMs: 700 });
      if (!r.ok || !r.data) { if (from === 0) return null; diag.push(`@${from} HTTP ${r.status}`); break; }
      const rs = r.data.refineSearch ?? {}; if (from === 0 && !rs.data) return null; total = rs.totalHits ?? total; const list: any[] = rs.data?.jobs ?? [];
      for (const x of list) jobs.push({ id: String(x.jobId ?? x.reqId ?? x.jobSeqNo), title: x.title ?? "", location: [x.city, x.state, x.country].filter(Boolean).join(", "), url: x.applyUrl ?? `https://${host}/job/${x.jobSeqNo ?? x.jobId}`, posted_at: iso(x.postedDate), updated_at: iso(x.dateCreated), posted_text: null });
      if (list.length < 100 || jobs.length >= total) break;
    }
    diag.push(`totalHits ${total}`);
    return { system: "phenom", ref: host, board_url: `https://${host}/search-jobs?location=Bengaluru`, company_name: null, jobs, debug: diag.join("; ") };
  },
};

/** Oracle Recruiting Cloud career sites. ref: "host/CX_n". Keyword search for Bengaluru, server-side. */
export const oracle: System = {
  id: "oracle",
  detect: (u) => { const m = u.match(/^https?:\/\/([a-z0-9.-]+\.oraclecloud\.com)\/hcmUI\/CandidateExperience\/[a-z-]+\/sites\/(CX_\d+)/i); return m ? `${m[1]}/${m[2]}` : null; },
  // Oracle Recruiting Cloud. The LOCATIONS facet is a tree: country → state → city. Selecting India lists its
  // cities with ids; selecting Bengaluru's id gives the exact set (JPMC: 145 vs 10 by keyword). Keyword is the fallback.
  async read(ref) {
    const [host, site] = ref.split("/");
    const jobs: FeedJob[] = []; const diag: string[] = []; let total = 0;
    const api = (finder: string, expand = "requisitionList.secondaryLocations") => getJson<any>(`https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=${expand}&finder=findReqs;siteNumber=${site},${finder}`, { headers: { ...BROWSERISH, "ora-irc-language": "en" }, gapMs: 700 });
    const take = (list: any[]) => { for (const x of list) jobs.push({ id: String(x.Id), title: x.Title ?? "", location: [x.PrimaryLocation, ...(x.secondaryLocations ?? []).map((s: any) => s.Name)].filter(Boolean).join(" · "), url: `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${x.Id}`, posted_at: iso(x.PostedDate), updated_at: null, posted_text: null }); };
    const page = async (finder: string, label: string) => {
      let got = 0;
      for (let offset = 0; offset < 5000; offset += 100) {
        const r = await api(`${finder},limit=100,offset=${offset},sortBy=POSTING_DATES_DESC`);
        if (!r.ok || !r.data) { if (offset === 0 && (r.status === ROBOTS_STATUS || r.status === 403 || r.status === 429 || r.status === 0)) throw new Error(`oracle ${label}: HTTP ${r.status}`); diag.push(`${label}@${offset} HTTP ${r.status}`); break; }
        const item = r.data.items?.[0] ?? {}; total = item.TotalJobsCount ?? total; const list: any[] = item.requisitionList ?? [];
        got += list.length; take(list);
        if (list.length < 100 || offset + 100 >= total) break;
      }
      diag.push(`${label}: total ${total}, read ${got}`);
    };
    // 1. exact: the location facet
    let exact = false;
    const f0 = await api("facetsList=LOCATIONS,limit=1,offset=0", "requisitionList.secondaryLocations");
    const india = (f0.data?.items?.[0]?.locationsFacet ?? []).find((v: any) => /^india$/i.test(String(v.Name ?? "")));
    if (india?.Id) {
      const f1 = await api(`facetsList=LOCATIONS,selectedLocationsFacet=${india.Id},limit=1,offset=0`);
      const blr = (f1.data?.items?.[0]?.locationsFacet ?? []).filter((v: any) => /bengaluru|bangalore/i.test(String(v.Name ?? "")));
      if (blr.length) { for (const b of blr) await page(`selectedLocationsFacet=${b.Id}`, `facet ${b.Name}`); exact = true; }
      else diag.push(`India facet (${india.TotalCount}) lists no Bengaluru city`);
    } else diag.push("no India in the location facet");
    // 2. fallback: keyword search
    if (!exact) for (const kw of ["Bengaluru", "Bangalore"]) await page(`keyword=${encodeURIComponent(kw)}`, `keyword ${kw}`);
    const seen = new Set<string>(); const uniq = jobs.filter((j) => !seen.has(j.id) && seen.add(j.id));
    return { system: "oracle", ref, board_url: `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/requisitions?keyword=Bengaluru`, company_name: null, jobs: uniq, debug: diag.join("; ") };
  },
};

/** Which of the page-recognised systems is behind this HTML, if any. */
export function detectBigFromHtml(html: string, pageUrl: string): { system: string; ref: string } | null {
  const host = new URL(pageUrl).host;
  const ef = html.match(/https?:\/\/([a-z0-9.-]+\.eightfold\.ai)\/[^"'\s]*?domain=([a-z0-9.-]+)/i) ?? html.match(/https?:\/\/([a-z0-9.-]+\.eightfold\.ai)\//i);
  if (ef) return { system: "eightfold", ref: `${ef[1]}|${ef[2] ?? ""}` };
  if (/eightfold\.ai|ef-api|"domain"\s*:\s*"[a-z0-9.-]+"[^}]*apply\/v2/i.test(html) && /api\/apply\/v2\/jobs/i.test(html)) return { system: "eightfold", ref: `${host}|${host.replace(/^(careers|jobs)\./, "")}` };
  if (/phenom(people)?\.com|phenom-|ddoKey|\/widgets["']/i.test(html)) return { system: "phenom", ref: host };
  const orc = html.match(/https?:\/\/([a-z0-9.-]+\.oraclecloud\.com)\/hcmUI\/CandidateExperience\/[a-z-]+\/sites\/(CX_\d+)/i);
  if (orc) return { system: "oracle", ref: `${orc[1]}/${orc[2]}` };
  return null;
}

/** Ask a careers host directly whether it is Phenom or Eightfold (two cheap requests). Returns the feed when one answers with jobs. */
export async function probeBig(host: string, website: string | null): Promise<Feed | null> {
  const domain = (website ? new URL(website).host : host).replace(/^(www|careers|jobs)\./, "");
  try { const f = await phenom.read(host); if (f && f.jobs.length) return f; } catch { /* not phenom */ }
  try { const f = await eightfold.read(`${host}|${domain}`); if (f && f.jobs.length) return f; } catch { /* not eightfold */ }
  return null;
}

export const BIG: System[] = [amazon, google, microsoft, eightfold, phenom, oracle];
export { getText };
