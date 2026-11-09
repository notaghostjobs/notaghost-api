// The smaller hiring systems startups and SMEs use, each with a public JSON board. Refs come from a URL seen on the
// employer's careers page (detect), never from a guess. Each reader returns what the board says; null when the board
// does not exist. Shapes checked against live boards on 9 Nov 2026.
import { getJson } from "../http.js";
import type { FeedJob, System } from "./types.js";

const iso = (v: unknown): string | null => { if (!v) return null; const d = new Date(String(v)); return isNaN(d.getTime()) ? null : d.toISOString(); };
const H = { accept: "application/json, text/plain, */*" };

/** Recruitee: {sub}.recruitee.com/api/offers/ */
export const recruitee: System = {
  id: "recruitee",
  detect: (u) => u.match(/^https?:\/\/([a-z0-9-]+)\.recruitee\.com/i)?.[1]?.toLowerCase() ?? null,
  async read(sub) {
    const r = await getJson<any>(`https://${sub}.recruitee.com/api/offers/`, { headers: H, gapMs: 600 });
    if (r.status === 404) return null;
    if (!r.ok || !Array.isArray(r.data?.offers)) throw new Error(`recruitee ${sub}: HTTP ${r.status}`);
    const jobs: FeedJob[] = r.data.offers.filter((o: any) => !o.status || o.status === "published").map((o: any) => ({ id: String(o.id), title: o.title ?? "", location: [o.city, o.state_name ?? o.state, o.country].filter(Boolean).join(", ") || (o.location ?? ""), url: o.careers_url ?? `https://${sub}.recruitee.com/o/${o.slug ?? o.id}`, posted_at: iso(o.published_at ?? o.created_at), updated_at: iso(o.updated_at), posted_text: null }));
    return { system: "recruitee", ref: sub, board_url: `https://${sub}.recruitee.com`, company_name: r.data.offers[0]?.company_name ?? null, jobs };
  },
};

/** BambooHR: {sub}.bamboohr.com/careers/list */
export const bamboohr: System = {
  id: "bamboohr",
  detect: (u) => u.match(/^https?:\/\/([a-z0-9-]+)\.bamboohr\.com\/careers/i)?.[1]?.toLowerCase() ?? null,
  async read(sub) {
    const r = await getJson<any>(`https://${sub}.bamboohr.com/careers/list`, { headers: H, gapMs: 600 });
    if (r.status === 404) return null;
    if (!r.ok || !Array.isArray(r.data?.result)) throw new Error(`bamboohr ${sub}: HTTP ${r.status}`);
    const jobs: FeedJob[] = r.data.result.map((x: any) => ({ id: String(x.id), title: x.jobOpeningName ?? "", location: [x.location?.city, x.location?.state, x.location?.country ?? (x.isRemote ? "Remote" : null)].filter(Boolean).join(", ") || (x.atsLocation?.label ?? ""), url: `https://${sub}.bamboohr.com/careers/${x.id}`, posted_at: iso(x.datePosted), updated_at: null, posted_text: null }));
    return { system: "bamboohr", ref: sub, board_url: `https://${sub}.bamboohr.com/careers`, company_name: null, jobs };
  },
};

/** Breezy: {sub}.breezy.hr/json */
export const breezy: System = {
  id: "breezy",
  detect: (u) => u.match(/^https?:\/\/([a-z0-9-]+)\.breezy\.hr/i)?.[1]?.toLowerCase() ?? null,
  async read(sub) {
    const r = await getJson<any>(`https://${sub}.breezy.hr/json`, { headers: H, gapMs: 600 });
    if (r.status === 404) return null;
    if (!r.ok || !Array.isArray(r.data)) throw new Error(`breezy ${sub}: HTTP ${r.status}`);
    if (!r.data.length) return null;   // an unknown subdomain answers [] too
    const jobs: FeedJob[] = r.data.map((x: any) => ({ id: String(x.id ?? x.friendly_id), title: x.name ?? "", location: x.location?.name ?? [x.location?.city, x.location?.state?.name, x.location?.country?.name].filter(Boolean).join(", "), url: x.url ?? `https://${sub}.breezy.hr/p/${x.friendly_id ?? x.id}`, posted_at: iso(x.published_date ?? x.creation_date), updated_at: iso(x.updated_date), posted_text: null }));
    return { system: "breezy", ref: sub, board_url: `https://${sub}.breezy.hr`, company_name: null, jobs };
  },
};

