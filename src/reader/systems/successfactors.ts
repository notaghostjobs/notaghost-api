// SAP SuccessFactors "Career Site Builder" sites: jobs.sap.com, jobs.siemens.com, jobs.ericsson.com, careers.ltimindtree.com, ...
// Public HTML search with a location box and 25 rows per page: /search/?q=&locationsearch=Bengaluru&startrow=N
// Each row carries title, link, location and date. Bengaluru-direct by construction.
import { getText } from "../http.js";
import type { Feed, FeedJob, System } from "./types.js";

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
