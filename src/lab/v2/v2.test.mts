// Matching v2: the 21 mandatory tests from the authorization (§8), plus budget-guard tests. Offline: no network,
// no model, no database. Fixtures below are small hand-written test inputs, not job descriptions or results.
//   SUPABASE_URL=https://offline.invalid SUPABASE_SERVICE_ROLE_KEY=offline npx tsx src/lab/v2/v2.test.mts
import assert from "node:assert/strict";
const { buildCER } = await import("./cer.js");
const { eligibility, shortlist, candidateSubspecs, personRung, shortlistScore, validateVerdict, display } = await import("./pipeline.js");
const { validateCJR, quoted } = await import("./cjr.js");
const { callSonnet, Ledger, firstJson, BudgetError } = await import("./api.js");
const { subspecs, rungOf } = await import("./terms.js");
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os";

let n = 0; const t = async (name: string, f: () => void | Promise<void>) => { await f(); n++; console.log("ok", n, name); };
const L = (text: string, section: string, column = "main") => ({ page: 1, column, section, text });
const layout = (lines: any[], two = false) => ({ lines, layout: [{ two_column: two }] });
const ans = { direction_primary: "eng.backend", direction_secondary: "none", level: "senior", open_to_adjacent: "yes", transition: "no" };
const cer = (lines: any[], o: any = {}) => buildCER("T", "x", layout(lines, true), { jobs: o.jobs ?? [], years_read: o.years ?? 6, years_basis: "dated", level_read: "senior", specs_shown: [] }, { ...ans, ...o.ans });
const backend = cer([L("Test Person", "unlabelled"), L("Backend Engineer, Acme 2019 - 2024", "experience"), L("Built Java Spring Boot microservices and REST APIs for payments", "experience"), L("React, Angular, Kubernetes", "skills", "side"), L("B.Tech Computer Science", "education")]);
const job = (o: any = {}) => ({ id: "1", title: "Backend Engineer", employer: "Co", text: "We need Java and Spring Boot experience.", reqText: "Must have Java and Spring Boot.", poolRank: 1, channel: "pool", agree: 0.8, ...o });
const elig = (o: any = {}, c = backend, r = "B.Tech Computer Science, Java") => eligibility({ id: "1", title: "Analyst", location: "Bengaluru", text: "", invalid: false, closed: false, ...o }, c, r);

await t("1 two-column résumé: the sidebar column is read as a list, not work", () => { assert.ok(backend.listed_lines.some((l) => /React/.test(l))); assert.ok(!backend.work_lines.some((l) => /React/.test(l))); });
await t("2 sidebar skills are never promoted to work experience", () => { const s = backend.skills.find((x) => x.id === "react"); assert.equal(s?.basis, "listed"); assert.equal(backend.skills.find((x) => x.id === "java")?.basis, "work"); });
await t("3 experience is not transferred between employers", () => {
  const c = cer([L("Analyst, Alpha Ltd 2016 - 2019", "experience"), L("Prepared Excel MIS reports", "experience"), L("Engineer, Beta Ltd 2019 - 2024", "experience"), L("Built Kafka pipelines", "experience")], { jobs: [{ title: "Analyst, Alpha Ltd", from: "2016", to: "2019" }, { title: "Engineer, Beta Ltd", from: "2019", to: "2024" }] });
  const a = c.roles.find((r) => /Alpha/.test(r.title))!, b = c.roles.find((r) => /Beta/.test(r.title))!;
  assert.ok(!a.lines.some((l) => /Kafka/.test(l))); assert.ok(!b.lines.some((l) => /Excel MIS/.test(l))); });
await t("4 Salesforce development vs Marketing Cloud (Next) are different specialisations", () => {
  assert.deepEqual(subspecs("Apex and LWC developer"), ["sf.dev"]); assert.deepEqual(subspecs("Marketing Cloud Next specialist, Journey Builder"), ["sf.marketing_cloud"]);
  const c = cer([L("Salesforce Developer, X 2019 - 2024", "experience"), L("Built Apex triggers and LWC components", "experience")]);
  const s = shortlistScore(job({ title: "Marketing Cloud Next Specialist", reqText: "Marketing Cloud, AMPscript required" }), c, candidateSubspecs(c), personRung(c), 10);
  assert.ok(s.why.some((w) => /sf.marketing_cloud/.test(w))); });
await t("5 SAP ABAP vs Fiori/UI5 vs CPI/BTP", () => {
  assert.deepEqual(subspecs("SAP Fiori UI5 consultant"), ["sap.fiori_ui5"]); assert.deepEqual(subspecs("SAP CPI / BTP integration"), ["sap.integration"]);
  const c = cer([L("SAP ABAP Developer, X 2018 - 2024", "experience"), L("Developed ABAP reports, BAPIs and RICEF objects", "experience")]);
  const same = shortlistScore(job({ title: "SAP ABAP Developer", reqText: "ABAP, RICEF" }), c, candidateSubspecs(c), personRung(c), 10).score;
  const fiori = shortlistScore(job({ title: "SAP Fiori Developer", reqText: "Fiori, UI5 required" }), c, candidateSubspecs(c), personRung(c), 10).score;
  assert.ok(same > fiori + 0.1); });
