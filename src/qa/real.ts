// Real résumés in QA — only when the founder has authorised it (QA_REAL_RESUMES=authorised), behind a second access code
// that the ordinary QA code does not open. The files are stored and served byte for byte as uploaded. They are run through
// the product's own upload, Record and Radar code against QA's job fixtures. Nothing is messaged to anyone, no account
// with a real phone number is created, nothing is charged. Everything is deleted automatically after the retention period,
// or at once on request, or as soon as the authorisation is withdrawn.
import { Hono } from "hono";
import { z } from "zod";
import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "../lib/db.js";
import { createSession } from "../lib/auth.js";
import { extractText } from "../engine/extract.js";
import { REAL_ON, REAL_MAX, realId, realNumber, realPhone } from "./guard.js";
import { store, now } from "./state.js";
import { qaSpend } from "./budget.js";
import { allJobs } from "./catalog.js";
import { checkRecord, checkRadar, checkSharpen } from "./realcheck.js";
import { PRICES } from "../lib/env.js";
import { DISCOVERY_ON } from "./guard.js";
import { isFixtureUrl, qaPoolMode } from "./pool.js";
import { verifyListing, type Evidence } from "./discovery.js";
import type { JobIn } from "./evaluate.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type Entry = { id: string; n: number; filename: string; sha256: string; bytes: number; path: string; uploaded_at: string; expires_at: string; status: "uploaded" | "running" | "done" | "failed" | "stopped_budget"; steps: { at: string; step: string; ok: boolean; detail: string }[]; upload_error: string | null; radar_error: string | null; spend_paise: number; ran_at: string | null; pool_mode?: "fixtures" | "real"; evidence?: Evidence[]; sharpens?: { shot_id: string | null; url: string; sighting_id: number | null; at: string; status: string; error: string | null; before?: number; after?: number; spend_paise: number }[];
  review: { at: string; verdict: "accurate" | "issues"; parsing_errors: string[]; wrong_matches: string[]; missed: string[]; notes: string } | null };
const KEY = (id: string) => `qa:real:entry:${id}`;
const DAYS = () => Number(process.env.QA_REAL_RETENTION_DAYS ?? "7");
const SITE = () => (process.env.APP_ORIGIN ?? "").split(",")[0].trim().replace(/\/$/, "");
const entries = async () => (await store.list<Entry>("qa:real:entry:", 100)).sort((a, b) => a.n - b.n);
const userOf = async (n: number) => (await db.from("users").select("id, phone").eq("phone", realPhone(n)).maybeSingle()).data as { id: string; phone: string } | null;
const audit = (action: string, detail: Record<string, unknown>, tester: string) => store.log("realaudit", { action, tester: tester.slice(0, 40) || null, ...detail });

function hasRealAccess(given: string | undefined | null) { const want = process.env.QA_REAL_ACCESS_TOKEN ?? "", got = String(given ?? ""); if (!REAL_ON || want.length < 32 || got.length !== want.length) return false; return timingSafeEqual(Buffer.from(got), Buffer.from(want)); }

/** remove everything held about one real résumé: the original file, the product's copy, the Record, the Radar run, sessions, simulated messages, the account row */
export async function purge(e: Entry, why: string) {
  const u = await userOf(e.n); const gone: string[] = [];
  await db.storage.from("resumes").remove([e.path]).then(() => gone.push("original file"), () => {});
  if (u) {
    const { data: rs } = await db.from("resumes").select("storage_path").eq("user_id", u.id); const paths = (rs ?? []).map((r: any) => r.storage_path).filter(Boolean);
    if (paths.length) await db.storage.from("resumes").remove(paths).then(() => gone.push("product's copy of the file"), () => {});
    const { data: sh } = await db.from("shots").select("output").eq("user_id", u.id); const pdfs = (sh ?? []).map((x: any) => x.output?.pdf_path).filter(Boolean); if (pdfs.length) await db.storage.from("outputs").remove(pdfs).then(() => gone.push(`${pdfs.length} Sharpen PDF(s)`), () => {});
    for (const t of ["shots", "previews", "plans", "payments", "resumes", "sessions"]) await db.from(t).delete().eq("user_id", u.id).then(() => {}, () => {});
    gone.push("Record", "sessions");
    for (const k of [`radar:run:${u.id}`, `radar:unlock:${u.id}`, `radar:seen:${u.id}`, `told:${u.id}`]) await db.from("reader_control").delete().eq("key", k);
    for (const p of [`radar:m:${u.id}:`, `radar:targets:v3:${u.id}:`, `meter:plan:${u.id}:`, `meter:acct:${u.id}`, `radar:q:${u.id}`]) await store.del(p);
    gone.push("Radar run");
    const { data: msgs } = await db.from("reader_control").select("key, value").like("key", "qa:outbox:%").limit(2000); const mine = (msgs ?? []).filter((m: any) => m.value?.to === u.phone || m.value?.to === u.phone.slice(1)).map((m: any) => m.key);
    if (mine.length) { await db.from("reader_control").delete().in("key", mine); gone.push(`${mine.length} simulated message(s)`); }
    await db.from("otp_codes").delete().eq("phone", u.phone); await db.from("users").delete().eq("id", u.id).then(() => gone.push("account row"), () => {});
  }
  await db.from("reader_control").delete().eq("key", KEY(e.id));
  await store.log("realaudit", { action: "deleted", id: e.id, why, removed: gone });
  return gone;
}
/** retention: anything past its date goes; and if the authorisation is no longer in place, everything goes */
export async function sweepReal() { let n = 0; for (const e of await entries()) if (!REAL_ON || Date.parse(e.expires_at) <= Date.now()) { await purge(e, REAL_ON ? "retention period ended" : "authorisation is not in place"); n++; } return n; }

