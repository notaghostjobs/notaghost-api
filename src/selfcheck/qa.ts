// QA safety self-check: runs on every build of the qa branch (npm run build). It proves, without a database or a network,
// that an unsafe QA configuration is refused and that QA's network boundary sends no message and reaches no stranger.
process.env.GHOSTED_ENV = "qa"; process.env.WA_TOKEN = "qa-simulated"; process.env.QA_PUBLIC_URL = "https://ghosted-qa-api.example"; process.env.SUPABASE_URL = "https://qaqaqaqaqaqaqaqaqaqa.supabase.co";
const { qaProblems, isQa, qaPhone, qaIdOf, qaNumber, QA_PHONE, PROD_SUPABASE_REFS } = await import("../qa/guard.js");
const { installQaNetwork } = await import("../qa/net.js");
const { hasQaAccess } = await import("../qa/routes.js");

let failed = 0; const ok = (name: string, pass: boolean, detail = "") => { console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : ` — ${detail}`}`); if (!pass) failed++; };
const NOW = Date.parse("2026-11-14T10:00:00Z");
const good: Record<string, string> = { GHOSTED_ENV: "qa", SUPABASE_URL: "https://qaqaqaqaqaqaqaqaqaqa.supabase.co", QA_SUPABASE_REF: "qaqaqaqaqaqaqaqaqaqa", RAZORPAY_KEY_ID: "rzp_test_abc123", RAZORPAY_KEY_SECRET: "x", RAZORPAY_WEBHOOK_SECRET: "y", WA_TOKEN: "qa-simulated", WA_PHONE_ID: "qa-simulated", OTP_PROVIDER: "whatsapp",
  QA_ACCESS_TOKEN: "a".repeat(40), QA_ACCESS_EXPIRES: "2026-11-28T00:00:00Z", QA_AI_KEY_IS_SEPARATE: "yes", QA_AI_BUDGET_INR: "1000", QA_PUBLIC_URL: "https://ghosted-qa-api.example", APP_ORIGIN: "https://ghosted-qa.example" };
const bad = (patch: Record<string, string | undefined>, re: RegExp) => qaProblems({ ...good, ...patch }, NOW).some((p) => re.test(p));
console.log("QA safety self-check");
ok("a correct QA configuration is accepted", qaProblems(good, NOW).length === 0, qaProblems(good, NOW).join(" | "));
ok("the production database is refused", bad({ SUPABASE_URL: `https://${PROD_SUPABASE_REFS[0]}.supabase.co`, QA_SUPABASE_REF: PROD_SUPABASE_REFS[0] }, /PRODUCTION/));
ok("a database that was not declared as QA's is refused", bad({ QA_SUPABASE_REF: "someotherproject0000" }, /QA_SUPABASE_REF/) && bad({ QA_SUPABASE_REF: undefined }, /QA_SUPABASE_REF/));
ok("a live Razorpay key is refused", bad({ RAZORPAY_KEY_ID: "rzp_live_abc123" }, /test-mode/));
ok("a real WhatsApp token is refused", bad({ WA_TOKEN: "EAAG-real-token" }, /WhatsApp/) && bad({ WA_PHONE_ID: "104857600000000" }, /WhatsApp/));
ok("an SMS or email provider key is refused", bad({ MSG91_AUTHKEY: "k" }, /SMS and email/) && bad({ RESEND_API_KEY: "re_x" }, /SMS and email/));
ok("a real OTP provider is refused", bad({ OTP_PROVIDER: "msg91" }, /OTP_PROVIDER/) && bad({ OTP_PROVIDER: "dev" }, /OTP_PROVIDER/));
ok("a fixed sign-in code, test phones or an admin secret are refused", bad({ OTP_DEV_CODE: "123456" }, /OTP_DEV_CODE/) && bad({ OTP_TEST_PHONES: "+919999999999" }, /OTP_TEST_PHONES/) && bad({ ADMIN_SECRET: "s" }, /ADMIN_SECRET/));
ok("a short, missing, expired or never-expiring access token is refused", bad({ QA_ACCESS_TOKEN: "short" }, /32 characters/) && bad({ QA_ACCESS_EXPIRES: "2026-11-01T00:00:00Z" }, /expired/) && bad({ QA_ACCESS_EXPIRES: "2027-06-01T00:00:00Z" }, /31 days/) && bad({ QA_ACCESS_EXPIRES: undefined }, /must be a date/));
ok("an undeclared AI key or a budget over ₹1,000 is refused", bad({ QA_AI_KEY_IS_SEPARATE: undefined }, /dedicated QA key/) && bad({ QA_AI_BUDGET_INR: "5000" }, /between 1 and 1000/));
ok("an address that points at production is refused", bad({ APP_ORIGIN: "https://notaghost.jobs" }, /production/) && bad({ QA_PUBLIC_URL: "https://notaghost-api.onrender.com" }, /production/));
ok("QA is off unless switched on", isQa({}) === false && isQa({ GHOSTED_ENV: "production" }) === false && isQa({ GHOSTED_ENV: "qa" }) === true);
ok("QA identities are numbers no phone can have", qaPhone(1) === "+910000001001" && qaPhone(100) === "+910000001100" && qaIdOf("+910000001007") === "QA007" && qaIdOf("+919952037479") === null && qaNumber("qa010") === 10 && qaNumber("QA101") === 0 && QA_PHONE.test(qaPhone(55)) && !/^\+91[6-9]/.test(qaPhone(55)));

