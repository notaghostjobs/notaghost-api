// The free check is free at the door and gated by use (playbook: "Free check gating").
//   anonymous → 3 distinct postings in any 24 hours, then sign in
//   signed in → 5 more distinct postings in any 24 hours (its own count, separate from the anonymous one)
//   a plan (Sharpen with shots left, Build, Radar) → unlimited
// Re-opening a posting already counted in the window never costs anything. Counters live in reader_control (a KV table we
// already have) as quota24:<who> → { keys: [{ k, at }, …] }, so no migration stands between this and launch.
import type { Context } from "hono";
import { db, activePlan, type User } from "./db.js";
import { createHash } from "node:crypto";

export const LIMITS = { anon: 3, user: 5 } as const;
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

export type Caller = { kind: "plan"; user: User } | { kind: "user"; user: User } | { kind: "anon"; id: string };

/** Who is asking: a signed-in user (Bearer), else an anonymous id the client keeps, else the IP. */
export async function identify(c: Context): Promise<Caller> {
  const h = c.req.header("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (token) {
    const { data } = await db.from("sessions").select("user_id, users(id, phone, email, name, city)").eq("token", sha256(token)).gt("expires_at", new Date().toISOString()).maybeSingle();
    const user = data?.users as unknown as User | undefined;
    if (user) {
      const [s, b, r] = await Promise.all([activePlan(user.id, "sharpen"), activePlan(user.id, "build"), activePlan(user.id, "radar")]);
      return s || b || r ? { kind: "plan", user } : { kind: "user", user };
    }
  }
  const anon = (c.req.header("x-ghosted-anon") ?? "").trim();
  const ip = (c.req.header("x-forwarded-for") ?? "").split(",")[0].trim() || c.req.header("x-real-ip") || "ip";
  return { kind: "anon", id: anon && /^[a-z0-9-]{8,64}$/i.test(anon) ? `a:${sha(anon)}` : `ip:${sha(ip)}` };
}
function sha256(s: string) { return createHash("sha256").update(s).digest("hex"); }

const WINDOW_MS = 24 * 3600e3;
const who = (caller: Caller) => (caller.kind === "anon" ? caller.id : `u:${caller.user.id}`);
type Entry = { k: string; at: string };
/** The caller's checks in the last 24 hours. One row per caller: quota24:<who> → { keys: [{ k, at }] }. Older entries fall off on read. */
async function recent(caller: Caller): Promise<{ key: string; entries: Entry[] }> {
  const key = `quota24:${who(caller)}`;
  const { data } = await db.from("reader_control").select("value").eq("key", key).maybeSingle();
  const raw: any[] = Array.isArray((data?.value as any)?.keys) ? (data!.value as any).keys : [];
  const cutoff = Date.now() - WINDOW_MS;
  const entries = raw.filter((e) => e && typeof e.k === "string" && Date.parse(e.at) > cutoff);
  return { key, entries };
}

export type Gate = { allowed: true; used: number; limit: number | null } | { allowed: false; gate: "otp" | "limit"; used: number; limit: number };

/** A check that failed on our side (couldn't read the posting) must not cost the slot it was granted. */
export async function refund(caller: Caller, jobKey: string) {
  if (caller.kind === "plan") return;
  const { key, entries } = await recent(caller);
  if (!entries.some((e) => e.k === jobKey)) return;
  await db.from("reader_control").upsert({ key, value: { keys: entries.filter((e) => e.k !== jobKey) }, updated_at: new Date().toISOString() });
}

/** May this caller check this posting? Counts a new distinct posting when allowed; a posting already counted in the window is free. */
export async function gate(caller: Caller, jobKey: string): Promise<Gate> {
  if (caller.kind === "plan") return { allowed: true, used: 0, limit: null };
  const limit = caller.kind === "anon" ? LIMITS.anon : LIMITS.user;
  const { key, entries } = await recent(caller);
  if (entries.some((e) => e.k === jobKey)) return { allowed: true, used: entries.length, limit };
  if (entries.length >= limit) return { allowed: false, gate: caller.kind === "anon" ? "otp" : "limit", used: entries.length, limit };
  await db.from("reader_control").upsert({ key, value: { keys: [...entries, { k: jobKey, at: new Date().toISOString() }] }, updated_at: new Date().toISOString() });
  return { allowed: true, used: entries.length + 1, limit };
}
