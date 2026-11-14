// The QA environment's first rule: it must be impossible for it to be production. GHOSTED_ENV=qa turns QA on; when it is
// on, the server refuses to start unless every check below passes. When it is off, nothing under src/qa is reachable and
// the server refuses to start against a database that carries the QA marker. This file is pure (no imports that touch
// the network or the database) so the build can test it.
export const PROD_SUPABASE_REFS = ["vviporiiqwykfcetusta"];   // production's project: the QA server will never accept it
export const SIMULATED = "qa-simulated";                        // the only value the WhatsApp settings may hold in QA
export const QA_PHONE = /^\+9100000\d{5}$/;                     // QA identities: numbers no real phone can have (they start with 0)
export const isQa = (e: Record<string, string | undefined> = process.env) => e.GHOSTED_ENV === "qa";
export const QA = isQa();
export const supabaseRef = (url?: string) => (String(url ?? "").match(/^https:\/\/([a-z0-9]{12,})\.supabase\.co\/?$/) ?? [])[1] ?? "";
export const qaPhone = (n: number) => `+9100000${String(1000 + n).padStart(5, "0")}`;            // QA001 → +910000001001
export const qaIdOf = (phone: string) => (QA_PHONE.test(phone) ? `QA${String(Number(phone.slice(-5)) - 1000).padStart(3, "0")}` : null);
export const qaNumber = (id: string) => { const m = /^QA(\d{3})$/.exec(String(id).toUpperCase()); const n = m ? Number(m[1]) : 0; return n >= 1 && n <= 100 ? n : 0; };

