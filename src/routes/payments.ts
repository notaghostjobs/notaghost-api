import { Hono } from "hono";
import { srcOf, srcOfUser, stampUser, logEvent } from "../lib/src.js";
import { isTester } from "../lib/testers.js";
import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import Razorpay from "razorpay";
import { db, currentResume, type User } from "../lib/db.js";
import { env, PRICES, receiptItem } from "../lib/env.js";
import { requireUser } from "../lib/auth.js";
import { notifyReceipt } from "./whatsapp.js";
import { readReceiptToken } from "./doc.js";
import { settleOpenIntro } from "./open.js";

export const payments = new Hono<{ Variables: { user: User } }>();

const rzp = () => new Razorpay({ key_id: env.razorpayKeyId, key_secret: env.razorpayKeySecret });

// 1. Client asks for an order -> we create it at Razorpay and record it.
payments.post("/order", requireUser, async (c) => {
  const u = c.get("user");
  const body = z.object({ product: z.enum(["sharpen", "build", "radar", "first"]) }).safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "Pick Sharpen or Build." }, 400);
  if (body.data.product === "first" && !(await firstOpen(u.id))) return c.json({ error: "The ₹49 price is for your first résumé. Your next ones are on Sharpen: ₹499 for 10.", code: "first_used" }, 409);
  const price = PRICES[body.data.product];
  // the person's channel rides on the order: first (who brought them) and last (this visit) — on our row and in Razorpay's notes
  const here = srcOf(c); await stampUser(u.id, here);
  const src = await srcOfUser(u.id);
  const attributed = { first: src.first ?? here.first ?? here.last ?? null, last: here.last ?? src.last ?? null };

  const order = await rzp().orders.create({
    amount: price.paise,
    currency: "INR",
    notes: { user_id: u.id, product: body.data.product, src_first: attributed.first ?? "direct", src_last: attributed.last ?? "direct" },
  });
  const row = { user_id: u.id, product: body.data.product, amount_paise: price.paise, razorpay_order_id: order.id, raw: order, src_first: attributed.first, src_last: attributed.last };
  let { error } = await db.from("payments").insert(row);
  if (error && /column/i.test(error.message)) { const { src_first, src_last, ...plain } = row; void src_first; void src_last; ({ error } = await db.from("payments").insert(plain)); }  // before migration 0010
  if (error) return c.json({ error: error.message }, 500);
  void logEvent("order", { src: attributed, userId: u.id, meta: { order_id: order.id, product: body.data.product, amount_paise: price.paise } });
  return c.json({ order_id: order.id, amount: price.paise, key_id: env.razorpayKeyId, phone: u.phone });
});

// 2. Razorpay Checkout returns payment_id + signature -> verify, mark paid, open the plan.
payments.post("/confirm", requireUser, async (c) => {
  const u = c.get("user");
  const body = z
    .object({ razorpay_order_id: z.string(), razorpay_payment_id: z.string(), razorpay_signature: z.string() })
    .safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "Bad payload." }, 400);
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body.data;

  const expected = createHmac("sha256", env.razorpayKeySecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest("hex");
  if (expected.length !== razorpay_signature.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(razorpay_signature)))
    return c.json({ error: "Signature mismatch." }, 400);

  // The signature proves the browser's three fields came from Razorpay; whether we hold the payment as paid is read from
  // our own payment record, never taken from the browser. When settling stops part-way (the plan is not made yet) but
  // the record says paid, the answer is "paid, plan pending", not an error: the customer has paid and must not be told
  // otherwise or pay again. A retry of this same call (it is idempotent) or Razorpay's webhook finishes the plan.
  try {
    const plan = await settle(razorpay_order_id, razorpay_payment_id, razorpay_signature, u.id);
    return c.json({ ok: true, plan });
  } catch (e) {
    const st = await paymentState(razorpay_order_id, u.id);
    if (!st?.paid) throw e;
    console.error(`[payments] confirm: ${st.payment_id} is paid, plan pending: ${(e as Error).message}`);
    return c.json({ ok: true, plan: null, pending: true, paid: true });
  }
});

/** Where this person's order stands, from our payment record alone: paid or not, and whether its plan exists yet. Open
 *  (one conversation) opens no plan, so it is ready once paid. Read-only. */
async function paymentState(orderId: string, userId: string) {
  const { data: pay, error } = await db.from("payments").select("id, user_id, product, status").eq("razorpay_order_id", orderId).maybeSingle();
  if (error) throw new Error(`payment state not readable: ${error.message}`);
  if (!pay || pay.user_id !== userId) return null;
  const paid = pay.status === "paid";
  const ready = paid && (pay.product === "open_intro" || !!(await planFor(pay.id)));
  return { payment_id: pay.id as string, product: pay.product as string, paid, plan_ready: ready, status: pay.status as string };
}

