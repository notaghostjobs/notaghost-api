// Probe: given any careers URL, record exactly what each reader sees — status codes, first lines, location samples.
// For diagnosing a row in the Tier-1 table without another deploy.
import { http, getText } from "./http.js";
import { detect, byId } from "./systems/index.js";
import { atsLinksIn, jsonLdJobs } from "./systems/page.js";
import { detectBigFromHtml } from "./systems/big.js";

const snip = (t: string, n = 300) => t.replace(/\s+/g, " ").slice(0, n);

export async function probeUrl(url: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { url, at: new Date().toISOString() };
  const u = new URL(url); const host = u.host;
  // 1. what the URL itself says
  const d = detect(url); out.detect = d;
  if (d) { try { const f = await byId(d.system)!.read(d.ref); out.read = f ? { jobs: f.jobs.length, debug: f.debug ?? null, sample: f.jobs.slice(0, 3).map((j) => `${j.title} — ${j.location}`) } : "null (does not exist)"; } catch (e) { out.read = `error: ${(e as Error).message}`; } }
  // 2. the plain page
  const page = await getText(url);
  out.page = { status: page.status, bytes: page.text.length, title: page.text.match(/<title[^>]*>([^<]*)</i)?.[1]?.trim() ?? null, ats_links: atsLinksIn(page.text).slice(0, 8), jsonld_jobs: jsonLdJobs(page.text, url).length, big: detectBigFromHtml(page.text, url),
    hints: ["phenom", "eightfold", "workday", "successfactors", "taleo", "icims", "oraclecloud", "greenhouse", "lever.co", "smartrecruiters", "__NEXT_DATA__", "widgets", "api/apply", "searchJobs", "jobsearch"].filter((h) => page.text.toLowerCase().includes(h.toLowerCase())) };
  // 3. raw answers from the two "probe" systems, so a wrong body or a block is visible
  try {
    const r = await http(`https://${host}/widgets`, { method: "POST", body: { lang: "en_us", deviceType: "desktop", country: "in", pageName: "search-results", ddoKey: "refineSearch", sortBy: "", subsearch: "", from: 0, jobs: true, counts: true, all_fields: ["category", "country", "state", "city"], size: 10, clearAll: false, jdsource: "facets", isSliderEnable: false, pageId: "page1", siteType: "external", keywords: "", global: true, selected_fields: { city: ["Bengaluru"] }, locationData: {} }, headers: { origin: `https://${host}`, referer: `https://${host}/`, accept: "application/json" }, retries: 0 });
    out.phenom = { status: r.status, body: snip(await r.text()) };
  } catch (e) { out.phenom = `error: ${(e as Error).message}`; }
  try {
    const domain = host.replace(/^(www|careers|jobs)\./, "");
    const r = await http(`https://${host}/api/apply/v2/jobs?domain=${domain}&location=Bengaluru&start=0&num=5`, { retries: 0 });
    out.eightfold = { status: r.status, body: snip(await r.text()) };
  } catch (e) { out.eightfold = `error: ${(e as Error).message}`; }
  // 3b. sibling hosts: the real job site is often careers./jobs. of the root domain
  const root = host.replace(/^(www|careers|jobs|career)\./, "");
  const sib: Record<string, unknown> = {};
  for (const h of [...new Set([`careers.${root}`, `jobs.${root}`, `career.${root}`])].filter((h) => h !== host)) {
    try {
      const r = await http(`https://${h}/widgets`, { method: "POST", body: { lang: "en_us", deviceType: "desktop", country: "in", pageName: "search-results", ddoKey: "refineSearch", sortBy: "", subsearch: "", from: 0, jobs: true, counts: true, all_fields: ["category", "country", "state", "city"], size: 10, clearAll: false, jdsource: "facets", isSliderEnable: false, pageId: "page1", siteType: "external", keywords: "", global: true, selected_fields: { city: ["Bengaluru"] }, locationData: {} }, headers: { origin: `https://${h}`, referer: `https://${h}/`, accept: "application/json" }, retries: 0, timeoutMs: 10000 });
      const t = await r.text(); sib[`${h} phenom`] = `${r.status} ${snip(t, 100)}`;
    } catch (e) { sib[`${h} phenom`] = `error: ${(e as Error).message.slice(0, 60)}`; }
    try { const r = await http(`https://${h}/search/?q=&locationsearch=Bengaluru`, { retries: 0, timeoutMs: 10000 }); const t = await r.text(); sib[`${h} sf`] = `${r.status} jobTitle-link=${/jobTitle-link/i.test(t)} ${snip(t.match(/<title[^>]*>([^<]*)</i)?.[1] ?? "", 60)}`; } catch (e) { sib[`${h} sf`] = `error: ${(e as Error).message.slice(0, 60)}`; }
  }
  out.siblings = sib;
  // 4. any JSON-looking XHR endpoints the page mentions
  const apis = [...new Set([...page.text.matchAll(/["'](\/[a-z0-9_\-/.]*(?:api|search|jobs|positions|requisition)[a-z0-9_\-/.]*)["']/gi)].map((m) => m[1]))].slice(0, 12);
  out.api_paths_in_page = apis;
  const pg = out.page as any;
  out.summary = `page ${pg.status} "${pg.title ?? ""}" hints=[${(pg.hints ?? []).join(",")}] big=${pg.big ? (pg.big as any).system : "-"} detect=${d ? d.system : "-"} read=${typeof out.read === "object" && out.read ? (out.read as any).jobs : out.read ?? "-"} | phenom ${typeof out.phenom === "object" ? (out.phenom as any).status : out.phenom} | eightfold ${typeof out.eightfold === "object" ? (out.eightfold as any).status : out.eightfold} | apis=${apis.length} | ${Object.entries(sib).map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`).join(" ; ")}`;
  return { summary: out.summary, ...out };
}