/** Everything wrong with a QA configuration. Empty means it may start. */
export function qaProblems(e: Record<string, string | undefined>, now = Date.now()): string[] {
  const p: string[] = [];
  const set = (k: string) => !!(e[k] ?? "").trim();
  const ref = supabaseRef(e.SUPABASE_URL);
  if (!ref) p.push("SUPABASE_URL is not a Supabase project URL (https://<ref>.supabase.co)");
  if (PROD_SUPABASE_REFS.includes(ref)) p.push("SUPABASE_URL is the PRODUCTION project");
  if (!set("QA_SUPABASE_REF") || e.QA_SUPABASE_REF !== ref) p.push("QA_SUPABASE_REF must be set to the QA project's reference and match SUPABASE_URL");
  if (PROD_SUPABASE_REFS.includes(e.QA_SUPABASE_REF ?? "")) p.push("QA_SUPABASE_REF names the PRODUCTION project");
  // payments: test mode or nothing
  if (set("RAZORPAY_KEY_ID") && !/^rzp_test_/.test(e.RAZORPAY_KEY_ID!)) p.push("RAZORPAY_KEY_ID is not a test-mode key (must start with rzp_test_)");
  if (set("RAZORPAY_KEY_SECRET") && !set("RAZORPAY_KEY_ID")) p.push("RAZORPAY_KEY_SECRET is set without a test-mode RAZORPAY_KEY_ID");
  // messaging: simulated or nothing — a real token, sender or mail key means a real person could be messaged
  for (const k of ["WA_TOKEN", "WA_PHONE_ID", "WA_APP_SECRET", "WA_WABA_ID", "WA_VERIFY_TOKEN"]) if (set(k) && e[k] !== SIMULATED) p.push(`${k} must be empty or "${SIMULATED}" — real WhatsApp sending is not allowed`);
  for (const k of ["MSG91_AUTHKEY", "MSG91_TEMPLATE_ID", "MSG91_WA_NUMBER", "RESEND_API_KEY"]) if (set(k)) p.push(`${k} must be empty — real SMS and email sending is not allowed`);
  if (e.OTP_PROVIDER !== "whatsapp" || e.WA_TOKEN !== SIMULATED || e.WA_PHONE_ID !== SIMULATED) p.push(`OTP_PROVIDER must be "whatsapp" with WA_TOKEN and WA_PHONE_ID both "${SIMULATED}" (the code goes to the QA outbox)`);
  // no shortcuts into an account, no production admin secret
  for (const k of ["OTP_DEV_CODE", "OTP_TEST_PHONES", "RADAR_TESTERS", "ADMIN_SECRET"]) if (set(k)) p.push(`${k} must be empty in QA`);
  // access to the QA tools: a long token that expires
  if ((e.QA_ACCESS_TOKEN ?? "").length < 32) p.push("QA_ACCESS_TOKEN must be at least 32 characters");
  const exp = Date.parse(e.QA_ACCESS_EXPIRES ?? "");
  if (!Number.isFinite(exp)) p.push("QA_ACCESS_EXPIRES must be a date (e.g. 2026-11-28T00:00:00+05:30)");
  else if (exp <= now) p.push("QA_ACCESS_EXPIRES is in the past — QA access has expired");
  else if (exp - now > 31 * 86400e3) p.push("QA_ACCESS_EXPIRES is more than 31 days away — access must expire");
  // AI: a separate key, declared, with a ceiling
  if (e.QA_AI_KEY_IS_SEPARATE !== "yes") p.push('QA_AI_KEY_IS_SEPARATE must be "yes": confirm ANTHROPIC_API_KEY is a dedicated QA key, not production\'s');
  const cap = Number(e.QA_AI_BUDGET_INR ?? "1000");
  if (!(cap > 0) || cap > 1000) p.push("QA_AI_BUDGET_INR must be between 1 and 1000");
  // real résumés: off unless the founder has authorised it, in which case it needs its own code, a named authoriser and a short retention
  if (set("QA_REAL_RESUMES")) {
    if (e.QA_REAL_RESUMES !== "authorised") p.push('QA_REAL_RESUMES must be empty, or exactly "authorised" once the founder has authorised the use of real résumés');
    if ((e.QA_REAL_ACCESS_TOKEN ?? "").length < 32) p.push("QA_REAL_ACCESS_TOKEN must be at least 32 characters when real résumés are authorised");
    if (set("QA_REAL_ACCESS_TOKEN") && e.QA_REAL_ACCESS_TOKEN === e.QA_ACCESS_TOKEN) p.push("QA_REAL_ACCESS_TOKEN must be different from QA_ACCESS_TOKEN: real résumés need their own code");
    if ((e.QA_REAL_AUTHORISED_BY ?? "").trim().length < 3) p.push("QA_REAL_AUTHORISED_BY must name the person who authorised the use of real résumés");
    const on = Date.parse(e.QA_REAL_AUTHORISED_ON ?? ""); if (!Number.isFinite(on) || on > now + 86400e3) p.push("QA_REAL_AUTHORISED_ON must be the date of that authorisation (e.g. 2026-11-14)");
    const days = Number(e.QA_REAL_RETENTION_DAYS ?? ""); if (!Number.isInteger(days) || days < 1 || days > 14) p.push("QA_REAL_RETENTION_DAYS must be a whole number from 1 to 14: real résumés are deleted automatically after that many days");
  }
  // where it lives
  if (!/^https:\/\/[a-z0-9.-]+$/.test(e.QA_PUBLIC_URL ?? "")) p.push("QA_PUBLIC_URL must be this service's own https address (no trailing slash)");
  for (const k of ["QA_PUBLIC_URL", "APP_ORIGIN"]) if (/notaghost\.jobs|notaghost-api\.onrender\.com/i.test(e[k] ?? "")) p.push(`${k} points at production`);
  if (!set("APP_ORIGIN")) p.push("APP_ORIGIN must be the QA front end's address");
  return p;
}

// ---- real résumés (only when authorised): their own identity range, apart from the synthetic QA001–QA100 ----
export const REAL_ON = isQa() && process.env.QA_REAL_RESUMES === "authorised";
export const REAL_MAX = 30;
export const realPhone = (n: number) => `+9100000${String(2000 + n).padStart(5, "0")}`;           // R001 → +910000002001 (still a number no phone can have)
export const realNumber = (id: string) => { const m = /^R(\d{3})$/.exec(String(id).toUpperCase()); const n = m ? Number(m[1]) : 0; return n >= 1 && n <= REAL_MAX ? n : 0; };
export const realId = (n: number) => `R${String(n).padStart(3, "0")}`;
export const isRealPhone = (phone: string | null | undefined) => /^\+91000000[2]\d{3}$/.test(String(phone ?? ""));
