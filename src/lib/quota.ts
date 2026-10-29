// The free check is free at the door and gated by use (playbook: "Free check gating").
//   anonymous → 3 distinct postings a day, then sign in
//   signed in → 5 distinct postings a day
//   a plan with shots left → unlimited
// Re-opening a posting already counted today never costs anything. Counters live in reader_control (a KV table we
// already have) as quota:<who>:<day> → { keys: [job_key, …] }, so no migration stands between this and launch.
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
      const [s, b] = await Promise.all([activePlan(user.id, "sharpen"), activePlan(user.id, "build")]);
      return s || b ? { kind: "plan", user } : { kind: "user", user };
    }
  }
  const anon = (c.req.header("x-ghosted-anon") ?? "").trim();
  const ip = (c.req.header("x-forwarded-for") ?? "").split(",")[0].trim() || c.req.header("x-real-ip") || "ip";
  return { kind: "anon", id: anon && /^[a-z0-9-]{8,64}$/i.test(anon) ? `a:${sha(anon)}` : `ip:${sha(ip)}` };
}
function sha256(s: string) { return createHash("sha256").update(s).digest("hex"); }

const dayKey = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);   // IST day
const who = (caller: Caller) => (caller.kind === "anon" ? caller.id : `u:${caller.user.id}`);

export type Gate = { allowed: true; used: number; limit: number | null } | { allowed: false; gate: "otp" | "limit"; used: number; limit: number };

/** A check that failed on our side (couldn't read the posting) must not cost the slot it was granted. */
export async function refund(caller: Caller, jobKey: string) {
  if (caller.kind === "plan") return;
  const key = `quota:${who(caller)}:${dayKey()}`;
  const { data } = await db.from("reader_control").select("value").eq("key", key).maybeSingle();
  const keys: string[] = Array.isArray((data?.value as any)?.keys) ? (data!.value as any).keys : [];
  if (!keys.includes(jobKey)) return;
  await db.from("reader_control").upsert({ key, value: { keys: keys.filter((k) => k !== jobKey) }, updated_at: new Date().toISOString() });
}

/** May this caller check this posting today? Counts a new distinct posting when allowed. */
export async function gate(caller: Caller, jobKey: string): Promise<Gate> {
  if (caller.kind === "plan") return { allowed: true, used: 0, limit: null };
  const limit = caller.kind === "anon" ? LIMITS.anon : LIMITS.user;
  const key = `quota:${who(caller)}:${dayKey()}`;
  const { data } = await db.from("reader_control").select("value").eq("key", key).maybeSingle();
  const keys: string[] = Array.isArray((data?.value as any)?.keys) ? (data!.value as any).keys : [];
  if (keys.includes(jobKey)) return { allowed: true, used: keys.length, limit };
  if (keys.length >= limit) return { allowed: false, gate: caller.kind === "anon" ? "otp" : "limit", used: keys.length, limit };
  await db.from("reader_control").upsert({ key, value: { keys: [...keys, jobKey] }, updated_at: new Date().toISOString() });
  return { allowed: true, used: keys.length + 1, limit };
}
