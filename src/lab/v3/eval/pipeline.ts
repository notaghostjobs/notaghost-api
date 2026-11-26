// Matching V3 evaluation pipeline for one isolated data root. Stages, in the fixed order:
//   preflight  1  validate intake; derive intent answers (accepted candidates only)
//   snapshot   3  import the inventory snapshot and hash it
//   prepare    2  parse résumés (layout + evidence with provenance)
//              4  one eligible inventory for both arms: open postings seen in the last 72 hours, valid descriptions
//              5–6 hybrid retrieval (frozen retrieve.py) → complete ranked pools with channel ranks
//              14 Arm A: the original OFFLINE control matcher (run-req2 control) on the same pools and inputs
//   v3         7–13 shortlist ≤40 (requirement-sensitive clusters) → extraction (exact cache) → judge j3 → quote and
//              schema validation → gate g3v3.2 → 0–5 strong + stretch; full per-pair trace; cost ledger
//   review     15 blinded packages (review.ts)      report  16 per-stage trace and cost report
// Modes: dry (no calls; builds and prices every request), mock (local stub provider), paid (refused unless the stage
// is in AUTHORISED, the root is finalised, the pricing check is current and a key is present).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { EvalRoot, RootError, fileSha, sha256 } from "./root.js";
import { preflight, resumeText, sketch } from "./intake.js";
import { REPO, SETTINGS, verifyConfig, verifyFinal } from "./freeze.js";
import { ExtractionCache } from "./cache.js";
import * as A from "../api3.js";
import * as FC from "../featcore.js";
import * as SL from "../shortlist.js";
import * as G from "../gate.js";
import { htmlToText, descSha } from "../jobtext.js";
import { EXTRACT_SYSTEM, extractUser, validateCJR } from "../../v2/cjr.js";
import { JUDGE_SYSTEM, candidateBlock, validateVerdict, eligibility } from "../../v2/pipeline.js";
import * as J3 from "../judge3.js";
import { buildCER, verifyCER } from "../../v2/cer.js";
import { firstJson } from "../../v2/api.js";
import { validity2 } from "../../validity.js";
import { SPEC, transfer } from "../../../lib/ontology.js";

/** Paid stages are authorised only by lab/eval/v3/AUTHORISATION.json, committed (tracked and unmodified in git) after
 *  the founder approves a stage: {"stage": "pilot", "ceiling_inr": 1350, "approved_by": "...", "approved_at": "...",
 *  "root_id": "..."}. The file is not part of the configuration freeze, so authorising never changes the experiment.
 *  It does not exist in this commit: no paid call is possible. */
export const AUTH_FILE = process.env.V3_AUTH_FILE ?? join(REPO, "lab/eval/v3/AUTHORISATION.json");
export function authorisation(stage: string, rootId: string, file = AUTH_FILE): { ceiling_inr: number } {
  if (!existsSync(file)) throw new A.BudgetError(`stage "${stage}" is not authorised (no ${file.replace(REPO + "/", "")}): no paid call made`);
  const rel = file.replace(REPO + "/", "");
  try { execFileSync("git", ["ls-files", "--error-unmatch", rel], { cwd: REPO, stdio: "ignore" }); execFileSync("git", ["diff", "--quiet", "HEAD", "--", rel], { cwd: REPO, stdio: "ignore" }); }
  catch { throw new A.BudgetError("the authorisation file is not committed, or has uncommitted changes: no paid call made"); }
  const a = JSON.parse(readFileSync(file, "utf8"));
  if (a.stage !== stage || a.root_id !== rootId || !(a.ceiling_inr > 0) || !a.approved_by || !a.approved_at) throw new A.BudgetError(`authorisation does not cover stage "${stage}" for root ${rootId}: no paid call made`);
  return { ceiling_inr: a.ceiling_inr };
}
/** Kept for tests and reports: the stages authorised in this commit (none). */
export const AUTHORISED: Record<string, number> = {};
export const PRICING_MAX_AGE_HOURS = 24;
const ENV = { ...process.env, SUPABASE_URL: "https://offline.invalid", SUPABASE_SERVICE_ROLE_KEY: "offline" };
const sh = (root: EvalRoot, cmd: string, args: string[], env: Record<string, string> = {}) => { root.log("exec", { cmd, args: args.map((a) => a.replace(root.dir, "<root>")) }); return execFileSync(cmd, args, { cwd: REPO, env: { ...ENV, ...env }, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] }); };
const tsx = (root: EvalRoot, script: string, args: string[], env: Record<string, string> = {}) => sh(root, join(REPO, "node_modules/.bin/tsx"), [join(REPO, script), ...args], env);

