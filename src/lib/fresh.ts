// The 72-hour freshness gate (26 Nov 2026). A job is offered to people only if a successful read of its employer's feed
// listed it within FRESH_HOURS (default 72; 0 turns the gate off). Everything else is "not confirmed lately" and is held
// back: suppressed, never closed. The gate changes no data: gone_at, last_seen and every other column stay exactly as
// the Reader wrote them. A held job comes back on its own the moment a successful read lists it again, because
// recordFeed() refreshes last_seen for every job a read lists. A failed read (Workday's challenge, an error, robots.txt,
// a feed no longer read) never refreshes last_seen, so those jobs age out of view without being called closed.
import { db } from "./db.js";

const DEFAULT_HOURS = 72;
/** Hours of freshness required; 0 = gate off. A bad value falls back to the default, never to "off". */
export function freshHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.FRESH_HOURS ?? "").trim();
  if (raw === "") return DEFAULT_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_HOURS;
}
/** The oldest last_seen still counted as fresh, or null when the gate is off. */
export function freshSince(now = Date.now(), env: NodeJS.ProcessEnv = process.env): string | null {
  const h = freshHours(env);
  return h > 0 ? new Date(now - h * 3600e3).toISOString() : null;
}
/** True when a job last listed at `lastSeen` may be offered now. A job with no last_seen is not fresh (gate on). */
export function isFresh(lastSeen: string | null | undefined, now = Date.now(), env: NodeJS.ProcessEnv = process.env): boolean {
  const since = freshSince(now, env);
  if (!since) return true;
  return !!lastSeen && Date.parse(lastSeen) >= Date.parse(since);
}
/** Adds the gate to a query on sightings (the PostgREST builder), or leaves it as it is when the gate is off. */
export function freshOnly<Q extends { gte: (col: string, v: string) => Q }>(q: Q, now = Date.now()): Q {
  const since = freshSince(now);
  return since ? q.gte("last_seen", since) : q;
}

export type Standing = "fresh" | "held" | "gone";
/** For jobs already on someone's list: fresh (offer it), held (open but not confirmed lately: hide it, keep it, it may
 *  come back) or gone (closed, or no longer on file). One read per 200 ids; writes nothing. */
export async function standings(ids: number[], now = Date.now()): Promise<Map<number, Standing>> {
  const out = new Map<number, Standing>();
  const uniq = [...new Set(ids.filter((n) => Number.isFinite(n)))];
  for (let i = 0; i < uniq.length; i += 200) {
    const part = uniq.slice(i, i + 200);
    const { data, error } = await db.from("sightings").select("id, last_seen, gone_at").in("id", part);
    if (error) throw new Error(`freshness: sightings not readable: ${error.message}`);
    const by = new Map((data ?? []).map((r: any) => [Number(r.id), r]));
    for (const id of part) {
      const r: any = by.get(id);
      out.set(id, !r || r.gone_at ? "gone" : isFresh(r.last_seen, now) ? "fresh" : "held");
    }
  }
  return out;
}