// 2b. The payment page asks where a payment stands while a plan is pending (after checkout, never instead of it).
payments.get("/status/:orderId", requireUser, async (c) => {
  const st = await paymentState(c.req.param("orderId") ?? "", c.get("user").id);
  if (!st) return c.json({ error: "No such order on this account." }, 404);
  return c.json({ paid: st.paid, plan_ready: st.plan_ready, product: st.product, refunded: st.status === "refunded" });
});

// 3. Webhook (belt and braces: catches payments where the browser closed early).
payments.post("/webhook", async (c) => {
  const raw = await c.req.text();
  const sig = c.req.header("x-razorpay-signature") ?? "";
  const expected = createHmac("sha256", env.razorpayWebhookSecret).update(raw).digest("hex");
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig)))
    return c.text("bad signature", 400);
  const evt = JSON.parse(raw);
  if (evt.event === "payment.captured") {
    const p = evt.payload.payment.entity;
    await settle(p.order_id, p.id, null, null);
  }
  return c.text("ok");
});

/** The ₹49 first résumé is open to an account that has never paid for a résumé product and has never held a plan. */
async function firstOpen(userId: string): Promise<boolean> {
  const [{ data: paid }, { data: plans }] = await Promise.all([
    db.from("payments").select("id").eq("user_id", userId).eq("status", "paid").in("product", ["sharpen", "build", "radar", "first"]).limit(1),
    db.from("plans").select("id").eq("user_id", userId).limit(1),
  ]);
  return !paid?.length && !plans?.length;
}
/** What this account is offered for a Sharpen: the first résumé at ₹49, or the pack. */
payments.get("/offer", requireUser, async (c) => {
  const first = await firstOpen(c.get("user").id);
  return c.json({ first, first_paise: PRICES.first.paise, pack_paise: PRICES.sharpen.paise, pack_shots: PRICES.sharpen.shots });
});

const REPAIR_WINDOW_MS = 72 * 3600e3, RECEIPT_GRACE_MS = 120e3;
/** States a captured payment may be settled from. "refunded" is never one: a refund is final. */
const UNPAID = ["created", "failed"];
const paymentRow = async (id: string) => {
  const { data, error } = await db.from("payments").select("*").eq("id", id).single();
  if (error || !data) throw new Error(`payment ${id} not readable: ${error?.message ?? "missing"}`);
  return data;
};
const planFor = async (paymentId: string) => {
  const { data, error } = await db.from("plans").select("*").eq("payment_id", paymentId).order("created_at", { ascending: true }).limit(1);
  if (error) throw new Error(`plan lookup failed: ${error.message}`);
  return data?.[0] ?? null;
};

/** Idempotent and safe to retry: marks the payment paid, issues its receipt number and creates its plan, each once.
 *  Any step that fails throws, so the webhook answers 500 and Razorpay retries; a retry finishes what is missing. */
