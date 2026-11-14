// A runtime check of the QA network boundary, with no database and no secrets: `npx tsx scripts/qa-boundary-check.ts`.
// It starts the QA boundary with placeholder settings and tries the things QA must never do.
const E = process.env;
Object.assign(E, { GHOSTED_ENV: "qa", SUPABASE_URL: "https://qaqaqaqaqaqaqaqaqaqa.supabase.co", QA_SUPABASE_REF: "qaqaqaqaqaqaqaqaqaqa", SUPABASE_SERVICE_ROLE_KEY: "placeholder", ANTHROPIC_API_KEY: "placeholder", QA_AI_KEY_IS_SEPARATE: "yes", QA_AI_BUDGET_INR: "1000",
  RAZORPAY_KEY_ID: "rzp_test_placeholder", RAZORPAY_KEY_SECRET: "placeholder", WA_TOKEN: "qa-simulated", WA_PHONE_ID: "qa-simulated", OTP_PROVIDER: "whatsapp", QA_ACCESS_TOKEN: "x".repeat(40), QA_ACCESS_EXPIRES: new Date(Date.now() + 7 * 86400e3).toISOString().slice(0, 10), QA_PUBLIC_URL: "https://ghosted-qa-api.example.net", APP_ORIGIN: "https://ghosted-qa.example.net" });
for (const k of ["MSG91_AUTH_KEY", "RESEND_API_KEY", "OTP_DEV_CODE", "OTP_TEST_PHONES", "RADAR_TESTERS", "ADMIN_SECRET"]) delete E[k];
let bad = 0; const say = (ok: boolean, what: string, detail = "") => { console.log(`${ok ? "✓" : "✗"} ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) bad++; };
const thrown = async (f: () => unknown) => { try { await f(); return ""; } catch (e: any) { return String(e?.message ?? e); } };
(async () => {
  await import("../src/qa/boot.js");
  const https = (await import("node:https")).default;
  const r = await fetch("https://notaghost-api.onrender.com/health"); say(r.status === 599, "production API: refused by the QA boundary", `answer ${r.status}`);
  let m = await thrown(() => fetch("https://vviporiiqwykfcetusta.supabase.co/rest/v1/users")); say(/production database was refused/.test(m), "production database: refused", m);
  m = await thrown(() => fetch("https://control.msg91.com/api/v5/otp", { method: "POST" })); say(/not allowed/.test(m), "SMS provider: refused", m);
  m = await thrown(() => fetch("https://api.resend.com/emails", { method: "POST" })); say(/not allowed/.test(m), "email provider: refused", m);
  const w: any = await (await fetch("https://graph.facebook.com/v20.0/qa-simulated/messages", { method: "POST", headers: { Authorization: "Bearer qa-simulated" }, body: JSON.stringify({ to: "910000001001", type: "text", text: { body: "hello" } }) })).json(); say(String(w?.messages?.[0]?.id).startsWith("wamid.QA."), "WhatsApp: answered by the simulator, nothing sent", w?.messages?.[0]?.id);
  m = await thrown(() => https.get("https://example.com/")); say(/refused/.test(m), "direct connection to an outside host: refused", m);
  m = await thrown(() => { const q = https.request({ hostname: "api.razorpay.com", path: "/v1/orders", method: "POST" }); q.on("error", () => {}); q.destroy(); }); say(m === "", "Razorpay API with a test-mode key: allowed (request built, not sent)");
  m = await thrown(() => https.request({ hostname: "graph.facebook.com", path: "/", method: "POST" })); say(/refused/.test(m), "WhatsApp over a direct connection: refused", m);
  const { sendOtp } = await import("../src/lib/auth.js"); m = await thrown(() => sendOtp("+919876543210")); say(/QA environment/.test(m), "sign-in code for a real number: refused before anything is stored", m);
  const { chromium } = await import("playwright-core");
  try { const b = await chromium.launch({ headless: true, args: ["--no-sandbox"], executablePath: process.env.QA_CHROMIUM || undefined }); const p = await b.newPage(); const g = await thrown(() => p.goto("https://example.com/", { timeout: 15000 })); say(/ERR_NAME_NOT_RESOLVED/.test(g), "page-opening browser: an outside site does not resolve", g.match(/ERR_[A-Z_]+/)?.[0] ?? g.slice(0, 80)); await b.close(); }
  catch (e: any) { console.log(`– page-opening browser: not run here (${String(e?.message).split("\n")[0].slice(0, 90)})`); }
  console.log(bad ? `\n${bad} FAILED` : "\nQA boundary: all passed"); process.exit(bad ? 1 : 0);
})();
