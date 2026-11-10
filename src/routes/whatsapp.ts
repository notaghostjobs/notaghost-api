// WhatsApp: a job link in, a verdict out. Meta's Cloud API calls this webhook; we reply inside the user's own
// conversation (a reply to a user-started message needs no template and is free). The user's WhatsApp number is a
// verified phone, so the account exists from the first message and the link we send signs them in — no OTP wall.
// Quota is the signed-in quota (section 7 of the rule book). Nothing outbound is ever sent unprompted.
import { docLink, docToken, receiptToken } from "./doc.js";
import { Hono } from "hono";
import { stampUser, srcOfUser, logEvent, untagMessage } from "../lib/src.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env, receiptItem } from "../lib/env.js";
import { db, activePlan } from "../lib/db.js";
import { createSession } from "../lib/auth.js";
import { gate, refund, type Caller } from "../lib/quota.js";
import { ghostCheck, type CheckResult } from "../engine/ghost/index.js";
import { jobKey, isListingPage } from "../engine/ghost/canon.js";

export const whatsapp = new Hono();
/** The last 50 webhook events and sends, for the read-only audit: did Meta call us, did we reply, what did Graph say. */
export const waTrace: { at: string; kind: string; detail: string }[] = [];
const trace = (kind: string, detail: unknown) => { waTrace.unshift({ at: new Date().toISOString(), kind, detail: String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) }); if (waTrace.length > 50) waTrace.pop(); };
const SITE = "https://notaghost.jobs";
const GRAPH = "https://graph.facebook.com/v21.0";

/** The four nudges for someone who said hello and never sent a link. One mention of the check (with the Share → WhatsApp flow),
 *  three about what changes for them. Stops after four. Texts 3 and 4 are also the bodies of the two marketing templates. */
export const NUDGE_TEXT = [
  "Still here, and I don’t do the “we’ll get back to you” thing.\n\nSend me the job you were about to apply to and I’ll tell you in eight seconds if anyone’s actually hiring for it.\n\nFastest way: open the job on LinkedIn or Naukri, tap *Share → WhatsApp → Ghosted*. The link lands here by itself.",
  "Honest maths. An application takes you about 40 minutes: form, résumé, the “why do you want to work here” essay nobody reads.\n\nOne in four of those postings is already gone from the employer’s own system. That’s an evening a week spent writing to nobody.\n\nSend me the link first and spend the evening on the ones that are real.",
  "Good morning. Once a job comes back Real, I can do one more thing: read your résumé the way their screener reads it and show you the number before you pay a rupee.\n\nMost people find out they’ve done the work but never wrote it down, in the employer’s words. We fix the words. Nothing invented, ever.\n\nStart with a link.",
  "Last message from me, promise. I’m the one job-search thing that won’t spam you.\n\nWhenever you next see a role you’d actually take, send me the link before you apply. I’ll still be here, it’ll still be free, and it was never you.",
];
const NUDGE_TEMPLATE: Record<number, string> = { 2: "ghosted_nudge_morning", 3: "ghosted_nudge_last" };

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

  // Radar's morning: the day's new roles (or a quiet morning), outside the 24-hour window, so templates
  { name: "ghosted_radar_morning", category: "UTILITY", language: "en",
    components: [
      { type: "BODY", text: "Good morning. Radar checked Bengaluru companies’ hiring systems this morning: *{{1}}* new roles for you, {{2}} on your list in all. Tap to see them — they’re ranked by your real shot.", example: { body_text: [["3", "41"]] } },
      { type: "BUTTONS", buttons: [{ type: "URL", text: "See today’s roles", url: "https://notaghost.jobs/app.html#/radar/test" }] },
    ] },
  { name: "ghosted_radar_quiet", category: "UTILITY", language: "en",
    components: [
      { type: "BODY", text: "Good morning. Radar checked this morning: nothing new that clears your bar yet. {{1}} roles still on your list, {{2}} went quiet overnight. We check again tomorrow at 8.", example: { body_text: [["38", "2"]] } },
      { type: "BUTTONS", buttons: [{ type: "URL", text: "See your list", url: "https://notaghost.jobs/app.html#/radar/test" }] },
    ] },

  // nudges 3 and 4 go out more than 24 hours after the person's last message, so they must be templates (Meta reviews them)
  { name: "ghosted_nudge_morning", category: "MARKETING", language: "en",
    components: [{ type: "BODY", text: NUDGE_TEXT[2] }] },
  { name: "ghosted_nudge_last", category: "MARKETING", language: "en",
    components: [{ type: "BODY", text: NUDGE_TEXT[3] }] },
];