export async function settle(orderId: string, paymentId: string, signature: string | null, userId: string | null) {
  let { data: pay } = await db.from("payments").select("*").eq("razorpay_order_id", orderId).maybeSingle();
  if (!pay) throw new Error("unknown order");
  if (userId && pay.user_id !== userId) throw new Error("order belongs to another user");

  // Open by notaghost.jobs: ₹499 for one accepted conversation. No plan is opened; the answer on the employer's desk becomes "paid".
  if (pay.product === "open_intro") {
    if (pay.status !== "paid") {
      const { data: receipt } = await db.rpc("next_receipt_no");
      await db.from("payments").update({ status: "paid", razorpay_payment_id: paymentId, razorpay_signature: signature, receipt_no: receipt, paid_at: new Date().toISOString() }).eq("id", pay.id);
      void logEvent("paid", { src: { first: pay.src_first ?? null, last: pay.src_last ?? null }, userId: pay.user_id, meta: { payment_id: pay.id, order_id: orderId, product: pay.product, amount_paise: pay.amount_paise } });
      if (receipt) void notifyReceipt(pay.user_id, { id: pay.id, receipt_no: String(receipt), amount_paise: pay.amount_paise, product: pay.product, shots: 1, days: 0 });
    }
    await settleOpenIntro(orderId, paymentId);
    return null;
  }
  const price = PRICES[pay.product as keyof typeof PRICES];
  if (!price) throw new Error(`no price for product ${pay.product}`);

  // 1. Mark paid. The update only matches while the row is unpaid, so when the webhook and the checkout confirmation
  //    arrive together exactly one of them wins; the other reads the row back. A failure here throws: the webhook
  //    answers 500 and Razorpay sends it again.
  const wasPaid = pay.status === "paid";
  let claimed = false;
  if (!wasPaid) {
    const { data: won, error } = await db.from("payments").update({
      status: "paid", razorpay_payment_id: paymentId, razorpay_signature: signature, paid_at: new Date().toISOString(),
    }).eq("id", pay.id).in("status", UNPAID).select("*");
    if (error) throw new Error(`payment not marked paid: ${error.message}`);
    if (won?.length) {
      pay = won[0]; claimed = true;
      void logEvent("paid", { src: { first: pay.src_first ?? null, last: pay.src_last ?? null }, userId: pay.user_id, meta: { payment_id: pay.id, order_id: orderId, product: pay.product, amount_paise: pay.amount_paise } });
    } else pay = await paymentRow(pay.id);
  }
  // A payment that is not paid after the claim was refunded (or is in a state we do not settle): a late or replayed
  // "captured" webhook changes nothing and creates nothing. Its existing plan, if any, is returned as it stands.
  if (pay.status !== "paid") { console.error(`[payments] ${pay.id} is ${pay.status}; settle changed nothing`); return await planFor(pay.id); }

  // 2. A receipt number, once: drawn by the caller that marked the payment paid, or by a later retry if that caller
  //    failed before saving one. The caller that lost the race draws none, so no number in the sequence is wasted.
  //    "Later" means two minutes after it was marked paid: a call that arrives sooner is racing the first one.
  let issued = false;
  const stalled = wasPaid && !!pay.paid_at && Date.now() - Date.parse(pay.paid_at) > RECEIPT_GRACE_MS;
  if (!pay.receipt_no && (claimed || stalled)) {
    const { data: receipt, error } = await db.rpc("next_receipt_no");
    if (error) throw new Error(`receipt number not issued: ${error.message}`);
    if (receipt) {
      const { data: set, error: e2 } = await db.from("payments").update({ receipt_no: receipt }).eq("id", pay.id).is("receipt_no", null).select("*");
      if (e2) throw new Error(`receipt number not saved: ${e2.message}`);
      if (set?.length) { pay = set[0]; issued = true; } else pay = await paymentRow(pay.id);
    }
  }

  // 3. The entitlement, exactly once per payment. A payment marked paid whose plan is missing (an insert that failed,
  //    or a restart mid-way) gets it on the next webhook or confirmation. Two at once: the unique index on
  //    plans.payment_id (migration 0013) refuses the second insert, and that caller returns the first one's plan.
  let plan = await planFor(pay.id), created = false;
  if (!plan) {
    // Repair is for a fulfilment cut short, which Razorpay's retries (up to 24 hours) bring back. An older paid payment
    // with no plan is left alone: its plan may have been removed on purpose, and an old confirmation must not revive it.
    if (pay.paid_at && Date.now() - Date.parse(pay.paid_at) > REPAIR_WINDOW_MS) {
      console.error(`[payments] paid ${pay.id} has no plan and is past the repair window; not created`);
      return null;
    }
    const cur = await currentResume<{ parsed: any }>(pay.user_id, "parsed");
    const { data, error } = await db.from("plans").insert({
      user_id: pay.user_id, product: pay.product === "first" ? "sharpen" : pay.product, shots_total: price.shots,   // the first résumé is one Sharpen resume_name: (cur?.parsed as any)?.name ?? null,
      expires_at: new Date(Date.now() + price.days * 86400e3).toISOString(), payment_id: pay.id,
    }).select("*").single();
    if (data && !error) { plan = data; created = true; }
    else if ((error as any)?.code === "23505") plan = await planFor(pay.id);   // the other caller made it
    if (!plan) throw new Error(`plan not created for payment ${pay.id}: ${error?.message ?? "no row returned"}`);
  }

  // 4. The receipt message, once per payment: offered by the caller that made the plan or saved the number (whichever
  //    finishes second has both), and sent only by the one that writes the marker first.
  if (created || issued) await sendReceiptOnce(pay.id, price);
  // Radar is paid for: the full pass over their roles starts now, whether or not their page is still open (the free
  // check before payment made no paid judgement). Loaded here, not at the top, because radar.ts is a long way round.
  if (created && pay.product === "radar") void import("./radar.js").then((m) => m.fullPassIfFree(pay.user_id)).catch((e) => console.error("[radar] full pass after payment", e?.message ?? e));
  return plan;
}

