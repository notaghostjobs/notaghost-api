import "./qa/boot.js";   // FIRST: in QA, an unsafe configuration stops the process here, before any client exists
import { QA, supabaseRef, QA_PHONE } from "./qa/guard.js";
import { qaCtx, rid } from "./qa/state.js";
import { qaRoutes, hasQaAccess } from "./qa/routes.js";
import { doc } from "./routes/doc.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { env } from "./lib/env.js";
import { db } from "./lib/db.js";
import { auth } from "./routes/auth.js";
import { resumes } from "./routes/resumes.js";
import { shots } from "./routes/shots.js";
import { payments } from "./routes/payments.js";
import { whatsapp } from "./routes/whatsapp.js";
import { preview } from "./routes/preview.js";
import { check } from "./routes/check.js";
import { radar, radarPublic } from "./routes/radar.js";
import { open, openPublic } from "./routes/open.js";
import { events } from "./routes/funnel.js";
import { admin } from "./routes/admin.js";
import { snapshotDue } from "./engine/ghost/index.js";

const app = new Hono();
app.use("*", logger());
// ---- QA only: every request carries an id; nothing is served without QA access or a QA session; the tools are mounted ----
if (QA) {
  app.use("*", async (c, next) => {
    const id = rid(); c.header("x-request-id", id); c.header("x-ghosted-env", "qa");
    const path = new URL(c.req.url).pathname;
    const open = c.req.method === "OPTIONS" || path === "/health" || /^\/qa\/(jobs|company|files)\//.test(path) || path === "/qa/report" || path === "/payments/webhook";
    const signed = (c.req.header("authorization") ?? "").startsWith("Bearer ");   // a session: the route's own check decides
    if (!open && !signed && !hasQaAccess(c.req.header("x-qa-access"))) return c.json({ error: "This is the Ghosted QA environment. QA access is required, or it has expired.", request_id: id }, 401);
    await qaCtx.run({ rid: id }, next);
  });
}
const origins = QA ? env.appOrigin.split(",").map((o) => o.trim()).filter(Boolean)   // QA answers its own front end only, never production's
  : [...env.appOrigin.split(",").map((o) => o.trim()).filter(Boolean), "https://notaghost.jobs", "https://www.notaghost.jobs", "https://notaghost-web.onrender.com", "http://localhost:5173"];
