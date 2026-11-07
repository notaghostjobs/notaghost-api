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
import { events } from "./routes/funnel.js";
import { admin } from "./routes/admin.js";
import { snapshotDue } from "./engine/ghost/index.js";

const app = new Hono();
app.use("*", logger());
const origins = [...env.appOrigin.split(",").map((o) => o.trim()).filter(Boolean), "https://notaghost.jobs", "https://www.notaghost.jobs", "https://notaghost-web.onrender.com", "http://localhost:5173"];
app.use("/admin/*", cors({ origin: "*", allowHeaders: ["x-admin", "content-type"], allowMethods: ["GET", "POST", "OPTIONS"] }));  // secret header is the gate
// the browser extension calls /check from chrome-extension:// origins
app.use("*", cors({ origin: (o) => (o && (origins.includes(o) || /^(chrome|moz)-extension:\/\//.test(o)) ? o : origins[0]), allowHeaders: ["authorization", "content-type", "x-admin", "x-ghosted-anon", "x-ghosted-src-first", "x-ghosted-src-last"] }));

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
  return c.json({ ok: !error, v: "0.1.3", db: error ? JSON.stringify(error) : "ok", raw, url: env.supabaseUrl, keylen: env.supabaseServiceKey.length, otp: env.otpProvider, dev_code: !!process.env.OTP_DEV_CODE, reader });
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
app.route("/events", events);
app.route("/admin", admin);

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
import { radarMorning } from "./routes/radar.js";
import { experienceTick } from "./reader/experience.js";
setTimeout(() => experienceTick().then((r) => r && console.log("[experience] computed")).catch((e) => console.error("[experience]", e?.message ?? e)), 90e3);
setInterval(() => experienceTick().then((r) => r && console.log("[experience] computed")).catch((e) => console.error("[experience]", e?.message ?? e)), 30 * 60e3);
setInterval(() => radarMorning(notifyRadarMorning).then((n) => n && console.log(`[radar] morning refreshed ${n}`)).catch((e) => console.error("[radar] morning", e?.message ?? e)), 5 * 60e3);
setInterval(() => runNudges().then((n) => n && console.log(`[whatsapp] nudges sent ${n}`)).catch((e) => console.error("[whatsapp] nudges", e?.message ?? e)), 5 * 60e3);
ensureTemplates().then((r) => r.length && console.log("[whatsapp] templates", JSON.stringify(r.map((x: any) => ({ name: x.name, status: x.status ?? x.skipped }))))).catch((e) => console.error("[whatsapp] templates", e?.message ?? e));
setInterval(() => snapshotDue(200).then((n) => n && console.log(`[snapshot] rechecked ${n}`)).catch((e) => console.error("[snapshot]", e)), 6 * 3600e3);
