import { Hono } from "hono";
import { z } from "zod";
import { PHONE_RE, sendOtp, verifyOtp, createSession, requireUser } from "../lib/auth.js";

export const auth = new Hono<{ Variables: { user: import("../lib/db.js").User } }>();

auth.post("/otp", async (c) => {
  const body = z.object({ phone: z.string().regex(PHONE_RE) }).safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "Phone must be +91 and ten digits." }, 400);
  await sendOtp(body.data.phone);
  return c.json({ ok: true });
});

auth.post("/verify", async (c) => {
  const body = z
    .object({ phone: z.string().regex(PHONE_RE), code: z.string().length(6) })
    .safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "Phone and six-digit code." }, 400);
  const user = await verifyOtp(body.data.phone, body.data.code);
  const token = await createSession(user.id);
  return c.json({ token, user });
});

auth.get("/me", requireUser, (c) => c.json({ user: c.get("user") }));