app.use("/admin/*", cors({ origin: "*", allowHeaders: ["x-admin", "content-type"], allowMethods: ["GET", "POST", "OPTIONS"] }));  // secret header is the gate
// the browser extension calls /check from chrome-extension:// origins
app.use("*", cors({ origin: (o) => (o && (origins.includes(o) || /^(chrome|moz)-extension:\/\//.test(o)) ? o : origins[0]), allowHeaders: ["authorization", "content-type", "x-admin", "x-qa-access", "x-ghosted-anon", "x-ghosted-src-first", "x-ghosted-src-last"] }));

app.get("/health", async (c) => {
  const { error } = await db.from("users").select("id", { count: "exact", head: true });
  let raw = "";
  try {
    const r = await fetch(`${env.supabaseUrl}/rest/v1/users?select=id&limit=1`, { headers: { apikey: env.supabaseServiceKey, authorization: `Bearer ${env.supabaseServiceKey}` }, signal: AbortSignal.timeout(8000) });
    raw = `${r.status} ${(await r.text()).slice(0, 200)}`;
  } catch (e) { raw = `fetch failed: ${(e as Error).message} ${(e as any)?.cause?.code ?? ""}`; }
  // the reader's last three hours: pages the extension couldn't read, and how many of those were recovered from the board's own copy.
  // "failed" > 0 means users saw "couldn't read" — the canary for a board changing its page under us.
  const since = new Date(Date.now() - 3 * 3600e3).toISOString();
  const { data: ur } = await db.from("reader_control").select("value").like("key", "unreadable:%").gt("updated_at", since);
  const rows = (ur ?? []).map((r: any) => r.value ?? {});
  const reader = { window_h: 3, unreadable: rows.length, recovered: rows.filter((v: any) => v.recovered).length, failed: rows.filter((v: any) => !v.recovered).length };
  if (QA) return c.json({ ok: !error, env: "qa", commit: (process.env.RENDER_GIT_COMMIT ?? "").slice(0, 7) || null, db: error ? "error" : "ok", database: supabaseRef(env.supabaseUrl), access_expires: process.env.QA_ACCESS_EXPIRES });
  return c.json({ ok: !error, v: "0.1.3", commit: (process.env.RENDER_GIT_COMMIT ?? "").slice(0, 7) || null, db: error ? JSON.stringify(error) : "ok", raw, url: env.supabaseUrl, keylen: env.supabaseServiceKey.length, otp: env.otpProvider, dev_code: !!process.env.OTP_DEV_CODE, reader });
});
app.route("/auth", auth);
app.route("/resumes", resumes);
app.route("/shots", shots);
app.route("/d", doc);
app.route("/payments", payments);
app.route("/whatsapp", whatsapp);
app.route("/preview", preview);
app.route("/check", check);
app.route("/radar/public", radarPublic);
app.route("/radar", radar);
app.route("/open/public", openPublic);
app.route("/open", open);
app.route("/events", events);
app.route("/admin", admin);
if (QA) app.route("/qa", qaRoutes(app));

app.onError((err, c) => {
  const status = (err as { status?: number }).status ?? 500;
  if (status >= 500) console.error(err);
  return c.json({ error: status >= 500 ? "Something broke on our side." : err.message }, status as 400);
});

serve({ fetch: app.fetch, port: env.port }, () => console.log(`notaghost-api on :${env.port}`));

// the reader runs in its own worker process (src/reader/worker.ts); this process only serves.
// daily snapshot of every posting we know (signal 21); runs every 6h, re-checks what is due
// WhatsApp nudges for people who said hello and never sent a link: what is due goes out every 5 minutes; templates are created once at boot
import { runNudges, ensureTemplates, notifyRadarMorning } from "./routes/whatsapp.js";
import { radarMorning, panelTick, unstickRuns } from "./routes/radar.js";
setTimeout(() => unstickRuns().then((r) => (r.finished || r.failed) && console.log(`[radar] unstuck runs: ${r.finished} finished, ${r.failed} failed`)).catch((e) => console.error("[radar] unstick", e?.message ?? e)), 75e3);
import { unstickShots, resumeShots } from "./engine/worker.js";
// 75 seconds after boot: by then the instance this one replaced has stopped, so what is still marked running is truly cut off
setTimeout(() => resumeShots().then((n) => n && console.log(`[shots] picked up ${n} cut off by a restart`)).catch((e) => console.error("[shots] resume", e?.message ?? e)), 75e3);
setTimeout(() => unstickShots().then((n) => n && console.log(`[shots] closed ${n} left running by a restart`)).catch((e) => console.error("[shots] unstick", e?.message ?? e)), 60e3);
setInterval(() => unstickShots().catch(() => {}), 10 * 60e3);
import { experienceTick } from "./reader/experience.js";
// In QA none of the scheduled jobs below run by the clock: the morning Radar, nudges, snapshots and the automatic walks
// are started by a tester through the QA clock, so nothing spends the AI budget or writes to the outbox unasked.
if (!QA) {
setTimeout(() => experienceTick().then((r) => r && console.log("[experience] computed")).catch((e) => console.error("[experience]", e?.message ?? e)), 90e3);
setInterval(() => experienceTick().then((r) => r && console.log("[experience] computed")).catch((e) => console.error("[experience]", e?.message ?? e)), 30 * 60e3);
setTimeout(() => panelTick(app).catch((e) => console.error("[radar] panel", e?.message ?? e)), 3 * 60e3);
setInterval(() => panelTick(app).catch((e) => console.error("[radar] panel", e?.message ?? e)), 10 * 60e3);
setInterval(() => radarMorning(notifyRadarMorning).then((n) => n && console.log(`[radar] morning refreshed ${n}`)).catch((e) => console.error("[radar] morning", e?.message ?? e)), 5 * 60e3);
setInterval(() => runNudges().then((n) => n && console.log(`[whatsapp] nudges sent ${n}`)).catch((e) => console.error("[whatsapp] nudges", e?.message ?? e)), 5 * 60e3);
ensureTemplates().then((r) => r.length && console.log("[whatsapp] templates", JSON.stringify(r.map((x: any) => ({ name: x.name, status: x.status ?? x.skipped }))))).catch((e) => console.error("[whatsapp] templates", e?.message ?? e));
setInterval(() => snapshotDue(200).then((n) => n && console.log(`[snapshot] rechecked ${n}`)).catch((e) => console.error("[snapshot]", e)), 6 * 3600e3);
}

// ---- which database is this? QA must be on the QA database; anything else must not be ----
(async () => {
  const { data: marker } = await db.from("reader_control").select("value").eq("key", "qa:environment").maybeSingle();
  if (!QA) { if (marker) { console.error("[qa] REFUSING TO RUN: this database carries the QA marker but GHOSTED_ENV is not qa"); process.exit(1); } return; }
  const { data: people } = await db.from("users").select("phone").limit(1000);
  const strangers = (people ?? []).filter((u: any) => !QA_PHONE.test(u.phone ?? ""));
  if (strangers.length) { console.error(`[qa] REFUSING TO RUN: this database holds ${strangers.length} account(s) that are not QA identities — it is not a QA database`); process.exit(1); }
  const { count: paid } = await db.from("payments").select("id", { count: "exact", head: true }).not("razorpay_payment_id", "is", null).not("razorpay_payment_id", "like", "pay_QA_%").not("razorpay_order_id", "like", "test_%");
  if (paid) console.warn(`[qa] note: ${paid} payment row(s) came through Razorpay test checkout`);
  // the database must have been prepared as QA (supabase/qa/qa-database.sql), and for this very project
  const marked = (marker?.value as any)?.database;
  if (!marker || marked !== supabaseRef(env.supabaseUrl)) { console.error(`[qa] REFUSING TO RUN: this database is ${marker ? `marked for project "${marked}", not the one in SUPABASE_URL` : "not marked as the QA database (run supabase/qa/qa-database.sql in the QA project)"}`); process.exit(1); }
  console.log("[qa] database identity confirmed:", marked);
  // every start proves the isolation again, and publishes the result at /qa/report
  setTimeout(() => import("./qa/selftest.js").then((m) => m.isolationReport(app)).catch((e) => console.error("[qa] self-test", e?.message ?? e)), 15e3);
})().catch((e) => { console.error("[qa] database identity check failed", e?.message ?? e); if (QA) process.exit(1); });