await t("6 backend vs hands-on full-stack", () => { const s = shortlistScore(job({ title: "Full Stack Engineer", reqText: "React and Node.js required" }), backend, candidateSubspecs(backend), personRung(backend), 10); assert.ok(s.why.some((w) => /full-stack/.test(w))); });
await t("7 credit underwriting vs loan operations", () => { assert.deepEqual(subspecs("Credit underwriting of SME loans, CAM preparation"), ["lend.underwriting"]); assert.deepEqual(subspecs("Loan disbursal and LMS updates"), ["lend.operations"]); });
await t("8 senior analyst vs principal scientist", () => { assert.equal(rungOf("Senior Analyst").rung, 2); assert.equal(rungOf("Principal Scientist").rung, 4);
  const c = cer([L("Senior Analyst, X 2020 - 2024", "experience"), L("Built ML models", "experience")], { years: 4, jobs: [{ title: "Senior Analyst", from: "2020", to: "2024" }] });
  assert.ok(shortlistScore(job({ title: "Principal Scientist" }), c, candidateSubspecs(c), personRung(c), 10).why.some((w) => /rung/.test(w))); });
await t("9 manager vs hands-on individual contributor", () => { const s = shortlistScore(job({ text: "You will manage a team of 8 engineers." }), backend, candidateSubspecs(backend), personRung(backend), 10); assert.ok(s.why.some((w) => /manages people/.test(w))); });
await t("10 missing compulsory certification excludes", () => { const e = elig({ text: "Must be a qualified Chartered Accountant." }, backend, "B.Tech"); assert.ok(e.excluded); assert.match(e.reasons[0], /requires ca/); });
await t("11 credentials with allowed alternatives do not exclude", () => { assert.equal(elig({ text: "Qualified Chartered Accountant or CMA or MBA Finance." }, backend, "B.Tech").excluded, false); });
await t("12 missing requirement (unverified) vs explicit contradiction (confirmed gap)", () => {
  const j = { id: "1", title: "Analyst", text: "Must have Tableau experience." };
  const gap = validateVerdict({ job_id: "1", fit: "adjacent", function: "same", specialisation: "same", seniority: "right", confidence: "high", why: "x", core: [{ requirement: "Tableau", job_quote: "Must have Tableau experience", status: "confirmed_gap", resume_quote: null }] }, j, "evidence");
  assert.equal(gap.fit, "cannot_judge");
  const unv = validateVerdict({ job_id: "1", fit: "adjacent", function: "same", specialisation: "same", seniority: "right", confidence: "high", why: "x", core: [{ requirement: "Tableau", job_quote: "Must have Tableau experience", status: "unverified", resume_quote: null }] }, j, "evidence");
  assert.equal(unv.fit, "adjacent"); assert.equal(display([unv], backend, new Map([["1", { title: "A", employer: "C", eligible: true }]])).strong.length, 0); });
await t("13 years not quoted from the posting are unknown, not inferred", () => {
  const r = validateCJR({ function: "f", specialisation: "s", usable: true, seniority: "mid", mandatory: [{ text: "Java", quote: "Must have Java experience", kind: "tool" }], secondary: [], preferred: [], credentials: [], years: { min: 7, max: 10, quote: "7-10 years required" } }, { id: "1", title: "T", text: "Must have Java experience." }, "m");
  assert.ok(r.ok && r.cjr.years.min === null && r.cjr.years.max === null); });
await t("14 wrong work location or candidate exclusion", () => { assert.ok(elig({ location: "Mumbai" }).excluded); assert.equal(elig({ location: "Bengaluru / Mumbai" }).excluded, false);
  const c = { ...backend, target: { ...backend.target, exclusions: ["night shift"] } }; assert.ok(elig({ text: "This is a night shift role." }, c).excluded); });
await t("15 duplicate jobs are suppressed", () => { const s = shortlist([job({ id: "1" }), job({ id: "2" }), job({ id: "3", title: "Platform Engineer" })], backend); assert.equal(s.length, 2);
  const v = (id: string) => ({ job_id: id, fit: "direct", function: "same", specialisation: "same", seniority: "right", confidence: "high", why: "x", gaps: [], unverified: [], core: [{ requirement: "Java", job_quote: "q", status: "demonstrated", resume_quote: "r" }] }) as any;
  assert.equal(display([v("1"), v("2")], backend, new Map([["1", { title: "Backend Engineer", employer: "Co", eligible: true }], ["2", { title: "Backend  engineer", employer: "co", eligible: true }]])).strong.length, 1); });
await t("16 closed and stale jobs are excluded and never shown", () => { assert.ok(elig({ closed: true }).excluded); assert.ok(elig({ stale: true }).excluded); assert.ok(elig({ invalid: true }).excluded);
  const v = { job_id: "9", fit: "direct", function: "same", specialisation: "same", seniority: "right", confidence: "high", why: "x", gaps: [], unverified: [], core: [{ requirement: "Java", job_quote: "q", status: "demonstrated", resume_quote: "r" }] } as any;
  assert.equal(display([v], backend, new Map([["9", { title: "B", employer: "C", eligible: false }]])).strong.length, 0); });