let running = false;
async function runAll(app: App, list: Entry[]) {
  if (running) return; running = true;
  const call = async (token: string, method: string, path: string, body?: unknown) => { const r = await app.request(path, { method, headers: { authorization: `Bearer ${token}`, ...(body instanceof FormData || body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) }); const j: any = await r.json().catch(() => ({})); return { status: r.status, j, budget: j?.code === "qa_budget" || /QA AI budget/.test(String(j?.error ?? "")) }; };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    for (const e0 of list) {
      const e = (await store.get<Entry>(KEY(e0.id))) ?? e0; if (Date.parse(e.expires_at) <= Date.now()) continue;
      if ((await qaSpend()).left_paise <= 0) { e.status = "stopped_budget"; e.steps.push({ at: now(), step: "start", ok: false, detail: "the QA AI budget is used up; nothing was sent to the model" }); await store.set(KEY(e.id), e); continue; }
      const before = (await qaSpend()).paise; e.status = "running"; e.pool_mode = await qaPoolMode(); e.evidence = []; e.steps = []; e.upload_error = null; e.radar_error = null; e.ran_at = now(); await store.set(KEY(e.id), e);
      const step = (s: string, ok: boolean, detail: string) => e.steps.push({ at: now(), step: s, ok, detail });
      let token = ""; let uid = "";
      try {
        await db.from("users").upsert({ phone: realPhone(e.n), name: `Real résumé ${e.id}`, last_seen_at: now() }, { onConflict: "phone" }); const u = await userOf(e.n); if (!u) throw new Error("the placeholder account could not be created"); uid = u.id;
        // a clean slate for this slot, then the original bytes through the product's own upload
        const { data: old } = await db.from("resumes").select("storage_path").eq("user_id", u.id); const op = (old ?? []).map((r: any) => r.storage_path).filter(Boolean); if (op.length) await db.storage.from("resumes").remove(op).then(() => {}, () => {});
        await db.from("resumes").delete().eq("user_id", u.id); await db.from("reader_control").delete().eq("key", `radar:run:${u.id}`); await store.del(`radar:targets:v3:${u.id}:`);
        const d = await db.storage.from("resumes").download(e.path); if (!d.data) throw new Error("the original file is no longer in storage"); const buf = Buffer.from(await d.data.arrayBuffer());
        if (createHash("sha256").update(buf).digest("hex") !== e.sha256) throw new Error("the stored file no longer matches the uploaded file");
        token = await createSession(u.id);
        const form = new FormData(); form.append("file", new File([new Uint8Array(buf)], e.filename, { type: "application/pdf" }));
        const up = await call(token, "POST", "/resumes", form);
        if (up.budget) { e.status = "stopped_budget"; step("résumé read", false, "the QA AI budget was reached"); }
        else if (up.status >= 300) { e.upload_error = `${up.status}: ${String(up.j?.error ?? "no message")}`; e.status = "failed"; step("résumé read", false, e.upload_error); }
        else { step("résumé read", true, "Record created by the product");
          const tg = await call(token, "GET", "/radar/test/targets");
          if (tg.budget) { e.status = "stopped_budget"; step("Radar reading", false, "the QA AI budget was reached"); }
          else if (tg.status >= 300) { e.radar_error = `targets ${tg.status}: ${String(tg.j?.error ?? "")}`; e.status = "failed"; step("Radar reading", false, e.radar_error); }
          else { step("Radar reading", true, `${tg.j?.targets?.level ?? "?"} · ${(tg.j?.targets?.titles ?? []).length} titles`);
            await store.set(`radar:unlock:${u.id}`, { at: now(), by: "qa-real" });
            const st = await call(token, "POST", "/radar/test/start", {});
            if (st.status >= 300) { e.radar_error = `start ${st.status}: ${String(st.j?.error ?? "")}`; e.status = "failed"; step("Radar run", false, e.radar_error); }
            else { let run: any = null; for (let i = 0; i < 96; i++) { await wait(5000); run = await store.get<any>(`radar:run:${u.id}`); if (["done", "error"].includes(run?.status)) break; }
              if (run?.status === "done") { e.status = "done"; const picks = (run.items ?? []).filter((x: any) => x.label); step("Radar run", true, `${picks.length} recommendation(s)`);
                e.evidence = await verifyAll(picks.map((x: any) => x.sighting_id)); step("Listings checked at their source", true, `${e.evidence.filter((v) => v.status === "verified_active").length} open now, ${e.evidence.filter((v) => v.status === "closed").length} closed, ${e.evidence.filter((v) => v.status === "unverifiable").length} could not be confirmed, ${e.evidence.filter((v) => v.status === "invented_fixture").length} invented fixture(s)`); }
              else { e.radar_error = run?.status === "error" ? String(run.error ?? "error") : `did not finish within 8 minutes (status ${run?.status ?? "none"})`; e.status = /QA AI budget/.test(e.radar_error) ? "stopped_budget" : "failed"; step("Radar run", false, e.radar_error); } } } }
      } catch (x: any) { e.status = "failed"; step("unexpected error", false, String(x?.message ?? x).slice(0, 300)); }
      finally { if (uid) await db.from("sessions").delete().eq("user_id", uid).then(() => {}, () => {}); }   // no session outlives the run
      e.spend_paise = (await qaSpend()).paise - before; await store.set(KEY(e.id), e);
    }
  } finally { running = false; }
}