/** Pinpoint: {sub}.pinpointhq.com/postings.json */
export const pinpoint: System = {
  id: "pinpoint",
  detect: (u) => u.match(/^https?:\/\/([a-z0-9-]+)\.pinpointhq\.com/i)?.[1]?.toLowerCase() ?? null,
  async read(sub) {
    const r = await getJson<any>(`https://${sub}.pinpointhq.com/postings.json`, { headers: H, gapMs: 600 });
    if (r.status === 404) return null;
    if (!r.ok || !Array.isArray(r.data?.data)) throw new Error(`pinpoint ${sub}: HTTP ${r.status}`);
    const jobs: FeedJob[] = r.data.data.map((x: any) => ({ id: String(x.id), title: x.title ?? "", location: x.location?.name ?? [x.location?.city, x.location?.country].filter(Boolean).join(", "), url: x.url ?? `https://${sub}.pinpointhq.com/postings/${x.id}`, posted_at: iso(x.published_at ?? x.created_at), updated_at: iso(x.updated_at), posted_text: null }));
    return { system: "pinpoint", ref: sub, board_url: `https://${sub}.pinpointhq.com`, company_name: null, jobs };
  },
};

/** Rippling ATS: ats.rippling.com/{slug}/jobs → api.rippling.com/platform/api/ats/v1/board/{slug}/jobs */
export const rippling: System = {
  id: "rippling",
  detect: (u) => u.match(/^https?:\/\/ats\.rippling\.com\/([a-z0-9-]+)\/jobs/i)?.[1]?.toLowerCase() ?? null,
  async read(slug) {
    const r = await getJson<any>(`https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`, { headers: H, gapMs: 600 });
    if (r.status === 404 || r.data?.error_code === "RESOURCE_NOT_FOUND") return null;
    if (!r.ok || !Array.isArray(r.data)) throw new Error(`rippling ${slug}: HTTP ${r.status}`);
    const jobs: FeedJob[] = r.data.map((x: any) => ({ id: String(x.uuid ?? x.id), title: x.name ?? x.title ?? "", location: x.workLocation?.label ?? (Array.isArray(x.locations) ? x.locations.map((l: any) => l.label ?? l.name).join(" · ") : ""), url: x.url ?? `https://ats.rippling.com/${slug}/jobs/${x.uuid ?? x.id}`, posted_at: iso(x.createdAt ?? x.created_at), updated_at: null, posted_text: null }));
    return { system: "rippling", ref: slug, board_url: `https://ats.rippling.com/${slug}/jobs`, company_name: null, jobs };
  },
};

/** Workable: apply.workable.com/api/v3/accounts/{slug}/jobs (paged by token). Cloudflare rate-limits bursts: slow and gentle. */
export const workable: System = {
  id: "workable",
  detect: (u) => u.match(/^https?:\/\/apply\.workable\.com\/([a-z0-9-]+)\/?/i)?.[1]?.toLowerCase() ?? (u.match(/^https?:\/\/([a-z0-9-]+)\.workable\.com/i)?.[1]?.toLowerCase() ?? null),
  async read(slug) {
    if (["api", "www", "apply", "jobs"].includes(slug)) return null;
    const jobs: FeedJob[] = []; let token: string | null = null; let name: string | null = null; const diag: string[] = [];
    for (let page = 0; page < 40; page++) {
      const body: Record<string, unknown> = { query: "", location: [], department: [], worktype: [], remote: [] }; if (token) body.token = token;
      const r = await getJson<any>(`https://apply.workable.com/api/v3/accounts/${slug}/jobs`, { method: "POST", body, headers: { ...H, origin: "https://apply.workable.com", referer: `https://apply.workable.com/${slug}/` }, gapMs: 2500, timeoutMs: 20000 });
      if (r.status === 404) return null;
      if (!r.ok || !Array.isArray(r.data?.results)) { if (page === 0) throw new Error(`workable ${slug}: HTTP ${r.status}`); diag.push(`page ${page} HTTP ${r.status}`); break; }
      for (const x of r.data.results) jobs.push({ id: String(x.shortcode ?? x.id), title: x.title ?? "", location: [x.location?.city, x.location?.region, x.location?.country, x.remote ? "Remote" : null].filter(Boolean).join(", "), url: `https://apply.workable.com/${slug}/j/${x.shortcode}/`, posted_at: iso(x.published), updated_at: null, posted_text: null });
      name ??= r.data.name ?? null; token = r.data.nextPage ?? null; if (!token) break;
    }
    return { system: "workable", ref: slug, board_url: `https://apply.workable.com/${slug}/`, company_name: name, jobs, debug: diag.join("; ") };
  },
};

