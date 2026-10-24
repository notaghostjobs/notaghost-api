// SAP SuccessFactors "Career Site Builder" sites: jobs.sap.com, jobs.siemens.com, jobs.ericsson.com, careers.ltimindtree.com, ...
// Public HTML search with a location box and 25 rows per page: /search/?q=&locationsearch=Bengaluru&startrow=N
// Each row carries title, link, location and date. Bengaluru-direct by construction.
import { getText } from "../http.js";
import type { Feed, FeedJob, System } from "./types.js";

const ROW = /<tr[^>]*class="[^"]*data-row[^"]*"[\s\S]*?<\/tr>/gi;
const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

function parseRows(html: string, origin: string): FeedJob[] {
  const jobs: FeedJob[] = [];
  for (const m of html.matchAll(ROW)) {
    const row = m[0];
    const a = row.match(/<a[^>]+class="[^"]*jobTitle-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const href = a[1].startsWith("http") ? a[1] : origin + a[1];
    const id = href.match(/\/(\d+)\/?(?:[?#]|$)/)?.[1] ?? href;
    const loc = row.match(/<span[^>]+class="[^"]*jobLocation[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "";
    const date = row.match(/<span[^>]+class="[^"]*jobDate[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "";
    const d = strip(date); const parsed = d ? new Date(d) : null;
    jobs.push({ id, title: strip(a[2]), location: strip(loc), url: href, posted_at: parsed && !isNaN(parsed.getTime()) ? parsed.toISOString() : null, updated_at: null, posted_text: d || null });
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
    for (const loc of ["Bengaluru", "Bangalore"]) {
      let got = 0;
      for (let start = 0; start < 2500; start += 25) {
        const r = await getText(`${origin}/search/?q=&locationsearch=${encodeURIComponent(loc)}&startrow=${start}`, { timeoutMs: 20000, gapMs: 700 });
        if (r.status === 404) { if (start === 0 && loc === "Bengaluru") return null; break; }
        if (!r.ok) { diag.push(`${loc}@${start} HTTP ${r.status}`); break; }
        if (start === 0 && loc === "Bengaluru" && !/jobTitle-link/i.test(r.text)) return null; // not a SuccessFactors site
        const rows = parseRows(r.text, origin);
        for (const j of rows) if (!seen.has(j.id)) { seen.add(j.id); jobs.push(j); }
        got += rows.length;
        if (rows.length < 25) break;
      }
      diag.push(`${loc}: read ${got}`);
    }
    return { system: "successfactors", ref: origin, board_url: `${origin}/search/?q=&locationsearch=Bengaluru`, company_name: null, jobs, debug: diag.join("; ") };
  },
};
