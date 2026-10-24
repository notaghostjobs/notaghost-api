// The hiring systems with public JSON feeds. Each reader is exact: it returns what the system says, or null if the ref does not exist.
import { getJson } from "../http.js";
import type { Feed, FeedJob, System } from "./types.js";

const iso = (v: unknown): string | null => {
  if (!v) return null;
  const d = typeof v === "number" ? new Date(v) : new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
};

export const greenhouse: System = {
  id: "greenhouse",
  detect: (u) => u.match(/greenhouse\.io\/(?:embed\/job_app\?for=|v1\/boards\/)?([a-z0-9_-]+)/i)?.[1]?.toLowerCase() ?? null,
  async read(slug) {
    const board = await getJson<{ name: string }>(`https://boards-api.greenhouse.io/v1/boards/${slug}`);
    if (board.status === 404) return null;
    const r = await getJson<{ jobs: any[] }>(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=false`);
    if (r.status === 404) return null;
    if (!r.ok || !r.data) throw new Error(`greenhouse ${slug}: HTTP ${r.status}`);
    const jobs: FeedJob[] = (r.data.jobs ?? []).map((x) => ({ id: String(x.id), title: x.title ?? "", location: x.location?.name ?? "", url: x.absolute_url, posted_at: iso(x.first_published), updated_at: iso(x.updated_at), posted_text: null }));
    return { system: "greenhouse", ref: slug, board_url: `https://boards.greenhouse.io/${slug}`, company_name: board.data?.name ?? null, jobs };
  },
};

export const lever: System = {
  id: "lever",
  detect: (u) => u.match(/lever\.co\/(?:v0\/postings\/)?([a-z0-9-]+)/i)?.[1]?.toLowerCase() ?? null,
  async read(site) {
    const r = await getJson<any>(`https://api.lever.co/v0/postings/${site}?mode=json`);
    if (r.status === 404) return null;
    if (!r.ok || !Array.isArray(r.data)) throw new Error(`lever ${site}: HTTP ${r.status}`);
    const jobs: FeedJob[] = r.data.map((x: any) => ({ id: String(x.id), title: x.text ?? "", location: [x.categories?.location, x.workplaceType === "remote" ? "Remote" : null].filter(Boolean).join(" · "), url: x.hostedUrl, posted_at: iso(x.createdAt), updated_at: iso(x.updatedAt), posted_text: null }));
    return { system: "lever", ref: site, board_url: `https://jobs.lever.co/${site}`, company_name: null, jobs };
  },
};

export const ashby: System = {
  id: "ashby",
  detect: (u) => u.match(/ashbyhq\.com\/(?:posting-api\/job-board\/)?([a-z0-9._-]+)/i)?.[1] ?? null,
  async read(name) {
    const r = await getJson<{ jobs: any[] }>(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(name)}?includeCompensation=false`);
    if (r.status === 404) return null;
    if (!r.ok || !r.data?.jobs) throw new Error(`ashby ${name}: HTTP ${r.status}`);
    const jobs: FeedJob[] = r.data.jobs.filter((x) => x.isListed !== false).map((x) => ({ id: String(x.id), title: x.title ?? "", location: [x.location, ...(x.secondaryLocations ?? []).map((s: any) => s.location), x.isRemote ? "Remote" : null].filter(Boolean).join(" · "), url: x.jobUrl, posted_at: iso(x.publishedAt), updated_at: null, posted_text: null }));
    return { system: "ashby", ref: name, board_url: `https://jobs.ashbyhq.com/${name}`, company_name: null, jobs };
  },
};

export const smartrecruiters: System = {
  id: "smartrecruiters",
  detect: (u) => u.match(/smartrecruiters\.com\/(?:v1\/companies\/)?([A-Za-z0-9-]+)/i)?.[1] ?? null,
  async read(ident) {
    const jobs: FeedJob[] = []; let name: string | null = null; let realIdent = ident;
    for (let offset = 0; offset < 5000; offset += 100) {
      const r = await getJson<any>(`https://api.smartrecruiters.com/v1/companies/${ident}/postings?limit=100&offset=${offset}`);
      if (r.status === 404) return null;
      if (!r.ok || !r.data) throw new Error(`smartrecruiters ${ident}: HTTP ${r.status}`);
      const page: any[] = r.data.content ?? [];
      for (const x of page) {
        name ??= x.company?.name ?? null; realIdent = x.company?.identifier ?? realIdent;
        jobs.push({ id: String(x.id), title: x.name ?? "", location: [x.location?.city, x.location?.region, x.location?.country, x.location?.remote ? "Remote" : null].filter(Boolean).join(", "), url: `https://jobs.smartrecruiters.com/${x.company?.identifier ?? ident}/${x.id}`, posted_at: iso(x.releasedDate), updated_at: null, posted_text: null });
      }
      if (page.length < 100 || offset + 100 >= (r.data.totalFound ?? 0)) break;
    }
    // the API answers for the company it THINKS we meant; a different identifier means a wrong slug
    if (realIdent.toLowerCase() !== ident.toLowerCase()) return null;
    return { system: "smartrecruiters", ref: ident, board_url: `https://careers.smartrecruiters.com/${ident}`, company_name: name, jobs };
  },
};

/** Workday: ref is "tenant/wdN/site", always taken from a real URL — tenant names are not guessable.
 *  Bengaluru-direct: the first call asks Workday for "Bengaluru" and reads its location facets; if a Bengaluru/India facet exists we
 *  query by that facet (exact), else we fall back to the text search. We never crawl the global board. */
const WD_BLR = /bengaluru|bangalore|karnataka/i;
export const workday: System = {
  id: "workday",
  detect: (u) => { const m = u.match(/https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[a-z]{2}\/)?([^/?#]+)/i); return m ? `${m[1]}/${m[2]}/${m[3]}` : null; },
  async read(ref) {
    const [tenant, wd, site] = ref.split("/");
    const base = `https://${tenant}.${wd}.myworkdayjobs.com`;
    const api = `${base}/wday/cxs/${tenant}/${site}/jobs`;
    const diag: string[] = [];
    const post = (body: unknown) => getJson<any>(api, { method: "POST", body, gapMs: 500, headers: { accept: "application/json", referer: `${base}/${site}` } });

    // 1. probe with the text search; learn the location facets
    const probe = await post({ appliedFacets: {}, limit: 20, offset: 0, searchText: "Bengaluru" });
    if (probe.status === 404) return null;
    if (!probe.ok || !probe.data) { diag.push(`probe HTTP ${probe.status}`); throw new Error(`workday ${ref}: HTTP ${probe.status}`); }
    const facets: any[] = probe.data.facets ?? [];
    let facetParam: string | null = null; const facetIds: string[] = [];
    for (const f of facets) for (const v of (f.values ?? [])) {
      const d = String(v.descriptor ?? ""); if (WD_BLR.test(d) && v.id) { facetParam ??= f.facetParameter; if (f.facetParameter === facetParam) facetIds.push(String(v.id)); }
    }
    diag.push(`text-search total ${probe.data.total ?? "?"}`, facetParam ? `facet ${facetParam}: ${facetIds.length} Bengaluru values` : "no Bengaluru facet");

    // 2. page through the exact facet query, or the text search if there is no facet
    const body = (offset: number) => facetParam ? { appliedFacets: { [facetParam]: facetIds }, limit: 20, offset, searchText: "" } : { appliedFacets: {}, limit: 20, offset, searchText: "Bengaluru" };
    const jobs: FeedJob[] = []; const seen = new Set<string>(); let total = 0;
    for (let offset = 0; offset < 4000; offset += 20) {
      const r = offset === 0 && !facetParam ? probe : await post(body(offset));
      if (!r.ok || !r.data) { diag.push(`page@${offset} HTTP ${r.status}`); break; }
      total = r.data.total ?? total;
      const page: any[] = r.data.jobPostings ?? [];
      for (const x of page) {
        const id = String(x.bulletFields?.[0] ?? x.externalPath); if (seen.has(id)) continue; seen.add(id);
        const loc = String(x.locationsText ?? "");
        // under a Bengaluru-scoped query, "N Locations" means Bengaluru is one of them
        jobs.push({ id, title: x.title ?? "", location: /^\d+ locations?$/i.test(loc) ? `${loc} (incl. Bengaluru)` : loc, url: `${base}/${site}${x.externalPath}`, posted_at: null, updated_at: null, posted_text: x.postedOn ?? null });
      }
      if (page.length < 20 || jobs.length >= total) { diag.push(`stopped@${offset + page.length} total ${total}`); break; }
    }
    return { system: "workday", ref, board_url: `${base}/${site}`, company_name: null, jobs, debug: diag.join("; ") };
  },
};

export const ATS: System[] = [greenhouse, lever, ashby, smartrecruiters, workday];
