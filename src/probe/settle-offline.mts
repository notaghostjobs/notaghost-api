// Offline check of payment settlement (settle() and the webhook in src/routes/payments.ts): a captured payment makes
// exactly one plan, one receipt number, one receipt message and one "paid" event, through failures, retries and a
// webhook racing the checkout confirmation. The database is an in-memory stand-in that answers the requests
// supabase-js makes (with plans.payment_id unique, as migration 0013 makes it, unless a test turns that off); every
// other host is stubbed, so nothing leaves the machine. Run: npx tsx src/probe/settle-offline.mts
import { createHmac } from "node:crypto";
process.env.SUPABASE_URL = "http://db.test"; process.env.SUPABASE_SERVICE_ROLE_KEY = "x";
process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test"; process.env.RAZORPAY_KEY_SECRET = "rzp_secret_test";
process.env.WA_TOKEN = "wa_test"; process.env.WA_PHONE_ID = "1000";
let fail = 0; const ok = (n: string, c: boolean, d: unknown = "") => { if (c) console.log("  ✓", n); else { fail++; console.log("  ✗", n, JSON.stringify(d)); } };

// ---- the in-memory database -------------------------------------------------------------------------------------
type Row = Record<string, any>;
const T: Record<string, Row[]> = {};
let receiptSeq = 0, uniquePlanPayment = true, jitter = 0;
const failNext: Record<string, number> = {};          // "plans:POST" → how many of the next such requests answer 500
const seen: { table: string; method: string; url: string; body: any }[] = [];
const sent: any[] = [];                                // requests to WhatsApp
const reset = () => { for (const k of Object.keys(T)) delete T[k]; T.payments = []; T.plans = []; T.users = []; T.resumes = []; T.events = []; T.reader_control = [];
  receiptSeq = 0; seen.length = 0; sent.length = 0; for (const k of Object.keys(failNext)) delete failNext[k]; };
const val = (v: string): any => v === "null" ? null : v === "true" ? true : v === "false" ? false : decodeURIComponent(v);
function filters(u: URL) {
  const f: ((r: Row) => boolean)[] = []; let order: [string, boolean] | null = null, limit = Infinity;
  for (const [k, v] of u.searchParams) {
    if (k === "select" || k === "columns") continue;
    if (k === "order") { const [c, d] = v.split("."); order = [c, d !== "desc"]; continue; }
    if (k === "limit") { limit = Number(v); continue; }
    const i = v.indexOf("."); const op = v.slice(0, i), x = val(v.slice(i + 1));
    if (op === "eq") f.push((r) => String(r[k]) === String(x));
    else if (op === "neq") f.push((r) => String(r[k]) !== String(x));
    else if (op === "is") f.push((r) => (r[k] ?? null) === x);
    else if (op === "gt") f.push((r) => r[k] > x);
    else throw new Error(`stand-in: filter ${k}=${v} not supported`);
  }
  return { pick: (rows: Row[]) => { let o = rows.filter((r) => f.every((g) => g(r))); if (order) { const [c, asc] = order; o = [...o].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1)); } return o.slice(0, limit); } };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const answer = (rows: Row[], accept: string) => accept.includes("vnd.pgrst.object")
  ? rows.length === 1 ? json(rows[0]) : json({ code: "PGRST116", message: `JSON object requested, ${rows.length} rows returned`, details: null, hint: null }, 406)
  : json(rows);
