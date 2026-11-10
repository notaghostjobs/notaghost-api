// Enrich: open each live Bengaluru job once. Description, a real posting date when the list did not give one,
// salary/experience when the page states them, and a fingerprint for the repost signal.
import { db } from "../lib/db.js";
import { getText, getJson, ROBOTS_STATUS } from "./http.js";
import { htmlToText } from "../engine/extract.js";
import { fingerprint } from "../engine/ghost/canon.js";
import { renderText } from "./systems/page.js";

/** Hosts whose job pages only speak to a browser; a plain fetch is empty. Rendered one at a time, a few per batch. */
const RENDER_HOSTS = /^(careers\.ibm\.com|apply\.deloitte\.com|usijobs\.deloitte\.com)$/i;
let rendersThisBatch = 0;
export const RENDERS_PER_BATCH = 25;
export const resetRenderBudget = () => { rendersThisBatch = 0; };

const iso = (v: unknown): string | null => { if (!v) return null; const d = new Date(String(v)); return isNaN(d.getTime()) ? null : d.toISOString(); };

/** JSON-LD JobPosting on the page, when present — the most reliable source of date and salary. */
function jsonLd(html: string): { datePosted?: string; salary?: string; description?: string; validThrough?: string } | null {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1].trim());
      for (const x of [j, ...(j?.["@graph"] ?? []), ...(Array.isArray(j) ? j : [])].flat(2)) if (x?.["@type"] === "JobPosting") {
        const bs = x.baseSalary?.value; const salary = bs ? [bs.minValue ?? bs.value, bs.maxValue].filter(Boolean).join("–") + (bs.unitText ? ` per ${bs.unitText.toLowerCase()}` : "") + (x.baseSalary?.currency ? ` ${x.baseSalary.currency}` : "") : undefined;
        return { datePosted: x.datePosted, validThrough: x.validThrough, salary, description: typeof x.description === "string" ? htmlToText(x.description) : undefined };
      }
    } catch { /* next */ }
  }
  return null;
}

/** Salary / experience phrases in plain text, when the page states them. */
function pick(text: string) {
  const salary = text.match(/(?:₹|INR|Rs\.?)\s?[\d,.]+\s?(?:L|LPA|lakh|lakhs|Lac|k|K|CR|crore)?(?:\s?(?:-|–|to)\s?(?:₹|INR|Rs\.?)?\s?[\d,.]+\s?(?:L|LPA|lakh|lakhs|Lac|k|K)?)?(?:\s?(?:per|\/)\s?(?:annum|year|month|yr|p\.?a\.?))?/i)?.[0] ?? null;
  const exp = text.match(/\b(\d{1,2})\s?(?:\+|-|–|to)\s?(\d{1,2})?\s?(?:\+)?\s?years?\b/i)?.[0] ?? null;
  return { salary, exp };
}

