// Employer resolution: where do this employer's jobs truly live? website → careers page → hiring system.
// Every answer carries a confidence and one line of evidence, so a wrong match is visible and fixable.
import { db } from "../lib/db.js";
import { companyKey } from "../engine/ghost/canon.js";
import { research } from "../engine/ghost/research.js";
import { getText } from "./http.js";
import { detect, byId, SYSTEMS, type Feed } from "./systems/index.js";
import { atsLinksIn, jsonLdJobs, harvestLinks } from "./systems/page.js";

export interface Resolution { ats: string; ats_ref: string | null; careers_url: string | null; website: string | null; confidence: "link" | "page" | "search" | "guess" | "none"; evidence: string; feed?: Feed | null }

const nameWords = (s: string) => new Set(companyKey(s).split(" ").filter((w) => w.length > 2));
/** Does the system's own company name agree with ours? (null name = cannot tell = accept) */
function sameCompany(ours: string, theirs: string | null) {
  if (!theirs) return true;
  const a = nameWords(ours), b = nameWords(theirs);
  for (const w of a) if (b.has(w)) return true;
  return a.size === 0;
}

/** Try a system ref; accept only if it exists, has jobs, and (when it tells us) is the same company. */
async function tryRef(name: string, system: string, ref: string): Promise<Feed | null> {
  const s = byId(system); if (!s) return null;
  try {
    const f = await s.read(ref);
    if (!f || !f.jobs.length) return null;
    if (!sameCompany(name, f.company_name)) return null;
    return f;
  } catch { return null; }
}

/** Given any URL (careers page, job link, ATS board), find the system behind it. */
async function fromUrl(name: string, url: string): Promise<Resolution | null> {
  const d = detect(url);
  if (d) { const f = await tryRef(name, d.system, d.ref); if (f) return { ats: d.system, ats_ref: d.ref, careers_url: f.board_url, website: null, confidence: "link", evidence: `system URL ${url}`, feed: f }; }
  return null;
}

/** Read a careers page: links to a system inside it, else JSON-LD jobs, else harvested job links. */
async function fromCareersPage(name: string, url: string): Promise<Resolution | null> {
  const r = await getText(url);
  let html = r.ok ? r.text : "";
  let harvested = null as null | { jobs: any[]; html: string };
  if (!html || html.length < 2000) { try { harvested = await harvestLinks(url); html = harvested.html; } catch { /* unreachable */ } }
  if (!html) return null;
  // 1. a hiring system embedded or linked
  for (const link of atsLinksIn(html)) {
    const d = detect(link); if (!d) continue;
    const f = await tryRef(name, d.system, d.ref);
    if (f) return { ats: d.system, ats_ref: d.ref, careers_url: url, website: null, confidence: "page", evidence: `careers page links to ${link}`, feed: f };
  }
  // 2. structured job list on the page itself
  const ld = jsonLdJobs(html, url);
  if (ld.length) return { ats: "page", ats_ref: url, careers_url: url, website: null, confidence: "page", evidence: `JSON-LD list of ${ld.length} jobs`, feed: { system: "page", ref: url, board_url: url, company_name: null, jobs: ld } };
  // 3. rendered page with job links (also re-check for systems that appear only after render)
  try {
    harvested ??= await harvestLinks(url);
    for (const link of atsLinksIn(harvested.html)) {
      const d = detect(link); if (!d) continue;
      const f = await tryRef(name, d.system, d.ref);
      if (f) return { ats: d.system, ats_ref: d.ref, careers_url: url, website: null, confidence: "page", evidence: `rendered careers page links to ${link}`, feed: f };
    }
    for (const j of harvested.jobs.slice(0, 5)) { const viaJob = await fromUrl(name, j.url); if (viaJob) return { ...viaJob, careers_url: url, evidence: `job link on careers page → ${viaJob.evidence}` }; }
    if (harvested.jobs.length >= 3) return { ats: "page", ats_ref: url, careers_url: url, website: null, confidence: "page", evidence: `${harvested.jobs.length} job links on the rendered page`, feed: { system: "page", ref: url, board_url: url, company_name: null, jobs: harvested.jobs } };
  } catch { /* browser failed */ }
  return null;
}