const COLS = "id, source, source_id, url, title, company_name, location, posted_at, posted_text, first_seen, last_seen, enriched_at, gone_at, blr, description";
const byIds = async (ids: number[]) => (ids.length ? ((await db.from("sightings").select(COLS).in("id", ids)).data ?? []) : []) as any[];
async function verifyAll(ids: number[]): Promise<Evidence[]> { const rows = await byIds(ids.filter(Boolean)); const out: Evidence[] = []; for (const r of rows) out.push(await verifyListing(r)); return out; }
/** every live Bengaluru listing QA holds from real sources: titles only, for the "possibly missed" comparison. Kept five minutes. */
let titles: { at: number; rows: JobIn[] } | null = null;
async function realTitles(): Promise<JobIn[]> {
  if (titles && Date.now() - titles.at < 5 * 60e3) return titles.rows; const rows: JobIn[] = []; const pub = `${(process.env.QA_PUBLIC_URL ?? "").replace(/\/$/, "")}/qa/%`;
  for (let from = 0; from < 40000; from += 1000) { const { data } = await db.from("sightings").select("id, title, company_name, location, url").eq("blr", true).is("gone_at", null).not("url", "like", pub).order("id").range(from, from + 999);
    for (const r of (data ?? []) as any[]) rows.push({ slug: String(r.id), url: r.url, title: r.title, employer: r.company_name ?? "", fn: "", level: "", location: `${r.location ?? ""} (Bengaluru)`, state: "live", text: "" }); if (!data || data.length < 1000) break; }
  titles = { at: Date.now(), rows }; return rows;
}
async function runSharpen(app: App, e0: Entry, url: string, sighting_id: number | null) {
  if (running) return; running = true; const e = (await store.get<Entry>(KEY(e0.id))) ?? e0; const before = (await qaSpend()).paise; const row = { shot_id: null as string | null, url, sighting_id, at: now(), status: "running", error: null as string | null, before: undefined as number | undefined, after: undefined as number | undefined, spend_paise: 0 };
  e.sharpens = [...(e.sharpens ?? []), row]; await store.set(KEY(e.id), e); let uid = "";
  const call = async (token: string, method: string, path: string, body?: unknown) => { const r = await app.request(path, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) }); const j: any = await r.json().catch(() => ({})); return { status: r.status, j }; };
  try { const u = await userOf(e.n); if (!u) throw new Error("this résumé has not been run through Radar yet"); uid = u.id; const token = await createSession(u.id);
    const pv = await call(token, "POST", "/preview", { posting_url: url }); if (pv.status >= 300 || !pv.j?.preview_id) throw new Error(`fit step ${pv.status}: ${String(pv.j?.error ?? pv.j?.code ?? "no fit returned")}`);
    row.before = pv.j.score_before; 
    const { data: plans } = await db.from("plans").select("id, shots_total, shots_used").eq("user_id", u.id).eq("product", "sharpen").gt("expires_at", now()); 
    if (!(plans ?? []).some((p: any) => p.shots_used < p.shots_total)) { const price = PRICES.sharpen; const { data: pay } = await db.from("payments").insert({ user_id: u.id, product: "sharpen", amount_paise: price.paise, status: "paid", razorpay_order_id: `order_QAREAL_${Date.now()}`, paid_at: now(), raw: { qa: true, real_resume_test: true, note: "no money moved: QA entitlement" } }).select("id").single();
      await db.from("plans").insert({ user_id: u.id, product: "sharpen", shots_total: price.shots, shots_used: 0, expires_at: new Date(Date.now() + 14 * 86400e3).toISOString(), payment_id: pay?.id ?? null }); }
    const sh = await call(token, "POST", "/shots", { product: "sharpen", posting_url: url, preview_id: pv.j.preview_id }); const sid = sh.j?.shot?.id ?? sh.j?.id; if (sh.status >= 300 || !sid) throw new Error(`Sharpen start ${sh.status}: ${String(sh.j?.error ?? "no id returned")}`); row.shot_id = sid; await store.set(KEY(e.id), e);
    let shot: any = null; for (let i = 0; i < 110; i++) { await new Promise((r) => setTimeout(r, 5000)); shot = (await db.from("shots").select("status, error, output").eq("id", sid).maybeSingle()).data; if (["done", "failed", "error", "refunded"].includes(shot?.status)) break; }
    row.status = shot?.status ?? "did not finish within 9 minutes"; row.error = shot?.error ?? null; row.before = shot?.output?.before ?? row.before; row.after = shot?.output?.after;
  } catch (x: any) { row.status = "failed"; row.error = String(x?.message ?? x).slice(0, 300); }
  finally { if (uid) await db.from("sessions").delete().eq("user_id", uid).then(() => {}, () => {}); row.spend_paise = (await qaSpend()).paise - before; e.spend_paise += row.spend_paise; await store.set(KEY(e.id), e); running = false; }
}

