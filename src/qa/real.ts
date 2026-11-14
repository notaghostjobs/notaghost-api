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
import { checkRecord, checkRadar } from "./realcheck.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type Entry = { id: string; n: number; filename: string; sha256: string; bytes: number; path: string; uploaded_at: string; expires_at: string; status: "uploaded" | "running" | "done" | "failed" | "stopped_budget"; steps: { at: string; step: string; ok: boolean; detail: string }[]; upload_error: string | null; radar_error: string | null; spend_paise: number; ran_at: string | null;
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
      const before = (await qaSpend()).paise; e.status = "running"; e.steps = []; e.upload_error = null; e.radar_error = null; e.ran_at = now(); await store.set(KEY(e.id), e);
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
              if (run?.status === "done") { e.status = "done"; step("Radar run", true, `${(run.items ?? []).filter((x: any) => x.label).length} recommendation(s)`); }
              else { e.radar_error = run?.status === "error" ? String(run.error ?? "error") : `did not finish within 8 minutes (status ${run?.status ?? "none"})`; e.status = /QA AI budget/.test(e.radar_error) ? "stopped_budget" : "failed"; step("Radar run", false, e.radar_error); } } } }
      } catch (x: any) { e.status = "failed"; step("unexpected error", false, String(x?.message ?? x).slice(0, 300)); }
      finally { if (uid) await db.from("sessions").delete().eq("user_id", uid).then(() => {}, () => {}); }   // no session outlives the run
      e.spend_paise = (await qaSpend()).paise - before; await store.set(KEY(e.id), e);
    }
  } finally { running = false; }
}

