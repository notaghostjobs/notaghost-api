// WhatsApp: a job link in, a verdict out. Meta's Cloud API calls this webhook; we reply inside the user's own
// conversation (no template needed, free). Verification handshake first; the message flow lands behind it.
import { Hono } from "hono";
import { env } from "../lib/env.js";

export const whatsapp = new Hono();

/** Meta's one-time handshake when the callback URL is saved: echo hub.challenge if the verify token matches. */
whatsapp.get("/webhook", (c) => {
  const mode = c.req.query("hub.mode"), token = c.req.query("hub.verify_token"), challenge = c.req.query("hub.challenge");
  if (mode === "subscribe" && token && env.waVerifyToken && token === env.waVerifyToken) return c.text(challenge ?? "", 200);
  return c.text("forbidden", 403);
});

/** Inbound events. Acknowledged at once (Meta retries anything not 200'd within seconds); handled after the reply. */
whatsapp.post("/webhook", async (c) => {
  let body: any = null;
  try { body = await c.req.json(); } catch { /* ignore */ }
  const msgs = body?.entry?.flatMap((e: any) => e.changes ?? []).flatMap((ch: any) => ch.value?.messages ?? []) ?? [];
  if (msgs.length) console.log("[whatsapp] inbound", msgs.length, msgs.map((m: any) => ({ from: m.from, type: m.type })));
  return c.json({ ok: true });
});
