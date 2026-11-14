// QA's own evidence. Two reports, both published without secrets at GET /qa/report so they can be read by anyone
// checking the environment:
//  · isolation — run at every start and on demand. No AI call is made. Each line is something that was actually tried.
//  · pilot     — the ten synthetic candidates through the real product with the real model, inside the AI budget.
import https from "node:https";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
type App = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
import { db } from "../lib/db.js";
import { env } from "../lib/env.js";
import { sendOtp, verifyOtp, createSession } from "../lib/auth.js";
import { PROD_SUPABASE_REFS, QA_PHONE, qaPhone, supabaseRef } from "./guard.js";
import { store, now } from "./state.js";
import { qaSpend } from "./budget.js";
import { JOBS } from "./fixtures.js";
import { expectedFor, meterCases, resumeBytes } from "./catalog.js";

type Line = { check: string; ok: boolean | null; detail: string };
const PUBLIC = () => (process.env.QA_PUBLIC_URL ?? "").replace(/\/$/, "");
const jobUrl = (slug: string) => `${PUBLIC()}/qa/jobs/${slug}`;
const commit = () => (process.env.RENDER_GIT_COMMIT ?? "local").slice(0, 7);

export async function isolationReport(app: App) {
  const out: Line[] = [];
  const add = (check: string, ok: boolean | null, detail: string) => out.push({ check, ok, detail });
  const tried = async (check: string, f: () => Promise<[boolean | null, string]>) => { try { const [ok, d] = await f(); add(check, ok, d); } catch (e: any) { add(check, false, `the check itself failed: ${String(e?.message ?? e).slice(0, 200)}`); } };
  const outboxSince = async (at: string) => (await store.list<any>("qa:outbox:", 50)).filter((r) => r.at >= at);
  const blockedSince = async (at: string) => (await store.list<any>("qa:blocked:", 50)).filter((r) => r.at >= at);

  const ref = supabaseRef(env.supabaseUrl);
  add("Database is the QA project, not production", !!ref && !PROD_SUPABASE_REFS.includes(ref) && ref === process.env.QA_SUPABASE_REF, `connected to project ${ref}; production is ${PROD_SUPABASE_REFS[0]}`);
  await tried("Database was prepared as QA, for this project", async () => { const m = await store.get<any>("qa:environment"); return [m?.name === "qa" && m?.database === ref, `marked for ${m?.database ?? "nothing"}`]; });
  await tried("Database has every table the product uses", async () => { const missing: string[] = []; for (const t of ["users", "otp_codes", "sessions", "resumes", "postings", "plans", "shots", "payments", "previews", "companies", "observations", "outcomes", "employers", "sightings", "reader_control", "events"]) { const r = await db.from(t).select("*").limit(1); if (r.error) missing.push(`${t}: ${r.error.message.slice(0, 60)}`); } return [missing.length === 0, missing.length ? missing.join(" · ") : "16 tables present and readable with the service key"]; });
  await tried("Database holds no real account", async () => { const { data, error } = await db.from("users").select("phone").limit(2000); if (error) return [false, error.message]; const strangers = (data ?? []).filter((u: any) => !QA_PHONE.test(u.phone ?? "")); return [strangers.length === 0, `${(data ?? []).length} accounts, ${strangers.length} that are not QA identities`]; });
  await tried("Database refuses to store a real phone number", async () => { const phone = "+919000000001"; const r = await db.from("users").insert({ phone }).select("id"); if (!r.error) { await db.from("users").delete().eq("phone", phone); return [false, "a real-looking number was accepted (and removed again): the database was not prepared with supabase/qa/qa-database.sql"]; } return [true, `insert refused: ${r.error.message.slice(0, 90)}`]; });
  await tried("Production API cannot be reached from QA", async () => { const at = now(); const r = await fetch("https://notaghost-api.onrender.com/health"); const b = await blockedSince(at); return [r.status === 599 && b.some((x) => x.host === "notaghost-api.onrender.com"), `answer ${r.status} from the QA boundary; recorded in blocked calls: ${b.length > 0}`]; });
  await tried("Production database address is refused", async () => { try { await fetch(`https://${PROD_SUPABASE_REFS[0]}.supabase.co/rest/v1/users?select=id&limit=1`); return [false, "the request was allowed"]; } catch (e: any) { return [/refused/.test(String(e?.message)), String(e?.message)]; } });
  await tried("SMS provider is refused", async () => { try { await fetch("https://control.msg91.com/api/v5/otp", { method: "POST", body: "{}" }); return [false, "the request was allowed"]; } catch (e: any) { return [/not allowed/.test(String(e?.message)), String(e?.message)]; } });
  await tried("Email provider is refused", async () => { try { await fetch("https://api.resend.com/emails", { method: "POST", body: "{}" }); return [false, "the request was allowed"]; } catch (e: any) { return [/not allowed/.test(String(e?.message)), String(e?.message)]; } });
  await tried("A direct connection outside QA is refused", async () => { try { https.get("https://example.com/"); return [false, "the connection was allowed"]; } catch (e: any) { return [/refused/.test(String(e?.message)), String(e?.message)]; } });
  await tried("WhatsApp is simulated: the message lands in the QA outbox and nowhere else", async () => { const at = now(); const r = await fetch(`https://graph.facebook.com/v20.0/${env.waPhoneId}/messages`, { method: "POST", headers: { Authorization: `Bearer ${env.waToken}`, "content-type": "application/json" }, body: JSON.stringify({ messaging_product: "whatsapp", to: qaPhone(1).slice(1), type: "text", text: { body: "QA self-test message" } }) }); const j: any = await r.json(); const o = await outboxSince(at); return [String(j?.messages?.[0]?.id ?? "").startsWith("wamid.QA.") && o.some((m) => m.text === "QA self-test message" && m.delivered === false), `simulator id ${j?.messages?.[0]?.id ?? "none"}; outbox rows written: ${o.length}`]; });
  await tried("A real phone number cannot ask for a sign-in code", async () => { const phone = "+919876543210"; try { await sendOtp(phone); return [false, "a code was generated"]; } catch (e: any) { const { count } = await db.from("otp_codes").select("id", { count: "exact", head: true }).eq("phone", phone); return [(count ?? 0) === 0, `${String(e?.message).slice(0, 80)} · codes stored for it: ${count ?? 0}`]; } });
  await tried("OTP simulator: a QA number's code is captured and signs in", async () => {
    const phone = qaPhone(1); const { data: u } = await db.from("users").select("id").eq("phone", phone).maybeSingle(); if (!u) return [null, "not run: seed the QA identities first"];
    const at = now(); await sendOtp(phone); const m = (await outboxSince(at)).find((r) => r.to === phone && r.template === env.waOtpTemplate); const code = String(m?.params?.[0] ?? "");
    if (!/^\d{6}$/.test(code)) return [false, "no code was captured in the outbox"];
    let wrong = false; try { await verifyOtp(phone, code === "000000" ? "111111" : "000000"); } catch { wrong = true; }
    const user = await verifyOtp(phone, code); return [wrong && user.id === u.id, `code captured in the outbox (not sent); a wrong code was refused: ${wrong}; the right code signed in QA001`]; });
  add("Payments are test mode only", !env.razorpayKeyId || /^rzp_test_/.test(env.razorpayKeyId), env.razorpayKeyId ? "the configured key is a Razorpay test-mode key (a live key stops the service at start)" : "no payment key configured: paid states are set with the QA tools");
  await tried("Payment confirmation with a bad signature is rejected", async () => { const r = await app.request("/payments/webhook", { method: "POST", headers: { "x-razorpay-signature": "0".repeat(64), "content-type": "application/json" }, body: JSON.stringify({ event: "payment.captured" }) }); return [r.status >= 400, `answer ${r.status}`]; });
  await tried("Nothing is served without QA access", async () => { const gated = ["/qa/import", "/qa/import/truth/QA001", "/qa/eval", "/qa/eval/QA001", "/qa/eval/QA001/bundle", "/qa/eval/meter", "/qa/files/QA001.pdf", "/qa/identities", "/qa/outbox"]; const open: string[] = []; for (const p of gated) if ((await app.request(p)).status !== 401) open.push(p); for (const p of ["/qa/import", "/qa/import/check", "/qa/import/jobs", "/qa/import/remove", "/qa/pilot"]) if ((await app.request(p, { method: "POST" })).status !== 401) open.push(`POST ${p}`);
    if (open.length) return [false, `reachable without a code: ${open.join(", ")}`];
    const a = await app.request("/qa/status"); const b = await app.request("/resumes/current"); const c = await app.request("/qa/status", { headers: { "x-qa-access": "x".repeat(40) } }); const d = await app.request("/health"); const h: any = await d.json(); return [a.status === 401 && b.status === 401 && c.status === 401 && h?.env === "qa", `import, evaluation, résumé files and 11 other tools without a code: all 401; tools without a code ${a.status}; product without a code ${b.status}; wrong code ${c.status}; health says env=${h?.env}`]; });
  { const exp = Date.parse(process.env.QA_ACCESS_EXPIRES ?? ""); const days = (exp - Date.now()) / 86400e3; add("QA access expires", days > 0 && days <= 31, `access ends ${process.env.QA_ACCESS_EXPIRES} (${days.toFixed(1)} days); after that every request is refused and the service will not restart`); }
  await tried("AI budget is enforced by the service", async () => { const s = await qaSpend(); return [s.cap_paise > 0 && s.cap_paise <= 100000, `spent ₹${(s.paise / 100).toFixed(2)} of ₹${(s.cap_paise / 100).toFixed(0)}; ${s.left_paise <= 0 ? "STOPPED" : "open"}; at most ${s.concurrency} calls at once`]; });
  await tried("The page-opening browser cannot reach the internet", async () => {
    const { chromium } = await import("playwright-core"); let b: any;
    try { b = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] }); } catch (e: any) { return [null, `not run: the browser did not start here (${String(e?.message).split("\n")[0].slice(0, 80)})`]; }
    try { const p = await b.newPage(); let outside = ""; try { await p.goto("https://example.com/", { timeout: 15000 }); outside = "opened"; } catch (e: any) { outside = String(e?.message).match(/ERR_[A-Z_]+/)?.[0] ?? "failed"; }
      let own = ""; try { const r = await p.goto(`${PUBLIC()}/health`, { timeout: 15000 }); own = String(r?.status()); } catch (e: any) { own = `could not open (${String(e?.message).split("\n")[0].slice(0, 90)})`; }
      return [outside !== "opened", `example.com: ${outside}; QA's own address: ${own}`]; } finally { await b.close().catch(() => {}); } });
  await tried("Real résumés: closed unless authorised, and never opened by the ordinary QA code", async () => { const on = process.env.QA_REAL_RESUMES === "authorised"; const code = { "x-qa-access": process.env.QA_ACCESS_TOKEN ?? "" };
    const paths = ["/qa/real/status", "/qa/real/report", "/qa/real/R001", "/qa/real/R001/original", "/qa/real/audit"]; const got: string[] = [];
    for (const p of paths) { const none = (await app.request(p)).status, qaOnly = (await app.request(p, { headers: code })).status; if (none !== 401 || qaOnly !== (on ? 401 : 403)) got.push(`${p}: no code ${none}, QA code only ${qaOnly}`); }
    for (const p of ["/qa/real/upload", "/qa/real/run", "/qa/real/delete"]) { const qaOnly = (await app.request(p, { method: "POST", headers: code })).status; if (qaOnly !== (on ? 401 : 403)) got.push(`POST ${p}: QA code only ${qaOnly}`); }
    const { data: ids } = await db.from("users").select("phone").like("phone", "+910000002%").limit(40); const lj: any = await (await app.request("/qa/identities", { headers: code })).json().catch(() => ({})); const leak = (lj.identities ?? []).filter((x: any) => /^\+910000002/.test(x.phone)).length;
    return [got.length === 0 && leak === 0, got.length || leak ? `${got.join(" · ")}${leak ? ` · ${leak} real-résumé placeholder(s) visible in the ordinary candidate list` : ""}` : `${on ? `authorised by ${process.env.QA_REAL_AUTHORISED_BY} on ${process.env.QA_REAL_AUTHORISED_ON}; held ${(ids ?? []).length}; deleted after ${process.env.QA_REAL_RETENTION_DAYS} day(s)` : "not authorised: every route answers 403"}; the ordinary QA code alone opens none of the 8 routes`]; });
  add("The automated paid run is switched off", process.env.QA_PAID_RUNS !== "on", process.env.QA_PAID_RUNS === "on" ? "QA_PAID_RUNS is on: the pilot button will spend from the AI budget" : "QA_PAID_RUNS is not set: the pilot refuses to start");
  add("Scheduled jobs do not run by the clock in QA", null, "by construction: the morning Radar, nudges and automatic checks are only started from the QA tools (not a runtime test)");

  const failed = out.filter((l) => l.ok === false).length;
  const report = { at: now(), build: commit(), database: ref, passed: out.filter((l) => l.ok === true).length, failed, not_run: out.filter((l) => l.ok === null).length, safe: failed === 0, checks: out };
  await store.set("qa:report:isolation", report);
  console.log(`[qa] isolation self-test: ${report.passed} passed, ${failed} failed, ${report.not_run} not run`); for (const l of out) if (l.ok === false) console.error(`[qa]   ✗ ${l.check} — ${l.detail}`);
  return report;
}