let idSeq = 0; const now = () => new Date(Date.now() + idSeq).toISOString();
async function database(url: URL, method: string, headers: Headers, body: any) {
  if (jitter) await new Promise((r) => setTimeout(r, Math.random() * jitter));
  const path = url.pathname.replace(/^\/rest\/v1\//, ""); const accept = headers.get("accept") ?? "";
  if (path.startsWith("rpc/")) { seen.push({ table: path, method, url: url.href, body });
    if (failNext[`${path}:POST`]) { failNext[`${path}:POST`]--; return json({ code: "XX000", message: "stand-in failure" }, 500); }
    if (path === "rpc/next_receipt_no") return json(`NAG-TEST-${String(++receiptSeq).padStart(6, "0")}`);
    return json(null); }
  const table = path; seen.push({ table, method, url: url.href, body });
  const key = `${table}:${method}`; if (failNext[key]) { failNext[key]--; return json({ code: "XX000", message: "stand-in failure" }, 500); }
  const rows = (T[table] ??= []); const { pick } = filters(url);
  if (method === "GET" || method === "HEAD") return answer(pick(rows), accept);
  if (method === "POST") {
    const items = (Array.isArray(body) ? body : [body]).map((b: Row): Row => ({ id: `${table}-${++idSeq}`, created_at: now(), ...(table === "plans" ? { shots_used: 0, starts_at: now() } : {}), ...b }));
    if (table === "plans" && uniquePlanPayment) for (const it of items)
      if (it.payment_id && rows.some((r) => r.payment_id === it.payment_id)) return json({ code: "23505", message: 'duplicate key value violates unique constraint "plans_payment_id_key"', details: null, hint: null }, 409);
    if (table === "reader_control") for (const it of items)
      if (rows.some((r) => r.key === it.key)) return json({ code: "23505", message: 'duplicate key value violates unique constraint "reader_control_pkey"', details: null, hint: null }, 409);
    rows.push(...items); return answer(items, accept);
  }
  if (method === "PATCH") { const hit = pick(rows); for (const r of hit) Object.assign(r, body); return answer(hit, accept); }
  if (method === "DELETE") { const hit = pick(rows); T[table] = rows.filter((r) => !hit.includes(r)); return answer(hit, accept); }
  throw new Error(`stand-in: ${method} ${url.href}`);
}
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = String(init?.method ?? (input as any)?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers ?? (input as any)?.headers);
  const raw = init?.body ?? null; const body = typeof raw === "string" && raw ? JSON.parse(raw) : null;
  if (url.host === "db.test") return database(url, method, headers, body);
  if (/graph\.facebook\.com$/.test(url.hostname)) { sent.push(body); return json({ messages: [{ id: "wamid.test" }] }); }
  return new Response("offline", { status: 404 });
}) as any;

// ---- the code under test ----------------------------------------------------------------------------------------
const { payments, settle } = await import("../routes/payments.js");
const { PRICES } = await import("../lib/env.js");
const USER = "user-1";
const order = (product: string, extra: Row = {}) => { const o: Row = { id: `pay-${++idSeq}`, user_id: USER, product, amount_paise: (PRICES as any)[product].paise, status: "created", razorpay_order_id: `order_${idSeq}`, receipt_no: null, paid_at: null, razorpay_payment_id: null, razorpay_signature: null, ...extra }; T.payments.push(o); return o; };
const webhook = async (orderId: string, payId = `pay_rzp_${orderId}`) => {
  const raw = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: payId, order_id: orderId } } } });
  const sig = createHmac("sha256", "whsec_test").update(raw).digest("hex");
  const r = await payments.request("/webhook", { method: "POST", body: raw, headers: { "x-razorpay-signature": sig, "content-type": "application/json" } });
  return r.status;
};
const confirm = (orderId: string) => settle(orderId, `pay_rzp_${orderId}`, "checkout-signature", USER);   // what /confirm runs once the signature checks out
const settleQuiet = async (p: Promise<unknown>) => { try { return { ok: true, v: await p }; } catch (e) { return { ok: false, e: (e as Error).message }; } };
const tick = () => new Promise((r) => setTimeout(r, 30));   // fire-and-forget work (receipt, event, Radar's full pass) settles
const plansOf = (p: Row) => T.plans.filter((x) => x.payment_id === p.id);
const receipts = () => sent.filter((b) => b?.template?.name === "ghosted_receipt").length;
const paidEvents = () => T.events.filter((e) => e.kind === "paid").length;
const fullPassAsked = () => seen.filter((s) => s.table === "reader_control" && s.method === "GET" && s.url.includes(encodeURIComponent(`radar:run:${USER}`)) || s.url.includes(`radar:run:${USER}`)).length;
const hasRadar = () => T.plans.some((p) => p.user_id === USER && p.product === "radar" && p.expires_at > new Date().toISOString());   // the query hasRadar() makes
const fresh = () => { reset(); T.users.push({ id: USER, phone: "+910000000000" }); T.resumes.push({ id: "res-1", user_id: USER, is_current: true, created_at: now(), parsed: { name: "B-01" } }); };

