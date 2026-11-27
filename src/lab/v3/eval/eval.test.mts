// Acceptance tests for the V3 evaluation infrastructure: the whole workflow on invented candidates and an invented
// inventory, with the provider mocked. No network, no key, no spend.
//   SUPABASE_URL=https://offline.invalid SUPABASE_SERVICE_ROLE_KEY=offline npx tsx src/lab/v3/eval/eval.test.mts
import assert from "node:assert/strict"; import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, cpSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; import { execFileSync } from "node:child_process";
const T = mkdtempSync(join(tmpdir(), "v3eval-")); process.env.V3_FREEZE_FILE = join(T, "FROZEN-config.json");
const MODELS = process.env.LAB_MODELS ?? "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad/models";
const R = await import("./root.js"); const IN = await import("./intake.js"); const PL = await import("./pipeline.js"); const FZ = await import("./freeze.js"); const RV = await import("./review.js"); const MK = await import("./mock.js"); const FX = await import("./fixtures.mjs");
const A = await import("../api3.js"); const { htmlToText } = await import("../jobtext.js");
let n = 0; const t = async (name: string, f: () => any) => { await f(); n++; console.log("ok", n, name); };
const throwsAsync = async (f: () => Promise<any>, re: RegExp) => { let e: any = null; try { await f(); } catch (x) { e = x; } assert.ok(e && re.test(String(e.message)), `expected ${re}, got ${e?.message}`); };

FZ.writeConfigFreeze(MODELS, "acceptance test");
const root = R.EvalRoot.create(join(T, "root"), "synthetic", "synth-acceptance"); FX.writeCandidates(root.p("intake")); FX.writeAll(join(T, "fx"));
// development-profile sketches: invented here; one is made from S02's résumé to prove the duplicate check works
const s02 = IN.resumeText(root.p("intake", "S02", "resume.pdf")); writeFileSync(join(T, "dev.json"), JSON.stringify([{ id: "B99", sketch: IN.sketch("Unrelated text about ships and engines ".repeat(30)) }]));
writeFileSync(join(T, "dev-dup.json"), JSON.stringify([{ id: "B98", sketch: IN.sketch(s02) }]));