async function detail(e: Entry) {
  const u = await userOf(e.n); const mode = e.pool_mode ?? (await qaPoolMode());
  let text = "", pages = 0, intact: boolean | null = null; const d = await db.storage.from("resumes").download(e.path);
  if (d.data) { const buf = Buffer.from(await d.data.arrayBuffer()); intact = createHash("sha256").update(buf).digest("hex") === e.sha256; try { const x = await extractText(buf, e.filename); text = x.text; pages = x.pages; } catch { /* reported by the checks */ } }
  const res = u ? (await db.from("resumes").select("id, created_at, parsed").eq("user_id", u.id).eq("is_current", true).maybeSingle()).data : null; const record = (res?.parsed as any) ?? null;
  const run = u ? await store.get<any>(`radar:run:${u.id}`) : null; const tk = u ? ((await db.from("reader_control").select("value").like("key", `radar:targets:v3:${u.id}:%`).order("updated_at", { ascending: false }).limit(1)).data?.[0]?.value as any) : null; const targets = tk?.targets ?? tk ?? null;
  const picks: any[] = (run?.items ?? []).filter((i: any) => i.label); const rows = mode === "real" ? await byIds(picks.map((i) => i.sighting_id).filter(Boolean)) : []; const rowOf = new Map(rows.map((r: any) => [r.url, r]));
  const jobs: JobIn[] = mode === "real" ? [...rows.map((r: any) => ({ slug: String(r.id), url: r.url, title: r.title, employer: r.company_name ?? "", fn: "", level: "", location: r.blr ? `${r.location ?? ""} (Bengaluru)` : r.location ?? "", state: r.gone_at ? "gone" : "live", text: r.description ?? "" })), ...(await realTitles()).filter((j) => !rowOf.has(j.url))] : await allJobs();
  const rc = checkRecord(text, pages, e.status === "uploaded" ? null : record, e.upload_error); const rd = checkRadar(text, e.status === "uploaded" ? null : run, targets, jobs, e.radar_error);
  // every recommendation with where it came from and whether its source says it is open now
  const ev = new Map((e.evidence ?? []).map((v) => [v.url, v])); const recommended = rd.recommended.map((r: any) => { const row = rowOf.get(r.url); const v = ev.get(r.url) ?? null; return { ...r, status_at_source: v?.status ?? (isFixtureUrl(r.url) ? "invented_fixture" : "not_checked"), evidence: v, source: row?.source ?? null, job_id: v?.job_id ?? null, first_read: row?.first_seen ?? null, last_read: row?.last_seen ?? null, posted_at: row?.posted_at ?? null, posted_text: row?.posted_text ?? null, description: row?.description ?? (jobs.find((j) => j.url === r.url)?.text ?? null) }; });
  if (run?.status === "done" && e.status !== "uploaded") { const fake = recommended.filter((r) => r.status_at_source === "invented_fixture"), closed = recommended.filter((r) => r.status_at_source === "closed"), unk = recommended.filter((r) => ["unverifiable", "not_checked"].includes(r.status_at_source)), old = recommended.filter((r) => r.evidence?.age_note), nodesc = recommended.filter((r) => !(r.description ?? "").trim());
    rd.checks.unshift({ check: "Every recommendation is a real listing its own source says is open now", status: fake.length || closed.length ? "fail" : unk.length ? "review" : recommended.length ? "pass" : "not_run", detail: [fake.length ? `${fake.length} invented QA fixture(s) — this run did not use real listings` : "", ...closed.map((r) => `closed at source: ${r.title} — ${r.employer}`), ...unk.map((r) => `could not be confirmed: ${r.title} — ${r.employer} (${r.evidence?.how ?? "not checked"})`)].filter(Boolean).join(" · ") || `${recommended.length} of ${recommended.length} confirmed open at their source` });
    rd.checks.splice(1, 0, { check: "Every recommendation carries its source, job id, read times and description", status: nodesc.length || recommended.some((r) => !r.source || !r.job_id) ? (mode === "real" ? "fail" : "review") : recommended.length ? "pass" : "not_run", detail: [...nodesc.map((r) => `no description held: ${r.title} — ${r.employer}`), ...recommended.filter((r) => !r.source || !r.job_id).map((r) => `no source id: ${r.title} — ${r.employer}`)].join(" · ") || "complete" });
    if (old.length) rd.checks.splice(2, 0, { check: "Open, but old", status: "review", detail: old.map((r) => `${r.title} — ${r.employer}: ${r.evidence!.age_note}`).join(" · ") });
    const counts = { pass: 0, fail: 0, review: 0, not_run: 0 } as any; for (const k of rd.checks) counts[k.status]++; rd.counts = counts; rd.verdict = counts.fail ? "fail" : counts.not_run ? "incomplete" : counts.review ? "needs_review" : "pass"; }
  // each Sharpen run for this person: the document, the delivered PDF's text, the product's own status, and the comparison
  const sharpens: any[] = []; for (const sx of e.sharpens ?? []) { const shot = sx.shot_id ? (await db.from("shots").select("id, created_at, done_at, status, error, output").eq("id", sx.shot_id).maybeSingle()).data as any : null; let pdf: { text: string; pages: number } | null = null; const path = shot?.output?.pdf_path;
    if (path) try { const f = await db.storage.from("outputs").download(path); if (f.data) { const x = await extractText(Buffer.from(await f.data.arrayBuffer()), "out.pdf"); pdf = { text: x.text, pages: x.pages }; } } catch { /* reported */ }
    const jt = (rowOf.get(sx.url)?.description as string | undefined) ?? jobs.find((j) => j.url === sx.url)?.text ?? ((await db.from("sightings").select("description").eq("url", sx.url).limit(1)).data?.[0]?.description as string | undefined) ?? "";
    sharpens.push({ shot_id: sx.shot_id, role: sx.url, started: sx.at, spend_inr: (sx.spend_paise / 100).toFixed(2), backend: { status: shot?.status ?? sx.status, error: shot?.error ?? sx.error, created_at: shot?.created_at ?? null, done_at: shot?.done_at ?? null, score_before: shot?.output?.before ?? sx.before ?? null, score_after: shot?.output?.after ?? null, product_gate: shot?.output?.gate ?? null, product_verification: shot?.output?.verification ?? null, product_pdf_check: shot?.output?.pdf_check ?? null },
      pdf: path ? `/qa/real/${e.id}/sharpen/${sx.shot_id}/pdf` : null, pdf_pages: pdf?.pages ?? null, pdf_text: pdf?.text ?? null, document: shot?.output?.rewrite ?? null, comparison: checkSharpen(text, record, { status: shot?.status ?? sx.status, error: shot?.error ?? sx.error, rewrite: shot?.output?.rewrite ?? null, pdf, before: shot?.output?.before, after: shot?.output?.after }, jt) }); }
  const journeys = [...e.steps.filter((s) => !s.ok).map((s) => ({ at: s.at, what: s.step, detail: s.detail })), ...(u ? (await store.list<any>("qa:http:", 600)).filter((r) => r.user === u.id).map((r) => ({ at: r.at, what: `${r.method} ${r.path} → ${r.status}`, detail: `${r.error ?? ""} (request ${r.rid})` })) : [])];
  for (const sx of e.sharpens ?? []) if (["failed", "error"].includes(sx.status)) journeys.push({ at: sx.at, what: "Sharpen", detail: String(sx.error ?? sx.status) });
  const verdict = [rc.verdict, rd.verdict, ...sharpens.map((x) => x.comparison.verdict)].includes("fail") || journeys.length ? "fail" : e.status === "uploaded" ? "not_run" : [rc.verdict, rd.verdict].some((v) => v === "incomplete" || v === "not_run") ? "incomplete" : e.review?.verdict === "accurate" ? "reviewed_accurate" : e.review?.verdict === "issues" ? "reviewed_issues" : "needs_review";
  return { e, text, pages, intact, record, targets, rc, rd, journeys, verdict, recommended, sharpens, mode };
}