/** Last resort for the systems whose slugs are the company name: exact slug only, never a partial word. */
async function fromSlugGuess(name: string): Promise<Resolution | null> {
  const base = companyKey(name).replace(/\s+/g, ""); if (base.length < 4) return null;
  for (const sys of ["greenhouse", "lever", "ashby"]) {
    const f = await tryRef(name, sys, base);
    if (f) return { ats: sys, ats_ref: base, careers_url: f.board_url, website: null, confidence: "guess", evidence: `slug "${base}" exists on ${sys} with ${f.jobs.length} jobs`, feed: f };
  }
  return null;
}

/** Resolve one employer. Order: a URL we already hold → web search for the careers page → read that page → slug guess → none. */
export async function resolveEmployer(e: { key: string; name: string; website: string | null; careers_url: string | null; ats_ref: string | null; ats: string | null }): Promise<Resolution> {
  // 0. hints we hold (seed "greenhouse:slug", or a careers URL)
  if (e.ats && e.ats_ref && e.ats !== "none" && e.ats !== "page") { const f = await tryRef(e.name, e.ats, e.ats_ref); if (f) return { ats: e.ats, ats_ref: e.ats_ref, careers_url: f.board_url, website: e.website, confidence: "link", evidence: "known ref re-read", feed: f }; }
  if (e.careers_url) { const r = (await fromUrl(e.name, e.careers_url)) ?? (await fromCareersPage(e.name, e.careers_url)); if (r) return { ...r, website: e.website }; }
  // 1. find the careers page
  const found = await research.careersPage(e.name, e.website).catch(() => null);
  const website = found?.domain ?? e.website ?? null;
  if (found?.url) {
    const r = (await fromUrl(e.name, found.url)) ?? (await fromCareersPage(e.name, found.url));
    if (r) return { ...r, website, confidence: r.confidence === "link" ? "search" : r.confidence, evidence: `search → ${found.url}; ${r.evidence}` };
  }
  // 2. slug guess on the name-keyed systems
  const g = await fromSlugGuess(e.name); if (g) return { ...g, website };
  return { ats: "none", ats_ref: null, careers_url: found?.url ?? e.careers_url ?? null, website, confidence: "none", evidence: found?.url ? `careers page ${found.url} has no readable list` : "no careers page found" };
}

/** Resolve a batch of unresolved employers, `concurrency` at a time. Returns counts. */
export async function resolveBatch(limit = 20, concurrency = 4, onDone?: (key: string, r: Resolution) => Promise<void>) {
  const { data } = await db.from("employers").select("key, name, website, careers_url, ats, ats_ref").is("resolved_at", null).order("created_at").limit(limit);
  const q = [...(data ?? [])]; const stats = { done: 0, found: 0, none: 0, errors: 0 };
  async function worker() {
    for (;;) {
      const e = q.shift(); if (!e) return;
      try {
        const r = await resolveEmployer(e);
        await db.from("employers").update({ ats: r.ats, ats_ref: r.ats_ref, careers_url: r.careers_url, website: r.website, confidence: r.confidence, evidence: r.evidence, resolved_at: new Date().toISOString(), resolve_error: null }).eq("key", e.key);
        stats.done++; if (r.ats === "none") stats.none++; else stats.found++;
        if (onDone) await onDone(e.key, r);
      } catch (err) {
        stats.errors++;
        await db.from("employers").update({ resolved_at: new Date().toISOString(), ats: "none", confidence: "none", resolve_error: (err as Error).message.slice(0, 300) }).eq("key", e.key);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return stats;
}
export { SYSTEMS };
