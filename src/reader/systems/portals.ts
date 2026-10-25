// Big employers whose own portals expose a JSON search. Each endpoint below was captured from the live page, 25 Oct 2026.
import { getJson } from "../http.js";
import { mode, progress, type FeedJob, type System } from "./types.js";

const ts = (v: unknown) => { const n = Number(v); return n > 1e9 ? new Date((n > 1e12 ? n : n * 1000)).toISOString() : null; };

/** IBM — www-api.ibm.com/search/api/v2 (Elasticsearch behind the careers search). field_keyword_19 is the location, "Bangalore, IN". */
export const ibm: System = {
  id: "ibm",
  detect: (u) => (/ibm\.com\/(?:[a-z-]+\/)?careers/i.test(u) ? "ibm" : null),
  async read() {
    const url = "https://www-api.ibm.com/search/api/v2"; const diag: string[] = [];
    const jobs: FeedJob[] = []; const seen = new Set<string>(); const size = 50; let total = 0;
    for (let from = 0; from < (mode.quick ? size * 2 : 3000); from += size) {
      progress(`ibm from ${from}${total ? `/${total}` : ""}`);
      const body = { appId: "careers", scopes: ["careers2"], size, from, _source: ["url", "title", "description", "field_keyword_19", "field_keyword_18", "field_keyword_08", "dcdate"], query: { bool: { filter: [{ term: { field_keyword_19: "Bangalore, IN" } }] } }, sort: [{ dcdate: "desc" }] };
      const r = await getJson<any>(url, { method: "POST", body, gapMs: 600, timeoutMs: 20000, headers: { accept: "application/json", origin: "https://www.ibm.com", referer: "https://www.ibm.com/careers/search" } });
      if (!r.ok || !r.data?.hits) { diag.push(`@${from} HTTP ${r.status}`); break; }
      total = Number(r.data.hits.total?.value ?? r.data.hits.total ?? 0);
      const hits: any[] = r.data.hits.hits ?? []; if (!hits.length) break;
      for (const h of hits) {
        const s = h._source ?? {}; const id = String(s.url ?? "").match(/jobId=(\d+)/)?.[1] ?? String(h._id);
        if (seen.has(id)) continue; seen.add(id);
        const d = s.dcdate ? new Date(s.dcdate) : null;
        jobs.push({ id, title: String(s.title ?? ""), location: String(s.field_keyword_19 ?? "Bangalore, IN"), url: String(s.url ?? `https://careers.ibm.com/careers/JobDetail?jobId=${id}`), posted_at: d && !isNaN(d.getTime()) ? d.toISOString() : null, updated_at: null, posted_text: s.dcdate ?? null });
      }
      if (from + size >= total) break;
    }
    diag.push(`Bangalore, IN: total ${total}, read ${jobs.length}${mode.quick ? " (quick)" : ""}`);
    return { system: "ibm", ref: "ibm", board_url: "https://www.ibm.com/careers/search?q=Bangalore", company_name: "IBM", jobs, debug: diag.join("; ") };
  },
};

/** Microsoft — the careers site now runs on apply.careers.microsoft.com (Eightfold "pcsx"); 10 a page, location filter honoured. */
export const microsoft: System = {
  id: "microsoft",
  detect: (u) => (/careers\.microsoft\.com/i.test(u) ? "microsoft" : null),
  async read() {
    const diag: string[] = []; const jobs: FeedJob[] = []; const seen = new Set<string>(); let count = 0;
    for (let start = 0; start < (mode.quick ? 20 : 2000); start += 10) {
      progress(`microsoft from ${start}${count ? `/${count}` : ""}`);
      const r = await getJson<any>(`https://apply.careers.microsoft.com/api/pcsx/search?domain=microsoft.com&query=&location=Bengaluru&start=${start}&num=10&sort_by=timestamp`, { gapMs: 600, timeoutMs: 20000, headers: { accept: "application/json", referer: "https://apply.careers.microsoft.com/careers" } });
      if (!r.ok || !r.data?.data) { diag.push(`@${start} HTTP ${r.status}`); break; }
      count = Number(r.data.data.count ?? 0);
      const list: any[] = r.data.data.positions ?? []; if (!list.length) break;
      for (const p of list) {
        const id = String(p.id ?? p.displayJobId ?? ""); if (!id || seen.has(id)) continue; seen.add(id);
        const loc = Array.isArray(p.standardizedLocations) ? p.standardizedLocations.join(" · ") : String(p.standardizedLocations ?? p.locations ?? "");
        jobs.push({ id, title: String(p.name ?? ""), location: loc, url: `https://apply.careers.microsoft.com/careers/job/${id}`, posted_at: ts(p.postedTs), updated_at: null, posted_text: null });
      }
      if (start + 10 >= count) break;
    }
    diag.push(`location=Bengaluru: count ${count}, read ${jobs.length}${mode.quick ? " (quick)" : ""}`);
    return { system: "microsoft", ref: "microsoft", board_url: "https://apply.careers.microsoft.com/careers?location=Bengaluru", company_name: "Microsoft", jobs, debug: diag.join("; ") };
  },
};

export const PORTALS: System[] = [ibm, microsoft];