export function realRoutes(app: App, hasQaAccess: (h: string | undefined | null) => boolean) {
  const r = new Hono();
  r.use("*", async (c, next) => {
    c.header("cache-control", "no-store"); c.header("x-robots-tag", "noindex");
    if (!REAL_ON) return c.json({ error: "Real résumés are not authorised in this QA environment. Nothing can be uploaded, run or read.", authorised: false }, 403);
    if (!hasQaAccess(c.req.header("x-qa-access")) || !hasRealAccess(c.req.header("x-qa-real-access"))) return c.json({ error: "This area needs both the QA access code and the separate real-résumé code." }, 401);
    await sweepReal().catch(() => {}); await next();
  });
  const who = (c: any) => String(c.req.header("x-qa-tester") ?? "");
  r.get("/status", async (c) => { const all = await entries(); const s = await qaSpend();
    return c.json({ authorised: true, authorised_by: process.env.QA_REAL_AUTHORISED_BY, authorised_on: process.env.QA_REAL_AUTHORISED_ON, retention_days: DAYS(), held: all.length, capacity: REAL_MAX, running, ai: { spent_inr: (s.paise / 100).toFixed(2), cap_inr: (s.cap_paise / 100).toFixed(0), left_inr: (s.left_paise / 100).toFixed(2) },
      safeguards: ["files stored and served byte for byte; SHA-256 checked on every read", "accounts are placeholders on numbers no phone can have; the person's name is not put on the account", "WhatsApp is simulated; SMS and e-mail are refused; no payment key is in use", "QA database and QA job fixtures only; production cannot be reached", "résumé text is sent to the AI provider through the QA key to build the Record and the Radar list", `everything is deleted ${DAYS()} day(s) after upload, on request, or when the authorisation is withdrawn`] }); });
  /** batch upload: up to 25 PDFs per request. Stored unmodified; nothing is processed and no model is called here. */
  r.post("/upload", async (c) => {
    const f = await c.req.formData().catch(() => null); const files = (f?.getAll("files") ?? []).filter((x): x is File => x instanceof File); if (!files.length) return c.json({ error: "Send the PDFs as form field “files”." }, 400);
    if (files.length > 25) return c.json({ error: "At most 25 files per upload." }, 400);
    const all = await entries(); const used = new Set(all.map((e) => e.n)); const out: any[] = [];
    for (const file of files) {
      const buf = Buffer.from(await file.arrayBuffer()); const sha256 = createHash("sha256").update(buf).digest("hex");
      if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") { out.push({ file: file.name, stored: false, why: "not a PDF" }); continue; }
      if (buf.length > 10 * 1024 * 1024) { out.push({ file: file.name, stored: false, why: "larger than 10 MB" }); continue; }
      const dup = all.find((e) => e.sha256 === sha256); if (dup) { out.push({ file: file.name, stored: false, why: `the same file is already held as ${dup.id}` }); continue; }
      let n = 0; for (let i = 1; i <= REAL_MAX; i++) if (!used.has(i)) { n = i; break; } if (!n) { out.push({ file: file.name, stored: false, why: `all ${REAL_MAX} places are in use; delete some first` }); continue; }
      const id = realId(n); const path = `qa-real/${id}-${sha256.slice(0, 12)}.pdf`;
      const up = await db.storage.from("resumes").upload(path, buf, { contentType: "application/pdf", upsert: false }); if (up.error) { out.push({ file: file.name, stored: false, why: up.error.message }); continue; }
      const e: Entry = { id, n, filename: file.name.slice(0, 200), sha256, bytes: buf.length, path, uploaded_at: now(), expires_at: new Date(Date.now() + DAYS() * 86400e3).toISOString(), status: "uploaded", steps: [], upload_error: null, radar_error: null, spend_paise: 0, ran_at: null, review: null };
      await store.set(KEY(id), e); used.add(n); all.push(e); out.push({ file: file.name, stored: true, id, sha256, bytes: buf.length, deleted_on: e.expires_at });
      await audit("uploaded", { id, sha256, bytes: buf.length }, who(c));
    }
    return c.json({ stored: out.filter((x) => x.stored).length, refused: out.filter((x) => !x.stored).length, files: out, note: "Stored exactly as uploaded. Nothing has been processed and no model has been called." });
  });
  /** run the held résumés through the product: upload → Record → Radar. This is the step that spends from the AI budget. */
  r.post("/run", async (c) => {
    const b = z.object({ ids: z.array(z.string()).max(REAL_MAX).optional(), rerun: z.boolean().default(false), allow_fixtures: z.boolean().default(false) }).safeParse(await c.req.json().catch(() => ({}))); if (!b.success) return c.json({ error: "ids (optional list), rerun (optional)" }, 400);
    if (running) return c.json({ ok: true, already_running: true });
    if ((await qaSpend()).left_paise <= 0) return c.json({ error: "The QA AI budget is used up. Nothing was started." }, 503);
    const pool = await qaPoolMode(); if (pool !== "real" && !b.data.allow_fixtures) return c.json({ error: "Radar is currently looking at invented QA fixtures, not real listings. Read the real sources and switch the pool to real first (QA start page → Real job discovery). To run against fixtures deliberately, send allow_fixtures: true.", pool_mode: pool, discovery_authorised: DISCOVERY_ON }, 409);
    const want = b.data.ids?.map((x) => x.toUpperCase()); const list = (await entries()).filter((e) => (!want || want.includes(e.id)) && (b.data.rerun || e.status === "uploaded" || e.status === "stopped_budget"));
    if (!list.length) return c.json({ ok: true, started: [], note: "Nothing to run: every held résumé has already been run. Send rerun: true to run again." });
    await audit("run started", { ids: list.map((e) => e.id) }, who(c)); void runAll(app, list).catch((e) => console.error("[qa-real] run", e?.message ?? e));
    return c.json({ ok: true, started: list.map((e) => e.id), pool_mode: pool, one_at_a_time: true, note: "Runs one résumé at a time and stops by itself if the AI budget is reached. Read /qa/real/report for progress." });
  });
  /** the consolidated report: one line per résumé, with a link to its own page */
  r.get("/report", async (c) => { const rows: any[] = []; for (const e of await entries()) { const d = await detail(e); const rec = d.recommended;
      rows.push({ id: e.id, file: e.filename, status: e.status, verdict: d.verdict, name_in_record: d.record?.name ?? null, roles_in_record: (d.record?.roles ?? []).length, years: d.record?.years_total ?? null, radar_reading: d.targets ? `${d.targets.level} · ${(d.targets.functions ?? []).join(", ")}` : null,
        for_you: rec.filter((x) => x.label === "for_you").length, adjacent: rec.filter((x) => x.label === "adjacent").length, stretch: rec.filter((x) => x.label === "stretch").length, jobs_were: d.mode === "real" ? "real listings" : "invented fixtures", open_now: rec.filter((x) => x.status_at_source === "verified_active").length, closed_or_unconfirmed: rec.filter((x) => !["verified_active"].includes(x.status_at_source)).length, rejected: d.rd.rejected.length, possibly_missed: d.rd.not_considered.filter((x) => x.possibly_missed).length,
        sharpens: d.sharpens.map((x) => `${x.backend.status}: ${x.comparison.verdict}`),
        record_findings: d.rc.checks.filter((k) => k.status === "fail").map((k) => k.check), radar_findings: d.rd.checks.filter((k) => k.status === "fail").map((k) => k.check), sharpen_findings: d.sharpens.flatMap((x) => x.comparison.checks.filter((k: any) => k.status === "fail").map((k: any) => k.check)), to_review: [...d.rc.checks, ...d.rd.checks, ...d.sharpens.flatMap((x) => x.comparison.checks)].filter((k: any) => k.status === "review").length, failed_steps: d.journeys.length,
        tester_review: e.review ? { verdict: e.review.verdict, parsing_errors: e.review.parsing_errors.length, wrong_matches: e.review.wrong_matches.length, missed: e.review.missed.length } : null, spend_inr: (e.spend_paise / 100).toFixed(2), deleted_on: e.expires_at, page: `${SITE()}/app.html#/qa/real/${e.id}`, api: `/qa/real/${e.id}` }); }
    const s = await qaSpend(); const count = (v: string) => rows.filter((x) => x.verdict === v).length;
    return c.json({ at: now(), running, candidates: rows.length, summary: { not_run: count("not_run"), fail: count("fail"), incomplete: count("incomplete"), needs_review: count("needs_review"), reviewed_accurate: count("reviewed_accurate"), reviewed_issues: count("reviewed_issues") }, ai: { spent_on_these_inr: (rows.reduce((n, x) => n + Number(x.spend_inr), 0)).toFixed(2), total_spent_inr: (s.paise / 100).toFixed(2), cap_inr: (s.cap_paise / 100).toFixed(0) },
      how_to_read: "fail = a rule found a definite problem or a step failed · needs_review = no rule failed, a person must compare with the original · reviewed_* = a tester recorded a verdict. No résumé is marked correct automatically.", rows }); });
  r.get("/audit", async (c) => c.json({ entries: await store.list<any>("qa:realaudit:", 300) }));
  r.post("/delete", async (c) => { const b = z.object({ id: z.string().optional(), all: z.boolean().optional() }).safeParse(await c.req.json().catch(() => ({}))); if (!b.success || (!b.data.id && !b.data.all)) return c.json({ error: "id or all" }, 400);
    if (running) return c.json({ error: "A run is in progress. Delete when it has finished." }, 409);
    const list = (await entries()).filter((e) => b.data.all || e.id === String(b.data.id).toUpperCase()); const out = []; for (const e of list) { out.push({ id: e.id, removed: await purge(e, "deleted by a tester") }); await audit("delete requested", { id: e.id }, who(c)); }
    return c.json({ ok: true, deleted: out, still_held: (await entries()).length }); });
  /** ask each recommended listing's own source again whether it is open — now */
  r.post("/:id/verify", async (c) => { const e = await store.get<Entry>(KEY(c.req.param("id").toUpperCase())); if (!e) return c.json({ error: "Not held." }, 404); const u = await userOf(e.n); const run = u ? await store.get<any>(`radar:run:${u.id}`) : null; if (!run) return c.json({ error: "No Radar run yet." }, 409);
    e.evidence = await verifyAll((run.items ?? []).filter((x: any) => x.label).map((x: any) => x.sighting_id)); await store.set(KEY(e.id), e); await audit("listings re-checked", { id: e.id }, who(c)); return c.json({ ok: true, checked: e.evidence.length, evidence: e.evidence }); });
  /** Sharpen this person's résumé against one of Radar's recommendations. Spends from the AI budget. */
  r.post("/:id/sharpen", async (c) => { const e = await store.get<Entry>(KEY(c.req.param("id").toUpperCase())); if (!e) return c.json({ error: "Not held." }, 404);
    const b = z.object({ url: z.string().url(), force: z.boolean().default(false) }).safeParse(await c.req.json().catch(() => ({}))); if (!b.success) return c.json({ error: "url (one of this person's recommended roles), force (optional)" }, 400);
    if (running) return c.json({ error: "Another run is in progress. Try again when it has finished." }, 409); if ((await qaSpend()).left_paise <= 0) return c.json({ error: "The QA AI budget is used up. Nothing was started." }, 503);
    const u = await userOf(e.n); const run = u ? await store.get<any>(`radar:run:${u.id}`) : null; const item = (run?.items ?? []).find((x: any) => x.label && x.url === b.data.url); if (!item) return c.json({ error: "That is not one of Radar's recommendations for this person." }, 400);
    const fresh = (await verifyAll([item.sighting_id]))[0] ?? null; if (fresh) { e.evidence = [...(e.evidence ?? []).filter((v) => v.url !== fresh.url), fresh]; await store.set(KEY(e.id), e); }
    if (fresh?.status !== "verified_active" && !b.data.force) return c.json({ error: `This role is not confirmed open at its source (${fresh?.status ?? "not checked"}: ${fresh?.how ?? ""}). Sharpen is run only against a verified open role. Send force: true to override.`, evidence: fresh }, 409);
    await audit("sharpen started", { id: e.id, url: b.data.url }, who(c)); void runSharpen(app, e, b.data.url, item.sighting_id ?? null).catch((x) => console.error("[qa-real] sharpen", x?.message ?? x));
    return c.json({ ok: true, started: true, role: { title: item.title, employer: item.company, url: item.url }, verified: fresh, note: "Runs in the background (a few minutes). Read this résumé's page for the result." }); });
  r.get("/:id/sharpen/:shot/pdf", async (c) => { const e = await store.get<Entry>(KEY(c.req.param("id").toUpperCase())); const sid = c.req.param("shot"); if (!e || !(e.sharpens ?? []).some((x) => x.shot_id === sid)) return c.json({ error: "Not held." }, 404);
    const { data: shot } = await db.from("shots").select("output").eq("id", sid).maybeSingle(); const path = (shot as any)?.output?.pdf_path; const f = path ? await db.storage.from("outputs").download(path) : null; if (!f?.data) return c.json({ error: "No PDF was delivered for this Sharpen." }, 404);
    await audit("sharpen pdf opened", { id: e.id, shot: sid }, who(c)); return new Response(new Uint8Array(await f.data.arrayBuffer()), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${e.id}-sharpened.pdf"`, "cache-control": "no-store" } }); });
  r.get("/:id/original", async (c) => { const e = await store.get<Entry>(KEY(c.req.param("id").toUpperCase())); if (!e) return c.json({ error: "Not held." }, 404); const d = await db.storage.from("resumes").download(e.path); if (!d.data) return c.json({ error: "The file is gone." }, 404);
    const buf = Buffer.from(await d.data.arrayBuffer()); const same = createHash("sha256").update(buf).digest("hex") === e.sha256; await audit("original opened", { id: e.id }, who(c));
    return new Response(new Uint8Array(buf), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${e.id}.pdf"`, "cache-control": "no-store", "x-sha256": e.sha256, "x-unmodified": String(same) } }); });
  r.post("/:id/review", async (c) => { const e = await store.get<Entry>(KEY(c.req.param("id").toUpperCase())); if (!e) return c.json({ error: "Not held." }, 404);
    const b = z.object({ verdict: z.enum(["accurate", "issues"]), parsing_errors: z.array(z.string().max(300)).max(40).default([]), wrong_matches: z.array(z.string().max(200)).max(60).default([]), missed: z.array(z.string().max(200)).max(60).default([]), notes: z.string().max(2000).default("") }).safeParse(await c.req.json().catch(() => ({}))); if (!b.success) return c.json({ error: "verdict (accurate | issues), parsing_errors, wrong_matches, missed, notes" }, 400);
    e.review = { at: now(), ...b.data }; await store.set(KEY(e.id), e); await audit("review recorded", { id: e.id, verdict: b.data.verdict }, who(c)); return c.json({ ok: true, review: e.review }); });
  /** one résumé's page: the original, the Record, what Radar recommended and why, what it turned down, what it never examined, and every error */
  r.get("/:id", async (c) => { const id = c.req.param("id").toUpperCase(); if (!realNumber(id)) return c.json({ error: "R001 to R030." }, 400); const e = await store.get<Entry>(KEY(id)); if (!e) return c.json({ error: "Not held (never uploaded, or already deleted)." }, 404);
    const d = await detail(e); await audit("report opened", { id }, who(c));
    return c.json({ id, verdict: d.verdict, status: e.status, ran_at: e.ran_at, spend_inr: (e.spend_paise / 100).toFixed(2), deleted_on: e.expires_at,
      original: { filename: e.filename, bytes: e.bytes, sha256: e.sha256, uploaded_at: e.uploaded_at, unmodified: d.intact, pages: d.pages, file: `/qa/real/${id}/original`, text: d.text },
      jobs_were: d.mode === "real" ? "real listings read from public hiring systems" : "invented QA fixtures", record: d.record, record_checks: d.rc, radar_reading: d.targets, radar: { verdict: d.rd.verdict, counts: d.rd.counts, checks: d.rd.checks }, recommended: d.recommended, sharpen: d.sharpens, rejected: d.rd.rejected, possibly_missed: d.rd.not_considered.filter((x) => x.possibly_missed).slice(0, 80), possibly_missed_total: d.rd.not_considered.filter((x) => x.possibly_missed).length, not_examined_unrelated: d.rd.not_considered.filter((x) => !x.possibly_missed).length,
      failed_steps: d.journeys, steps: e.steps, tester_review: e.review }); });
  return r;
}