export const SMALL: System[] = [recruitee, bamboohr, breezy, pinpoint, rippling, workable];

/** RippleHire (LTIMindtree, Mphasis and other Indian IT firms). ref: "host|token", both from the employer's own careers link.
 *  POST /candidate/candidatejobsearch with a JSON blob in a form field; location is free text, so both spellings are read. */
export const ripplehire: System = {
  id: "ripplehire",
  detect: (u) => { const m = u.match(/^https?:\/\/([a-z0-9-]+\.ripplehire\.com)\/candidate\/?\?[^#]*\btoken=([A-Za-z0-9]+)/i); return m ? `${m[1]}|${m[2]}` : null; },
  async read(ref) {
    const [host, token] = ref.split("|"); if (!host || !token) return null;
    const jobs: FeedJob[] = []; const seen = new Set<string>(); const diag: string[] = [];
    for (const location of ["Bengaluru", "Bangalore"]) {
      let total = 0, got = 0;
      for (let page = 0; page < 40; page++) {
        const params = JSON.stringify({ page, search: "*:*", location, token, source: "CAREERSITE", pagesize: 100 });
        const r = await getJson<any>(`https://${host}/candidate/candidatejobsearch`, { method: "POST", form: { careerSiteUrlParams: params, lang: "en" }, headers: { ...H, "x-requested-with": "XMLHttpRequest", referer: `https://${host}/candidate/?token=${token}&lang=en&source=CAREERSITE` }, gapMs: 800, timeoutMs: 20000 });
        if (r.status === 404) return null;
        if (!r.ok || !r.data) { if (page === 0 && location === "Bengaluru") throw new Error(`ripplehire ${host}: HTTP ${r.status}`); diag.push(`${location}@${page} HTTP ${r.status}`); break; }
        total = Number(r.data.totalJobCount ?? total); const list: any[] = r.data.jobVoList ?? []; got += list.length;
        for (const x of list) { const id = String(x.jobSeq ?? x.jobId ?? ""); if (!id || seen.has(id)) continue; seen.add(id); jobs.push({ id, title: String(x.jobTitle ?? ""), location: String(x.locations ?? x.jobLocation ?? ""), url: `https://${host}/candidate/?token=${token}&source=CAREERSITE#detail/job/${id}`, posted_at: null, updated_at: null, posted_text: null, raw: { exp: x.jobReqExp ?? null } }); }
        if (list.length < 100 || got >= total) break;
      }
      diag.push(`${location}: total ${total}`);
    }
    return { system: "ripplehire", ref, board_url: `https://${host}/candidate/?token=${token}&lang=en&source=CAREERSITE`, company_name: null, jobs, debug: diag.join("; ") };
  },
};

/** Capgemini India: the WordPress careers page fetches its list from cg-jobstream-api (an index over their SuccessFactors);
 *  the list carries the description, so no enrichment visit is needed. Fixed ref. */
export const capgemini: System = {
  id: "capgemini",
  detect: (u) => (/capgemini\.com\/(?:[a-z]{2}-[a-z]{2}\/)?careers/i.test(u) || /cg-jobstream-api\.azurewebsites\.net/i.test(u) ? "capgemini" : null),
  async read() {
    const jobs: FeedJob[] = []; const diag: string[] = []; let count = 0;
    for (let page = 1; page <= 20; page++) {
      const r = await getJson<any>(`https://cg-jobstream-api.azurewebsites.net/api/job-search?page=${page}&size=100&country_code=in-en&location=Bangalore`, { headers: { ...H, origin: "https://www.capgemini.com", referer: "https://www.capgemini.com/in-en/careers/join-capgemini/job-search/" }, gapMs: 800, timeoutMs: 25000 });
      if (!r.ok || !Array.isArray(r.data?.data)) { if (page === 1) throw new Error(`capgemini: HTTP ${r.status}`); diag.push(`page ${page} HTTP ${r.status}`); break; }
      count = Number(r.data.count ?? r.data.total ?? count); const list: any[] = r.data.data;
      for (const x of list) {
        const apply = String(x.apply_job_url ?? "").split("?")[0]; const sfid = apply.match(/\/(\d{6,})\/?$/)?.[1];
        const desc = typeof x.description_stripped === "string" && x.description_stripped.length > 200 ? x.description_stripped : undefined;
        jobs.push({ id: String(sfid ?? x.id), title: String(x.title ?? ""), location: String(x.location ?? ""), url: apply || `https://www.capgemini.com/in-en/careers/join-capgemini/job-search/`, posted_at: null, updated_at: iso(x.updated_at), posted_text: null, description: desc, raw: { level: x.experience_level ?? null, contract: x.contract_type ?? null } });
      }
      if (list.length < 100 || jobs.length >= count) break;
    }
    diag.push(`location=Bangalore: count ${count}, read ${jobs.length}`);
    return { system: "capgemini", ref: "capgemini", board_url: "https://www.capgemini.com/in-en/careers/join-capgemini/job-search/?location=Bangalore", company_name: "Capgemini", jobs, debug: diag.join("; ") };
  },
};


/** iCIMS Attract career sites (careers.amd.com and others): GET /api/jobs?location=…&page=N, 10 a page, JSON. ref: the host. */
export const icimsAttract: System = {
  id: "icims-attract",
  detect: (u) => { const m = u.match(/^https?:\/\/([a-z0-9.-]+)\/api\/jobs\b/i); return m ? m[1].toLowerCase() : null; },
  async read(host) {
    const jobs: FeedJob[] = []; const seen = new Set<string>(); const diag: string[] = [];
    for (const loc of ["Bengaluru", "Bangalore"]) {
      let total = 0, got = 0;
      for (let page = 1; page <= 60; page++) {
        const r = await getJson<any>(`https://${host}/api/jobs?location=${encodeURIComponent(loc)}&page=${page}&sortBy=relevance&descending=false&internal=false`, { headers: { ...H, "accept-language": "en-US,en;q=0.9", referer: `https://${host}/` }, gapMs: 700, timeoutMs: 20000 });   // en-IN as the language returns an empty board: the site has no en-in postings
        if (r.status === 404) return null;
        if (!r.ok || !Array.isArray(r.data?.jobs)) { if (page === 1 && loc === "Bengaluru") return null; diag.push(`${loc}@${page} HTTP ${r.status}`); break; }
        total = Number(r.data.totalCount ?? total); const list: any[] = r.data.jobs; got += list.length;
        for (const j of list) { const d = j.data ?? j; const id = String(d.slug ?? d.req_id ?? d.id ?? ""); if (!id || seen.has(id)) continue; seen.add(id); jobs.push({ id, title: String(d.title ?? ""), location: [d.city, d.state, d.country].filter(Boolean).join(", ") || String(d.full_location ?? d.location_name ?? ""), url: d.apply_url ?? d.meta_data?.canonical_url ?? `https://${host}/jobs/${d.slug ?? id}`, posted_at: iso(d.posted_date ?? d.create_date), updated_at: iso(d.update_date), posted_text: null, description: typeof d.description === "string" && d.description.length > 200 ? d.description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : undefined }); }
        if (!list.length || got >= total) break;
      }
      diag.push(`${loc}: total ${total}`);
    }
    return { system: "icims-attract", ref: host, board_url: `https://${host}/jobs?location=Bengaluru`, company_name: null, jobs, debug: diag.join("; ") };
  },
};

SMALL.push(ripplehire, capgemini, icimsAttract);