/** Creates any template we don't have yet. Called at boot (idempotent) and from POST /templates. */
export async function ensureTemplates(): Promise<any[]> {
  if (!env.waWabaId || !env.waToken) return [];
  const have = await (await fetch(`${GRAPH}/${env.waWabaId}/message_templates?fields=name,status&limit=50`, { headers: { authorization: `Bearer ${env.waToken}` } })).json();
  const names = new Set(((have as any).data ?? []).map((t: any) => t.name));
  const results: any[] = [];
  for (const t of TEMPLATES) {
    if (names.has(t.name)) { results.push({ name: t.name, skipped: "exists" }); continue; }
    const r = await fetch(`${GRAPH}/${env.waWabaId}/message_templates`, { method: "POST", headers: { authorization: `Bearer ${env.waToken}`, "content-type": "application/json" }, body: JSON.stringify(t) });
    results.push({ name: t.name, status: r.status, body: await r.json() });
  }
  return results;
}
async function templateApproved(name: string): Promise<boolean> {
  try {
    const r = await (await fetch(`${GRAPH}/${env.waWabaId}/message_templates?fields=name,status&name=${name}`, { headers: { authorization: `Bearer ${env.waToken}` } })).json();
    return ((r as any).data ?? []).some((t: any) => t.name === name && t.status === "APPROVED");
  } catch { return false; }
}
whatsapp.get("/templates", async (c) => {
  if (!env.waWabaId || !env.waToken) return c.json({ error: "WA_WABA_ID / WA_TOKEN not set" }, 500);
  const r = await fetch(`${GRAPH}/${env.waWabaId}/message_templates?fields=name,status,category,rejected_reason&limit=50`, { headers: { authorization: `Bearer ${env.waToken}` } });
  return c.json(await r.json());
});
whatsapp.post("/templates", async (c) => {
  if (!env.waWabaId || !env.waToken) return c.json({ error: "WA_WABA_ID / WA_TOKEN not set" }, 500);
  return c.json({ results: await ensureTemplates() });
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

// Nudges for a hello without a link. State lives in reader_control (survives deploys): key nudge:<digits>,
// value { at: opened, sent: n, next: iso, done }. A tick every 5 minutes sends what is due. Any inbound link ends the sequence.
const IST = 5.5 * 3600e3;
function nextIstMorning(fromMs: number, daysAhead: number): number {
  // 10:00 IST on the given number of days after `fromMs`
  const d = new Date(fromMs + IST); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + daysAhead); d.setUTCHours(10, 0, 0, 0);
  return d.getTime() - IST;
}
function nudgeDue(step: number, openedMs: number): number {
  if (step === 0) return openedMs + 20 * 60e3;          // 20 minutes
  if (step === 1) return openedMs + 3 * 3600e3;          // 3 hours
  if (step === 2) return nextIstMorning(openedMs, 1);     // next morning 10:00 IST
  return nextIstMorning(openedMs, 3);                     // 3 days later, 10:00 IST, then stop
}
async function startNudges(from: string) {
  const key = `nudge:${from}`;
  const { data } = await db.from("reader_control").select("value").eq("key", key).maybeSingle();
  if (data) return;                                      // anyone we have ever nudged, or who ever sent a link, is left alone
  const at = Date.now();
  await db.from("reader_control").upsert({ key, value: { at, sent: 0, next: new Date(nudgeDue(0, at)).toISOString(), done: false }, updated_at: new Date().toISOString() });
}
async function endNudges(from: string) {
  const key = `nudge:${from}`;
  await db.from("reader_control").upsert({ key, value: { done: true, sent: -1, linked: true }, updated_at: new Date().toISOString() });
}
export async function runNudges(): Promise<number> {
  const now = Date.now();
  const { data } = await db.from("reader_control").select("key,value").like("key", "nudge:%").limit(500);
  let n = 0;
  for (const row of data ?? []) {
    const v: any = row.value ?? {}; if (v.done || !v.next || Date.parse(v.next) > now) continue;
    const from = row.key.slice("nudge:".length), step = Number(v.sent ?? 0);
    let ok = false;
    const tpl = NUDGE_TEMPLATE[step];
    if (tpl) {
      if (!(await templateApproved(tpl))) {
        // not approved yet: try again in an hour, but never let a step slip past the next one's time
        const retry = Math.min(now + 3600e3, step < 3 ? nudgeDue(step + 1, Number(v.at)) : now + 3600e3);
        const give_up = step === 3 && now > nudgeDue(3, Number(v.at)) + 48 * 3600e3;
        await db.from("reader_control").upsert({ key: row.key, value: give_up ? { ...v, done: true } : { ...v, next: new Date(retry).toISOString() }, updated_at: new Date().toISOString() });
        continue;
      }
      ok = await graph("messages", { messaging_product: "whatsapp", to: from, type: "template", template: { name: tpl, language: { code: "en" } } });
    } else {
      ok = await send(from, NUDGE_TEXT[step] + "\n\n_Ghosted · notaghost.jobs_");
    }
    const sent = step + 1, done = sent >= NUDGE_TEXT.length || !ok;
    await db.from("reader_control").upsert({ key: row.key, value: { ...v, sent, done, next: done ? null : new Date(nudgeDue(sent, Number(v.at))).toISOString() }, updated_at: new Date().toISOString() });
    if (ok) { n++; void logEvent("wa_nudge", { meta: { step: sent } }); }
  }
  return n;
}

async function handle(m: any) {
  if (!m?.id || !m?.from || !once(m.id)) return;
  const from: string = String(m.from).replace(/\D/g, "");                 // E.164 digits without '+', e.g. 9198765...
  const rawText: string = m.type === "text" ? String(m.text?.body ?? "") : m.type === "interactive" ? String(m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "") : "";
  await markRead(m.id);
  // a prefilled message from a post carries its channel in a trailing bracket — "(IF)" → wa-if; a hand-typed message is wa-direct
  const { text, tag } = untagMessage(rawText);
  const url = firstUrl(text);
  if (!url) {
    // first contact from the site arrives as the opener; anything else without a link gets the short ask
    const opener = /done applying into the dark|show me what.s real/i.test(text);
    await send(from, opener
      ? "You’ve come to the right place. Let’s end that together.\n\nSend me any job link and in about eight seconds I’ll tell you if the role is real — with every reason.\n\nFastest way: in LinkedIn or Naukri, on the job you’re looking at, tap *Share → WhatsApp → Ghosted*. The link lands here on its own.\n\n_Ghosted · notaghost.jobs_"
      : "I need the link itself — on the job, tap *Share → Copy link*, then paste it here. LinkedIn, Naukri or any careers page.\n\n_Ghosted · notaghost.jobs_");
    startNudges(from).catch((e) => console.error("[whatsapp] nudge start", e?.message ?? e));
    return;
  }
  endNudges(from).catch(() => {});
  const user = await userFor(from);
  await stampUser(user.id, { first: tag ?? "wa-direct", last: tag ?? "wa-direct" });
  const src = await srcOfUser(user.id);
  void logEvent("wa_in", { src, userId: user.id, meta: { tagged: !!tag } });
  const caller: Caller = await callerFor(user);
  if (isListingPage(url)) { await send(from, "That link is a search page, not a job. Open the job you want and send me the link from its own page."); return; }
  const key = jobKey(url).key;
  const g = await gate(caller, key);
  if (!g.allowed) {
    const token = await createSession(user.id);
    await sendCard(from, { body: `That’s your ${g.limit} free checks for today.\n\nA Sharpen plan makes them unlimited — and shows you why they’d skip you.`, button: "Make it unlimited", url: `${SITE}/app.html#/sharpen?t=${token}&src=wa`, footer: "Ghosted · notaghost.jobs" });
    return;
  }
  let r: CheckResult;
  try {
    r = await ghostCheck({ url, page: { source: "site" } }, { quick: true });
  } catch (e) {
    await refund(caller, key).catch(() => {});
    const msg = (e as Error).message ?? "";
    console.error("[whatsapp] check", msg.slice(0, 200));
    // a 422 is a message for the person (not a job posting, a search page, a page we can't read); anything else is ours
    await send(from, (e as any)?.status === 422 && msg ? msg : "I couldn’t read that posting just now. If it’s a LinkedIn or Naukri link, open it in Chrome with the Ghosted extension — or try again in a minute.");
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
  const head = r.verdict === "Real" ? `✅ *Real* — ${r.clear} of ${r.checks_run} checks clear`
    : r.verdict === "Caution" ? `⚠️ *Caution* — ${r.flags} of ${r.checks_run} checks flagged`
    : `⛔ *Ghost* — don’t spend time here`;
  // the hook is a sentence; the button carries the link (WhatsApp button labels are capped at 20 characters)
  const [hook, button, url] = r.verdict === "Ghost"
    ? ["*Don’t spend time here.*\nSend me the next link — the check is free.", "See every check", check]
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

/** After a shot lands: the approved "document ready" template (works outside the 24-hour window) and the PDF itself as a
 *  WhatsApp document, so the phone has the file where the person already is. Both best-effort; the page is the source of truth. */
export async function notifyDocumentReady(userId: string, shotId: string, d: { title: string; company: string; before: number; after: number; pdf_path: string; filename: string }) {
  try {
    const { data: u } = await db.from("users").select("phone").eq("id", userId).maybeSingle();
    const to = String(u?.phone ?? "").replace(/\D/g, ""); if (!to) return;
    await graph("messages", { messaging_product: "whatsapp", to, type: "template", template: { name: "ghosted_document_ready", language: { code: "en" }, components: [
      { type: "body", parameters: [{ type: "text", text: d.title.slice(0, 60) }, { type: "text", text: d.company.slice(0, 40) }, { type: "text", text: String(d.before) }, { type: "text", text: String(d.after) }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: docToken(shotId) }] },
    ] } });
    await graph("messages", { messaging_product: "whatsapp", to, type: "document", document: { link: docLink(shotId), filename: d.filename, caption: `Your résumé for ${d.title} at ${d.company} — ${d.after}% fit, as promised.` } });
  } catch (e: any) { console.error("[whatsapp] document ready", e?.message ?? e); }
}
/** Radar's 8am: the morning's new roles, or a quiet morning. Template first (works outside the 24-hour window); if Meta
 *  hasn't approved it yet, the same words as plain text, which lands only if they wrote to us in the last day. */
export async function notifyRadarMorning(userId: string, r: { new_shots: number; gone: number; shots: number }) {
  try {
    const { data: u } = await db.from("users").select("phone").eq("id", userId).maybeSingle();
    const to = String(u?.phone ?? "").replace(/\D/g, ""); if (!to) return;
    const url = "https://notaghost.jobs/app.html#/radar/test";
    if (r.new_shots > 0) {
      const ok = await graph("messages", { messaging_product: "whatsapp", to, type: "template", template: { name: "ghosted_radar_morning", language: { code: "en" }, components: [
        { type: "body", parameters: [{ type: "text", text: String(r.new_shots) }, { type: "text", text: String(r.shots) }] } ] } });
      if (!ok) await sendCard(to, { body: `Good morning. Radar checked Bengaluru companies’ hiring systems this morning: *${r.new_shots}* new role${r.new_shots === 1 ? "" : "s"} for you, ${r.shots} on your list in all. Ranked by your real shot.`, button: "See today’s roles", url });
    } else {
      const ok = await graph("messages", { messaging_product: "whatsapp", to, type: "template", template: { name: "ghosted_radar_quiet", language: { code: "en" }, components: [
        { type: "body", parameters: [{ type: "text", text: String(r.shots) }, { type: "text", text: String(r.gone) }] } ] } });
      if (!ok) await sendCard(to, { body: `Good morning. Radar checked this morning: nothing new that clears your bar yet. ${r.shots} roles still on your list, ${r.gone} went quiet overnight. We check again tomorrow at 8.`, button: "See your list", url });
    }
  } catch (e: any) { console.error("[whatsapp] radar morning", e?.message ?? e); }
}
/** Receipt on WhatsApp right after payment (approved template ghosted_receipt). The list price is shown struck while the launch offer runs. */
export async function notifyReceipt(userId: string, p: { id: string; receipt_no: string; amount_paise: number; product: string; shots: number; days: number; list_paise?: number }) {
  try {
    const { data: u } = await db.from("users").select("phone").eq("id", userId).maybeSingle();
    const to = String(u?.phone ?? "").replace(/\D/g, ""); if (!to) return;
    const rupees = (n: number) => (n / 100).toLocaleString("en-IN");
    const item = receiptItem(p.product, p.shots, p.days) + (p.list_paise && p.list_paise > p.amount_paise ? ` (launch offer, ~₹${rupees(p.list_paise)}~)` : "");
    const date = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
    await graph("messages", { messaging_product: "whatsapp", to, type: "template", template: { name: "ghosted_receipt", language: { code: "en" }, components: [
      { type: "body", parameters: [{ type: "text", text: p.receipt_no }, { type: "text", text: item }, { type: "text", text: rupees(p.amount_paise) }, { type: "text", text: date }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: receiptToken(p.id) }] },
    ] } });
  } catch (e: any) { console.error("[whatsapp] receipt", e?.message ?? e); }
}
const markRead = (id: string) => graph("messages", { messaging_product: "whatsapp", status: "read", message_id: id });
