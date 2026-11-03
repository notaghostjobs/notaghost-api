// WhatsApp: a job link in, a verdict out. Meta's Cloud API calls this webhook; we reply inside the user's own
// conversation (a reply to a user-started message needs no template and is free). The user's WhatsApp number is a
// verified phone, so the account exists from the first message and the link we send signs them in — no OTP wall.
// Quota is the signed-in quota (section 7 of the rule book). Nothing outbound is ever sent unprompted.
import { Hono } from "hono";
import { stampUser, srcOfUser, logEvent, untagMessage } from "../lib/src.js";
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

/** The three launch templates, created through the Graph API (so the console isn't needed). Read-only listing at GET /templates;
 *  POST /templates creates any that are missing. Meta reviews them (minutes to a day); status shows here. */
export const TEMPLATES = [
  { name: "ghosted_signin_code", category: "AUTHENTICATION", language: "en",
    components: [{ type: "BODY", add_security_recommendation: true }, { type: "FOOTER", code_expiration_minutes: 5 }, { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "Copy code" }] }] },
  { name: "ghosted_document_ready", category: "UTILITY", language: "en",
    components: [
      { type: "BODY", text: "Your sharpened résumé for *{{1}}* at *{{2}}* is ready: {{3}}% → *{{4}}%*. Open it, download the PDF, and send the referral note.", example: { body_text: [["Category Manager", "Amazon", "54", "75"]] } },
      { type: "BUTTONS", buttons: [{ type: "URL", text: "Open document", url: "https://notaghost.jobs/app.html#/sharpen/delivered?s={{1}}", example: ["abc123"] }] },
    ] },
  { name: "ghosted_receipt", category: "UTILITY", language: "en",
    components: [
      { type: "BODY", text: "Receipt {{1}} from Ghosted: {{2}} for ₹{{3}}, paid on {{4}}. Tap to view or download.", example: { body_text: [["NAG-2026-00001", "Sharpen — 10 shots", "499", "2 Nov 2026"]] } },
      { type: "BUTTONS", buttons: [{ type: "URL", text: "View receipt", url: "https://notaghost.jobs/app.html#/receipts/{{1}}", example: ["NAG-2026-00001"] }] },
    ] },
];
whatsapp.get("/templates", async (c) => {
  if (!env.waWabaId || !env.waToken) return c.json({ error: "WA_WABA_ID / WA_TOKEN not set" }, 500);
  const r = await fetch(`${GRAPH}/${env.waWabaId}/message_templates?fields=name,status,category,rejected_reason&limit=50`, { headers: { authorization: `Bearer ${env.waToken}` } });
  return c.json(await r.json());
});
whatsapp.post("/templates", async (c) => {
  if (!env.waWabaId || !env.waToken) return c.json({ error: "WA_WABA_ID / WA_TOKEN not set" }, 500);
  const have = await (await fetch(`${GRAPH}/${env.waWabaId}/message_templates?fields=name,status&limit=50`, { headers: { authorization: `Bearer ${env.waToken}` } })).json();
  const names = new Set(((have as any).data ?? []).map((t: any) => t.name));
  const results: any[] = [];
  for (const t of TEMPLATES) {
    if (names.has(t.name)) { results.push({ name: t.name, skipped: "exists" }); continue; }
    const r = await fetch(`${GRAPH}/${env.waWabaId}/message_templates`, { method: "POST", headers: { authorization: `Bearer ${env.waToken}`, "content-type": "application/json" }, body: JSON.stringify(t) });
    results.push({ name: t.name, status: r.status, body: await r.json() });
  }
  return c.json({ results });
});

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
  const rawText: string = m.type === "text" ? String(m.text?.body ?? "") : m.type === "interactive" ? String(m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "") : "";
  await markRead(m.id);
  // a prefilled message from a post carries its channel in a trailing bracket — "(IF)" → wa-if; a hand-typed message is wa-direct
  const { text, tag } = untagMessage(rawText);
  const url = firstUrl(text);
  if (!url) {
    await send(from, "Send me a job link — LinkedIn, Naukri or a careers page — and I’ll tell you if the role is real.\n\n_Ghosted · notaghost.jobs_");
    return;
  }
  const user = await userFor(from);
  await stampUser(user.id, { first: tag ?? "wa-direct", last: tag ?? "wa-direct" });
  const src = await srcOfUser(user.id);
  void logEvent("wa_in", { src, userId: user.id, meta: { tagged: !!tag } });
  const caller: Caller = await callerFor(user);
  const key = jobKey(url).key;
  const g = await gate(caller, key);
  if (!g.allowed) {
    const token = await createSession(user.id);
    await sendCard(from, { body: `That’s your ${g.limit} free checks for today.\n\nSharpen, Build or Radar makes them unlimited — and shows you why they’d skip you.`, button: "Make it unlimited", url: `${SITE}/app.html#/sharpen?t=${token}&src=wa`, footer: "Ghosted · notaghost.jobs" });
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
  void logEvent("check", { src, userId: user.id, meta: { verdict: r.verdict, source: "whatsapp", posting_id: r.posting_id } });
  await sendCard(from, format(r, token, g));
}

/** The card, as a WhatsApp message: verdict + count, three facts (positives first on a Real, flags first otherwise),
 *  one hook that only the link answers. Mirrors the Ghost Meter card; nothing here is invented. */