/** The WhatsApp receipt for a paid payment, at most once, with its outcome on record. A marker keyed by the payment
 *  (reader_control's key is its primary key) is written first as "pending", so only one caller sends; after WhatsApp
 *  answers it becomes "sent" or "failed". A process that dies in between leaves "pending": the payment health check
 *  reports it, and a person decides whether to resend. Nothing here resends on its own, so a receipt is never doubled. */
export const receiptKey = (paymentId: string) => `receipt:sent:${paymentId}`;
async function sendReceiptOnce(paymentId: string, price: { shots: number; days: number }) {
  const pay = await paymentRow(paymentId);
  if (!pay.receipt_no) return;
  const key = receiptKey(pay.id), at = new Date().toISOString();
  const { error } = await db.from("reader_control").insert({ key, value: { state: "pending", receipt_no: pay.receipt_no, at }, updated_at: at });
  if (error) { if ((error as any).code !== "23505") console.error(`[payments] receipt marker for ${pay.id} not written; receipt not sent: ${error.message}`); return; }
  void (async () => {
    const ok = await notifyReceipt(pay.user_id, { id: pay.id, receipt_no: String(pay.receipt_no), amount_paise: pay.amount_paise, product: pay.product, shots: price.shots, days: price.days, list_paise: (price as any).list_paise }).catch(() => false);
    const done = new Date().toISOString();
    const { error: e2 } = await db.from("reader_control").update({ value: { state: ok ? "sent" : "failed", receipt_no: pay.receipt_no, at, done_at: done, ...(ok ? {} : { reason: "WhatsApp did not accept the receipt (see the API log for its answer)" }) }, updated_at: done }).eq("key", key);
    if (e2) console.error(`[payments] receipt for ${pay.id} ${ok ? "sent" : "failed"} but not recorded (left pending): ${e2.message}`);
  })();
}

/** Test grant, founder's phone only: retires every plan the user holds and issues a fresh 10-shot Sharpen plan without
 *  a payment, so the end-to-end flow can be walked from shot 1 before the gateway is used for real. */
payments.post("/dummy", requireUser, async (c) => {
  const u = c.get("user");
  if (!isTester(u)) return c.json({ error: "Not available." }, 403);
  const now = new Date().toISOString();
  await db.from("plans").update({ expires_at: now }).eq("user_id", u.id).gt("expires_at", now);
  const price = PRICES.sharpen;
  const { data: pay, error } = await db.from("payments").insert({ user_id: u.id, product: "sharpen", amount_paise: 0, status: "paid", razorpay_order_id: `test_${Date.now()}`, paid_at: now }).select("*").single();
  if (error || !pay) return c.json({ error: error?.message ?? "could not record" }, 500);
  const cur = await currentResume<{ parsed: any }>(u.id, "parsed");
  const { data: plan } = await db.from("plans").insert({ user_id: u.id, product: "sharpen", shots_total: price.shots, resume_name: (cur?.parsed as any)?.name ?? null, expires_at: new Date(Date.now() + price.days * 86400e3).toISOString(), payment_id: pay.id }).select("*").single();
  return c.json({ ok: true, plan });
});

/** Public, signed: the receipt page behind WhatsApp's "View receipt" button. */
payments.get("/receipt/:tok", async (c) => {
  const id = readReceiptToken(c.req.param("tok"));
  if (!id) return c.json({ error: "This receipt link has expired." }, 410);
  const { data: p } = await db.from("payments").select("id, user_id, product, amount_paise, status, receipt_no, paid_at, razorpay_payment_id").eq("id", id).maybeSingle();
  if (!p || p.status !== "paid") return c.json({ error: "Receipt not found." }, 404);
  const { data: u } = await db.from("users").select("phone").eq("id", p.user_id).maybeSingle();
  const ph = String(u?.phone ?? "").replace(/\D/g, "");
  const price = PRICES[p.product as keyof typeof PRICES] as any;
  return c.json({ receipt_no: p.receipt_no, paid_at: p.paid_at, amount_paise: p.amount_paise, list_paise: price?.list_paise ?? null,
    item: receiptItem(p.product, price?.shots ?? 10, price?.days ?? 10), payment_ref: p.razorpay_payment_id, phone: ph ? `+${ph.slice(0, 2)} ••••• ${ph.slice(-4)}` : null });
});

payments.get("/", requireUser, async (c) => {
  const { data } = await db.from("payments")
    .select("id, product, amount_paise, status, receipt_no, paid_at")
    .eq("user_id", c.get("user").id).eq("status", "paid").order("paid_at", { ascending: false });
  return c.json({ payments: data ?? [] });
});