async function detail(e: Entry) {
  const u = await userOf(e.n); const jobs = await allJobs();
  let text = "", pages = 0, intact: boolean | null = null; const d = await db.storage.from("resumes").download(e.path);
  if (d.data) { const buf = Buffer.from(await d.data.arrayBuffer()); intact = createHash("sha256").update(buf).digest("hex") === e.sha256; try { const x = await extractText(buf, e.filename); text = x.text; pages = x.pages; } catch { /* reported by the checks */ } }
  const res = u ? (await db.from("resumes").select("id, created_at, parsed").eq("user_id", u.id).eq("is_current", true).maybeSingle()).data : null; const record = (res?.parsed as any) ?? null;
  const run = u ? await store.get<any>(`radar:run:${u.id}`) : null; const tk = u ? ((await db.from("reader_control").select("value").like("key", `radar:targets:v3:${u.id}:%`).order("updated_at", { ascending: false }).limit(1)).data?.[0]?.value as any) : null; const targets = tk?.targets ?? tk ?? null;
  const rc = checkRecord(text, pages, e.status === "uploaded" ? null : record, e.upload_error); const rd = checkRadar(text, e.status === "uploaded" ? null : run, targets, jobs, e.radar_error);
  const journeys = [...e.steps.filter((s) => !s.ok).map((s) => ({ at: s.at, what: s.step, detail: s.detail })), ...(u ? (await store.list<any>("qa:http:", 600)).filter((r) => r.user === u.id).map((r) => ({ at: r.at, what: `${r.method} ${r.path} → ${r.status}`, detail: `${r.error ?? ""} (request ${r.rid})` })) : [])];
  const verdict = [rc.verdict, rd.verdict].includes("fail") || journeys.length ? "fail" : e.status === "uploaded" ? "not_run" : [rc.verdict, rd.verdict].some((v) => v === "incomplete" || v === "not_run") ? "incomplete" : e.review?.verdict === "accurate" ? "reviewed_accurate" : e.review?.verdict === "issues" ? "reviewed_issues" : "needs_review";
  return { e, text, pages, intact, record, targets, rc, rd, journeys, verdict };
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
    const b = z.object({ ids: z.array(z.string()).max(REAL_MAX).optional(), rerun: z.boolean().default(false) }).safeParse(await c.req.json().catch(() => ({}))); if (!b.success) return c.json({ error: "ids (optional list), rerun (optional)" }, 400);
    if (running) return c.json({ ok: true, already_running: true });
    if ((await qaSpend()).left_paise <= 0) return c.json({ error: "The QA AI budget is used up. Nothing was started." }, 503);
    const want = b.data.ids?.map((x) => x.toUpperCase()); const list = (await entries()).filter((e) => (!want || want.includes(e.id)) && (b.data.rerun || e.status === "uploaded" || e.status === "stopped_budget"));
    if (!list.length) return c.json({ ok: true, started: [], note: "Nothing to run: every held résumé has already been run. Send rerun: true to run again." });
    await audit("run started", { ids: list.map((e) => e.id) }, who(c)); void runAll(app, list).catch((e) => console.error("[qa-real] run", e?.message ?? e));
    return c.json({ ok: true, started: list.map((e) => e.id), one_at_a_time: true, note: "Runs one résumé at a time and stops by itself if the AI budget is reached. Read /qa/real/report for progress." });
  });
  /** the consolidated report: one line per résumé, with a link to its own page */
  r.get("/report", async (c) => { const rows: any[] = []; for (const e of await entries()) { const d = await detail(e); const rec = d.rd.recommended;
      rows.push({ id: e.id, file: e.filename, status: e.status, verdict: d.verdict, name_in_record: d.record?.name ?? null, roles_in_record: (d.record?.roles ?? []).length, years: d.record?.years_total ?? null, radar_reading: d.targets ? `${d.targets.level} · ${(d.targets.functions ?? []).join(", ")}` : null,
        for_you: rec.filter((x) => x.label === "for_you").length, adjacent: rec.filter((x) => x.label === "adjacent").length, stretch: rec.filter((x) => x.label === "stretch").length, rejected: d.rd.rejected.length, possibly_missed: d.rd.not_considered.filter((x) => x.possibly_missed).length,
        record_findings: d.rc.checks.filter((k) => k.status === "fail").map((k) => k.check), radar_findings: d.rd.checks.filter((k) => k.status === "fail").map((k) => k.check), to_review: [...d.rc.checks, ...d.rd.checks].filter((k) => k.status === "review").length, failed_steps: d.journeys.length,
        tester_review: e.review ? { verdict: e.review.verdict, parsing_errors: e.review.parsing_errors.length, wrong_matches: e.review.wrong_matches.length, missed: e.review.missed.length } : null, spend_inr: (e.spend_paise / 100).toFixed(2), deleted_on: e.expires_at, page: `${SITE()}/app.html#/qa/real/${e.id}`, api: `/qa/real/${e.id}` }); }
    const s = await qaSpend(); const count = (v: string) => rows.filter((x) => x.verdict === v).length;
    return c.json({ at: now(), running, candidates: rows.length, summary: { not_run: count("not_run"), fail: count("fail"), incomplete: count("incomplete"), needs_review: count("needs_review"), reviewed_accurate: count("reviewed_accurate"), reviewed_issues: count("reviewed_issues") }, ai: { spent_on_these_inr: (rows.reduce((n, x) => n + Number(x.spend_inr), 0)).toFixed(2), total_spent_inr: (s.paise / 100).toFixed(2), cap_inr: (s.cap_paise / 100).toFixed(0) },
      how_to_read: "fail = a rule found a definite problem or a step failed · needs_review = no rule failed, a person must compare with the original · reviewed_* = a tester recorded a verdict. No résumé is marked correct automatically.", rows }); });
  r.get("/audit", async (c) => c.json({ entries: await store.list<any>("qa:realaudit:", 300) }));
  r.post("/delete", async (c) => { const b = z.object({ id: z.string().optional(), all: z.boolean().optional() }).safeParse(await c.req.json().catch(() => ({}))); if (!b.success || (!b.data.id && !b.data.all)) return c.json({ error: "id or all" }, 400);
    if (running) return c.json({ error: "A run is in progress. Delete when it has finished." }, 409);
    const list = (await entries()).filter((e) => b.data.all || e.id === String(b.data.id).toUpperCase()); const out = []; for (const e of list) { out.push({ id: e.id, removed: await purge(e, "deleted by a tester") }); await audit("delete requested", { id: e.id }, who(c)); }
    return c.json({ ok: true, deleted: out, still_held: (await entries()).length }); });
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
      record: d.record, record_checks: d.rc, radar_reading: d.targets, radar: { verdict: d.rd.verdict, counts: d.rd.counts, checks: d.rd.checks }, recommended: d.rd.recommended, rejected: d.rd.rejected, possibly_missed: d.rd.not_considered.filter((x) => x.possibly_missed), not_examined_unrelated: d.rd.not_considered.filter((x) => !x.possibly_missed).length,
      failed_steps: d.journeys, steps: e.steps, tester_review: e.review }); });
  return r;
}
