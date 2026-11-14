// The QA tools: identity selector, OTP inbox, outbox, entitlements, payment scenarios, test clock, faults, inspection,
// reset and seed, and the synthetic job pages. Mounted only when GHOSTED_ENV=qa; every tool needs the QA access token,
// which expires. None of this exists in production.
import { Hono } from "hono";
import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "../lib/db.js";
import { env, PRICES } from "../lib/env.js";
import { createSession } from "../lib/auth.js";
import { companyKey } from "../engine/ghost/canon.js";
import { refreshRadar } from "../routes/radar.js";
import { notifyRadarMorning } from "../routes/whatsapp.js";
import { QA, qaPhone, qaNumber, qaIdOf, QA_PHONE, supabaseRef } from "./guard.js";
import { store, setFault, faultState, now, type FaultKind } from "./state.js";
import { qaSpend, promptVersion } from "./budget.js";
import { EMPLOYERS, FUNCTIONS, JOBS, GM, CANDIDATES, BAND } from "./fixtures.js";
import { MODEL, HOUSEKEEPING } from "../engine/claude.js";
import { isolationReport, runPilot, pilotBusy } from "./selftest.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
const PUBLIC = () => (process.env.QA_PUBLIC_URL ?? "").replace(/\/$/, "");
export const jobUrl = (slug: string) => `${PUBLIC()}/qa/jobs/${slug}`;
const DAY = 86400e3; const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();