type Card = { body: string; button: string; url: string; footer?: string };
function format(r: CheckResult, token: string, g: { used: number; limit: number | null }): Card {
  const bad = r.signals.filter((s) => s.kind === "bad").sort((a, b) => b.pts - a.pts);
  const ok = r.signals.filter((s) => s.kind === "ok");
  const line = (s: { text: string; strong?: string; tail?: string }) => tidy([s.text, s.strong, s.tail].filter(Boolean).join(" "));
  // On a Real the card leads with what's FOR it; a flag it still shows, phrased as a fact ("in their system since June"), not a contradiction.
  const picks = r.verdict === "Real" ? [...ok.slice(0, 2).map((s) => `✔ ${line(s)}`), ...bad.slice(0, 1).map((s) => `⚠ ${line(s)}`)]
    : r.verdict === "Caution" ? [...bad.slice(0, 2).map((s) => `⚠ ${line(s)}`), ...ok.slice(0, 1).map((s) => `✔ ${line(s)}`)]
    : bad.slice(0, 3).map((s) => `⛔ ${line(s)}`);
  const where = [r.title, r.company, r.location].filter(Boolean).join(" · ");
  const check = `${SITE}/app.html#/check?id=${r.posting_id}&t=${token}&src=wa`;
  const radar = `${SITE}/app.html#/radar?t=${token}&src=wa`;
  const head = r.verdict === "Real" ? `✅ *Real* — ${r.clear} of ${r.checks_run} checks clear`
    : r.verdict === "Caution" ? `⚠️ *Caution* — ${r.flags} of ${r.checks_run} checks flagged`
    : `⛔ *Ghost* — don’t spend time here`;
  // the hook is a sentence; the button carries the link (WhatsApp button labels are capped at 20 characters)
  const [hook, button, url] = r.verdict === "Ghost"
    ? ["*Don’t spend time here.*\nRadar shows you only the real ones, the day they appear.", "See real roles", radar]
    : r.verdict === "Real"
    ? ["*They’re hiring. Will they see you?*\nYour résumé against what they screen for — what you say, what you don’t, and the one line that would change it.", "Sharpen this job", check]
    : ["*Check before you apply.*\nEvery check we ran, and whether your résumé clears the ones that matter.", "See every check", check];
  // testers run on a large allowance; "499 free checks left" reads as a mistake, so only a real daily limit is shown
  const footer = g.limit == null || g.limit > 50 ? "Ghosted · notaghost.jobs" : `${Math.max(0, g.limit - g.used)} free checks left today · Ghosted`;
  return { body: [head, where, "", picks.join("\n"), "", hook].join("\n"), button, url, footer };
}
/** Card lines read as facts, not accusations: "Created 145 days ago in amazon — the page says…" → "In amazon’s system for 145 days; the page says…". */
/** Card lines read as facts, not accusations. "Created 145 days ago in amazon — the page says “1 week ago”" becomes
 *  "In Amazon’s system since June; the page says “1 week ago”". The month is the honest unit for a long-open requisition. */
function tidy(t: string): string {
  const since = (days: string) => { const d = new Date(Date.now() - Number(days) * 86400e3); return d.toLocaleDateString("en-IN", { month: "long", ...(Number(days) > 300 ? { year: "numeric" } : {}) }); };
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return t
    .replace(/^Created (\d+) days ago in (\S+) — the page says (.+)$/i, (_m, d, sys, page) => `In ${cap(sys)}’s system since ${since(d)}; the page says ${page}`)
    .replace(/^We first saw this (\d+) days ago — the page says (.+)$/i, (_m, d, page) => `We’ve seen it since ${since(d)}; the page says ${page}`)
    .replace(/^On the company’s own hiring system \((\w+); (\d+) Bengaluru roles open there today\)$/i, (_m, sys, n) => `On ${cap(sys)}’s own hiring system — ${n} Bengaluru roles open there today`)
    .replace(/^Open for (\d+) days(.*)$/i, (_m, d, rest) => `Open ${d} days${rest}`)
    .replace(/\s+—\s+/g, " — ").replace(/\s{2,}/g, " ").trim();
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

async function graph(path: string, body: unknown): Promise<boolean> {
  if (!env.waToken || !env.waPhoneId) { trace("graph:unconfigured", { token: !!env.waToken, phone: !!env.waPhoneId }); console.error("[whatsapp] not configured"); return false; }
  const res = await fetch(`${GRAPH}/${env.waPhoneId}/${path}`, { method: "POST", headers: { authorization: `Bearer ${env.waToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  trace(res.ok ? "graph:ok" : "graph:error", `${path} ${res.status} ${text.slice(0, 300)}`);
  if (!res.ok) console.error("[whatsapp] graph", res.status, text.slice(0, 300));
  return res.ok;
}
const send = (to: string, text: string) => graph("messages", { messaging_product: "whatsapp", to, type: "text", text: { body: text.slice(0, 4000), preview_url: false } });
/** A card with one button. WhatsApp's interactive "cta_url" message: the body reads like a message, the link sits behind a
 *  button and is never printed (a long signed URL in chat looks like phishing). Limits: body 1024, footer 60, label 20.
 *  If Meta refuses the interactive form for any reason, the same card goes as text with the link on its own line. */
async function sendCard(to: string, c: Card) {
  const ok = await graph("messages", { messaging_product: "whatsapp", to, type: "interactive", interactive: {
    type: "cta_url", body: { text: c.body.slice(0, 1024) }, ...(c.footer ? { footer: { text: c.footer.slice(0, 60) } } : {}),
    action: { name: "cta_url", parameters: { display_text: c.button.slice(0, 20), url: c.url } } } });
  if (!ok) await send(to, `${c.body}\n\n${c.url}`);
}
const markRead = (id: string) => graph("messages", { messaging_product: "whatsapp", status: "read", message_id: id });