/** Workday job pages are empty shells; the same JSON endpoint the page itself calls returns the posting in full. */
async function workdayDetail(url: string): Promise<{ ok: true; text: string; posted?: string | null } | { ok: false; status: number } | null> {
  const m = url.match(/^https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[a-z]{2}\/)?([^/?#]+)(\/job\/[^?#]+)/i);
  if (!m) return null;
  const [, tenant, wd, site, path] = m; const base = `https://${tenant}.${wd}.myworkdayjobs.com`;
  const r = await getJson<any>(`${base}/wday/cxs/${tenant}/${site}${path}`, { timeoutMs: 20000, gapMs: 800, headers: { accept: "application/json", referer: `${base}/${site}` } });
  if (!r.ok || !r.data) return { ok: false, status: r.status };
  const info = r.data.jobPostingInfo ?? {};
  const text = htmlToText(String(info.jobDescription ?? ""));
  return { ok: true, text, posted: info.startDate ?? null };
}

/** Oracle Recruiting Cloud job pages are script shells; the requisition-details REST call the page makes returns the posting. */
async function oracleDetail(url: string): Promise<{ ok: true; text: string; posted?: string | null } | { ok: false; status: number } | null> {
  const m = url.match(/^https?:\/\/([a-z0-9.-]+\.oraclecloud\.com)\/hcmUI\/CandidateExperience\/[a-z-]+\/sites\/(CX_\d+)\/job\/(\d+)/i);
  if (!m) return null;
  const [, host, site, id] = m;
  const r = await getJson<any>(`https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${id}%22,siteNumber=${site}`, { timeoutMs: 20000, gapMs: 700, headers: { accept: "application/json", "ora-irc-language": "en" } });
  if (!r.ok || !r.data) return { ok: false, status: r.status };
  const it = r.data.items?.[0]; if (!it) return { ok: false, status: 404 };
  const text = [it.ExternalDescriptionStr, it.ExternalResponsibilitiesStr, it.ExternalQualificationsStr].filter(Boolean).map((h: string) => htmlToText(String(h))).join("\n\n");
  return { ok: true, text, posted: it.ExternalPostedStartDate ?? null };
}

/** Phenom job pages carry the posting in an inline `phApp.ddo` object (jobDetail.data.job). The list's applyUrl sometimes
 *  points at /job/{id}, which lands on the home page; the page that holds the job is /{site}/en/job/{id}. */
function phenomJob(html: string): { text: string; posted: string | null; url?: string } | null {
  if (!/phApp\.ddo\s*=/.test(html)) return null;
  const m = html.match(/phApp\.ddo\s*=\s*(\{[\s\S]*?\});\s*(?:phApp\.|<\/script>)/); if (!m) return null;
  try { const job = JSON.parse(m[1])?.jobDetail?.data?.job; if (!job?.description) return null; return { text: htmlToText(String(job.description)), posted: job.postedDate ?? job.dateCreated ?? null }; } catch { return null; }
}
async function phenomDetail(url: string, firstHtml: string | null): Promise<{ text: string; posted: string | null; url?: string } | null> {
  if (firstHtml) { const j = phenomJob(firstHtml); if (j) return j; if (!/phApp/.test(firstHtml)) return null; }
  const m = url.match(/^(https?:\/\/[a-z0-9.-]+)\/job\/([^/?#]+)/i); if (!m) return null;
  for (const site of ["global", "in", "en-us"]) {
    const r = await getText(`${m[1]}/${site}/en/job/${m[2]}`, { timeoutMs: 20000, gapMs: 800 });
    if (r.ok) { const j = phenomJob(r.text); if (j) return { ...j, url: `${m[1]}/${site}/en/job/${m[2]}` }; }
  }
  return null;
}

/** The page's own title: JSON-LD JobPosting first, else the first h1. */
function pageTitle(html: string): string | null {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const j = JSON.parse(m[1].trim()); for (const x of [j, ...(j?.["@graph"] ?? []), ...(Array.isArray(j) ? j : [])].flat(2)) if (x?.["@type"] === "JobPosting" && typeof x.title === "string" && x.title.trim()) return x.title.trim().slice(0, 300); } catch { /* next */ }
  }
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return h1 && h1.length >= 3 && h1.length <= 200 ? h1 : null;
}

export async function enrichOne(s: { id: number; url: string; posted_at: string | null; salary_text: string | null; raw: any }) {
  const fail = (why: string) => db.from("sightings").update({ enriched_at: new Date().toISOString(), enrich_error: why }).eq("id", s.id);
  let ld: ReturnType<typeof jsonLd> = null, text = "", betterUrl: string | null = null, realTitle: string | null = null;
  const wd = (await workdayDetail(s.url.replace(/\/apply\/?$/, ""))) ?? (await oracleDetail(s.url));
  if (wd) {
    if (!wd.ok) { await fail(wd.status === ROBOTS_STATUS ? "disallowed by robots.txt" : `HTTP ${wd.status}`); return false; }
    text = wd.text.slice(0, 20000); if (wd.posted) ld = { datePosted: wd.posted };
  } else {
    const r = await getText(s.url, { timeoutMs: 20000, gapMs: 800 });
    if (!r.ok) { await fail(r.status === ROBOTS_STATUS ? "disallowed by robots.txt" : `HTTP ${r.status}`); return false; }
    ld = jsonLd(r.text);
    text = (ld?.description && ld.description.length > 300 ? ld.description : htmlToText(r.text)).slice(0, 20000);
    if (s.raw?.title_from === "slug") { const t = pageTitle(r.text); if (t) realTitle = t; }
    if (text.length < 200 || /phApp\.ddo/.test(r.text)) { const ph = await phenomDetail(s.url, r.text); if (ph) { text = ph.text.slice(0, 20000); if (ph.posted && !ld?.datePosted) ld = { ...(ld ?? {}), datePosted: ph.posted }; if (ph.url) betterUrl = ph.url; } }
    if (text.length < 200 && RENDER_HOSTS.test(new URL(s.url).host)) {
      if (rendersThisBatch >= RENDERS_PER_BATCH) { await db.from("sightings").update({ enrich_error: "render budget for this batch used; next batch" }).eq("id", s.id); return false; }   // enriched_at stays null: tried again next batch
      rendersThisBatch++;
      try { const t = await renderText(s.url); if (t.length >= 200) text = t.slice(0, 20000); } catch (e) { await fail(`render: ${(e as Error).message.slice(0, 120)}`); return false; }
    }
  }
  if (text.length < 200) { await fail("page has no readable text (likely rendered by script)"); return false; }
  const p = pick(text);
  const upd: Record<string, unknown> = { description: text, fingerprint: fingerprint(text), enriched_at: new Date().toISOString(), enrich_error: null };
  if (betterUrl) upd.url = betterUrl;   // the page that actually holds the job, so the card's link lands on it
  if (realTitle) upd.title = realTitle;   // a sitemap row's slug title replaced by the page's own
  if (!s.posted_at && ld?.datePosted) upd.posted_at = iso(ld.datePosted);
  if (!s.salary_text && (ld?.salary || p.salary)) upd.salary_text = ld?.salary ?? p.salary;
  upd.raw = { ...(s.raw ?? {}), ...(p.exp ? { exp: s.raw?.exp ?? p.exp } : {}), ...(ld?.validThrough ? { valid_through: ld.validThrough } : {}), ...(realTitle ? { title_from: "page" } : {}) };
  const { error } = await db.from("sightings").update(upd).eq("id", s.id);
  if (error) throw new Error(error.message);
  return true;
}

/** Enrich a batch of live Bengaluru sightings that have not been opened yet. Gentle: 3 at a time, per-host spacing from http(). */
export async function enrichDue(limit = 300, concurrency = 6) {
  resetRenderBudget();
  const { data } = await db.from("sightings").select("id, url, posted_at, salary_text, raw, employer_key").eq("blr", true).is("gone_at", null).is("enriched_at", null).not("url", "is", null).order("first_seen", { ascending: false }).limit(limit);
  // spread the batch across employers: the per-host pacing in http() then runs in parallel instead of serialising one big employer
  type Row = NonNullable<typeof data>[number];
  const byHost = new Map<string, Row[]>(); for (const s of data ?? []) { const k = s.employer_key ?? "?"; if (!byHost.has(k)) byHost.set(k, []); byHost.get(k)!.push(s); }
  const q: Row[] = []; const lists = [...byHost.values()]; for (let i = 0; q.length < (data ?? []).length; i++) for (const l of lists) if (l[i]) q.push(l[i]);
  const stats = { tried: 0, ok: 0, failed: 0 };
  async function worker() {
    for (;;) {
      const s = q.shift(); if (!s) return;
      stats.tried++;
      try { (await enrichOne(s)) ? stats.ok++ : stats.failed++; }
      catch (e) { stats.failed++; await db.from("sightings").update({ enriched_at: new Date().toISOString(), enrich_error: (e as Error).message.slice(0, 200) }).eq("id", s.id); }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return stats;
}

/** The posting's text by whatever door the host offers — Workday/Oracle JSON, Phenom's inline object, JSON-LD, or the
 *  page itself — with no database and no browser. For checks and panels outside the worker. */
export async function readPostingText(url: string): Promise<string> {
  const wd = (await workdayDetail(url.replace(/\/apply\/?$/, ""))) ?? (await oracleDetail(url));
  if (wd) return wd.ok ? wd.text.slice(0, 20000) : "";
  const r = await getText(url, { timeoutMs: 20000, gapMs: 600 });
  if (!r.ok) return "";
  const ld = jsonLd(r.text);
  let text = (ld?.description && ld.description.length > 300 ? ld.description : htmlToText(r.text)).slice(0, 20000);
  if (text.length < 200 || /phApp\.ddo/.test(r.text)) { const ph = await phenomDetail(url, r.text); if (ph) text = ph.text.slice(0, 20000); }
  return text;
}