// the network boundary, exercised for real: outbound calls made through fetch after it is installed
let reached: string[] = [];
globalThis.fetch = (async (u: any) => { reached.push(String(u)); return new Response("{}", { status: 200 }); }) as any;   // stands in for the real network: records anything that gets through
installQaNetwork();
const wa = await fetch("https://graph.facebook.com/v21.0/qa-simulated/messages", { method: "POST", headers: { Authorization: "Bearer qa-simulated" }, body: JSON.stringify({ messaging_product: "whatsapp", to: "910000001001", type: "template", template: { name: "ghosted_signin_code", components: [{ type: "body", parameters: [{ type: "text", text: "482913" }] }] } }) });
const waBody: any = await wa.json();
ok("a WhatsApp send is answered by the simulator and never leaves", wa.status === 200 && String(waBody.messages?.[0]?.id).startsWith("wamid.QA.") && !reached.some((u) => u.includes("graph.facebook.com")), JSON.stringify([wa.status, waBody, reached]));
let threw = ""; try { await fetch("https://control.msg91.com/api/v5/otp", { method: "POST", body: "{}" }); } catch (e) { threw = (e as Error).message; }
ok("an SMS send is refused", /not allowed/.test(threw) && !reached.some((u) => u.includes("msg91")), threw);
threw = ""; try { await fetch(`https://${PROD_SUPABASE_REFS[0]}.supabase.co/rest/v1/users`); } catch (e) { threw = (e as Error).message; }
ok("a call to the production database is refused at the network", /production database/.test(threw) && !reached.some((u) => u.includes(PROD_SUPABASE_REFS[0])), threw);
const stranger = await fetch("https://www.linkedin.com/jobs/view/1");
ok("a real job site is not reachable from QA", stranger.status === 599 && !reached.some((u) => u.includes("linkedin")), String(stranger.status));
reached = reached.filter((u) => !u.includes("qaqaqaqaqaqaqaqaqaqa.supabase.co"));   // QA's own database is where the outbox is written
await fetch("https://ghosted-qa-api.example/qa/jobs/pm-mid"); await fetch("https://api.anthropic.com/v1/messages");
ok("QA's own pages and the AI provider are reachable, and nothing else got through", reached.length === 2 && reached[0].includes("ghosted-qa-api.example") && reached[1].includes("api.anthropic.com"), JSON.stringify(reached));
process.env.QA_ACCESS_TOKEN = "a".repeat(40); process.env.QA_ACCESS_EXPIRES = new Date(Date.now() + 86400e3).toISOString();
ok("the access token is needed, exact, and expires", hasQaAccess("a".repeat(40)) && !hasQaAccess("a".repeat(39)) && !hasQaAccess("b".repeat(40)) && !hasQaAccess(undefined) && ((process.env.QA_ACCESS_EXPIRES = new Date(Date.now() - 1000).toISOString()), !hasQaAccess("a".repeat(40))));
if (failed) { console.error(`QA safety self-check: ${failed} failed`); process.exit(1); }
console.log("QA safety self-check: all passed"); process.exit(0);
