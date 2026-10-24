// The reader: reads every known employer's hiring feed daily, builds the city-wide posting table and history.
import { db } from "../lib/db.js";
import { findAts, type AtsJob } from "../engine/ghost/ats.js";
import { companyKey, fingerprint } from "../engine/ghost/canon.js";
import { ghostCheck } from "../engine/ghost/index.js";

const DAY = 86400e3;
const BLR = /bengaluru|bangalore|karnataka|\bblr\b|india|remote/i;

/** Add companies to the seed table (idempotent). */
export async function seedCompanies(lines: string[]) {
  let n = 0;
  for (const raw of lines) {
    const line = raw.trim(); if (!line || line.startsWith("#")) continue;
    const [name, hint] = line.split("|").map((s) => s.trim());
    const key = companyKey(name);
    const { data } = await db.from("companies").select("key").eq("key", key).maybeSingle();
    if (data) continue;
    await db.from("companies").insert({ key, name, ats_slug: hint ?? null, ats: null, research: {} });
    n++;
  }
  return n;
}

/** Discover each company's ATS if unknown; read its feed; upsert postings; observe. */
export async function readCity(opts: { limit?: number; onlyStale?: boolean } = {}) {
  const since = new Date(Date.now() - DAY).toISOString();
  let q = db.from("companies").select("key, name, ats, ats_slug, careers_url, ats_checked").order("ats_checked", { ascending: true, nullsFirst: true }).limit(opts.limit ?? 100);
  if (opts.onlyStale) q = q.or(`ats_checked.is.null,ats_checked.lt.${since}`);
  const { data: companies } = await q;
  const stats = { companies: 0, postings: 0, new: 0, gone: 0, scored: 0, errors: 0 };
  for (const c of companies ?? []) {
    stats.companies++;
    try {
      // discover (first time) or re-read
      // skip companies we've already found have no readable feed, unless it's been a month
      if ((c.ats === "none" || c.ats === "unknown") && c.ats_checked && Date.now() - new Date(c.ats_checked).getTime() < 30 * DAY) continue;
      const hintUrl = c.ats_slug?.startsWith("greenhouse:") ? `https://boards.greenhouse.io/${c.ats_slug.split(":")[1]}` : c.careers_url ?? null;
      const hintSlug = c.ats_slug && !c.ats_slug.includes(":") ? c.ats_slug : null;
      const ats = await findAts(c.name, hintUrl, null, hintSlug ? [hintSlug] : []);
      const now = new Date().toISOString();
      await db.from("companies").update({ ats: ats.system, ats_slug: ats.slug ?? c.ats_slug, careers_url: ats.careers_url ?? c.careers_url, ats_jobs: ats.jobs, ats_checked: now, openings: ats.jobs.length || null }).eq("key", c.key);
      if (!ats.jobs.length) continue;

      // which of their postings do we already have?
      const keys = ats.jobs.map((j) => `${ats.system}:${ats.slug ?? c.key}:${j.id}`);
      const { data: known } = await db.from("postings").select("id, job_key").in("job_key", keys);
      const knownMap = new Map((known ?? []).map((k) => [k.job_key, k.id]));

      for (const j of ats.jobs) {
        if (!BLR.test(j.location || "")) continue;                      // Bengaluru (or remote/India-wide) only
        const job_key = `${ats.system}:${ats.slug ?? c.key}:${j.id}`;
        stats.postings++;
        let id = knownMap.get(job_key);
        if (!id) {
          const { data: row } = await db.from("postings").insert({
            job_key, url: j.url, url_hash: job_key, source: "ats", company: c.name, company_key: c.key, title: j.title,
            raw_text: `${j.title}\n${c.name}\n${j.location}`, fingerprint: fingerprint(`${j.title} ${c.name}`),
            first_seen_at: j.created_at ?? now, next_check: new Date(Date.now() + 7 * DAY).toISOString(),
          }).select("id").single();
          id = row?.id; stats.new++;
        }
        if (id) await db.from("observations").insert({ posting_id: id, present: true, posted_text: j.created_at ? `Created ${j.created_at.slice(0, 10)}` : null, applicants: null, hash: null });
      }
      // postings we knew from this company that are no longer in the feed → absent observation
      const liveKeys = new Set(keys);
      const { data: ours } = await db.from("postings").select("id, job_key").eq("company_key", c.key).like("job_key", `${ats.system}:%`);
      for (const p of ours ?? []) if (!liveKeys.has(p.job_key)) { await db.from("observations").insert({ posting_id: p.id, present: false, hash: null }); stats.gone++; }
    } catch (e) { stats.errors++; console.error("[reader]", c.name, (e as Error).message); }
  }
  return stats;
}

/** Score postings that have never been scored (new from the reader), a batch at a time. */
export async function scoreUnscored(limit = 50) {
  const { data } = await db.from("postings").select("id, url").is("scored_at", null).not("url", "is", null).order("created_at", { ascending: false }).limit(limit);
  let n = 0;
  for (const p of data ?? []) {
    try { await ghostCheck({ url: p.url }); n++; }
    catch (e) { await db.from("postings").update({ scored_at: new Date().toISOString(), verdict: "Can’t verify", score: 0, signals: [] }).eq("id", p.id); console.error("[score]", p.url, (e as Error).message); }
  }
  return n;
}

export type { AtsJob };

let running = false;
/** Kick a full read of every company in the background; returns immediately. */
export function readAllInBackground() {
  if (running) return { started: false, reason: "already running" };
  running = true;
  (async () => {
    try {
      let total = { companies: 0, postings: 0, new: 0 };
      for (let i = 0; i < 10; i++) {
        const r = await readCity({ limit: 25, onlyStale: true });
        total = { companies: total.companies + r.companies, postings: total.postings + r.postings, new: total.new + r.new };
        if (r.companies < 25) break;
      }
      console.log("[reader] full read", JSON.stringify(total));
      const n = await scoreUnscored(200); console.log("[score]", n);
    } catch (e) { console.error("[reader] background", e); }
    finally { running = false; }
  })();
  return { started: true };
}
export const readerStatus = () => ({ running });