// ── 1. preflight ─────────────────────────────────────────────────────────────────────────────────────────────────
export function preflightStage(root: EvalRoot, devSketchFile: string, now = new Date()) {
  if (!existsSync(devSketchFile)) throw new RootError(`development-profile sketches missing: ${devSketchFile} (needed for the duplicate check)`);
  const dev = JSON.parse(readFileSync(devSketchFile, "utf8")); const rep = preflight(root.p("intake"), dev, now);
  root.write("intake/preflight.json", rep);
  const accepted = rep.decisions.filter((d: any) => d.status === "accepted");
  root.write("intent/answers.json", Object.fromEntries(accepted.map((d: any) => [d.candidate, d.answers])));
  const profiles = accepted.map((d: any) => { const intake = root.read("intake", d.candidate, "intake.json"); const src = root.need("intake", d.candidate, intake.resume_file);
    const txt = root.write(`candidates/text/${d.candidate}.txt`, resumeText(src)); return { id: d.candidate, resume: txt, source_file: intake.resume_file, source_sha256: fileSha(src), format: extname(src).slice(1) }; });
  root.write("candidates/profiles.json", profiles); root.log("preflight", { accepted: rep.accepted, held: rep.held, rejected: rep.rejected });
  return rep;
}
/** Development-profile sketches (no text) for the duplicate check. Built once from the 19 dev résumés. */
export function writeDevSketches(profilesFile: string, out: string) { const ps = JSON.parse(readFileSync(profilesFile, "utf8")); writeFileSync(out, JSON.stringify(ps.map((p: any) => ({ id: p.id, sketch: sketch(readFileSync(p.resume, "utf8")) })))); return ps.length; }

// ── 3. inventory snapshot ────────────────────────────────────────────────────────────────────────────────────────
export const SNAPSHOT_FIELDS = ["id", "source", "company_name", "title", "location", "url", "first_seen", "last_seen", "description"];
export function snapshotStage(root: EvalRoot, file: string, o: { captured_at: string; source: string }) {
  if (existsSync(root.p("inventory", "snapshot.jsonl"))) throw new RootError("a snapshot is already recorded for this root");
  const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l, i) => { let r: any; try { r = JSON.parse(l); } catch { throw new RootError(`snapshot line ${i + 1} is not JSON`); }
    for (const k of SNAPSHOT_FIELDS) if (!(k in r)) throw new RootError(`snapshot line ${i + 1} lacks ${k}`); return r; });
  const ids = new Set(rows.map((r) => String(r.id))); if (ids.size !== rows.length) throw new RootError("snapshot has duplicate job ids");
  copyFileSync(file, root.p("inventory", "snapshot.jsonl"));
  const meta = { sha256: fileSha(root.p("inventory", "snapshot.jsonl")), rows: rows.length, captured_at: o.captured_at, source: o.source, last_seen_max: rows.map((r) => String(r.last_seen)).sort().at(-1), recorded_at: new Date().toISOString() };
  root.write("inventory/snapshot.meta.json", meta); root.log("snapshot", meta); return meta;
}