await t("data root: missing, wrong schema, wrong population and path escapes fail clearly", () => {
  assert.throws(() => R.EvalRoot.open(undefined, "pilot"), /no data root/); assert.throws(() => R.EvalRoot.open(join(T, "nope"), "pilot"), /not an evaluation root/);
  assert.throws(() => R.EvalRoot.open(root.dir, "pilot"), /population is synthetic/); assert.throws(() => root.p("..", "x"), /escapes/); assert.throws(() => root.need("jobs", "missing.json"), /required file missing/);
  writeFileSync(join(T, "bad-root.json"), "{}"); const bad = join(T, "badroot"); cpSync(root.dir, bad, { recursive: true }); writeFileSync(join(bad, "ROOT.json"), JSON.stringify({ schema: "other/1", population: "synthetic" })); assert.throws(() => R.EvalRoot.open(bad, "synthetic"), /schema/);
});
let pre: any;
await t("intake: accepted, held and rejected with reasons; nothing filled in", () => {
  pre = PL.preflightStage(root, join(T, "dev.json"), new Date("2026-11-26T12:00:00Z")); const d = Object.fromEntries(pre.decisions.map((x: any) => [x.candidate, x]));
  assert.deepEqual(["S01", "S02", "S03", "S04"].map((c) => d[c].status), ["accepted", "accepted", "accepted", "accepted"]);
  assert.equal(d.S05.status, "rejected"); assert.match(d.S05.reasons.join(), /same résumé as candidate S01/);
  assert.equal(d.S06.status, "rejected"); assert.match(d.S06.reasons.join(), /no valid consent/);
  assert.equal(d.S07.status, "held"); assert.match(d.S07.reasons.join(), /leader roles/); assert.ok(d.S07.clarify.length);
  assert.equal(d.S08.status, "held"); assert.match(d.S08.reasons.join(), /target functions required/); assert.match(d.S08.reasons.join(), /adjacent-role preference missing/);
  assert.equal(d.S09.status, "rejected"); assert.match(d.S09.reasons.join(), /unreadable or too short/);
  assert.equal(d.S10.status, "held"); assert.match(d.S10.reasons.join(), /deal-breaker/);
  const ans = root.read("intent", "answers.json"); assert.deepEqual(Object.keys(ans).sort(), ["S01", "S02", "S03", "S04"]); assert.equal(ans.S01.source, "candidate");
  assert.ok(!("S08" in ans), "a held candidate gets no invented answers");
  const dup = IN.preflight(root.p("intake"), JSON.parse(readFileSync(join(T, "dev-dup.json"), "utf8")), new Date("2026-11-26T12:00:00Z")); assert.match(dup.decisions.find((x: any) => x.candidate === "S02")!.reasons.join(), /same person as development profile B98/);
  const bad = { ...root.read("intake", "S01", "intake.json"), candidate_id: "B07" }; assert.match(IN.validate(root.p("intake", "S01"), bad, [], []).reasons.join(), /development ID/);
});
await t("pilot selection: by arrival, first per professional area, before any output", () => {
  const intakes = root.candidates().map((c) => root.read("intake", c, "intake.json")); const acc = pre.decisions.filter((d: any) => d.status === "accepted").map((d: any) => d.candidate);
  const sel = IN.selectByArrival(intakes as any, acc, 3); assert.deepEqual(sel.selected.map((x) => x.candidate), ["S01", "S02", "S03"]); assert.equal(new Set(sel.selected.map((x) => x.area)).size, 3);
  root.write("intake/sampling-manifest.json", sel);
});
await t("snapshot: hashed on import; malformed, duplicate or second snapshots refused", () => {
  const meta = PL.snapshotStage(root, join(T, "fx", "snapshot.jsonl"), { captured_at: FX.SYNTHETIC_CAPTURED_AT, source: "synthetic" }); assert.equal(meta.sha256, R.fileSha(root.p("inventory", "snapshot.jsonl")));
  assert.throws(() => PL.snapshotStage(root, join(T, "fx", "snapshot.jsonl"), { captured_at: "x", source: "x" }), /already recorded/);
  const r2 = R.EvalRoot.create(join(T, "r2"), "synthetic", "r2"); const lines = readFileSync(join(T, "fx", "snapshot.jsonl"), "utf8").split("\n").filter(Boolean);
  writeFileSync(join(T, "bad1.jsonl"), [lines[0], lines[0]].join("\n")); assert.throws(() => PL.snapshotStage(r2, join(T, "bad1.jsonl"), { captured_at: "x", source: "x" }), /duplicate job ids/);
  const o = JSON.parse(lines[0]); delete o.description; writeFileSync(join(T, "bad2.jsonl"), JSON.stringify(o)); assert.throws(() => PL.snapshotStage(r2, join(T, "bad2.jsonl"), { captured_at: "x", source: "x" }), /lacks description/);
});
await t("freeze: any changed file, setting or hash is refused", () => {
  const good = readFileSync(process.env.V3_FREEZE_FILE!, "utf8"); FZ.verifyConfig(MODELS);
  const f = JSON.parse(good); f.files["src/lab/v3/gate.ts"] = "0".repeat(64); writeFileSync(process.env.V3_FREEZE_FILE!, JSON.stringify(f)); assert.throws(() => FZ.verifyConfig(MODELS), /gate\.ts changed since the freeze/);
  const g = JSON.parse(good); g.settings.shortlist_size = 50; writeFileSync(process.env.V3_FREEZE_FILE!, JSON.stringify(g)); assert.throws(() => FZ.verifyConfig(MODELS), /settings changed/);
  writeFileSync(process.env.V3_FREEZE_FILE!, good);
});
let prep: any;
await t("free stages: one eligible inventory (fresh, valid) for both arms; résumé evidence; retrieval pools; control", () => {
  prep = PL.prepareStage(root, MODELS); const el = root.read("jobs", "eligibility.json"); assert.equal(el.stale_or_empty, 3, "the three stale postings are excluded for both arms");
  const elig = new Set(root.readLines("jobs", "eligible-snapshot.jsonl").map((r) => String(r.id))); const ret = root.read("pools", "retrieval.json"); const ctl = root.read("control", "control.json");
  for (const r of ret.runs) { assert.ok(r.pool.every((id: string) => elig.has(id))); assert.ok(r.pool.length > 0); }
  for (const [p, c] of Object.entries<any>(ctl)) { assert.ok(c.top.every((id: string) => elig.has(id)), `control for ${p} reads only the eligible inventory`); assert.match(c.arm, /original offline matcher, not production Radar/); }
  const views = new Map(root.readLines("jobs", "views-det.jsonl").map((v) => [v.id, v.title])); assert.ok(![...views.values()].includes("Associate - Special Projects"), "invalid (empty) postings are excluded for both arms");
  for (const p of ["S01", "S02", "S03", "S04"]) { const c = root.read("candidates", "cer", `${p}.json`); assert.ok(c.work_lines.length >= 3, `${p} evidence lines`); assert.equal(c.target.source, "candidate"); }
});
const faults: Record<string, any> = {}; const J = PL.jobs(root); const title = (id: string) => J.views.get(id)?.title;
const idOf = (t0: string) => [...J.views.values()].find((v: any) => v.title === t0)!.id as string;
faults["title:Senior Backend Engineer - Ledger"] = "truncated";
let rep1: any; let cachedAfterFirst = 0;
await t("V3 end to end with the mocked provider: trace for every pair, 0–5 strong, stretch apart, ledger reconciled", async () => {
  // fault injection on judge calls for one shortlisted job of S01 and S02 (schema breach; fabricated quote)
  rep1 = await PL.v3Stage(root, { mode: "dry", modelsDir: MODELS }); assert.equal(rep1.ledger.entries, 0, "dry run: no call"); assert.ok(rep1.plan.judge_requests > 0 && rep1.plan.extract_requests > 0);
  for (const f of readdirSync(root.p("v3"))) rmSync(root.p("v3", f)); for (const f of readdirSync(root.p("judge", "requests"))) rmSync(root.p("judge", "requests", f));
  const v1 = (p: string) => root.read("v3", `${p}.json`);
  const firstRun = await PL.v3Stage(root, { mode: "mock", modelsDir: MODELS, fetchImpl: MK.mockFetch({ faults }), onlyFirst: true }); assert.equal(firstRun.candidates.length, 1); assert.ok(existsSync(root.p("logs", "checkpoint-first-candidate.json")));
  cachedAfterFirst = readdirSync(root.p("cjr")).length; const s01 = v1("S01"); const sl = s01.trace.filter((x: any) => x.stage === "shortlisted" && x.judge?.valid); faults[sl[3].job_id] = "schema"; faults[sl[6].job_id] = "fabricated_quote";
  for (const f of readdirSync(root.p("v3"))) rmSync(root.p("v3", f));
  rep1 = await PL.v3Stage(root, { mode: "mock", modelsDir: MODELS, fetchImpl: MK.mockFetch({ faults }) });
  const L = new A.Ledger3(root.p("ledger", "ledger.jsonl"), "mock"); assert.equal(rep1.ledger.entries, L.entries().length);
  for (const p of ["S01", "S02", "S03", "S04"]) { const o = v1(p); assert.ok(o.strong.length >= 0 && o.strong.length <= 5); const st = new Set(o.stretch.map((x: any) => x.job_id)); assert.ok(o.strong.every((s: any) => !st.has(s.job_id)), "no stretch role in the strong list");
    for (const tr of o.trace) { for (const k of ["job_id", "url", "desc_sha256", "retrieval_channel"]) assert.ok(k in tr, `${p} trace has ${k}`); assert.ok(tr.stage, "every pair has a stage"); }
    for (const s of o.strong) { const tr = o.trace.find((x: any) => x.job_id === s.job_id); assert.equal(tr.judge.valid, true); assert.equal(tr.gate, "strong"); assert.equal(tr.display, "strong"); assert.ok(tr.shortlist_rank >= 1 && tr.retrieval_rank !== undefined); } }
  const a = v1("S01").trace; assert.match(a.find((x: any) => x.job_id === sl[3].job_id).judge.failed, /schema/); assert.match(a.find((x: any) => x.job_id === sl[6].job_id).judge.failed ?? "", /résumé quote not in evidence/);
});
await t("zero-recommendation candidate is reported with its reason, never padded", () => { const o = root.read("v3", "S04.json"); assert.equal(o.strong.length, 0); assert.ok(o.none_reason); });
await t("complete job descriptions: the long posting is sent whole (its last requirement included); oversized flagged, never cut", () => {
  const ledgerJob = idOf("Senior Backend Engineer - Ledger"); const full = htmlToText(J.raw.get(ledgerJob).description); assert.ok(full.length > 16000, "the fixture is longer than V2's old limits");
  const req = readdirSync(root.p("judge", "requests")).map((f) => root.read("judge", "requests", f)).find((r) => r.user.includes("TITLE: Senior Backend Engineer - Ledger"));
  assert.ok(req.user.endsWith(full), "the complete text is in the extraction request"); assert.ok(req.user.includes("Certified Kubernetes Administrator"), "the mandatory requirement at the end is present");
  const jreqs = readdirSync(root.p("judge", "requests")).filter((f) => f.endsWith("-judge.json")).map((f) => root.read("judge", "requests", f));
  for (const r of jreqs) { for (const part of r.user.split("\n\n=====\n\n")) { const id = /^JOB (\S+):/.exec(part)![1]; assert.equal(part.split("\nJOB TEXT:\n")[1], htmlToText(J.raw.get(id).description), `judge request for ${id} carries the complete posting`); }
    assert.ok(Math.abs(r.worst_case_inr - A.worstCase3(r.system_chars, r.user.length, r.max_tokens)) < 1e-9, "the reservation is computed on the actual request"); assert.ok(r.user.split("\n\n=====\n\n").length <= 5); }
  const trs = ["S01", "S02", "S03", "S04"].flatMap((p) => root.read("v3", `${p}.json`).trace); const ov = trs.filter((x: any) => title(x.job_id) === "Backend Engineer - Archive Platform" && x.extraction);
  assert.ok(ov.length && ov.every((x: any) => /oversized: not sent/.test(x.extraction))); assert.ok(!readdirSync(root.p("judge", "requests")).some((f) => root.read("judge", "requests", f).user.includes("TITLE: Backend Engineer - Archive Platform")));
  const trunc = trs.filter((x: any) => x.job_id === ledgerJob && x.extraction); assert.ok(trunc.some((x: any) => /extraction truncated/.test(x.extraction)), "the truncated reply fails closed"); assert.ok(trunc.every((x: any) => !x.judge?.valid));
  const amb = trs.filter((x: any) => title(x.job_id) === "Finance Associate - Special Projects" && x.judge); assert.ok(amb.every((x: any) => /not usable/.test(x.judge.failed ?? "")), "a posting without stated requirements is flagged, not judged");
});
await t("no automatic retries: a failed extraction is not re-sent for the next candidate", () => {
  const sent = readdirSync(root.p("judge", "requests")).filter((f) => f.startsWith(rep1.run)).map((f) => root.read("judge", "requests", f)).filter((r) => r.user.includes("TITLE: Senior Backend Engineer - Ledger")); assert.equal(sent.length, 1);
});
await t("requirement-sensitive clustering: same-title postings with different requirements are judged separately; members never shown", () => {
  const trs = ["S01", "S02", "S03", "S04"].flatMap((p) => root.read("v3", `${p}.json`).trace.map((x: any) => ({ p, ...x })));
  const se = trs.filter((x: any) => title(x.job_id) === "Software Engineer" && x.stage === "cluster member, not judged"); const seIds = new Set([...J.views.values()].filter((v: any) => v.title === "Software Engineer").map((v: any) => v.id));
  assert.ok(se.every((x: any) => !seIds.has(x.represented_by)), "a different-requirement Software Engineer posting is never represented by another");
  const mem = trs.filter((x: any) => x.stage === "cluster member, not judged"); assert.ok(mem.length > 0, "the exact duplicates form a cluster");
  for (const m of mem) { assert.equal(m.judge, null); assert.match(m.display, /never judged itself/); const o = root.read("v3", `${m.p}.json`); assert.ok(!o.strong.some((s: any) => s.job_id === m.job_id)); }
});
await t("cache: exact identity only; reuse within a run and hits from an earlier run counted separately; stale detected", async () => {
  assert.ok(rep1.cache.reused_in_run > 0, "sharing within a run is counted as reuse"); assert.ok(rep1.cache.hit > 0 && rep1.cache.hit <= cachedAfterFirst, "earlier-run hits only for records an earlier run actually wrote");
  const before = root.read("v3", "S01.json"); for (const f of readdirSync(root.p("v3"))) rmSync(root.p("v3", f));
  const files = readdirSync(root.p("cjr")); const victim = files[0]; const c = JSON.parse(readFileSync(root.p("cjr", victim), "utf8")); c.extractor = "x9"; writeFileSync(root.p("cjr", victim), JSON.stringify(c));
  const rep2 = await PL.v3Stage(root, { mode: "mock", modelsDir: MODELS, fetchImpl: MK.mockFetch({ faults }) }); assert.ok(rep2.cache.hit > 0, "second run: exact hits"); assert.ok(rep2.cache.stale >= 1, "a record with another extractor version is stale, not reused");
  const after = root.read("v3", "S01.json"); assert.deepEqual(after.strong.map((s: any) => s.job_id), before.strong.map((s: any) => s.job_id), "the same inputs give the same recommendations");
});
await t("paid calls: impossible without stage authorisation; failed and truncated calls are in the ledger; zero budget refuses", async () => {
  let fetched = 0; const spy = (async () => { fetched++; throw new Error("must not be called"); }) as any;
  await throwsAsync(() => PL.v3Stage(root, { mode: "paid", modelsDir: MODELS, stage: "pilot", key: "k", fetchImpl: spy }), /not authorised|does not cover stage/); assert.equal(fetched, 0); assert.ok(!existsSync(PL.AUTH_FILE), "no authorisation file exists in this commit");
  const fake = join(T, "AUTH.json"); writeFileSync(fake, JSON.stringify({ stage: "pilot", ceiling_inr: 1350, approved_by: "x", approved_at: "y", root_id: root.meta.id })); 
  assert.throws(() => PL.authorisation("pilot", root.meta.id, fake), /not committed/, "an uncommitted authorisation file is refused");
  const L = new A.Ledger3(join(T, "led.jsonl"), "t"); const g = new A.Guard(L, 5); const big = { purpose: "judge", system: "s".repeat(10000), user: "u".repeat(40000), maxTokens: 10000, key: "k" };
  await throwsAsync(() => A.call3(g, { ...big, fetchImpl: MK.mockFetch() }), /refused/); assert.equal(L.entries().length, 0, "nothing sent when the reservation cannot fit");
  const g2 = new A.Guard(L, 100); const r = await A.call3(g2, { ...big, fetchImpl: MK.mockFetch({ faults: { "J1": "http_error" } }), user: "JOB J1: x\n" + big.user }); assert.equal(r.ok, false); assert.equal(L.entries().at(-1).ok, false); assert.equal(L.entries().at(-1).inr, 0);
  const w = A.worstCase3(10000, 40000, 10000); assert.ok(w >= ((10000 * A.PRICE.out) / 1e6) * A.INR_PER_USD, "the reservation covers the full max_tokens output");
  const g3 = new A.Guard(L, L.spent() + w * 1.5); const both = await Promise.allSettled([A.call3(g3, { ...big, fetchImpl: MK.mockFetch() }), A.call3(g3, { ...big, fetchImpl: MK.mockFetch() })]); assert.equal(both.filter((x) => x.status === "rejected").length, 1, "two concurrent reservations cannot both fit");
});
let rv: any;
await t("review packages: every displayed job is a case; overlaps share one code; audit sample; no system identity; feedback forms", () => {
  rv = RV.reviewStage(root); const key = root.read("review", "key.HIDDEN.json"); const c = rv.counts;
  const pairs = key.map((k: any) => `${k.profile}|${k.job_id}`); assert.equal(new Set(pairs).size, pairs.length, "one case per person–job pair");
  for (const p of ["S01", "S02", "S03", "S04"]) { const o = root.read("v3", `${p}.json`); const ctl = root.read("control", "control.json")[p];
    for (const s of o.strong) assert.ok(key.some((k: any) => k.profile === p && k.job_id === s.job_id && k.arms.includes("v3") && k.package === "P"));
    for (const j of ctl.top) assert.ok(key.some((k: any) => k.profile === p && k.job_id === j && k.arms.includes("control") && k.package === "P")); }
  assert.ok(c.overlap_cases >= 1 && key.filter((k: any) => k.arms.length === 2).every((k: any) => k.arms.join() === "control,v3"));
  // the case categories are disjoint and add up; shown-by totals count an overlap once per arm (27 Nov reconciliation)
  assert.equal(c.v3_only_cases + c.control_only_cases + c.overlap_cases + c.audit_cases, c.cases_total); assert.equal(c.v3_only_cases + c.control_only_cases + c.overlap_cases, c.displayed_cases);
  assert.equal(c.v3_shown + c.control_shown - c.overlap_cases, c.displayed_cases); assert.equal(c.P + c.Q, c.cases_total); assert.equal(c.v3_cases, undefined);
  assert.ok(c.audit_cases > 0 && key.filter((k: any) => !k.arms.length).every((k: any) => k.strata.every((s: string) => /^audit:[ABC]$/.test(s))));
  for (const pkg of ["P", "Q"]) { const html = readFileSync(root.p("review", `Radar-review-synthetic-${pkg}.html`), "utf8"); const data = /const D=(\{.*?\});const PKG/s.exec(html)![1]; const D = JSON.parse(data.replace(/\\u003c/g, "<"));
    assert.deepEqual(Object.keys(D).sort(), ["cases", "people", "version"]); for (const c of D.cases) assert.deepEqual(Object.keys(c).sort(), ["cand", "code", "employer", "location", "text", "title"], "a case carries only what a reviewer needs");
    for (const p of Object.values<any>(D.people)) assert.deepEqual(Object.keys(p).sort(), ["achievements", "education", "intent_candidate", "projects", "roles", "skills_listed", "summary", "work", "years", "years_basis"]);
    const meta = JSON.stringify({ version: D.version, codes: D.cases.map((c: any) => c.code), cands: D.cases.map((c: any) => c.cand) });
    for (const w of [/\bv3\b/i, /control/i, /sonnet/i, /audit/i, /strat/i, /arm/i]) assert.ok(!w.test(meta), `${pkg} package metadata leaks ${w}`);
    assert.ok(!/\bv3\b|control|sonnet|claude/i.test(html.replace(data, "")), `${pkg} page shell leaks system identity`); }
  for (const p of ["S01", "S02", "S03", "S04"]) { const f = readFileSync(root.p("review", `feedback-${p}.html`), "utf8"); const d = JSON.parse(/const D=(\{.*?\});const PKG/s.exec(f)![1].replace(/\\u003c/g, "<"));
    assert.equal(d.jobs.length, key.filter((k: any) => k.profile === p && k.arms.length).length, "feedback lists exactly the jobs shown to that person"); }
});
await t("scoring: agree → adjudicate → lock → unblind; denominators exact; audit and self-report kept apart; populations never mixed", () => {
  const key = root.read("review", "key.HIDDEN.json"); const P = root.read("review", "manifest-P.json"); const Q = root.read("review", "manifest-Q.json");
  const ans = (code: string, s: string, a: string) => ({ suitability: s, apply: a, reasons: { primary: ["stretch", "unsuitable", "cannot"].includes(s) ? "seniority" : null, secondary: [] }, confidence: "high", uncertainty: "", note: "", at: "t" });
  const pick = (code: string, i: number) => (i % 4 === 0 ? "stretch" : "direct");
  const exp = (rev: string, codes: string[], m: any, flip = "") => ({ package: { name: "ghosted-radar-review", version: m.version, data_sha: m.data_sha }, reviewer: rev, answers: Object.fromEntries(codes.map((c, i) => [c, ans(c, c === flip ? "unsuitable" : pick(c, i), "yes")])) });
  const w = (f: string, o: any) => { writeFileSync(join(T, f), JSON.stringify(o)); return join(T, f); };
  const ea = w("a.json", exp("rev-1", P.codes, P)), eb = w("b.json", exp("rev-2", P.codes, P, P.codes[1])), mp = w("mP.json", P), mq = w("mQ.json", Q), eq = w("q.json", exp("rev-1", Q.codes, Q));
  const py = (...a: string[]) => execFileSync("python3", [join(FZ.REPO, "lab/eval/v2/score-review-v2b.py"), ...a], { encoding: "utf8" });
  const ag = JSON.parse(py("agree", mp, ea, eb)).agreement; assert.deepEqual(ag.to_adjudicate, [P.codes[1]]);
  const adj = w("adj.json", { [P.codes[1]]: { suitability: "direct", apply: "yes", dispute_type: "suitability", adjudicator: "independent" } }); py("lock", mp, ea, eb, adj, "--out", join(T, "lock.json"));
  py("single", mq, eq, "--out", join(T, "single.json"));
  const fb = w("fb.json", { answers: Object.fromEntries(key.filter((k: any) => k.arms.length).slice(0, 3).map((k: any) => [k.code, { apply: "yes" }])) });
  const split = w("split.json", { synthetic: ["S01", "S02", "S03", "S04"] });
  const u = JSON.parse(py("unblind", join(T, "lock.json"), root.p("review", "key.HIDDEN.json"), "--boot", "200", "--splits", split, "--self", fb, "--audit-single", join(T, "single.json")));
  const v3 = u.arms.v3.synthetic; const v3cases = key.filter((k: any) => k.arms.includes("v3")).length;
  assert.equal(v3.displayed, v3cases); assert.equal(u.denominator_audit.v3.displayed_in_key, u.denominator_audit.v3.labelled);
  const lock = JSON.parse(readFileSync(join(T, "lock.json"), "utf8")); const k = key.filter((x: any) => x.arms.includes("v3")).filter((x: any) => ["direct", "adjacent"].includes(lock.final[x.code].suitability)).length;
  assert.equal(v3.primary_precision.k, k); assert.equal(v3.primary_precision.n, v3cases);
  assert.ok(u.false_negative_audit && Object.keys(u.false_negative_audit).every((s) => /^audit:/.test(s))); assert.equal(u.denominator_audit.audit_cases.unlabelled, 0);
  assert.ok(u.candidate_reported_would_apply.v3 || u.candidate_reported_would_apply.control); assert.ok("failure_rates" in u.arms.v3);
  const mixed = w("mixed-key.json", [...key, { ...key[0], code: "C999", profile: "B01" }]); const lk = JSON.parse(readFileSync(join(T, "lock.json"), "utf8")); lk.final["C999"] = lk.final[P.codes[0]]; writeFileSync(join(T, "lock2.json"), JSON.stringify(lk));
  assert.throws(() => py("unblind", join(T, "lock2.json"), mixed), /populations are never combined/);
});
await t("finalise: the snapshot, candidates and pricing check are fixed before any paid call; later changes are refused", () => {
  root.write("manifest/pricing-check.json", { checked_at: new Date().toISOString(), source: "synthetic test", model: A.MODEL, usd_per_mtok: A.PRICE });
  const fin = FZ.finalise(root, MODELS, { stage: "pilot", pricing: root.read("manifest", "pricing-check.json") }); assert.equal(fin.snapshot.sha256, R.fileSha(root.p("inventory", "snapshot.jsonl")));
  assert.throws(() => FZ.finalise(root, MODELS, { stage: "pilot", pricing: {} }), /already exists/); FZ.verifyFinal(root, MODELS);
  const f = root.p("intake", "S01", "intake.json"); const orig = readFileSync(f, "utf8"); writeFileSync(f, orig.replace('"senior"', '"leader"')); assert.throws(() => FZ.verifyFinal(root, MODELS), /intake for S01 changed/); writeFileSync(f, orig);
});
console.log(`${n} tests passed`); rmSync(T, { recursive: true, force: true });
