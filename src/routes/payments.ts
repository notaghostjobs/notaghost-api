import { Hono } from "hono";
import { srcOf, srcOfUser, stampUser, logEvent } from "../lib/src.js";
import { isTester } from "../lib/testers.js";
import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import Razorpay from "razorpay";
import { db, currentResume, type User } from "../lib/db.js";
import { env, PRICES } from "../lib/env.js";
import { requireUser } from "../lib/auth.js";
import { notifyReceipt } from "./whatsapp.js";
import { readReceiptToken } from "./doc.js";

export const payments = new Hono<{ Variables: { user: User } }>();

const rzp = () => new Razorpay({ key_id: env.razorpayKeyId, key_secret: env.razorpayKeySecret });

// 1. Client asks for an order -> we create it at Razorpay and record it.
payments.post("/order", requireUser, async (c) => {
  const u = c.get("user");
  const body = z.object({ product: z.enum(["sharpen", "build"]) }).safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "Pick Sharpen or Build." }, 400);
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

  const plan = await settle(razorpay_order_id, razorpay_payment_id, razorpay_signature, u.id);
  return c.json({ ok: true, plan });
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

/** Idempotent: marks the payment paid and creates the plan once. */
async function settle(orderId: string, paymentId: string, signature: string | null, userId: string | null) {
  const { data: pay } = await db.from("payments").select("*").eq("razorpay_order_id", orderId).maybeSingle();
  if (!pay) throw new Error("unknown order");
  if (userId && pay.user_id !== userId) throw new Error("order belongs to another user");

  if (pay.status === "paid") {
    const { data } = await db.from("plans").select("*").eq("payment_id", pay.id).maybeSingle();
    return data;
  }
  const price = PRICES[pay.product as "sharpen" | "build"];
  const { data: receipt } = await db.rpc("next_receipt_no");
  await db.from("payments").update({
    status: "paid", razorpay_payment_id: paymentId, razorpay_signature: signature,
    receipt_no: receipt, paid_at: new Date().toISOString(),
  }).eq("id", pay.id);
  void logEvent("paid", { src: { first: pay.src_first ?? null, last: pay.src_last ?? null }, userId: pay.user_id, meta: { payment_id: pay.id, order_id: orderId, product: pay.product, amount_paise: pay.amount_paise } });

  const cur = await currentResume<{ parsed: any }>(pay.user_id, "parsed");
  const { data: plan } = await db.from("plans").insert({
    user_id: pay.user_id, product: pay.product, shots_total: price.shots, resume_name: (cur?.parsed as any)?.name ?? null,
    expires_at: new Date(Date.now() + price.days * 86400e3).toISOString(), payment_id: pay.id,
  }).select("*").single();
  if (receipt) void notifyReceipt(pay.user_id, { id: pay.id, receipt_no: String(receipt), amount_paise: pay.amount_paise, product: pay.product, shots: price.shots, days: price.days, list_paise: (price as any).list_paise });
  return plan;
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
  const price = PRICES[p.product as "sharpen" | "build"] as any;
  return c.json({ receipt_no: p.receipt_no, paid_at: p.paid_at, amount_paise: p.amount_paise, list_paise: price?.list_paise ?? null,
    item: `Sharpen, ${price?.shots ?? 10} shots, valid ${price?.days ?? 10} days`, payment_ref: p.razorpay_payment_id, phone: ph ? `+${ph.slice(0, 2)} ••••• ${ph.slice(-4)}` : null });
});

payments.get("/", requireUser, async (c) => {
  const { data } = await db.from("payments")
    .select("id, product, amount_paise, status, receipt_no, paid_at")
    .eq("user_id", c.get("user").id).eq("status", "paid").order("paid_at", { ascending: false });
  return c.json({ payments: data ?? [] });
});
