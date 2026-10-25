// The hiring systems with public JSON feeds. Each reader is exact: it returns what the system says, or null if the ref does not exist.
import { getJson } from "../http.js";
import { progress, type Feed, type FeedJob, type System } from "./types.js";

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
 *  Bengaluru-direct, exact: Workday's own location facet ("Bengaluru, India" has an id; facets are nested one level under
 *  groups like locationMainGroup). Query by that id, so even tenants that hide per-job location text (Accenture) count correctly.
 *  Fallback when no facet matches: text search for both spellings. Never the global board. */
const WD_BLR = /bengaluru|bangalore|karnataka/i;
function blrFacets(facets: any[]): { param: string; ids: string[] } | null {
  const found = new Map<string, string[]>();
  const walk = (node: any, param: string | null) => {
    if (!node || typeof node !== "object") return;
    const p = typeof node.facetParameter === "string" ? node.facetParameter : param;
    if (Array.isArray(node.values)) for (const v of node.values) {
      if (v && typeof v.descriptor === "string" && v.id && WD_BLR.test(v.descriptor) && p) found.set(p, [...(found.get(p) ?? []), String(v.id)]);
      walk(v, p);
    }
  };
  for (const f of facets ?? []) walk(f, null);
  if (!found.size) return null;
  // prefer a city-level facet over country/region ones
  const pick = [...found.entries()].sort((x, y) => (/location(s)?$/i.test(y[0]) ? 1 : 0) - (/location(s)?$/i.test(x[0]) ? 1 : 0))[0];
  return { param: pick[0], ids: [...new Set(pick[1])] };
}
export const workday: System = {
  id: "workday",
  detect: (u) => { const m = u.match(/https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[a-z]{2}\/)?([^/?#]+)/i); return m ? `${m[1]}/${m[2]}/${m[3]}` : null; },
  async read(ref) {
    const [tenant, wd, site] = ref.split("/");
    const base = `https://${tenant}.${wd}.myworkdayjobs.com`;
    const api = `${base}/wday/cxs/${tenant}/${site}/jobs`;
    const diag: string[] = [];
    const post = (body: unknown) => getJson<any>(api, { method: "POST", body, gapMs: 500, headers: { accept: "application/json", referer: `${base}/${site}` } });
    const jobs: FeedJob[] = []; const seen = new Set<string>();
    const take = (page: any[], viaFacet: boolean) => {
      for (const x of page) {
        const id = String(x.bulletFields?.[0] ?? x.externalPath); if (seen.has(id)) continue; seen.add(id);
        const loc = String(x.locationsText ?? "").trim();
        const location = viaFacet && (!loc || /^\d+ locations?$/i.test(loc)) ? `${loc || "Bengaluru"} (Bengaluru facet)` : (/^\d+ locations?$/i.test(loc) ? `${loc} (incl. Bengaluru)` : loc);
        jobs.push({ id, title: x.title ?? "", location, url: `${base}/${site}${x.externalPath}`, posted_at: null, updated_at: null, posted_text: x.postedOn ?? null });
      }
    };
    // 1. probe: learn the facets (an empty search returns the full facet tree)
    let probe = await post({ appliedFacets: {}, limit: 20, offset: 0, searchText: "" });
    if (probe.status === 404) return null;
    // some tenants (Walmart, Wipro) answer 422 to an empty search; a worded search still returns the facet tree
    if (probe.status === 422 || probe.status === 400) { diag.push(`empty search HTTP ${probe.status}, probing with a word`); probe = await post({ appliedFacets: {}, limit: 20, offset: 0, searchText: "Bengaluru" }); }
    if (!probe.ok || !probe.data) throw new Error(`workday ${ref}: HTTP ${probe.status}`);
    const fac = blrFacets(probe.data.facets ?? []);
    diag.push(`board total ${probe.data.total ?? "?"}`, fac ? `facet ${fac.param} → ${fac.ids.length} Bengaluru value(s)` : "no Bengaluru facet");
    // 2. exact: by facet. Workday caps any query at 2000; past that, slice by every other facet's values and union.
    if (fac) {
      const page = async (applied: Record<string, string[]>) => {
        let maxTotal = 0, got = 0;
        for (let offset = 0; offset < 2000; offset += 20) {
          if (offset % 200 === 0) progress(`workday ${ref} offset ${offset}${maxTotal ? `/${maxTotal}` : ""}, ${jobs.length} read`);
          const r = await post({ appliedFacets: applied, limit: 20, offset, searchText: "" });
          if (!r.ok || !r.data) { diag.push(`@${offset} HTTP ${r.status}`); break; }
          const t = Number(r.data.total ?? 0); if (t > maxTotal) maxTotal = t;
          const pg: any[] = r.data.jobPostings ?? []; got += pg.length; take(pg, true);
          if (pg.length < 20) break;
          if (maxTotal > 0 && offset + 20 >= maxTotal) break;
        }
        return maxTotal;
      };
      const total = await page({ [fac.param]: fac.ids });
      diag.push(`facet total ${total}, read ${jobs.length}`);
      if (total >= 2000) {
        // slice: every other facet parameter, value by value, still within the Bengaluru facet
        const others: { param: string; ids: string[] }[] = [];
        const walk = (node: any, param: string | null) => { if (!node || typeof node !== "object") return; const p = typeof node.facetParameter === "string" ? node.facetParameter : param; if (Array.isArray(node.values) && p && p !== fac.param) { const ids = node.values.map((v: any) => v?.id).filter(Boolean).map(String); if (ids.length > 1 && ids.length < 80) others.push({ param: p, ids }); } if (Array.isArray(node.values)) for (const v of node.values) walk(v, p); };
        for (const f of probe.data.facets ?? []) walk(f, null);
        const sliceBy = others.sort((a, b) => b.ids.length - a.ids.length)[0];
        if (sliceBy) { let n = 0; for (const id of sliceBy.ids) { await page({ [fac.param]: fac.ids, [sliceBy.param]: [id] }); n++; } diag.push(`sliced by ${sliceBy.param} (${n} values) → ${jobs.length}`); }
        else diag.push("capped at 2000, no facet to slice by");
      }
    }
    if (!fac || jobs.length === 0) {
      // 3. fallback: text search, both spellings (also when the facet query was refused)
      for (const term of ["Bengaluru", "Bangalore"]) {
        let maxTotal = 0, got = 0;
        for (let offset = 0; offset < 4000; offset += 20) {
          const r = await post({ appliedFacets: {}, limit: 20, offset, searchText: term });
          if (!r.ok || !r.data) { diag.push(`${term}@${offset} HTTP ${r.status}`); break; }
          const t = Number(r.data.total ?? 0); if (t > maxTotal) maxTotal = t;
          const page: any[] = r.data.jobPostings ?? []; got += page.length; take(page, false);
          if (page.length < 20) break;
          if (maxTotal > 0 && offset + 20 >= maxTotal) break;
        }
        diag.push(`${term}: total ${maxTotal}, read ${got}`);
      }
    }
    diag.push(`locations e.g. ${[...new Set(jobs.map((j) => j.location))].slice(0, 5).join(" | ")}`);
    return { system: "workday", ref, board_url: `${base}/${site}`, company_name: null, jobs, debug: diag.join("; ") };
  },
};

export const ATS: System[] = [greenhouse, lever, ashby, smartrecruiters, workday];
