// Layer B: the company's own hiring system. Public ATS APIs expose the job's TRUE creation date.
import { htmlToText } from "../extract.js";
import { companyKey } from "./canon.js";
import { research } from "./research.js";

export interface AtsJob { id: string; title: string; location: string; created_at: string | null; updated_at: string | null; url: string }
export interface AtsResult { system: string; slug: string | null; careers_url: string | null; jobs: AtsJob[] }

const UA = "GhostedReader/1.0 (+https://notaghost.jobs/reader/; hello@notaghost.jobs)";
const get = (u: string) => fetch(u, { headers: { "user-agent": UA, accept: "application/json,text/html" }, signal: AbortSignal.timeout(12000) });

/** Guess slugs from the company name, probe each ATS, else find the careers page by search. */
export async function findAts(company: string, applyUrl: string | null, hintDomain?: string | null, extraSlugs: string[] = []): Promise<AtsResult> {
  // 0. the apply link itself may point into an ATS
  const fromLink = applyUrl ? await fromUrl(applyUrl) : null;
  if (fromLink) return fromLink;

  const base = companyKey(company).replace(/\s+/g, "");
  const slugs = unique([...extraSlugs, base, companyKey(company).replace(/\s+/g, "-"), companyKey(company).split(" ")[0]]).filter((s) => s && s.length >= 3);

  // 1. probe public ATS APIs in parallel (cheap, no auth)
  const probes = slugs.flatMap((s) => [greenhouse(s), lever(s), ashby(s), smartrecruiters(s), workday(s, "External"), workday(s, "Careers"), workday(s, `${s}careers`)]);
  const hits = ((await Promise.allSettled(probes)).filter((p): p is PromiseFulfilledResult<AtsResult | null> => p.status === "fulfilled").map((p) => p.value).filter(Boolean) as AtsResult[]).filter((h) => h.jobs.length > 0);
  if (hits.length) return hits.sort((a, b) => b.jobs.length - a.jobs.length)[0];

  // 2. search for the careers page, then read it (JSON-LD list, or an ATS link on it)
  const found = await research.careersPage(company, hintDomain ?? null);
  if (found?.url) {
    const viaLink = await fromUrl(found.url);
    if (viaLink) return viaLink;
    const jobs = await careersPage(found.url);
    return { system: jobs.length ? "careers" : "none", slug: null, careers_url: found.url, jobs };
  }
  return { system: "unknown", slug: null, careers_url: null, jobs: [] };
}