console.log("Success");
fresh(); { const p = order("radar"); const s = await webhook(p.razorpay_order_id); await tick(); const pl = plansOf(p);
  ok("Radar via webhook: 200, paid, one receipt number", s === 200 && p.status === "paid" && /^NAG-TEST-/.test(p.receipt_no) && receiptSeq === 1, { s, p });
  ok("Radar via webhook: exactly one Radar plan, 10 Sharpens, 30 days, résumé name kept", pl.length === 1 && pl[0].product === "radar" && pl[0].shots_total === 10 && Math.round((Date.parse(pl[0].expires_at) - Date.now()) / 86400e3) === 30 && pl[0].resume_name === "B-01", pl);
  ok("Radar via webhook: hasRadar() would now say yes", hasRadar());
  ok("Radar via webhook: Radar's full pass is asked to start, once", fullPassAsked() === 1, fullPassAsked());
  ok("Radar via webhook: one receipt message, one paid event", receipts() === 1 && paidEvents() === 1, { r: receipts(), e: paidEvents() });
  await webhook(p.razorpay_order_id); await confirm(p.razorpay_order_id); await tick();
  ok("Replayed webhook and a late confirmation change nothing", plansOf(p).length === 1 && receipts() === 1 && paidEvents() === 1 && receiptSeq === 1 && fullPassAsked() === 1 && p.razorpay_signature === null); }
fresh(); { const p = order("sharpen"); const r = await confirm(p.razorpay_order_id); await tick(); const pl = plansOf(p);
  ok("Sharpen via confirmation: one plan, 10 Sharpens, 10 days, signature kept, plan returned", pl.length === 1 && pl[0].product === "sharpen" && pl[0].shots_total === 10 && Math.round((Date.parse(pl[0].expires_at) - Date.now()) / 86400e3) === 10 && p.razorpay_signature === "checkout-signature" && (r as any)?.id === pl[0].id, { pl, r });
  ok("Sharpen via confirmation: one receipt, no Radar full pass", receipts() === 1 && fullPassAsked() === 0); }
fresh(); { const p = order("first"); await webhook(p.razorpay_order_id); await tick(); const pl = plansOf(p);
  ok("₹49 first résumé: a one-Sharpen 'sharpen' plan, as before", pl.length === 1 && pl[0].product === "sharpen" && pl[0].shots_total === 1, pl); }

console.log("Failure and retry");
fresh(); { const p = order("radar"); failNext["plans:POST"] = 1; const s1 = await webhook(p.razorpay_order_id); await tick();
  ok("plan insert fails: webhook answers 500 so Razorpay retries; no receipt message, no full pass yet", s1 === 500 && plansOf(p).length === 0 && receipts() === 0 && fullPassAsked() === 0, { s1 });
  const s2 = await webhook(p.razorpay_order_id); await tick();
  ok("the retry finishes it: one plan, the same receipt number, one message, one paid event, one full pass", s2 === 200 && plansOf(p).length === 1 && receiptSeq === 1 && receipts() === 1 && paidEvents() === 1 && fullPassAsked() === 1, { s2, n: receiptSeq }); }
fresh(); { const p = order("sharpen"); failNext["rpc/next_receipt_no:POST"] = 1; const s1 = await webhook(p.razorpay_order_id);
  ok("receipt number fails: 500, marked paid, no plan yet", s1 === 500 && p.status === "paid" && !p.receipt_no && plansOf(p).length === 0, { s1, p });
  const s1b = await webhook(p.razorpay_order_id); await tick();
  ok("a call within two minutes of being marked paid draws no number (it may be racing the first)", s1b === 200 && !p.receipt_no && receiptSeq === 0 && receipts() === 0 && plansOf(p).length === 1, { s1b });
  p.paid_at = new Date(Date.now() - 180e3).toISOString();   // Razorpay's retry comes minutes later
  const s2 = await webhook(p.razorpay_order_id); await tick();
  ok("the retry issues the number and the plan, once", s2 === 200 && !!p.receipt_no && plansOf(p).length === 1 && receipts() === 1 && paidEvents() === 1, { s2 }); }
fresh(); { const p = order("sharpen"); failNext["payments:PATCH"] = 1; const s1 = await webhook(p.razorpay_order_id);
  ok("marking paid fails: 500, nothing changed", s1 === 500 && p.status === "created" && plansOf(p).length === 0 && paidEvents() === 0, { s1 });
  const s2 = await webhook(p.razorpay_order_id); await tick();
  ok("the retry settles it once", s2 === 200 && p.status === "paid" && plansOf(p).length === 1 && receipts() === 1, { s2 }); }
fresh(); { const p = order("radar", { status: "paid", paid_at: new Date(Date.now() - 3600e3).toISOString(), receipt_no: "NAG-TEST-OLD", razorpay_payment_id: "pay_x" });
  const s = await webhook(p.razorpay_order_id); await tick();
  ok("paid an hour ago, plan missing (cut off mid-way): the next webhook creates it and sends the receipt once", s === 200 && plansOf(p).length === 1 && receipts() === 1 && receiptSeq === 0 && paidEvents() === 0, { s }); }