/** true when the request carries the QA access token and access has not expired */
export function hasQaAccess(given: string | undefined | null): boolean {
  const want = process.env.QA_ACCESS_TOKEN ?? "", got = String(given ?? "");
  if (!QA || want.length < 32 || got.length !== want.length) return false;
  if (!(Date.parse(process.env.QA_ACCESS_EXPIRES ?? "") > Date.now())) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
const userOf = async (id: string) => { const n = qaNumber(id); if (!n) return null; const { data } = await db.from("users").select("id, phone, name").eq("phone", qaPhone(n)).maybeSingle(); return data ? { ...data, qa: `QA${String(n).padStart(3, "0")}`, n } : null; };
const html = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:760px;margin:0 auto;padding:28px 20px;color:#111}h1{font-size:28px;margin:0 0 4px}.co{color:#444;margin:0}.posted{color:#666;font-size:14px}.qa{background:#fff3cd;border:1px solid #e0c060;border-radius:8px;padding:6px 10px;font-size:12px;margin-bottom:18px}li{margin:3px 0}a.apply{display:inline-block;margin-top:14px;background:#111;color:#fff;border-radius:999px;padding:10px 20px;text-decoration:none}</style></head><body><div class="qa">QA fixture · an invented posting for testing · not a real job</div>${body}</body></html>`;

export function qaRoutes(app: App) {
  const qa = new Hono();

  // ---------- public inside QA: the synthetic pages a tester (and our own reader) opens ----------
  qa.get("/jobs/:slug", async (c) => {
    const slug = c.req.param("slug");
    const g = GM.find((x) => x.slug === slug);
    if (g) {
      if (g.hang) { await new Promise((r) => setTimeout(r, 40000)); return c.text("", 504); }
      const posted = g.first_seen_days != null ? `Posted ${g.first_seen_days} days ago` : "Posted 6 days ago";
      return c.html(html(`${g.title} — ${g.employer}`, g.html(posted) + (g.http ? "" : `<a class="apply" href="${jobUrl(slug)}#apply">Apply</a>`)), (g.http ?? 200) as 200);
    }
    const j = JOBS.find((x) => x.slug === slug);
    if (!j) return c.html(html("Not found", "<h1>404</h1><p>No such posting.</p>"), 404);
    const [, , ...rest] = j.text.split("\n");
    const body = rest.join("\n").trim().split("\n").map((l) => (l.startsWith("•") ? `<li>${l.slice(1).trim()}</li>` : l.trim() ? `<p>${l}</p>` : "")).join("");
    return c.html(html(`${j.title} — ${j.employer}`, `<h1>${j.title}</h1><p class="co">${j.employer} · Bengaluru, Karnataka, India</p><p class="posted">${j.state === "gone" ? "This position is no longer accepting applications." : `Posted ${j.posted_days} days ago`}</p>${body}${j.state === "live" ? `<a class="apply" href="${jobUrl(slug)}#apply">Apply</a>` : ""}`));
  });
  qa.get("/company/:slug", (c) => {
    const e = EMPLOYERS.find((x) => x.slug === c.req.param("slug")); if (!e) return c.html(html("Not found", "<h1>404</h1>"), 404);
    const open = JOBS.filter((j) => j.employer === e.name && j.state === "live");
    return c.html(html(`Careers at ${e.name}`, `<h1>Careers at ${e.name}</h1><p>${e.about}</p><h2>Open roles (${open.length})</h2><ul>${open.map((j) => `<li><a href="${jobUrl(j.slug)}">${j.title}</a> · Bengaluru</li>`).join("")}</ul>`));
  });
  qa.get("/files/:name", async (c) => {
    const name = c.req.param("name"); if (!/^QA\d{3}\.(pdf|docx)$/.test(name)) return c.text("not found", 404);
    try { const buf = await readFile(join(process.cwd(), "seed", "qa", "resumes", name)); return new Response(new Uint8Array(buf), { headers: { "content-type": name.endsWith(".pdf") ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "content-disposition": `attachment; filename="${name}"` } }); }
    catch { return c.text("not found", 404); }
  });

  /** QA's own evidence, readable without the access code: pass/fail lines and synthetic results only, never a secret. */
  qa.get("/report", async (c) => c.json({ env: "qa", isolation: await store.get("qa:report:isolation"), pilot: await store.get("qa:report:pilot"), pilot_running: pilotBusy(), ai: await qaSpend() }));

  // ---------- everything below needs the access token ----------
  qa.use("*", async (c, next) => { if (!hasQaAccess(c.req.header("x-qa-access"))) return c.json({ error: "QA access required, or it has expired." }, 401); await next(); });

  qa.get("/status", async (c) => c.json({ env: "qa", commit: (process.env.RENDER_GIT_COMMIT ?? "").slice(0, 7) || null, database: supabaseRef(env.supabaseUrl), access_expires: process.env.QA_ACCESS_EXPIRES,
    providers: { payments: env.razorpayKeyId ? "razorpay test mode" : "not configured (scenarios only)", whatsapp: "simulated → QA outbox", sms: "blocked", email: "blocked", ai: "real (Anthropic), bounded" },
    ai: await qaSpend(), models: { main: process.env.MODEL_OVERRIDE ?? MODEL, light: HOUSEKEEPING }, rules_version: (process.env.RENDER_GIT_COMMIT ?? "local").slice(0, 7), faults: faultState(), real_fetch_hosts: (process.env.QA_REAL_FETCH_HOSTS ?? "").split(",").filter(Boolean) }));

  qa.get("/identities", async (c) => {
    const { data } = await db.from("users").select("id, phone, name").like("phone", "+9100000%").order("phone");
    const out = [];
    for (const u of data ?? []) { const cand = CANDIDATES.find((x) => qaPhone(x.n) === u.phone); const { data: r } = await db.from("resumes").select("filename").eq("user_id", u.id).eq("is_current", true).maybeSingle(); const { data: p } = await db.from("plans").select("product, shots_total, shots_used, expires_at").eq("user_id", u.id).gt("expires_at", now());
      out.push({ id: qaIdOf(u.phone), phone: u.phone, name: u.name, profile: cand ? { function: FUNCTIONS.find((f) => f.key === cand.fn)?.name, level: cand.level, years: cand.years, covers: cand.covers } : null, resume_file: `${PUBLIC()}/qa/files/${qaIdOf(u.phone)}.pdf`, resume_on_file: r?.filename ?? null, plans: p ?? [] }); }
    return c.json({ identities: out });
  });
  /** the identity selector: a normal session for a synthetic candidate. No code is sent because none is needed here; the
   *  OTP path itself is tested through /auth with the simulator and the inbox below. */
  qa.post("/login", async (c) => {
    const b = z.object({ id: z.string() }).safeParse(await c.req.json().catch(() => ({}))); const u = b.success ? await userOf(b.data.id) : null;
    if (!u) return c.json({ error: "No such QA identity. Seed first, then use QA001–QA100." }, 404);
    await db.from("users").update({ last_seen_at: now() }).eq("id", u.id);
    return c.json({ token: await createSession(u.id), identity: u.qa, phone: u.phone, name: u.name });
  });
  /** the OTP inbox: codes the simulator captured for a QA number (the OTP template carries the code as its first parameter) */
  qa.get("/otp", async (c) => {
    const u = await userOf(c.req.query("id") ?? ""); const phone = u?.phone ?? (QA_PHONE.test(c.req.query("phone") ?? "") ? c.req.query("phone")! : "");
    if (!phone) return c.json({ error: "Give ?id=QA001 or a QA phone." }, 400);
    const rows = (await store.list<any>("qa:outbox:", 300)).filter((r) => r.to === phone && r.template === env.waOtpTemplate);
    const { data: codes } = await db.from("otp_codes").select("created_at, expires_at, used_at, attempts").eq("phone", phone).order("created_at", { ascending: false }).limit(5);
    return c.json({ phone, messages: rows.slice(0, 5).map((r) => ({ at: r.at, code: r.params?.[0] ?? null, status: r.status, delivered: false })), codes: codes ?? [] });
  });
  qa.get("/outbox", async (c) => { const id = (c.req.query("id") ?? "").toUpperCase(); const rows = await store.list<any>("qa:outbox:", Number(c.req.query("limit") ?? 100)); return c.json({ messages: id ? rows.filter((r) => r.identity === id) : rows }); });
  qa.get("/blocked", async (c) => c.json({ calls: await store.list<any>("qa:blocked:", 100) }));
  qa.get("/ai", async (c) => { const calls = await store.list<any>("qa:ai:2", Number(c.req.query("limit") ?? 100)); return c.json({ spend: await qaSpend(), note: "Every call listed is a real model call. There is no mocked-output mode; simulated faults produce errors, never results.", calls }); });

  qa.post("/selftest", async (c) => c.json(await isolationReport(app)));
  /** the pilot: the synthetic candidates through the real product with the real model. Runs in the background; read /qa/report. */
  qa.post("/pilot", async (c) => {
    const b = z.object({ from: z.number().int().min(1).max(100).default(1), to: z.number().int().min(1).max(100).default(10), sharpen: z.boolean().default(true), meter: z.boolean().default(true) }).safeParse(await c.req.json().catch(() => ({})));
    if (!b.success || b.data.to < b.data.from) return c.json({ error: "from, to (1–100), sharpen, meter" }, 400);
    if (pilotBusy()) return c.json({ ok: true, already: true });
    if ((await qaSpend()).left_paise <= 0) return c.json({ error: "The QA AI budget is used up. The pilot will not start." }, 503);
    const ids = Array.from({ length: b.data.to - b.data.from + 1 }, (_, i) => b.data.from + i);
    void runPilot(app, ids, { sharpen: b.data.sharpen, meter: b.data.meter }).catch((e) => console.error("[qa] pilot", e?.message ?? e));
    return c.json({ ok: true, started: ids.map((n) => `QA${String(n).padStart(3, "0")}`), read: `${PUBLIC()}/qa/report` });
  });

  // ---------- seed and reset ----------
  qa.post("/seed", async (c) => {
    const b = z.object({ to: z.number().int().min(1).max(100).default(10) }).safeParse(await c.req.json().catch(() => ({}))); const to = b.success ? b.data.to : 10;
    await store.set("qa:environment", { name: "qa", seeded: now(), database: supabaseRef(env.supabaseUrl) });
    for (let n = 1; n <= to; n++) await db.from("users").upsert({ phone: qaPhone(n), name: CANDIDATES.find((x) => x.n === n)?.name ?? `QA Candidate ${n}`, last_seen_at: now() }, { onConflict: "phone" });
    for (const e of EMPLOYERS) { const live = JOBS.filter((j) => j.employer === e.name && j.state === "live").length;
      await db.from("employers").upsert({ key: companyKey(e.name), name: e.name, website: `${PUBLIC()}/qa/company/${e.slug}`, careers_url: `${PUBLIC()}/qa/company/${e.slug}`, ats: e.feed === "followed" ? "greenhouse" : e.feed === "none" ? "none" : null, ats_ref: e.feed === "followed" ? e.slug : null, source: "seed", resolved_at: e.feed === "unknown" ? null : now(), read_at: e.feed === "followed" ? now() : null, openings: live, blr_openings: live, evidence: "QA fixture" }, { onConflict: "key" }); }
    const slugOf = (name: string) => EMPLOYERS.find((e) => e.name === name)!.slug;
    const rows = JOBS.map((j, i) => ({ source: "greenhouse", source_id: `${slugOf(j.employer)}:${1000 + i}`, employer_key: companyKey(j.employer), company_name: j.employer, title: j.title, location: "Bengaluru, Karnataka, India", url: jobUrl(j.slug), posted_at: ago(j.posted_days), posted_text: `${j.posted_days} days ago`, salary_text: j.pay, blr: true, description: j.text, first_seen: ago(j.posted_days), last_seen: j.state === "gone" ? ago(3) : now(), gone_at: j.state === "gone" ? ago(3) : null, raw: { qa: true, slug: j.slug } }));
    const gm = GM.filter((g) => g.listed).map((g, i) => ({ source: "greenhouse", source_id: `${slugOf(g.employer)}:${5000 + i}`, employer_key: companyKey(g.employer), company_name: g.employer, title: g.title, location: "Bengaluru, Karnataka, India", url: jobUrl(g.slug), posted_at: ago(g.first_seen_days ?? 6), posted_text: `${g.first_seen_days ?? 6} days ago`, salary_text: null, blr: g.slug !== "gm-closed", description: null, first_seen: ago(g.first_seen_days ?? 6), last_seen: g.slug === "gm-closed" ? ago(2) : now(), gone_at: g.slug === "gm-closed" ? ago(2) : null, raw: { qa: true, slug: g.slug } }));
    const up = await db.from("sightings").upsert([...rows, ...gm], { onConflict: "source,source_id" });
    return c.json({ ok: !up.error, error: up.error?.message ?? null, identities: to, employers: EMPLOYERS.length, roles: rows.length, ghost_meter_pages: GM.length });
  });
  async function wipe(u: { id: string; phone: string }) {
    const { data: rs } = await db.from("resumes").select("storage_path").eq("user_id", u.id);
    const paths = (rs ?? []).map((r: any) => r.storage_path).filter(Boolean); if (paths.length) await db.storage.from("resumes").remove(paths).then(() => {}, () => {});
    for (const t of ["shots", "previews", "plans", "payments", "resumes", "sessions"]) await db.from(t).delete().eq("user_id", u.id).then(() => {}, () => {});
    await db.from("otp_codes").delete().eq("phone", u.phone);
    for (const k of [`radar:run:${u.id}`, `radar:unlock:${u.id}`, `radar:seen:${u.id}`, `told:${u.id}`]) await db.from("reader_control").delete().eq("key", k);
    for (const p of [`radar:m:${u.id}:`, `radar:targets:v3:${u.id}:`, `meter:plan:${u.id}:`, `meter:acct:${u.id}`]) await store.del(p);
  }
  qa.post("/reset", async (c) => {
    const b = z.object({ id: z.string().optional(), all: z.boolean().optional(), records: z.boolean().optional() }).safeParse(await c.req.json().catch(() => ({}))); if (!b.success) return c.json({ error: "id or all" }, 400);
    const { data: users } = await db.from("users").select("id, phone").like("phone", "+9100000%");
    const targets = b.data.all ? users ?? [] : (users ?? []).filter((u: any) => qaIdOf(u.phone) === String(b.data.id ?? "").toUpperCase());
    for (const u of targets) await wipe(u as any);
    if (b.data.records) for (const p of ["qa:outbox:", "qa:blocked:"]) await store.del(p);   // the AI log and spend are never reset: the budget is cumulative
    return c.json({ ok: true, reset: targets.map((u: any) => qaIdOf(u.phone)) });
  });

  // ---------- entitlements and payments ----------
  qa.post("/entitlement", async (c) => {
    const b = z.object({ id: z.string(), state: z.enum(["free", "paid", "exhausted", "expired"]), product: z.enum(["sharpen", "radar"]).default("sharpen") }).safeParse(await c.req.json().catch(() => ({}))); const u = b.success ? await userOf(b.data.id) : null;
    if (!b.success || !u) return c.json({ error: "id (QA001…), state (free|paid|exhausted|expired), product (sharpen|radar)" }, 400);
    await db.from("plans").update({ expires_at: ago(0.001) }).eq("user_id", u.id).gt("expires_at", now());
    await db.from("reader_control").delete().eq("key", `radar:unlock:${u.id}`);
    if (b.data.state === "free") return c.json({ ok: true, identity: u.qa, state: "free" });
    const price = PRICES[b.data.product];
    const { data: pay, error } = await db.from("payments").insert({ user_id: u.id, product: b.data.product, amount_paise: price.paise, status: "paid", razorpay_order_id: `order_QA_${Date.now()}`, razorpay_payment_id: `pay_QA_${Date.now()}`, paid_at: now(), raw: { qa: true, set_by: "entitlement" } }).select("id").single();
    if (error || !pay) return c.json({ error: error?.message ?? "could not record" }, 500);
    const { data: plan } = await db.from("plans").insert({ user_id: u.id, product: b.data.product, shots_total: price.shots, shots_used: b.data.state === "exhausted" ? price.shots : 0, expires_at: b.data.state === "expired" ? ago(1) : new Date(Date.now() + price.days * DAY).toISOString(), payment_id: pay.id }).select("*").single();
    return c.json({ ok: true, identity: u.qa, state: b.data.state, plan });
  });
  /** Payment scenarios through the product's own webhook handler, signed with the QA webhook secret. No provider is called. */
  qa.post("/pay", async (c) => {
    const b = z.object({ id: z.string(), product: z.enum(["sharpen", "radar"]).default("sharpen"), scenario: z.enum(["success", "failed", "cancelled", "pending", "duplicate_webhook", "delayed_webhook"]) }).safeParse(await c.req.json().catch(() => ({}))); const u = b.success ? await userOf(b.data.id) : null;
    if (!b.success || !u) return c.json({ error: "id, product, scenario (success|failed|cancelled|pending|duplicate_webhook|delayed_webhook)" }, 400);
    if (!env.razorpayWebhookSecret) return c.json({ error: "RAZORPAY_WEBHOOK_SECRET is not set in QA." }, 400);
    const order = `order_QA_${Date.now()}`, payment = `pay_QA_${Date.now()}`;
    await db.from("payments").insert({ user_id: u.id, product: b.data.product, amount_paise: PRICES[b.data.product].paise, razorpay_order_id: order, raw: { qa: true, scenario: b.data.scenario } });
    const hook = async (event: string) => { const raw = JSON.stringify({ event, payload: { payment: { entity: { id: payment, order_id: order, status: event.split(".")[1] } } } }); const sig = createHmac("sha256", env.razorpayWebhookSecret).update(raw).digest("hex"); const r = await app.request("/payments/webhook", { method: "POST", headers: { "x-razorpay-signature": sig, "content-type": "application/json" }, body: raw }); return { event, http: r.status }; };
    const sent: any[] = []; const s = b.data.scenario;
    if (s === "success") sent.push(await hook("payment.captured"));
    if (s === "duplicate_webhook") { sent.push(await hook("payment.captured")); sent.push(await hook("payment.captured")); }
    if (s === "delayed_webhook") { await new Promise((r) => setTimeout(r, 4000)); sent.push(await hook("payment.captured")); }
    if (s === "failed") sent.push(await hook("payment.failed"));
    if (s === "pending") sent.push(await hook("payment.authorized"));
    const bad = await app.request("/payments/webhook", { method: "POST", headers: { "x-razorpay-signature": "0".repeat(64) }, body: "{}" });
    const { data: pay } = await db.from("payments").select("id, status, amount_paise, receipt_no, paid_at").eq("razorpay_order_id", order).maybeSingle();
    const { data: plans } = await db.from("plans").select("id, product, shots_total, shots_used, expires_at").eq("payment_id", pay?.id ?? "");
    return c.json({ scenario: s, order, webhooks_sent: sent, forged_signature_http: bad.status, payment: pay, plans_opened: (plans ?? []).length, plans, money_moved: false });
  });

  // ---------- test clock ----------
  qa.post("/clock", async (c) => {
    const b = z.object({ id: z.string(), action: z.enum(["radar_morning", "expire_plan", "plan_days_left", "expire_session", "expire_otp"]), days: z.number().optional() }).safeParse(await c.req.json().catch(() => ({}))); const u = b.success ? await userOf(b.data.id) : null;
    if (!b.success || !u) return c.json({ error: "id and action (radar_morning|expire_plan|plan_days_left|expire_session|expire_otp)" }, 400);
    if (b.data.action === "radar_morning") { const r = await refreshRadar(u.id); if (!r) return c.json({ error: "No finished Radar on this identity yet." }, 404); await notifyRadarMorning(u.id, r); return c.json({ ok: true, refreshed: r, note: "The morning message is in the QA outbox." }); }
    if (b.data.action === "expire_plan") { const r = await db.from("plans").update({ expires_at: ago(0.01) }).eq("user_id", u.id).gt("expires_at", now()).select("id"); return c.json({ ok: true, expired: (r.data ?? []).length }); }
    if (b.data.action === "plan_days_left") { const r = await db.from("plans").update({ expires_at: new Date(Date.now() + (b.data.days ?? 1) * DAY).toISOString() }).eq("user_id", u.id).gt("expires_at", now()).select("id"); return c.json({ ok: true, changed: (r.data ?? []).length }); }
    if (b.data.action === "expire_session") { const r = await db.from("sessions").update({ expires_at: ago(0.01) }).eq("user_id", u.id).select("user_id"); return c.json({ ok: true, expired: (r.data ?? []).length }); }
    const r = await db.from("otp_codes").update({ expires_at: ago(0.01) }).eq("phone", u.phone).is("used_at", null).select("id"); return c.json({ ok: true, expired: (r.data ?? []).length });
  });
  qa.post("/fault", async (c) => {
    const b = z.object({ kind: z.enum(["ai_timeout", "ai_rate_limit", "ai_malformed", "parse_fail", "page_unavailable", "wa_fail"]), times: z.number().int().min(0).max(20).default(1) }).safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: "kind (ai_timeout|ai_rate_limit|ai_malformed|parse_fail|page_unavailable|wa_fail), times" }, 400);
    setFault(b.data.kind as FaultKind, b.data.times); return c.json({ ok: true, faults: faultState() });
  });

  // ---------- inspection ----------
  qa.get("/inspect/:id", async (c) => {
    const u = await userOf(c.req.param("id")); if (!u) return c.json({ error: "No such QA identity." }, 404);
    const sel = async (t: string, cols: string) => (await db.from(t).select(cols).eq("user_id", u.id).order("created_at", { ascending: false }).limit(20)).data ?? [];
    const [resumes, previews, shots, plans, payments] = await Promise.all([sel("resumes", "id, created_at, filename, is_current, storage_path, parsed"), sel("previews", "id, created_at, posting_id, score_before, score_after, matches"), sel("shots", "id, created_at, done_at, status, error, input, output"), sel("plans", "id, created_at, product, shots_total, shots_used, expires_at"), sel("payments", "id, created_at, product, amount_paise, status, razorpay_order_id, paid_at")]);
    const run = await store.get<any>(`radar:run:${u.id}`);
    const outbox = (await store.list<any>("qa:outbox:", 300)).filter((r) => r.identity === u.qa).slice(0, 30);
    const ai = (await store.list<any>("qa:ai:2", 400)).filter((r) => r.user === u.id);
    return c.json({ identity: u.qa, run_id: `${u.qa}-${(resumes[0] as any)?.id?.slice(0, 8) ?? "none"}`, candidate: CANDIDATES.find((x) => x.n === u.n) ?? null, user: { id: u.id, phone: u.phone, name: u.name },
      resumes: (resumes as any[]).map((r) => ({ id: r.id, at: r.created_at, filename: r.filename, current: r.is_current, original_file: r.storage_path, record: r.parsed })),
      radar: run ? { status: run.status, started: run.started, finished: run.finished, resume_id: run.resume_id, by_title: run.by_title, scored: run.scored, items: run.items, violations: run.violations ?? [], error: run.error ?? null } : null,
      previews: (previews as any[]).map((p) => ({ id: p.id, at: p.created_at, before: p.score_before, promised: p.score_after, lines: p.matches })),
      sharpens: (shots as any[]).map((s) => ({ id: s.id, at: s.created_at, done_at: s.done_at, status: s.status, error: s.error, job: s.input?.posting_url ?? null, before: s.output?.before, after: s.output?.after, rewrite: s.output?.rewrite ?? null, evidence: s.output?.evidence ?? null, verification: s.output?.verification ?? null, gate: s.output?.gate ?? null, pdf: s.output?.pdf_check ?? null, pdf_path: s.output?.pdf_path ?? null })),
      plans, payments, outbox, ai: { calls: ai.length, paise: ai.reduce((n, r) => n + (r.paise ?? 0), 0), by_prompt: Object.entries(ai.reduce((m: Record<string, number>, r) => ((m[`${r.tag} · ${r.model} · ${r.prompt}`] = (m[`${r.tag} · ${r.model} · ${r.prompt}`] ?? 0) + 1), m), {})).map(([k, n]) => ({ step: k, calls: n })) } });
  });
  /** the fixture catalogue with expected outcomes */
  qa.get("/fixtures", (c) => c.json({
    candidates: CANDIDATES.map((x) => ({ id: `QA${String(x.n).padStart(3, "0")}`, name: x.name, function: FUNCTIONS.find((f) => f.key === x.fn)?.name, level: x.level, years: x.years, covers: x.covers, resume: `${PUBLIC()}/qa/files/QA${String(x.n).padStart(3, "0")}.pdf`, expected_radar: { for_you: x.expect.for_you.map(jobUrl), must_not_appear: x.expect.never.map(jobUrl), notes: x.expect.notes } })),
    employers: EMPLOYERS.map((e) => ({ name: e.name, careers: `${PUBLIC()}/qa/company/${e.slug}`, hiring_system: e.feed })),
    roles: JOBS.map((j) => ({ url: jobUrl(j.slug), title: j.title, employer: j.employer, function: j.fn, level: j.level, years: `${j.band[0]}–${j.band[1]}`, pay: j.pay, state: j.state })),
    ghost_meter: GM.map((g) => ({ url: jobUrl(g.slug), title: g.title, employer: g.employer, what: g.what, expected: g.expect, acceptable: g.verdicts })), bands: BAND, prompt_version_note: `prompt versions are the first 12 hex of sha256 of the instructions, e.g. ${promptVersion("example")}` }));
  return qa;
}
