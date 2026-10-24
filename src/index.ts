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
import { preview } from "./routes/preview.js";
import { check } from "./routes/check.js";
import { snapshotDue } from "./engine/ghost/index.js";

const app = new Hono();
app.use("*", logger());
const origins = [...env.appOrigin.split(",").map((o) => o.trim()).filter(Boolean), "http://localhost:5173"];
app.use("*", cors({ origin: origins, allowHeaders: ["authorization", "content-type"] }));

app.get("/health", async (c) => {
  const { error } = await db.from("users").select("id", { count: "exact", head: true });
  let raw = "";
  try {
    const r = await fetch(`${env.supabaseUrl}/rest/v1/users?select=id&limit=1`, { headers: { apikey: env.supabaseServiceKey, authorization: `Bearer ${env.supabaseServiceKey}` }, signal: AbortSignal.timeout(8000) });
    raw = `${r.status} ${(await r.text()).slice(0, 200)}`;
  } catch (e) { raw = `fetch failed: ${(e as Error).message} ${(e as any)?.cause?.code ?? ""}`; }
  return c.json({ ok: !error, v: "0.1.2", db: error ? JSON.stringify(error) : "ok", raw, url: env.supabaseUrl, keylen: env.supabaseServiceKey.length, otp: env.otpProvider, dev_code: !!process.env.OTP_DEV_CODE });
});
app.route("/auth", auth);
app.route("/resumes", resumes);
app.route("/shots", shots);
app.route("/payments", payments);
app.route("/preview", preview);
app.route("/check", check);

app.onError((err, c) => {
  const status = (err as { status?: number }).status ?? 500;
  if (status >= 500) console.error(err);
  return c.json({ error: status >= 500 ? "Something broke on our side." : err.message }, status as 400);
});

serve({ fetch: app.fetch, port: env.port }, () => console.log(`notaghost-api on :${env.port}`));

// daily snapshot of every posting we know (signal 21); runs every 6h, re-checks what is due
setInterval(() => snapshotDue(200).then((n) => n && console.log(`[snapshot] rechecked ${n}`)).catch((e) => console.error("[snapshot]", e)), 6 * 3600e3);