async function fromUrl(u: string): Promise<AtsResult | null> {
  let m: RegExpMatchArray | null;
  if ((m = u.match(/greenhouse\.io\/(?:embed\/job_app\?for=)?([a-z0-9-]+)/i))) return greenhouse(m[1]);
  if ((m = u.match(/lever\.co\/([a-z0-9-]+)/i))) return lever(m[1]);
  if ((m = u.match(/ashbyhq\.com\/([a-z0-9-]+)/i))) return ashby(m[1]);
  if ((m = u.match(/smartrecruiters\.com\/([A-Za-z0-9-]+)/i))) return smartrecruiters(m[1]);
  if ((m = u.match(/https?:\/\/([a-z0-9-]+)\.(?:wd\d+\.)?myworkdayjobs\.com\/([^/?#]+)/i))) return workday(m[1], m[2]);
  if ((m = u.match(/https?:\/\/([a-z0-9-]+)\.darwinbox\.in/i))) { const jobs = await careersPage(`https://${m[1]}.darwinbox.in/ms/candidate/careers`); return { system: "darwinbox", slug: m[1], careers_url: `https://${m[1]}.darwinbox.in/ms/candidate/careers`, jobs }; }
  if ((m = u.match(/https?:\/\/([a-z0-9-]+)\.keka\.com/i))) { const jobs = await careersPage(`https://${m[1]}.keka.com/careers`); return { system: "keka", slug: m[1], careers_url: `https://${m[1]}.keka.com/careers`, jobs }; }
  return null;
}

async function greenhouse(slug: string): Promise<AtsResult | null> {
  try {
    const r = await get(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    if (!r.ok) return null;
    const j: any = await r.json();
    const jobs: AtsJob[] = (j.jobs ?? []).map((x: any) => ({ id: String(x.id), title: x.title, location: x.location?.name ?? "", created_at: x.first_published ?? null, updated_at: x.updated_at ?? null, url: x.absolute_url }));
    return { system: "greenhouse", slug, careers_url: `https://boards.greenhouse.io/${slug}`, jobs };
  } catch { return null; }
}
async function lever(slug: string): Promise<AtsResult | null> {
  try {
    const r = await get(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    if (!r.ok) return null;
    const j: any = await r.json(); if (!Array.isArray(j)) return null;
    const jobs: AtsJob[] = j.map((x: any) => ({ id: x.id, title: x.text, location: x.categories?.location ?? "", created_at: x.createdAt ? new Date(x.createdAt).toISOString() : null, updated_at: x.updatedAt ? new Date(x.updatedAt).toISOString() : null, url: x.hostedUrl }));
    return { system: "lever", slug, careers_url: `https://jobs.lever.co/${slug}`, jobs };
  } catch { return null; }
}
async function ashby(slug: string): Promise<AtsResult | null> {
  try {
    const r = await get(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    if (!r.ok) return null;
    const j: any = await r.json();
    const jobs: AtsJob[] = (j.jobs ?? []).map((x: any) => ({ id: x.id, title: x.title, location: x.location ?? "", created_at: x.publishedAt ?? null, updated_at: x.updatedAt ?? null, url: x.jobUrl }));
    return { system: "ashby", slug, careers_url: `https://jobs.ashbyhq.com/${slug}`, jobs };
  } catch { return null; }
}
async function smartrecruiters(slug: string): Promise<AtsResult | null> {
  try {
    const r = await get(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`);
    if (!r.ok) return null;
    const j: any = await r.json(); if (!Array.isArray(j.content) || !j.content.length) return null;
    // the API answers for the company it THINKS we meant; make sure it is ours
    const ident = String(j.content[0]?.company?.identifier ?? "").toLowerCase();
    if (ident && ident !== slug.toLowerCase()) return null;
    const jobs: AtsJob[] = j.content.map((x: any) => ({ id: x.id, title: x.name, location: x.location?.city ?? "", created_at: x.releasedDate ?? null, updated_at: null, url: `https://jobs.smartrecruiters.com/${slug}/${x.id}` }));
    return { system: "smartrecruiters", slug, careers_url: `https://careers.smartrecruiters.com/${slug}`, jobs };
  } catch { return null; }
}
async function workday(tenant: string, site: string): Promise<AtsResult | null> {
  // Workday exposes a JSON search endpoint used by its own UI
  for (const wd of ["wd1", "wd3", "wd5", "wd103"]) {
    try {
      const r = await fetch(`https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`, { method: "POST", headers: { "user-agent": UA, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ appliedFacets: {}, limit: 100, offset: 0, searchText: "" }), signal: AbortSignal.timeout(12000) });
      if (!r.ok) continue;
      const j: any = await r.json();
      const jobs: AtsJob[] = (j.jobPostings ?? []).map((x: any) => ({ id: x.bulletFields?.[0] ?? x.externalPath, title: x.title, location: x.locationsText ?? "", created_at: null, updated_at: null, url: `https://${tenant}.${wd}.myworkdayjobs.com${x.externalPath}` }));
      return { system: "workday", slug: `${tenant}/${site}`, careers_url: `https://${tenant}.${wd}.myworkdayjobs.com/${site}`, jobs };
    } catch { /* next */ }
  }
  return null;
}

/** A plain careers page: JSON-LD job list if present, else titles the model can see. */
async function careersPage(url: string): Promise<AtsJob[]> {
  try {
    let html = ""; const r = await get(url); if (r.ok) html = await r.text();
    const jobs: AtsJob[] = [];
    for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      try { const j = JSON.parse(m[1]); for (const x of [j].flat(3)) if (x?.["@type"] === "JobPosting") jobs.push({ id: x.identifier?.value ?? x.url ?? x.title, title: x.title, location: x.jobLocation?.address?.addressLocality ?? "", created_at: x.datePosted ?? null, updated_at: null, url: x.url ?? url }); } catch { /* next */ }
    }
    if (jobs.length) return jobs;
    // fall back: a browser render and link-text harvest
    const { chromium } = await import("playwright-core");
    const b = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    try {
      const p = await b.newPage({ userAgent: UA }); await p.goto(url, { waitUntil: "networkidle", timeout: 25000 });
      const links: { t: string; h: string }[] = await p.$$eval("a", (as) => as.map((a) => ({ t: (a.textContent || "").trim(), h: (a as HTMLAnchorElement).href })));
      return links.filter((l) => l.t.length > 6 && l.t.length < 90 && /\/(job|jobs|career|careers|position|opening|requisition)s?\//i.test(l.h)).slice(0, 200).map((l) => ({ id: l.h, title: l.t, location: "", created_at: null, updated_at: null, url: l.h }));
    } finally { await b.close(); }
  } catch { return []; }
}

/** Match a posting title against the company's live list. Loose on seniority words, strict on the core. */
export function matchTitle(title: string, jobs: AtsJob[]) {
  const core = (t: string) => t.toLowerCase().replace(/\(.*?\)/g, "").replace(/\b(senior|sr|junior|jr|lead|principal|staff|associate|assistant|head|director|manager|ii|iii|iv|i|-|–|&)\b/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const c = core(title); const words = new Set(c.split(" ").filter((w) => w.length > 2));
  const scored = jobs.map((j) => { const jw = new Set(core(j.title).split(" ").filter((w) => w.length > 2)); let n = 0; for (const w of words) if (jw.has(w)) n++; return { j, s: words.size ? n / Math.max(words.size, jw.size) : 0 }; }).filter((x) => x.s >= 0.5).sort((a, b) => b.s - a.s);
  const best = scored[0]?.j ?? null;
  const copies = best ? jobs.filter((j) => core(j.title) === core(best.title)).length : 0;
  return { best, copies };
}

const unique = <T>(a: T[]) => [...new Set(a)];
export { htmlToText };
