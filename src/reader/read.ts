// Read an employer's feed and record sightings. Idempotent: run it twice, nothing doubles.
import { db } from "../lib/db.js";
import { byId, type Feed } from "./systems/index.js";
import { isBlr } from "./blr.js";

export interface Employer { key: string; name: string; ats: string | null; ats_ref: string | null }

/** Write a feed's jobs as sightings for this employer; mark the ones that vanished. */
export async function recordFeed(e: Employer, feed: Feed) {
  const now = new Date().toISOString();
  // Circuit breaker: a read that comes back empty (or collapses to under a fifth) where roles were live is far more
  // likely a refusal, a maintenance page or a broken pager than a hiring freeze. Keep what we have, say so, retry
  // on the next cycle; accept the drop only once it has held for three consecutive reads.
  const { count: liveBefore } = await db.from("sightings").select("*", { count: "exact", head: true }).eq("employer_key", e.key).eq("source", feed.system).is("gone_at", null);
  const before = liveBefore ?? 0;
  if (before > 0 && (feed.jobs.length === 0 || (before >= 50 && feed.jobs.length < before / 5))) {
    const { data: prev } = await db.from("employers").select("read_error").eq("key", e.key).maybeSingle();
    const held = Number(prev?.read_error?.match(/held (\d+)x/)?.[1] ?? 0) + 1;
    if (held < 3) {
      // read_at set 19h back: the next cycle (20h stale) retries in about an hour instead of tomorrow
      await db.from("employers").update({ read_at: new Date(Date.now() - 19 * 3600e3).toISOString(), read_error: `read returned ${feed.jobs.length} where ${before} were live — kept, held ${held}x${feed.debug ? ` (${feed.debug.slice(0, 160)})` : ""}` }).eq("key", e.key);
      return { jobs: feed.jobs.length, blr: 0, gone: 0, held: true };
    }
  }
  const rows = feed.jobs.map((j) => ({
    source: feed.system, source_id: `${feed.ref}:${j.id}`, employer_key: e.key, company_name: feed.company_name ?? e.name,
    title: j.title.slice(0, 300), location: (j.location ?? "").slice(0, 300), url: j.url, posted_at: j.posted_at, updated_at_src: j.updated_at, posted_text: j.posted_text,
    blr: isBlr(j.location ?? ""), last_seen: now, gone_at: null,
  }));
  // upsert in chunks; first_seen keeps its original value because we never send it
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("sightings").upsert(rows.slice(i, i + 500), { onConflict: "source,source_id" });
    if (error) throw new Error(`sightings upsert: ${error.message}`);
  }
  // anything from this employer+system not seen this run is gone
  const { data: gone } = await db.from("sightings").update({ gone_at: now }).eq("employer_key", e.key).eq("source", feed.system).is("gone_at", null).lt("last_seen", now).select("id");
  const blr = rows.filter((r) => r.blr).length;
  await db.from("employers").update({ read_at: now, read_error: null, openings: rows.length, blr_openings: blr }).eq("key", e.key);
  return { jobs: rows.length, blr, gone: gone?.length ?? 0, held: false };
}

/** Read one employer by its stored system + ref. */
export async function readEmployer(e: Employer) {
  const s = e.ats ? byId(e.ats) : null;
  if (!s || !e.ats_ref) return null;
  const feed = await s.read(e.ats_ref);
  if (!feed) { await db.from("employers").update({ read_at: new Date().toISOString(), read_error: "feed no longer exists", openings: 0, blr_openings: 0 }).eq("key", e.key); return null; }
  return recordFeed(e, feed);
}

/** Read every resolved employer whose last read is older than `staleHours`. */
export async function readDue(limit = 200, staleHours = 20, concurrency = 3) {
  const since = new Date(Date.now() - staleHours * 3600e3).toISOString();
  const { data } = await db.from("employers").select("key, name, ats, ats_ref").not("ats", "is", null).not("ats", "in", '("none")').or(`read_at.is.null,read_at.lt.${since}`).order("read_at", { ascending: true, nullsFirst: true }).limit(limit);
  const q = [...(data ?? [])]; const stats = { employers: 0, jobs: 0, blr: 0, gone: 0, errors: 0 };
  async function worker() {
    for (;;) {
      const e = q.shift(); if (!e) return;
      stats.employers++;
      try { const r = await readEmployer(e); if (r) { stats.jobs += r.jobs; stats.blr += r.blr; stats.gone += r.gone; } }
      catch (err) { stats.errors++; await db.from("employers").update({ read_at: new Date().toISOString(), read_error: (err as Error).message.slice(0, 300) }).eq("key", e.key); }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return stats;
}