// ---------- the pilot: real résumés, real model, real product paths ----------
let pilotRunning = false;
export const pilotBusy = () => pilotRunning;
export async function runPilot(app: App, ids: number[], opts: { sharpen: boolean; meter: boolean }) {
  if (pilotRunning) return; pilotRunning = true;
  const started = now(); const spend0 = (await qaSpend()).paise; const people: any[] = []; const meter: any[] = []; let stopped: string | null = null;
  const save = async (done = false) => store.set("qa:report:pilot", { started, finished: done ? now() : null, build: commit(), real_model_calls: true, note: "This is a run log: what the product produced with the real model. It does not judge quality. The independent evaluation of each candidate against ground truth is at /qa/eval/<id>, and of Ghost Meter at /qa/eval/meter.", spend_inr: (((await qaSpend()).paise - spend0) / 100).toFixed(2), stopped, candidates: people, ghost_meter: meter });
  const call = async (token: string | null, method: string, path: string, body?: unknown) => { const r = await app.request(path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : { "x-qa-access": process.env.QA_ACCESS_TOKEN ?? "" }), ...(body instanceof FormData ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) }); const j: any = await r.json().catch(() => ({})); if (j?.code === "qa_budget" || /QA AI budget/.test(String(j?.error))) throw Object.assign(new Error("budget"), { budget: true }); return { status: r.status, j }; };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    for (const n of ids) {
      const cand = await expectedFor(n); const id = `QA${String(n).padStart(3, "0")}`; const row: any = { id, covers: cand.covers, ground_truth: cand.source, steps: [] as any[] }; people.push(row);
      const step = (name: string, ok: boolean | null, detail: unknown) => row.steps.push({ step: name, ok, detail });
      try {
        const { data: u } = await db.from("users").select("id").eq("phone", qaPhone(n)).maybeSingle(); if (!u) { step("identity", false, "not seeded"); continue; }
        const token = await createSession(u.id);
        // 1 · the résumé, through the same upload a person uses
        const rb = await resumeBytes(id); if (!rb) { step("résumé file", false, "no résumé file for this identity: import one"); continue; } const file = rb.buf; const form = new FormData(); form.append("file", new File([new Uint8Array(file)], `${id}.pdf`, { type: "application/pdf" }));
        const up = await call(token, "POST", "/resumes", form); step("résumé read", up.status < 300, up.status < 300 ? { roles: (up.j?.resume?.parsed?.roles ?? up.j?.parsed?.roles ?? []).map((r: any) => `${r.title} — ${r.company} (${r.start}–${r.end})`) } : up.j);
        if (up.status >= 300) continue;
        // 2 · Radar: the Record, then the run, then the list against the fixture's expectations
        const tg = await call(token, "GET", "/radar/test/targets"); const t = tg.j?.targets ?? {};
        step("Record", tg.status < 300, tg.status < 300 ? { functions: t.functions, level: t.level, years: t.years, titles: t.titles, one_line: t.one_line, catalogue: cand.source ? { level: cand.level, years: cand.years, function: cand.fn } : null } : tg.j);
        await call(null, "POST", "/qa/entitlement", { id, state: "paid", product: "radar" });
        const st = await call(token, "POST", "/radar/test/start", {}); let res: any = null;
        if (st.status < 300) for (let i = 0; i < 90; i++) { await wait(5000); const r = await call(token, "GET", "/radar/test/result"); res = r.j; if (["done", "error"].includes(res?.status)) break; }
        const items: any[] = res?.items ?? []; const shown = (label: string) => items.filter((i) => i.label === label).map((i) => i.url);
        const want = cand.for_you.map(jobUrl), never = cand.never.map(jobUrl), fy = shown("for_you"), all = items.filter((i) => i.label).map((i) => i.url);
        step("Radar list", res?.status === "done" ? want.every((w) => fy.includes(w)) && !never.some((x) => all.includes(x)) : false, { status: res?.status ?? st.j, error: res?.error ?? null, for_you: fy, adjacent: shown("adjacent"), stretch: shown("stretch"), expected_for_you_missing: want.filter((w) => !fy.includes(w)), must_not_appear_but_did: never.filter((x) => all.includes(x)) });
        // 3 · Sharpen against the first role the fixture says is theirs: the fit, then (if asked) the document
        const target = cand.sharpen_target ? jobUrl(cand.sharpen_target) : fy[0]; if (!target) { step("Sharpen fit", null, "no target role for this candidate"); await save(); continue; }
        const pv = await call(token, "POST", "/preview", { posting_url: target }); step("Sharpen fit", pv.status < 300, pv.status < 300 ? { job: target, before: pv.j?.score_before, after: pv.j?.score_after, can_lift: pv.j?.can_lift ?? null, counts: pv.j?.counts ?? null } : pv.j);
        if (opts.sharpen && pv.status < 300 && pv.j?.preview_id) {
          await call(null, "POST", "/qa/entitlement", { id, state: "paid", product: "sharpen" });
          const sh = await call(token, "POST", "/shots", { product: "sharpen", posting_url: target, preview_id: pv.j.preview_id }); const sid = sh.j?.shot?.id ?? sh.j?.id; let shot: any = null;
          if (sid) for (let i = 0; i < 72; i++) { await wait(5000); const r = await call(token, "GET", `/shots/${sid}`); shot = r.j?.shot ?? r.j; if (["done", "failed", "error"].includes(shot?.status)) break; }
          const o = shot?.output ?? {}; const rw = o.rewrite ?? {};
          step("Sharpen document", shot?.status === "done", sid ? { status: shot?.status, error: shot?.error ?? null, before: o.before, after: o.after, roles: (rw.roles ?? []).map((r: any) => `${r.title} — ${r.company} (${r.start}–${r.end}) · ${(r.bullets ?? []).length} lines`), gate: o.gate ?? null, verification: o.verification ?? null, pdf: o.pdf_check ?? null, shot_id: sid } : sh.j);
        }
      } catch (e: any) { if (e?.budget) { stopped = `AI budget reached while running ${id}`; break; } step("unexpected error", false, String(e?.message ?? e).slice(0, 300)); }
      await save();
    }
    if (opts.meter && !stopped && ids.length) {
      // Ghost Meter is asked as a signed-in candidate with a plan, so the daily free-check limit does not cut the list short
      const first = `QA${String(ids[0]).padStart(3, "0")}`; await call(null, "POST", "/qa/entitlement", { id: first, state: "paid", product: "sharpen" });
      const { data: u } = await db.from("users").select("id").eq("phone", qaPhone(ids[0])).maybeSingle(); const token = u ? await createSession(u.id) : null;
      for (const g of await meterCases()) {
        try { const r = await call(token, "POST", "/check", { url: jobUrl(g.slug) }); const got = r.status >= 400 ? "error" : String(r.j?.verdict ?? "none");
          meter.push({ page: jobUrl(g.slug), what: g.what, expected: g.expected, acceptable: g.verdicts, got, ok: g.verdicts.map((x) => x.toLowerCase()).includes(got.toLowerCase()), score: r.j?.score ?? null, signals: (r.j?.signals ?? []).map((x: any) => x.label ?? x.title ?? x.id ?? x), said: r.status >= 400 ? r.j?.error : undefined }); }
        catch (e: any) { if (e?.budget) { stopped = "AI budget reached during Ghost Meter"; break; } meter.push({ page: jobUrl(g.slug), ok: false, error: String(e?.message ?? e).slice(0, 200) }); }
        await save();
      }
    }
  } finally { await save(true); pilotRunning = false; }
}
export const pilotRoles = () => JOBS.length;
