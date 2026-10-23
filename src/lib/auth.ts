import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Context, Next } from "hono";
import { db, type User } from "./db.js";
import { env } from "./env.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export const PHONE_RE = /^\+91\d{10}$/;

// ---------- OTP ----------
export async function sendOtp(phone: string) {
  // rate limit: max 3 codes per phone per 10 minutes
  const since = new Date(Date.now() - 10 * 60e3).toISOString();
  const { count } = await db
    .from("otp_codes")
    .select("id", { count: "exact", head: true })
    .eq("phone", phone)
    .gt("created_at", since);
  if ((count ?? 0) >= 3) throw Object.assign(new Error("Too many codes. Wait ten minutes."), { status: 429 });

  const code = env.otpProvider === "dev" && process.env.OTP_DEV_CODE ? process.env.OTP_DEV_CODE : String(randomInt(100000, 999999));
  await db.from("otp_codes").insert({
    phone,
    code_hash: sha(phone + code),
    expires_at: new Date(Date.now() + 5 * 60e3).toISOString(),
  });
  await deliverOtp(phone, code);
}

async function deliverOtp(phone: string, code: string) {
  if (env.otpProvider === "dev") {
    console.log(`[otp] ${phone} -> ${code}`);
    return;
  }
  if (env.otpProvider === "msg91") {
    const r = await fetch("https://control.msg91.com/api/v5/otp", {
      method: "POST",
      headers: { authkey: env.msg91AuthKey, "content-type": "application/json" },
      body: JSON.stringify({ template_id: env.msg91TemplateId, mobile: phone.replace("+", ""), otp: code }),
    });
    if (!r.ok) throw new Error(`msg91 ${r.status}`);
    return;
  }
  // TODO email provider (Resend) once the user's email is known
  throw new Error("OTP provider not configured");
}

export async function verifyOtp(phone: string, code: string): Promise<User> {
  const { data: rows } = await db
    .from("otp_codes")
    .select("*")
    .eq("phone", phone)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1);
  const otp = rows?.[0];
  if (!otp) throw Object.assign(new Error("Code expired. Ask for a new one."), { status: 400 });
  if (otp.attempts >= 5) throw Object.assign(new Error("Too many tries. Ask for a new code."), { status: 429 });

  if (otp.code_hash !== sha(phone + code)) {
    await db.from("otp_codes").update({ attempts: otp.attempts + 1 }).eq("id", otp.id);
    throw Object.assign(new Error("Wrong code."), { status: 400 });
  }
  await db.from("otp_codes").update({ used_at: new Date().toISOString() }).eq("id", otp.id);

  // upsert user
  const { data: user, error } = await db
    .from("users")
    .upsert({ phone, last_seen_at: new Date().toISOString() }, { onConflict: "phone" })
    .select("id, phone, email, name, city")
    .single();
  if (error || !user) throw new Error(error?.message ?? "user upsert failed");
  return user;
}

// ---------- sessions ----------
export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  await db.from("sessions").insert({
    token: sha(token),
    user_id: userId,
    expires_at: new Date(Date.now() + 90 * 86400e3).toISOString(),
  });
  return token;
}

export async function requireUser(c: Context, next: Next) {
  const h = c.req.header("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return c.json({ error: "Sign in first." }, 401);
  const { data } = await db
    .from("sessions")
    .select("user_id, expires_at, users(id, phone, email, name, city)")
    .eq("token", sha(token))
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (!data?.users) return c.json({ error: "Session expired. Sign in again." }, 401);
  c.set("user", data.users as unknown as User);
  await next();
}