await t("17 missing or malformed AI output fails closed", () => { assert.equal(firstJson("no json here"), null); assert.equal(firstJson("{bad"), null); assert.equal(validateCJR(null, { id: "1", title: "", text: "" }, "m").ok, false);
  assert.equal(validateVerdict(undefined, { id: "1", title: "", text: "" }, "").fit, "cannot_judge"); assert.equal(validateVerdict({ job_id: "1", fit: "great" }, { id: "1", title: "", text: "" }, "").fit, "cannot_judge"); });
await t("18 fabricated or unsupported quotes fail closed", () => {
  const j = { id: "1", title: "Backend", text: "Must have Java and Spring Boot experience." };
  const v = validateVerdict({ job_id: "1", fit: "direct", function: "same", specialisation: "same", seniority: "right", confidence: "high", why: "x", core: [{ requirement: "Java", job_quote: "Must have Java and Spring Boot", status: "demonstrated", resume_quote: "Led a team of 40 Java engineers" }] }, j, "Built Java Spring Boot microservices");
  assert.equal(v.fit, "cannot_judge"); assert.match(v.failed!, /résumé quote/);
  const r = validateCJR({ function: "f", specialisation: "s", usable: true, seniority: "mid", mandatory: [{ text: "Kafka", quote: "Kafka expertise is mandatory", kind: "tool" }, { text: "Java", quote: "Must have Java and Spring Boot", kind: "tool" }], secondary: [], preferred: [], credentials: [], years: {} }, j, "m");
  assert.ok(r.ok && r.cjr.mandatory.length === 1 && r.dropped === 1); assert.equal(quoted("short", "short text"), false); });
await t("19 zero-match: nothing strong means zero shown, with a reason, and stretch never fills", () => {
  const s = { job_id: "1", fit: "stretch", function: "same", specialisation: "neighbour", seniority: "one_up", confidence: "high", why: "x", gaps: [], unverified: [], core: [] } as any;
  const d = display([s], backend, new Map([["1", { title: "A", employer: "B", eligible: true }]])); assert.equal(d.strong.length, 0); assert.ok(d.none_reason); assert.deepEqual(d.stretch, ["1"]); });
await t("20 candidate intent contradicting a job: adjacent not shown when related work is declined", () => {
  const c = { ...backend, target: { ...backend.target, open_to_adjacent: "no" } };
  const v = { job_id: "1", fit: "adjacent", function: "neighbour", specialisation: "neighbour", seniority: "right", confidence: "high", why: "x", gaps: [], unverified: [], core: [{ requirement: "Java", job_quote: "q", status: "demonstrated", resume_quote: "r" }] } as any;
  assert.equal(display([v], c, new Map([["1", { title: "A", employer: "B", eligible: true }]])).strong.length, 0); });
await t("21 a suitable job a broad function filter used to reject is kept (no ontology exclusion)", () => {
  const e = elig({ title: "Lending Operations Analyst", text: "Process loan files." }); assert.equal(e.excluded, false);
  assert.equal(shortlist([job({ title: "Lending Operations Analyst", agree: 0.1 })], backend).length, 1); });
// budget guard
const led = new Ledger(`${mkdtempSync(`${tmpdir()}/v2led-`)}/ledger.jsonl`);
await t("budget: no key, no call", async () => { const k = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY; await assert.rejects(callSonnet({ ledger: led, ceiling: 300, purpose: "t", system: "s", user: "u", maxTokens: 10 }), BudgetError); if (k) process.env.ANTHROPIC_API_KEY = k; });
await t("budget: a request that could cross the ceiling is refused before sending", async () => { process.env.ANTHROPIC_API_KEY ??= "test-not-a-key"; let sent = false;
  await assert.rejects(callSonnet({ ledger: led, ceiling: 0.01, purpose: "t", system: "s".repeat(4000), user: "u", maxTokens: 4000, fetchImpl: (async () => { sent = true; return new Response("{}"); }) as any }), BudgetError); assert.equal(sent, false); });
await t("budget: a substituted model is refused; usage is recorded from the provider", async () => {
  const ok = async () => new Response(JSON.stringify({ model: "claude-sonnet-5-5", usage: { input_tokens: 1000, output_tokens: 100 }, content: [{ type: "text", text: "{}" }] }), { status: 200 });
  const r = await callSonnet({ ledger: led, ceiling: 300, purpose: "t", system: "s", user: "u", maxTokens: 100, fetchImpl: ok as any }); assert.ok(Math.abs(r.inr - (1000 * 2 + 100 * 10) / 1e6 * 84) < 1e-9);
  const sub = async () => new Response(JSON.stringify({ model: "claude-haiku-5-5", usage: { input_tokens: 1, output_tokens: 1 }, content: [] }), { status: 200 });
  await assert.rejects(callSonnet({ ledger: led, ceiling: 300, purpose: "t", system: "s", user: "u", maxTokens: 10, fetchImpl: sub as any }), BudgetError); });
console.log(`${n} tests passed`);
