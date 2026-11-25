// The checker's own health, once a day, in plain numbers: for each hiring system, how many employers we check through it,
// how many of those failed their last check, how many roles we hold as open, and how many of those were confirmed in the
// last 24 hours. Written to reader_control (health:reader). When a system has been failing for most of its employers, or
// most of its open roles have gone a day unconfirmed, one email goes to the founder (ALERT_EMAIL in Render), at most once
// in 22 hours. This exists because Workday refused us for two weeks in November and nothing said so.
import { db } from "../lib/db.js";
import { sendMail, mailReady } from "../lib/mail.js";
import { familyReport } from "./http.js";
import { paymentHealthCheck } from "../lib/payHealth.js";

export interface SystemHealth { system: string; feeds: number; failing: number; open: number; confirmed_24h: number; example_error: string | null; problem: string | null }

export function judge(s: Omit<SystemHealth, "problem">): string | null {
  if (s.feeds >= 5 && s.failing / s.feeds >= 0.5) return `${s.failing} of ${s.feeds} employers failed their last check`;
  if (s.open >= 200 && s.confirmed_24h < s.open * 0.2) return `only ${s.confirmed_24h.toLocaleString("en-IN")} of ${s.open.toLocaleString("en-IN")} open roles were confirmed in the last 24 hours`;
  return null;
}

export async function readerHealth(): Promise<{ at: string; systems: SystemHealth[]; problems: SystemHealth[] }> {
  const feeds = new Map<string, Map<string, string | null>>();   // system → feed → last error
  for (let from = 0; from < 40000; from += 1000) {
    const { data } = await db.from("employers").select("ats, ats_ref, read_error").not("ats", "is", null).not("ats", "in", '("none","page")').not("ats_ref", "is", null).order("key", { ascending: true }).range(from, from + 999);
    for (const e of (data ?? []) as { ats: string; ats_ref: string; read_error: string | null }[]) { const m = feeds.get(e.ats) ?? new Map(); m.set(e.ats_ref, e.read_error); feeds.set(e.ats, m); }
    if (!data || data.length < 1000) break;
  }
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  const systems: SystemHealth[] = [];
  for (const [system, m] of feeds) {
    const errs = [...m.values()].filter((x): x is string => !!x && !/^partial read/i.test(x));
    const [{ count: open }, { count: seen }] = await Promise.all([
      db.from("sightings").select("id", { count: "exact", head: true }).eq("source", system).is("gone_at", null),
      db.from("sightings").select("id", { count: "exact", head: true }).eq("source", system).is("gone_at", null).gt("last_seen", since),
    ]);
    const row = { system, feeds: m.size, failing: errs.length, open: open ?? 0, confirmed_24h: seen ?? 0, example_error: errs[0]?.slice(0, 120) ?? null };
    systems.push({ ...row, problem: judge(row) });
  }
  systems.sort((a, b) => b.open - a.open);
  return { at: new Date().toISOString(), systems, problems: systems.filter((s) => s.problem) };
}

/** Works out the health, puts it on record, and emails the founder when something is wrong. Returns what it found. */
export async function healthCheck(): Promise<{ problems: number; mailed: boolean }> {
  await paymentHealthCheck();   // its own record and email (src/lib/payHealth.ts); never throws
  const h = await readerHealth();
  await db.from("reader_control").upsert({ key: "health:reader", value: { ...h, platforms: familyReport() }, updated_at: h.at }, { onConflict: "key" });
  if (!h.problems.length) return { problems: 0, mailed: false };
  const to = (process.env.ALERT_EMAIL ?? "").trim();
  const { data: last } = await db.from("reader_control").select("value").eq("key", "health:alerted").maybeSingle();
  const recently = Date.parse((last?.value as any)?.at ?? "") > Date.now() - 22 * 3600e3;
  if (!to || !mailReady() || recently) return { problems: h.problems.length, mailed: false };
  const mailed = await sendMail({ to, subject: `Ghosted checks: ${h.problems.map((p) => p.system).join(", ")} ${h.problems.length === 1 ? "is" : "are"} failing`,
    lines: ["The daily check of employers' hiring systems found a problem.", ...h.problems.map((p) => `${p.system}: ${p.problem}.${p.example_error ? ` Last error: ${p.example_error}` : ""}`), "Roles from these systems cannot be called “checked today” until this clears."] });
  if (mailed) await db.from("reader_control").upsert({ key: "health:alerted", value: { at: h.at, systems: h.problems.map((p) => p.system) }, updated_at: h.at }, { onConflict: "key" });
  return { problems: h.problems.length, mailed };
}
