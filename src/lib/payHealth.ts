// Payment health, once a day beside the checker's (src/reader/health.ts): read-only, it lists the cases a person must
// look at, because nothing repairs them on its own:
//   1. a paid payment with no plan, ten minutes or more after it was paid (Razorpay's retries ran out, or the repair
//      window passed): the customer paid and holds nothing;
//   2. a receipt whose marker is still "pending" ten minutes on (the process stopped between claiming the send and
//      recording WhatsApp's answer), or "failed" (WhatsApp refused it).
// Only payments from CHECK_SINCE are counted: the nine plans removed by hand before this check existed are a known,
// decided case and must not raise an alarm every day. Open (₹499, one conversation) opens no plan and is left out.
import { db } from "./db.js";

export const PAY_CHECK_SINCE = "2026-11-26T00:00:00Z";
const QUIET_MS = 10 * 60e3;

export type PayProblem = { kind: "paid_without_plan" | "receipt_pending" | "receipt_failed"; payment_id: string; since: string };

export async function paymentHealth(now = Date.now()): Promise<{ at: string; problems: PayProblem[] }> {
  const quiet = new Date(now - QUIET_MS).toISOString();
  const problems: PayProblem[] = [];
  const { data: paid, error } = await db.from("payments").select("id, paid_at, product").eq("status", "paid").gte("paid_at", PAY_CHECK_SINCE).lt("paid_at", quiet).neq("product", "open_intro").limit(1000);
  if (error) throw new Error(`payment health: payments not readable: ${error.message}`);
  const ids = (paid ?? []).map((p: any) => p.id as string);
  if (ids.length) {
    const { data: plans, error: e2 } = await db.from("plans").select("payment_id").in("payment_id", ids);
    if (e2) throw new Error(`payment health: plans not readable: ${e2.message}`);
    const held = new Set((plans ?? []).map((p: any) => p.payment_id));
    for (const p of paid as any[]) if (!held.has(p.id)) problems.push({ kind: "paid_without_plan", payment_id: p.id, since: p.paid_at });
  }
  const { data: marks, error: e3 } = await db.from("reader_control").select("key, value").like("key", "receipt:sent:%").limit(1000);
  if (e3) throw new Error(`payment health: receipt markers not readable: ${e3.message}`);
  for (const m of (marks ?? []) as { key: string; value: any }[]) {
    const id = m.key.slice("receipt:sent:".length), state = m.value?.state, at = String(m.value?.at ?? "");
    if (state === "failed") problems.push({ kind: "receipt_failed", payment_id: id, since: at });
    else if (state === "pending" && at < quiet) problems.push({ kind: "receipt_pending", payment_id: id, since: at });
  }
  return { at: new Date(now).toISOString(), problems };
}

export const describePayProblem = (p: PayProblem) =>
  p.kind === "paid_without_plan" ? `payment ${p.payment_id} was paid at ${p.since} and has no plan: the customer holds nothing`
  : p.kind === "receipt_failed" ? `payment ${p.payment_id}: WhatsApp did not accept the receipt (${p.since})`
  : `payment ${p.payment_id}: the receipt send started at ${p.since} and its outcome was never recorded`;

/** Puts payment health on record (health:payments) and emails the founder when there is a case to look at, at most
 *  once in 22 hours (its own limit, apart from the checker's). Never throws: the checker's health runs regardless. */
export async function paymentHealthCheck(): Promise<{ problems: number; mailed: boolean }> {
  try {
    const { sendMail, mailReady } = await import("./mail.js");
    const h = await paymentHealth();
    await db.from("reader_control").upsert({ key: "health:payments", value: h, updated_at: h.at }, { onConflict: "key" });
    if (!h.problems.length) return { problems: 0, mailed: false };
    const to = (process.env.ALERT_EMAIL ?? "").trim();
    const { data: last } = await db.from("reader_control").select("value").eq("key", "health:payments:alerted").maybeSingle();
    if (!to || !mailReady() || Date.parse((last?.value as any)?.at ?? "") > Date.now() - 22 * 3600e3) return { problems: h.problems.length, mailed: false };
    const mailed = await sendMail({ to, subject: `Ghosted payments: ${h.problems.length} case${h.problems.length === 1 ? "" : "s"} to look at`,
      lines: ["The daily payment check found something only a person can settle. Nothing was changed or resent.", ...h.problems.map(describePayProblem)] });
    if (mailed) await db.from("reader_control").upsert({ key: "health:payments:alerted", value: { at: h.at, n: h.problems.length }, updated_at: h.at }, { onConflict: "key" });
    return { problems: h.problems.length, mailed };
  } catch (e) { console.error("[health] payments", (e as Error).message); return { problems: -1, mailed: false }; }
}