/** Database timestamps ("2026-11-24 00:19:57.442+00") as dates. */
export const ts = (x: string) => { const d = new Date(String(x).trim().replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")); if (Number.isNaN(d.getTime())) throw new RootError(`unreadable timestamp ${x}`); return d; };
// ── 2, 4–6, 14. free stages ──────────────────────────────────────────────────────────────────────────────────────
export function prepareStage(root: EvalRoot, modelsDir: string) {
  verifyConfig(modelsDir);
  const meta = root.read("inventory", "snapshot.meta.json"); if (fileSha(root.need("inventory", "snapshot.jsonl")) !== meta.sha256) throw new RootError("snapshot changed after it was recorded");
  const profiles = root.read("candidates", "profiles.json"); const answers = root.read("intent", "answers.json"); if (!profiles.length) throw new RootError("no accepted candidates");
  // 4. one eligible inventory: fresh within 72 hours of capture, with a description. Both arms read only this file.
  const cutoff = new Date(new Date(meta.captured_at).getTime() - SETTINGS.freshness_hours * 3600e3).toISOString();
  const rows = root.readLines("inventory", "snapshot.jsonl"); const fresh = rows.filter((r) => r.description && ts(r.last_seen).getTime() >= new Date(cutoff).getTime());
  root.write("jobs/eligible-snapshot.jsonl", fresh.map((r) => JSON.stringify(r)).join("\n") + "\n");
  root.write("jobs/eligibility.json", { cutoff, snapshot_rows: rows.length, fresh_with_description: fresh.length, stale_or_empty: rows.length - fresh.length });
  for (const d of ["jobs/emb", "candidates/layout", "candidates/cand", "candidates/cer", "candidates/cand-v2", "judge/requests", "judge/responses"]) mkdirSync(root.p(d), { recursive: true });
  // job records, views and local embeddings
  tsx(root, "src/lab/build-jir.mts", [root.p("jobs/eligible-snapshot.jsonl"), root.p("jobs")]);
  sh(root, "python3", ["-I", join(REPO, "lab/py/embed.py"), "--model", "bge-small", "--views", root.p("jobs/views-det.jsonl"), "--fields", "resp,skills,whole,whole_raw", "--out", root.p("jobs/emb"), "--models", modelsDir]);
  // 2. résumés: layout with provenance (PDF reader, or the same headings for text), then the candidate records
  for (const p of profiles) { const lay = root.p(`candidates/layout/${p.id}.json`);
    if (p.format === "pdf") sh(root, "python3", ["-I", join(REPO, "lab/py/resume_layout.py"), root.need("intake", p.id, p.source_file), lay]); else sh(root, "python3", ["-I", join(REPO, "lab/py/text_layout.py"), p.resume, lay]); }
  tsx(root, "src/lab/prep-cands.mts", [root.p("candidates/profiles.json"), root.p("intent/answers.json"), root.p("jobs/eligible-snapshot.jsonl"), root.p("jobs/jir-det.jsonl"), root.p("candidates/cand")]);
  const label = (k: string) => (SPEC.get(k) as any)?.label ?? k;
  for (const p of profiles) {
    const resume = readFileSync(p.resume, "utf8"); const old = root.read("candidates", "cand", `${p.id}.json`); const lay = root.read("candidates", "layout", `${p.id}.json`);
    const c: any = buildCER(p.id, sha256(resume), lay, old.cir.done, answers[p.id], label); c.target.source = "candidate";
    const bad = verifyCER(c, resume); root.write(`candidates/cer/${p.id}.json`, c);
    const v = { ...old.cir.views, experience: [...c.work_lines, ...c.achievement_lines, ...c.project_lines].join(". ").slice(0, 4000), skills: c.listed_lines.join(", ").slice(0, 1200) };
    root.write(`candidates/cand-v2/${p.id}.json`, { ...old, cir: { ...old.cir, views: v } }); root.log("cer", { candidate: p.id, work_lines: c.work_lines.length, unverified_quotes: bad.length, warnings: c.parser.warnings });
  }
  // 5–6. retrieval: the frozen retrieve.py through the pattern wrapper; the complete pools are kept
  sh(root, "python3", ["-I", join(REPO, "lab/py/retrieve_eval.py"), "--cand-pattern", "[A-Z]\\d{2,3}", "--", "--arch", root.dir, "--views", "jobs/views-det.jsonl", "--emb", "jobs/emb", "--cand", "candidates/cand-v2", "--out", root.p("pools/retrieval.json"), "--models", modelsDir, "--pool", String(SETTINGS.retrieval.pool)]);
  // 14. Arm A: the offline control matcher, same pools, same intake answers, no fall back to development paths
  tsx(root, "src/lab/run-req2.mts", [root.p("pools/retrieval.json"), root.p("candidates/cand"), root.p("control/req2.json")], { REQ2_EVAL: "1", REQ2_JIR: root.p("jobs/jir-det.jsonl"), REQ2_VIEWS: root.p("jobs/views-det.jsonl"), REQ2_PROFILES: root.p("candidates/profiles.json"), REQ2_LAYOUT: root.p("candidates/layout") });
  const req2 = root.read("control", "req2.json"); const J = jobs(root); const out: any = {};
  for (const p of profiles) { const c = root.read("candidates", "cer", `${p.id}.json`); const resume = readFileSync(p.resume, "utf8"); const arm = req2.arms["R2:A_control"][p.id];
    // the same per-candidate eligibility V3 applies (deal-breakers, location, stated mandatory licences), then the first five
    const ranked = [...arm.top, ...arm.next]; const keep: string[] = [], dropped: any[] = [];
    for (const id of ranked) { const e = eligibility(J.jobFor(id), c, resume); if (e.excluded) dropped.push({ id, reasons: e.reasons }); else if (keep.length < 5) keep.push(id); }
    out[p.id] = { arm: "control (original offline matcher, not production Radar)", top: keep, excluded_by_shared_eligibility: dropped, source: "run-req2 R2:A_control" }; }
  root.write("control/control.json", out); root.log("prepare", { candidates: profiles.length, eligible_jobs: fresh.length });
  return { candidates: profiles.length, eligible_jobs: fresh.length };
}

// ── shared job access (this root only) ───────────────────────────────────────────────────────────────────────────
export function jobs(root: EvalRoot) {
  const views = new Map(root.readLines("jobs", "views-det.jsonl").map((v) => [String(v.id), v])); const det = new Map(root.readLines("jobs", "jir-det.jsonl").map((j) => [String(j.posting.id), j]));
  const raw = new Map(root.readLines("jobs", "eligible-snapshot.jsonl").map((r) => [String(r.id), r]));
  const full = (id: string) => htmlToText(raw.get(id)?.description ?? "");
  const jobFor = (id: string) => { const v: any = views.get(id), j: any = det.get(id); const text = full(id);
    return { id, title: v?.title ?? "", location: String(j?.posting?.location ?? ""), text, invalid: !v || !!validity2(v.title, v.whole_raw.slice(v.title.length + 2)), closed: false, stale: false }; };
  return { views, det, raw, full, jobFor };
}

// ── 7–13. V3 ─────────────────────────────────────────────────────────────────────────────────────────────────────
export type V3Opts = { mode: "dry" | "mock" | "paid"; modelsDir: string; fetchImpl?: typeof fetch; stage?: string; key?: string; onlyFirst?: boolean; resume?: boolean; now?: Date };
export async function v3Stage(root: EvalRoot, o: V3Opts) {
  const cfg = verifyConfig(o.modelsDir); let ceiling = 1e9;
  if (o.mode === "paid") {
    const stage = o.stage ?? ""; const auth = authorisation(stage, root.meta.id);
    const fin = verifyFinal(root, o.modelsDir); if (fin.stage !== stage) throw new A.BudgetError(`root was finalised for stage ${fin.stage}, not ${stage}`);
    const pc = root.read("manifest", "pricing-check.json"); const age = ((o.now ?? new Date()).getTime() - new Date(pc.checked_at).getTime()) / 3600e3;
    if (age > PRICING_MAX_AGE_HOURS || JSON.stringify(pc.usd_per_mtok) !== JSON.stringify(A.PRICE) || pc.model !== A.MODEL) throw new A.BudgetError("pricing check missing, older than 24 hours or different from the prices the guard uses");
    if (!o.key) throw new A.BudgetError("no API key: no paid call made"); ceiling = auth.ceiling_inr;
  }
  if (o.mode === "mock" && !o.fetchImpl) throw new Error("mock mode needs the stub provider");
  const ledger = new A.Ledger3(root.p("ledger", "ledger.jsonl"), o.mode); const guard = new A.Guard(ledger, ceiling);
  const cache = new ExtractionCache(root.p("cjr"), A.MODEL); const J = jobs(root); const ret = root.read("pools", "retrieval.json");
  const answers = root.read("intent", "answers.json"); const profiles = root.read("candidates", "profiles.json"); const urls = new Map([...J.raw].map(([id, r]) => [id, r.url]));
  const plan = { extract_requests: 0, judge_requests: 0, worst_case_reserved_inr: 0 };
  let seq = 0; const runId = `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${o.mode}-${Math.random().toString(36).slice(2, 6)}`;   // request files never overwrite an earlier run
  const send = async (kind: "extract" | "judge", purpose: string, system: string, user: string, maxTokens: number, effort: "low" | "medium") => {
    const worst = A.worstCase3(system.length, user.length, maxTokens); plan.worst_case_reserved_inr += worst; plan[kind === "extract" ? "extract_requests" : "judge_requests"]++;
    const n = ++seq; root.write(`judge/requests/${runId}-${String(n).padStart(5, "0")}-${kind}.json`, { run: runId, purpose, system_sha256: sha256(system), system_chars: system.length, user, max_tokens: maxTokens, worst_case_inr: worst });
    if (o.mode === "dry") return { ok: false as const, reason: "dry run", n };
    const r = await A.call3(guard, { purpose, system, user, maxTokens, cacheSystem: true, effort, key: o.mode === "mock" ? "mock" : o.key!, fetchImpl: o.fetchImpl });
    root.write(`judge/responses/${runId}-${String(n).padStart(5, "0")}-${kind}.json`, { run: runId, ...r }); return { ...r, n };
  };
  const done = (p: string) => existsSync(root.p("v3", `${p}.json`));
  // dry run: every posting is assumed usable and its extracted requirements are priced at a conservative size
  const plannedExtract = new Set<string>(); const failedExtract = new Map<string, string>(); const DRY_CJR = { usable: true, mandatory: [{ text: "x".repeat(200), quote: "x".repeat(200), kind: "tool" }], dry_padding: "x".repeat(3000) };
  const order = profiles.map((p: any) => p.id).filter((p: string) => !(o.resume && done(p)));
  const summary: any[] = [];
  for (const p of order) {
    const t0 = Date.now(); const c = root.read("candidates", "cer", `${p}.json`); const resume = readFileSync(profiles.find((x: any) => x.id === p).resume, "utf8");
    const run = ret.runs.find((r: any) => r.p === p); if (!run) throw new RootError(`no retrieval pool for ${p}`);
    const want: [string, number][] = root.read("candidates", "cand", `${p}.json`).belief.want;
    // pool exactly as V2/V3 built it: hybrid top 200, then each fallback channel's first 50
    const pool: { id: string; channel: string; rank: number | null }[] = run.pool.map((id: string, i: number) => ({ id, channel: "hybrid", rank: i + 1 }));
    for (const ch of SETTINGS.retrieval.fallback_channels) for (const id of (run.channels[ch] ?? []).slice(0, SETTINGS.retrieval.fallback_depth)) if (!pool.some((x) => x.id === id)) pool.push({ id, channel: ch, rank: null });
    const P = FC.personFrom(c, answers[p].level); const trace = new Map<string, any>(); const sc: any[] = [];
    for (const x of pool) {
      const j = J.jobFor(x.id); const v: any = J.views.get(x.id), d: any = J.det.get(x.id);
      const t: any = { job_id: x.id, url: urls.get(x.id) ?? null, desc_sha256: descSha(j.text), retrieval_rank: x.rank, retrieval_channel: x.channel, channel_ranks: Object.fromEntries(Object.entries<any>(run.channels).map(([k, l]) => [k, l.indexOf(x.id) + 1 || null])) };
      trace.set(x.id, t);
      if (!v || !d) { t.eligible = false; t.stage = "excluded"; t.reason = "no job record"; continue; }
      const e = eligibility(j, c, resume); if (e.excluded) { t.eligible = false; t.stage = "excluded"; t.reason = e.reasons.join("; "); continue; }
      t.eligible = true; const jin = { id: x.id, title: v.title, employer: v.employer ?? "", text: j.text, det: d }; const f = FC.featuresOf(P, jin); const sg = FC.signatureOf(jin);
      const specs: string[] = (d.specialisation?.value ?? []).map(String); const agree = specs.length ? Math.max(...specs.map((s) => want.reduce((a, [k, w]) => a + w * transfer(k, s), 0))) : null;
      t.scope = f.compat.verdict; t.anchors = f.anchors.status;
      sc.push({ id: x.id, title: v.title, employer: v.employer ?? "", channels: t.channel_ranks, agree, compat: f.compat, anchors: f.anchors, cover: FC.coverOf(c, `${d.text?.requirements ?? ""}\n${(d.capabilities_essential?.value ?? []).join("\n")}`), sig: sg.sig, reqHash: sg.reqHash });
    }
    const sl = SL.shortlist3(sc, { size: SETTINGS.shortlist_size, ...SL.DEFAULT_SHORT }); const reps = sl.chosen.map((cl) => cl.rep.id);
    sl.chosen.forEach((cl, i) => { const t = trace.get(cl.rep.id); t.stage = "shortlisted"; t.shortlist_rank = i + 1; t.cluster_members = cl.members.filter((m) => m !== cl.rep.id);
      for (const m of t.cluster_members) Object.assign(trace.get(m), { stage: "cluster member, not judged", represented_by: cl.rep.id, judge: null, display: "not shown (never judged itself)" }); });
    for (const x of sc) { const t = trace.get(x.id); if (!t.stage) { t.stage = SL.hardMismatch(x) ? "held from judging (deterministic mismatch)" : "not shortlisted (ranked below the cut)"; t.reason = SL.hardMismatch(x) ? `scope ${x.compat.verdict}; anchors ${x.anchors.status}` : null; t.display = "not shown"; } }
    // 9. extraction: exact cache, complete text, oversized flagged (never cut)
    const cjrOf = new Map<string, any>();
    for (const id of reps) { const j = J.jobFor(id); const t = trace.get(id); const v: any = J.views.get(id);
      if (j.text.length > SETTINGS.extract_char_limit) { t.extraction = "oversized: not sent, not judged"; cjrOf.set(id, null); continue; }
      if (failedExtract.has(id)) { t.extraction = `not re-sent: extraction failed earlier in this run (${failedExtract.get(id)}); no retries`; cjrOf.set(id, null); continue; }
      if (o.mode === "dry" && plannedExtract.has(id)) { t.extraction = "dry run: already planned for an earlier candidate (would be a cache hit)"; cjrOf.set(id, DRY_CJR); continue; }
      const hit = cache.lookup(id, j.text); if (hit.cjr) { t.extraction = { hit: "cache hit (earlier run, exact identity)", hit_unusable: "cache hit (earlier run): posting unusable", reused: "reused (extracted earlier in this run)", reused_unusable: "reused (earlier in this run): posting unusable" }[hit.status as string]; cjrOf.set(id, hit.cjr); continue; }
      if (o.mode === "dry") plannedExtract.add(id);
      const r = await send("extract", `extract x3 ${id}`, EXTRACT_SYSTEM, extractUser(v.title, v.employer ?? "", j.text), SETTINGS.max_tokens.extract, "low");
      if (!r.ok && o.mode === "dry") { t.extraction = `${hit.status}; dry run (planned)`; cjrOf.set(id, DRY_CJR); continue; }
      if (!r.ok) { t.extraction = `${hit.status}; extraction ${r.reason}`; failedExtract.set(id, String(r.reason)); cjrOf.set(id, null); continue; }
      const val = validateCJR(firstJson((r as any).text), { id, text: j.text, title: v.title }, A.MODEL);
      if (!val.ok) { t.extraction = `${hit.status}; extraction rejected: ${val.errors.join(", ")}`; failedExtract.set(id, "invalid reply"); cjrOf.set(id, null); continue; }
      cache.put(val.cjr, j.text); t.extraction = `${hit.status}; extracted (${val.dropped} unquoted item(s) dropped)`; cjrOf.set(id, val.cjr); }
    // 10–11. judging in batches of five, every verdict validated against the posting and the evidence
    const block = candidateBlock(c); const usable = reps.filter((id) => cjrOf.get(id)?.usable); const verdicts: any[] = [];
    for (const id of reps.filter((id) => !usable.includes(id))) { verdicts.push({ job_id: id, fit: "cannot_judge", failed: cjrOf.get(id) ? `posting not usable: ${cjrOf.get(id).usable_reason}` : `not judged: ${trace.get(id).extraction}`, core: [] }); }
    // judge input j3-fulltext (judge3.ts): complete posting text; batches shrink to stay within the request budget, text is never cut
    const jobsToJudge = usable.map((id) => { const v: any = J.views.get(id); return { id, title: v.title, company: v.employer ?? "", text: J.jobFor(id).text, cjr: cjrOf.get(id) }; });
    const bt = J3.batchJobs(jobsToJudge, JUDGE_SYSTEM(block).length);
    for (const x of bt.tooLarge) { verdicts.push({ job_id: x.id, fit: "cannot_judge", failed: "judge request too large: not sent, not cut", core: [] }); }
    for (const b of bt.batches) {
      const r = await send("judge", `judge ${J3.JUDGE3_INPUT} ${p}`, JUDGE_SYSTEM(block), J3.judgeUserFull(b), bt.maxTokens(b), "medium");
      const list: any[] = r.ok ? ((firstJson((r as any).text) as any)?.verdicts ?? []) : [];
      for (const x of b) verdicts.push(o.mode === "dry" ? { job_id: x.id, fit: "cannot_judge", failed: "dry run (no call made)", core: [] } : r.ok ? validateVerdict(list.find((v) => String(v?.job_id) === x.id), x, block, block) : { job_id: x.id, fit: "cannot_judge", failed: `judge call ${r.reason}`, core: [] });
    }
    // 12–13. gate and display
    const ctx = (id: string) => { const v: any = J.views.get(id); const f = FC.featuresOf(P, { id, title: v.title, employer: v.employer ?? "", text: J.jobFor(id).text, det: J.det.get(id) }); return { compat: f.compat, anchors: f.anchors, eligible: true, employer: v.employer ?? "", title: v.title }; };
    const shown = G.present(verdicts.map((v) => ({ ...v, core: v.core ?? [] })), ctx, SETTINGS.strong_max);
    const strongIds = new Set(shown.strong.map((s) => s.job_id)), stretchIds = new Set(shown.stretch.map((s) => s.job_id));
    for (const v of verdicts) { const t = trace.get(v.job_id); const dec = shown.decisions.find((z) => z.v.job_id === v.job_id)!;
      Object.assign(t, { core_requirements: (cjrOf.get(v.job_id)?.mandatory ?? []).map((m: any) => m.text), candidate_evidence: (v.core ?? []).filter((k: any) => k.resume_quote).map((k: any) => ({ requirement: k.requirement, status: k.status, resume_quote: k.resume_quote })),
        judge: v.failed ? { valid: false, failed: v.failed } : { valid: true, fit: v.fit, confidence: v.confidence, function: v.function, specialisation: v.specialisation, seniority: v.seniority },
        gate: dec.d.tier, gate_reasons: dec.d.reasons, display: strongIds.has(v.job_id) ? "strong" : stretchIds.has(v.job_id) ? "stretch" : dec.d.tier === "strong" ? "not shown (cap of 5 or duplicate)" : "not shown" }); }
    const out = { candidate: p, mode: o.mode, config_sha256: cfg.config_sha256, strong: shown.strong, stretch: shown.stretch, none_reason: shown.none_reason, counts: { pooled: pool.length, eligible: sc.length, shortlisted: reps.length, cluster_members: sl.chosen.reduce((a, cl) => a + cl.members.length - 1, 0), held: sl.held, judged_valid: verdicts.filter((v) => !v.failed).length, judge_failed: verdicts.filter((v) => v.failed).length, strong: shown.strong.length, stretch: shown.stretch.length }, ms: Date.now() - t0, trace: [...trace.values()] };
    if (out.strong.some((s: any) => !verdicts.find((v) => v.job_id === s.job_id && !v.failed))) throw new Error("a strong recommendation without a valid judgement: refusing to write output");
    root.write(`v3/${p}.json`, out); summary.push({ candidate: p, ...out.counts, ms: out.ms, spent_inr: +ledger.spent().toFixed(2) }); root.log("v3 candidate", { candidate: p, ...out.counts });
    if (o.onlyFirst) { root.write("logs/checkpoint-first-candidate.json", { candidate: p, ms: out.ms, spent_inr: ledger.spent(), ledger_entries: ledger.entries().length, cache: cache.stats }); break; }
  }
  const report = { run: runId, mode: o.mode, config_sha256: cfg.config_sha256, candidates: summary, plan: { ...plan, worst_case_reserved_inr: +plan.worst_case_reserved_inr.toFixed(2) }, cache: cache.stats, unique_model_requests: plan.extract_requests + plan.judge_requests,
    ledger: { entries: ledger.entries().length, failed: ledger.entries().filter((e) => !e.ok).length, truncated: ledger.entries().filter((e) => e.stop === "max_tokens").length, spent_inr: +ledger.spent().toFixed(2) } };
  root.write(`logs/v3-${o.mode}-report.json`, report); return report;
}

// ── 16. per-stage report ─────────────────────────────────────────────────────────────────────────────────────────
export function reportStage(root: EvalRoot) {
  const per = readdirSync(root.p("v3")).filter((f) => f.endsWith(".json")).map((f) => root.read("v3", f)); const stages: Record<string, number> = {}; const ext: Record<string, number> = {};
  for (const r of per) for (const t of r.trace) { stages[t.display === "strong" ? "displayed strong" : t.display === "stretch" ? "displayed stretch" : t.stage] = (stages[t.display === "strong" ? "displayed strong" : t.display === "stretch" ? "displayed stretch" : t.stage] ?? 0) + 1; if (t.extraction) { const k = t.extraction.split(";")[0].split(":")[0]; ext[k] = (ext[k] ?? 0) + 1; } }
  const L = root.p("ledger", "ledger.jsonl"); const led = existsSync(L) ? readFileSync(L, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const ms = per.map((r) => r.ms).sort((a, b) => a - b);
  const rep = { candidates: per.length, strong_per_candidate: per.map((r) => r.strong.length), zero_strong: per.filter((r) => !r.strong.length).map((r) => ({ candidate: r.candidate, reason: r.none_reason })), stage_counts: stages, extraction: ext,
    calls: { total: led.length, failed: led.filter((e) => !e.ok).length, truncated: led.filter((e) => e.stop === "max_tokens").length, extract: led.filter((e) => String(e.purpose).startsWith("extract")).length, judge: led.filter((e) => String(e.purpose).startsWith("judge")).length },
    spend_inr: +led.reduce((a, e) => a + (e.inr ?? 0), 0).toFixed(2), latency_ms: { median: ms[Math.floor(ms.length / 2)] ?? null, max: ms.at(-1) ?? null } };
  root.write("logs/stage-report.json", rep); return rep;
}
