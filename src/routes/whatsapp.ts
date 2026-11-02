// WhatsApp: a job link in, a verdict out. Meta's Cloud API calls this webhook; we reply inside the user's own
// conversation (a reply to a user-started message needs no template and is free). The user's WhatsApp number is a
// verified phone, so the account exists from the first message and the link we send signs them in — no OTP wall.
// Quota is the signed-in quota (section 7 of the rule book). Nothing outbound is ever sent unprompted.
import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../lib/env.js";
import { db, activePlan } from "../lib/db.js";
import { createSession } from "../lib/auth.js";
import { gate, refund, type Caller } from "../lib/quota.js";
import { ghostCheck, type CheckResult } from "../engine/ghost/index.js";
import { jobKey } from "../engine/ghost/canon.js";

export const whatsapp = new Hono();
/** The last 50 webhook events and sends, for the read-only audit: did Meta call us, did we reply, what did Graph say. */
export const waTrace: { at: string; kind: string; detail: string }[] = [];
const trace = (kind: string, detail: unknown) => { waTrace.unshift({ at: new Date().toISOString(), kind, detail: String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) }); if (waTrace.length > 50) waTrace.pop(); };
const SITE = "https://notaghost.jobs";
const GRAPH = "https://graph.facebook.com/v21.0";

/** Meta's one-time handshake when the callback URL is saved: echo hub.challenge if the verify token matches. */
whatsapp.get("/webhook", (c) => {
  const mode = c.req.query("hub.mode"), token = c.req.query("hub.verify_token"), challenge = c.req.query("hub.challenge");
  if (mode === "subscribe" && token && env.waVerifyToken && token === env.waVerifyToken) return c.text(challenge ?? "", 200);
  return c.text("forbidden", 403);
});

/** Inbound events. Acknowledged at once (Meta retries anything not 200'd within seconds); each message handled after. */
whatsapp.post("/webhook", async (c) => {
  const raw = await c.req.text();
  // Meta signs every delivery with the app secret; when we have it, an unsigned call is dropped. Until then, the URL is unguessable enough for launch.
  if (env.waAppSecret) {
    const sig = c.req.header("x-hub-signature-256") ?? "";
    const want = "sha256=" + createHmac("sha256", env.waAppSecret).update(raw).digest("hex");
    if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return c.text("bad signature", 401);
  }
  let body: any = null;
  try { body = JSON.parse(raw); } catch { trace("webhook:unparseable", raw.slice(0, 200)); return c.json({ ok: true }); }
  const msgs: any[] = body?.entry?.flatMap((e: any) => e.changes ?? []).flatMap((ch: any) => ch.value?.messages ?? []) ?? [];
  const statuses: any[] = body?.entry?.flatMap((e: any) => e.changes ?? []).flatMap((ch: any) => ch.value?.statuses ?? []) ?? [];
  trace("webhook", { messages: msgs.map((m: any) => ({ type: m.type, from: String(m.from ?? "").slice(0, 4) + "…" })), statuses: statuses.map((s: any) => s.status), fields: body?.entry?.flatMap((e: any) => (e.changes ?? []).map((ch: any) => ch.field)) });
  for (const m of msgs) handle(m).catch((e) => console.error("[whatsapp] handle", m?.id, e?.message ?? e));
  return c.json({ ok: true });
});

const seen = new Map<string, number>();   // Meta re-delivers on any hiccup; a message id is handled once
function once(id: string) { const now = Date.now(); for (const [k, t] of seen) if (now - t > 600e3) seen.delete(k); if (seen.has(id)) return false; seen.set(id, now); return true; }