fresh(); { const p = order("radar", { status: "paid", paid_at: "2026-11-10T13:43:00.471Z", receipt_no: "NAG-TEST-OLD", razorpay_payment_id: "pay_x" });
  const r = await settleQuiet(confirm(p.razorpay_order_id)); await tick();
  ok("paid weeks ago, plan gone: nothing is created or sent (a removed plan is not revived)", r.ok && r.v === null && plansOf(p).length === 0 && receipts() === 0 && fullPassAsked() === 0, r); }

fresh(); { const p = order("sharpen", { status: "paid", paid_at: new Date(Date.now() - 600e3).toISOString(), receipt_no: "NAG-TEST-OLD", razorpay_payment_id: "pay_x" });
  T.plans.push({ id: "plan-old", payment_id: p.id, user_id: USER, product: "sharpen", shots_total: 10, shots_used: 2, expires_at: new Date(Date.now() + 9 * 86400e3).toISOString(), created_at: now() });
  const r = await settleQuiet(confirm(p.razorpay_order_id)); const s = await webhook(p.razorpay_order_id); await tick();
  ok("settled by the old code (plan and receipt already there): a replay returns that plan and sends no second receipt", r.ok && (r.v as any)?.id === "plan-old" && s === 200 && T.plans.length === 1 && receipts() === 0 && receiptSeq === 0, r); }

console.log("Webhook and confirmation at the same moment (40 rounds, requests interleaved at random)");
jitter = 8;
for (const product of ["radar", "sharpen"]) {
  let bad = 0; const why: unknown[] = [];
  for (let i = 0; i < 20; i++) { fresh(); const p = order(product);
    const [a, b] = await Promise.all([webhook(p.razorpay_order_id), settleQuiet(confirm(p.razorpay_order_id))]); await new Promise((r) => setTimeout(r, 60));
    const good = a === 200 && b.ok && plansOf(p).length === 1 && receiptSeq === 1 && receipts() === 1 && paidEvents() === 1 && fullPassAsked() === (product === "radar" ? 1 : 0) && (b.v as any)?.id === plansOf(p)[0]?.id;
    if (!good) { bad++; why.push({ a, b, plans: plansOf(p).length, n: receiptSeq, r: receipts(), e: paidEvents() }); } }
  ok(`${product}: every round one plan, one receipt number and message, one paid event; both callers get the plan`, bad === 0, why.slice(0, 2)); }
// without migration 0013, the same race can make two plans: why the index goes in before this code
uniquePlanPayment = false; { let dup = 0; for (let i = 0; i < 20; i++) { fresh(); const p = order("sharpen"); await Promise.all([webhook(p.razorpay_order_id), settleQuiet(confirm(p.razorpay_order_id))]); if (plansOf(p).length > 1) dup++; }
  console.log(`  – without the unique index (before migration 0013): ${dup} of 20 rounds made two plans`); }
uniquePlanPayment = true; jitter = 0;

console.log("Unchanged");
fresh(); { const p = order("radar"); const r = await payments.request("/webhook", { method: "POST", body: "{}", headers: { "x-razorpay-signature": "0".repeat(64) } });
  ok("a webhook with a bad signature is refused (400) and changes nothing", r.status === 400 && p.status === "created" && T.plans.length === 0); }
fresh(); { const s = await webhook("order_unknown"); ok("an unknown order answers 500, as before", s === 500 && T.plans.length === 0); }
fresh(); { const p = order("radar"); const r = await settleQuiet(settle(p.razorpay_order_id, "pay_y", "sig", "someone-else"));
  ok("a confirmation from another account is refused and changes nothing", !r.ok && /another user/.test(String(r.e)) && p.status === "created" && T.plans.length === 0, r); }
fresh(); { const p = order("sharpen"); const raw = JSON.stringify({ event: "payment.failed", payload: { payment: { entity: { id: "pay_f", order_id: p.razorpay_order_id } } } });
  const r = await payments.request("/webhook", { method: "POST", body: raw, headers: { "x-razorpay-signature": createHmac("sha256", "whsec_test").update(raw).digest("hex") } });
  ok("other events (payment.failed) are acknowledged and ignored, as before", r.status === 200 && p.status === "created" && T.plans.length === 0); }

console.log(fail ? `${fail} failed` : "all passed"); process.exit(fail ? 1 : 0);