async function handle(m: any) {
  if (!m?.id || !m?.from || !once(m.id)) return;
  const from: string = String(m.from).replace(/\D/g, "");                 // E.164 digits without '+', e.g. 9198765...
  const text: string = m.type === "text" ? String(m.text?.body ?? "") : m.type === "interactive" ? String(m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "") : "";
  await markRead(m.id);
  const url = firstUrl(text);
  if (!url) {
    await send(from, "Send me a job link — LinkedIn, Naukri or a careers page — and I’ll tell you if the role is real.\n\n_Ghosted · notaghost.jobs_");
    return;
  }
  const user = await userFor(from);
  const caller: Caller = await callerFor(user);
  const key = jobKey(url).key;
  const g = await gate(caller, key);
  if (!g.allowed) {
    const token = await createSession(user.id);
    await send(from, `That’s your ${g.limit} checks for today. Sharpen, Build or Radar makes them unlimited — and shows you why they’d skip you.\n\n${SITE}/app.html#/sharpen?t=${token}&src=wa`);
    return;
  }
  let r: CheckResult;
  try {
    r = await ghostCheck({ url, page: { source: "site" } }, { quick: true });
  } catch (e) {
    await refund(caller, key).catch(() => {});
    const msg = (e as Error).message ?? "";
    console.error("[whatsapp] check", msg.slice(0, 200));
    await send(from, "I couldn’t read that posting just now. If it’s a LinkedIn or Naukri link, open it in Chrome with the Ghosted extension — or try again in a minute.");
    return;
  }
  const token = await createSession(user.id);
  await send(from, format(r, token, g));
}

/** WhatsApp formatting: *bold*, _italic_. Three lines of verdict, the two strongest findings, one link that signs them in. */
function format(r: CheckResult, token: string, g: { used: number; limit: number | null }): string {
  const head = r.verdict === "Real" ? "✅" : r.verdict === "Caution" ? "⚠️" : "⛔";
  const where = [r.title, r.company].filter(Boolean).join(" · ");
  const fired = r.signals.filter((s) => s.kind === "bad").sort((a, b) => b.pts - a.pts).slice(0, 2);
  const oks = r.signals.filter((s) => s.kind === "ok").slice(0, 2);
  const lines = (fired.length ? fired : oks).map((s) => `• ${[s.text, s.strong, s.tail].filter(Boolean).join(" ")}`);
  const check = `${SITE}/app.html#/check?id=${r.posting_id}&t=${token}&src=wa`;
  const next = r.verdict === "Ghost"
    ? `Don’t spend time here. Radar finds the real ones: ${SITE}/app.html#/radar?t=${token}&src=wa`
    : `See every check, and why they’d skip you: ${check}`;
  const left = g.limit == null ? "" : `\n_${Math.max(0, g.limit - g.used)} free checks left today_`;
  return `${head} *${r.verdict}* · ${r.clear}/${r.checks_run} clear\n${where}\n\n${r.headline}\n${lines.join("\n")}\n\n${next}${left}`;
}

function firstUrl(t: string): string | null {
  const m = t.match(/https?:\/\/[^\s<>"']+/i) ?? t.match(/\b(?:www\.)?(?:linkedin\.com|naukri\.com|[a-z0-9.-]+\.[a-z]{2,})\/[^\s<>"']+/i);
  if (!m) return null;
  const u = m[0].replace(/[.,;)\]]+$/, "");
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

async function userFor(digits: string) {
  const phone = `+${digits}`;
  const { data, error } = await db.from("users").upsert({ phone, last_seen_at: new Date().toISOString() }, { onConflict: "phone" }).select("id, phone, email, name, city").single();
  if (error || !data) throw new Error(error?.message ?? "user upsert failed");
  return data;
}
async function callerFor(user: any): Promise<Caller> {
  const [s, b, r] = await Promise.all([activePlan(user.id, "sharpen"), activePlan(user.id, "build"), activePlan(user.id, "radar")]);
  return s || b || r ? { kind: "plan", user } : { kind: "user", user };
}

async function graph(path: string, body: unknown) {
  if (!env.waToken || !env.waPhoneId) { trace("graph:unconfigured", { token: !!env.waToken, phone: !!env.waPhoneId }); console.error("[whatsapp] not configured"); return; }
  const res = await fetch(`${GRAPH}/${env.waPhoneId}/${path}`, { method: "POST", headers: { authorization: `Bearer ${env.waToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  trace(res.ok ? "graph:ok" : "graph:error", `${path} ${res.status} ${text.slice(0, 300)}`);
  if (!res.ok) console.error("[whatsapp] graph", res.status, text.slice(0, 300));
}
const send = (to: string, text: string) => graph("messages", { messaging_product: "whatsapp", to, type: "text", text: { body: text.slice(0, 4000), preview_url: false } });
const markRead = (id: string) => graph("messages", { messaging_product: "whatsapp", status: "read", message_id: id });
