// Matching v3 deterministic regression tests. Invented fixtures only (no résumé or posting text from the experiment).
//   SUPABASE_URL=https://offline.invalid SUPABASE_SERVICE_ROLE_KEY=offline npx tsx src/lab/v3/v3.test.mts
import assert from "node:assert/strict";
const SC = await import("./scope.js"); const AN = await import("./anchors.js"); const G = await import("./gate.js"); const SL = await import("./shortlist.js");
const { validateVerdict } = await import("../v2/pipeline.js");
let n = 0; const t = (name: string, f: () => void) => { f(); n++; console.log("ok", n, name); };
const person = (o: any) => ({ years_total: { value: o.years ?? 5 }, roles: o.roles ?? [{ title: o.title ?? "Analyst", from: 2020, to: 2026, lines: o.recent ?? o.work ?? [] }], work_lines: o.work ?? [], achievement_lines: o.ach ?? [], led_lines: o.led ?? [], project_lines: o.proj ?? [], listed_lines: o.listed ?? [], summary_lines: o.summary ?? [] });
const job = (title: string, o: any = {}) => ({ title, text: o.text ?? "", cjr: o.cjr });
const cjr = (o: any) => ({ function: o.function ?? "", specialisation: o.spec ?? "", mandatory: (o.mandatory ?? []).map((m: any) => (typeof m === "string" ? { text: m, quote: m, kind: "tool" } : m)), responsibilities: o.resp ?? [], years: { min: o.min ?? null, max: o.max ?? null }, seniority: o.seniority ?? "unknown", manages_people: o.manages ?? false });
const V = (o: any) => ({ job_id: "J1", fit: "direct", function: "same", specialisation: "same", seniority: "right", confidence: "high", why: "", core: [{ requirement: "r", job_quote: "q", status: "demonstrated", resume_quote: "x" }, { requirement: "r2", job_quote: "q2", status: "demonstrated", resume_quote: "y" }], ...o });
const ctx = (o: any = {}) => ({ compat: o.compat ?? { verdict: "fit", reasons: [] }, anchors: o.anchors ?? { status: "met", detail: [] }, eligible: o.eligible ?? true, employer: o.employer ?? "Acme", title: o.title ?? "Engineer" });
const lead = person({ years: 9, title: "Regional Credit Head", work: ["Led a team of 12 credit analysts across 4 branches", "Underwrote SME loans and prepared credit appraisal notes"] });

t("1 senior candidate is not given a junior role", () => {
  const c = SC.compat(SC.candidateScope(lead, "senior"), SC.jobScope(job("Credit Associate", { cjr: cjr({ seniority: "junior", min: 1, max: 3 }) })));
  assert.equal(c.verdict, "below"); assert.equal(G.decide(V({}), ctx({ compat: c })).tier, "rejected");
  // but a minimum is a floor, not a ceiling: 9 years for a "5+ years" manager role is a fit, not "below"
  assert.notEqual(SC.compat(SC.candidateScope(lead, "senior"), SC.jobScope(job("Credit Manager", { cjr: cjr({ min: 5, seniority: "senior" }) }))).verdict, "below");
});
t("2 principal-level scope is required for principal roles", () => {
  const ic = person({ years: 6, title: "Lead Software Engineer", work: ["Designed and implemented an LLM for wireless signal reasoning", "Built an ensemble CNN model"] });
  const c = SC.compat(SC.candidateScope(ic, "senior"), SC.jobScope(job("Principal Scientist", { cjr: cjr({ resp: ["Set the research agenda for the NLP group"], seniority: "lead" }) })));
  assert.equal(c.verdict, "too_far_up"); assert.ok(c.reasons.some((r) => /principal/.test(r))); assert.notEqual(G.decide(V({}), ctx({ compat: c })).tier, "strong");
  const pr = person({ years: 12, title: "Principal Scientist", work: ["Led a research group of 6", "Published at ACL and EMNLP as first author"] });
  assert.notEqual(SC.compat(SC.candidateScope(pr, "lead"), SC.jobScope(job("Principal Scientist", { cjr: cjr({ resp: ["Set the research agenda"], seniority: "lead" }) }))).verdict, "too_far_up");
});
t("3 individual contributor and manager are not converted automatically", () => {
  const ic = person({ years: 7, title: "Senior Engineer", work: ["Built payment APIs in Java", "Implemented Kafka consumers"] });
  const mgrJob = SC.jobScope(job("Engineering Manager", { cjr: cjr({ manages: true, seniority: "lead", min: 7 }) }));
  const c1 = SC.compat(SC.candidateScope(ic, "senior"), mgrJob); assert.ok(["step_up", "too_far_up"].includes(c1.verdict)); assert.ok(c1.reasons.some((r) => /no people leadership/.test(r)));
  const mgr = person({ years: 14, title: "Director of Engineering", roles: [{ title: "Director of Engineering", from: 2019, to: 2026, lines: ["Managed 4 engineering managers and a 40-person department"] }], work: ["Managed 4 engineering managers and a 40-person department"] });
  const icJob = SC.jobScope(job("Senior Backend Engineer", { text: "Hands-on role: you will write production code daily.", cjr: cjr({ min: 5, seniority: "senior" }) }));
  const c2 = SC.compat(SC.candidateScope(mgr, "head"), icJob); assert.ok(c2.reasons.some((r) => /recent work is management/.test(r))); assert.notEqual(c2.verdict, "fit");
});
t("4 specialist anchors are not inferred from generic skills", () => {
  const sqlExcel = AN.candidateAnchors(person({ work: ["Wrote SQL queries and Excel reports for operations"], listed: ["SQL, Excel, Tableau"] }));
  assert.ok(!["met", "partial"].includes(AN.checkAnchors(AN.jobAnchors(job("FP&A Analyst")), sqlExcel).status), "generic SQL/Excel never meets FP&A");
  const dash = AN.candidateAnchors(person({ work: ["Built dashboards and analytics for the sales team in SQL and Excel"] }));
  assert.equal(AN.checkAnchors(AN.jobAnchors(job("FP&A Analyst")), dash).status, "missing");
  assert.equal(G.decide(V({ confidence: "medium" }), ctx({ anchors: AN.checkAnchors(AN.jobAnchors(job("FP&A Analyst")), dash) })).tier, "stretch");
  const abap = AN.candidateAnchors(person({ work: ["Developed ABAP reports, BAPIs and BADIs for SD"] }));
  assert.equal(AN.checkAnchors(AN.jobAnchors(job("SAP Fiori Developer")), abap).status, "sibling_only");
  assert.notEqual(G.decide(V({}), ctx({ anchors: AN.checkAnchors(AN.jobAnchors(job("SAP Fiori Developer")), abap) })).tier, "strong");
  const sfdev = AN.candidateAnchors(person({ work: ["Built Apex triggers and LWC components"] }));
  assert.equal(AN.checkAnchors(AN.jobAnchors(job("Salesforce Marketing Cloud Developer")), sfdev).status, "sibling_only");
});
t("5 similar titles with different functions are told apart", () => {
  const under = AN.jobAnchors(job("Credit Analyst - Retail Underwriting")).defining.map((d) => d.id), ops = AN.jobAnchors(job("Credit Operations Executive - Loan Disbursal")).defining.map((d) => d.id);
  assert.ok(under.includes("lend.underwriting") && !under.includes("lend.operations")); assert.ok(ops.includes("lend.operations") && !ops.includes("lend.underwriting"));
  assert.deepEqual(AN.anchorsIn("Built financial modelling for the annual operating plan"), ["fin.fpa"]);   // financial modelling is not data science
  const mt = AN.candidateAnchors(person({ work: ["Managed category assortment and vendor negotiations"] }));
  assert.equal(AN.checkAnchors(AN.jobAnchors(job("Head of Modern Trade")), mt).status, "sibling_only");
});
t("6 relevant jobs are not discarded by near-duplicates or one large employer", () => {
  const SIG = { yearsBand: "3-5", city: "bengaluru", employment: "full-time", manages: false, anchors: "eng.backend", unit: "swe", tools: ["java", "spring"] };
  const mk = (id: string, title: string, employer: string, rank: number, sig: any = SIG) => ({ id, title, employer, channels: { dense: rank }, agree: 0.8, compat: { verdict: "fit" as const, reasons: [] }, anchors: { status: "met" as const, detail: [] }, cover: 0.8, sig });
  const dup = Array.from({ length: 12 }, (_, i) => mk(`D${i}`, "Custom Software Engineer - Bengaluru", "BigCo", i + 1));
  const others = Array.from({ length: 6 }, (_, i) => mk(`O${i}`, `Backend Engineer ${["Payments", "Search", "Risk", "Ledger", "Billing", "Infra"][i]}`, `Co${i}`, 20 + i));
  const r = SL.shortlist3([...dup, ...others], { size: 5, ...SL.DEFAULT_SHORT });
  assert.equal(r.chosen.filter((c) => c.rep.employer === "BigCo").length, 1); assert.equal(r.chosen.find((c) => c.rep.employer === "BigCo")!.members.length, 12);
  assert.equal(r.chosen.length, 5); assert.equal(SL.normTitle("Manager - Retail Credit - Housing - Bengaluru"), SL.normTitle("Manager - Housing - Retail Credit"));
  const bad = { ...mk("X", "Credit Associate", "Co9", 1), compat: { verdict: "below" as const, reasons: [] } };
  assert.ok(!SL.shortlist3([bad, ...others], { size: 3, ...SL.DEFAULT_SHORT }).chosen.some((c) => c.rep.id === "X"), "a hard mismatch never fills a slot");
});
t("7 missing mandatory qualifications block the strong list", () => {
  assert.equal(G.decide(V({ core: [{ requirement: "CA", job_quote: "q", status: "confirmed_gap", resume_quote: null }, { requirement: "r", job_quote: "q", status: "demonstrated", resume_quote: "x" }] }), ctx()).tier, "rejected");
  const miss = { status: "missing" as const, detail: [{ id: "fin.fpa", label: "FP&A", status: "missing", quote: null }] };
  assert.equal(G.decide(V({ confidence: "medium" }), ctx({ anchors: miss })).tier, "stretch");
  assert.equal(G.decide(V({ fit: "adjacent", confidence: "high" }), ctx({ anchors: miss })).tier, "stretch");
  assert.equal(G.decide(V({ confidence: "high" }), ctx({ anchors: miss })).tier, "strong", "only a direct, same-specialisation, high-confidence quoted verdict outranks a vocabulary miss");
});
t("8 contradictory résumé evidence: a senior title without the years or scope is not senior", () => {
  const p = SC.candidateScope(person({ years: 3, title: "Head of Growth", work: ["Ran weekly campaign reports"] }), null);
  assert.ok(p.titleInflated); assert.ok((p.level ?? 9) <= 2); assert.ok(!p.scopes.some((s) => s.scope === "team_leadership"));
});
t("9 ambiguous job requirements are not treated as a match", () => {
  const js = SC.jobScope(job("Associate - Special Projects")); const an = AN.jobAnchors(job("Associate - Special Projects"));
  assert.equal(an.defining.length, 0); const cs = SC.compat(SC.candidateScope({ ...person({}), years_total: { value: null }, roles: [] }, null), js);
  assert.equal(cs.verdict, "unknown"); const d = G.decide(V({ fit: "adjacent", confidence: "medium" }), ctx({ compat: cs, anchors: AN.checkAnchors(an, AN.candidateAnchors(person({}))) }));
  assert.notEqual(d.tier, "strong"); assert.equal(js.yearsMin, null);
});
t("10 experience is read as stated: floors, ranges and ceilings", () => {
  const p8 = SC.candidateScope(person({ years: 8, title: "Senior Analyst", work: ["Prepared monthly forecasts"] }), "senior");
  assert.equal(SC.compat(p8, SC.jobScope(job("FP&A Manager", { cjr: cjr({ min: 5 }) }))).verdict, "fit");
  const js = SC.jobScope(job("Analyst", { text: "Requires 3-5 years of experience" })); assert.equal(js.yearsMin, 3); assert.equal(js.yearsMax, 5);
  assert.equal(SC.compat(SC.candidateScope(person({ years: 2, work: ["Prepared reports"] }), "mid"), SC.jobScope(job("Senior Manager", { cjr: cjr({ min: 8 }) }))).verdict, "too_far_up");
});
t("11 no duplicate recommendations", () => {
  const vs = ["A", "B", "C"].map((id) => V({ job_id: id })); const titles: any = { A: "Credit Manager", B: "Credit Manager ", C: "Risk Manager" };
  const out = G.present(vs, (id) => ctx({ title: titles[id], employer: "Bank" })); assert.deepEqual(out.strong.map((s) => s.job_id), ["A", "C"]);
});
t("12 zero matches: nothing is padded", () => {
  const out = G.present([V({ job_id: "A", fit: "stretch" }), V({ job_id: "B", fit: "unsuitable" })], () => ctx());
  assert.equal(out.strong.length, 0); assert.ok(out.none_reason); assert.deepEqual(out.stretch.map((s) => s.job_id), ["A"]);
});
t("13 unsupported or fabricated evidence fails closed", () => {
  const raw = { job_id: "J1", fit: "direct", function: "same", specialisation: "same", seniority: "right", confidence: "high", why: "w", core: [{ requirement: "Java", job_quote: "5 years of Java", status: "demonstrated", resume_quote: "Led Java migration at a bank" }] };
  const v = validateVerdict(raw, { id: "J1", title: "Engineer", text: "Needs 5 years of Java." }, "Built Python services");
  assert.ok(v.failed); assert.equal(G.decide(v as any, ctx()).tier, "rejected");
});
t("14 a confident verdict does not override deterministic evidence", () => {
  assert.equal(G.decide(V({ confidence: "high" }), ctx({ compat: { verdict: "below", reasons: ["junior band"] } })).tier, "rejected");
  assert.notEqual(G.decide(V({ fit: "adjacent", confidence: "low" }), ctx()).tier, "strong");
  assert.notEqual(G.decide(V({ fit: "adjacent", confidence: "high" }), ctx({ compat: { verdict: "step_up", reasons: [] } })).tier, "strong");   // adjacent AND a step up is two stretches
  assert.notEqual(G.decide(V({ confidence: "medium" }), ctx({ compat: { verdict: "step_up", reasons: [] } }), { ...G.DEFAULT_OPTS, directStepUpMedium: false }).tier, "strong");
  assert.equal(G.decide(V({ function: "different", fit: "direct" }), ctx()).tier, "rejected");
});
t("15 same title, different requirements: never one judgement", () => {
  const base = { yearsBand: "3-5", city: "bengaluru", employment: "full-time", manages: false, anchors: "eng.backend", unit: "swe", tools: ["java", "spring", "kafka"] };
  const variants: [string, any][] = [["experience", { yearsBand: "10+" }], ["tech stack", { tools: ["golang", "kubernetes"] }], ["specialist requirement", { anchors: "eng.backend,eng.ml" }], ["location", { city: "pune" }],
    ["employment arrangement", { employment: "contract" }], ["management", { manages: true }], ["business unit", { unit: "payments" }]];
  for (const [what, d] of variants) assert.equal(SL.sameRequirements(base, { ...base, ...d }), false, what);
  assert.equal(SL.sameRequirements(base, { ...base, tools: ["java", "spring", "kafka", "redis"] }), true, "a minor tool difference still matches");
  assert.equal(SL.sameRequirements(base, undefined), false, "no signature, no merge");
  const mk = (id: string, sig: any) => ({ id, title: "Software Engineer", employer: "BigCo", channels: { dense: 1 }, agree: 0.8, compat: { verdict: "fit" as const, reasons: [] }, anchors: { status: "met" as const, detail: [] }, cover: 0.8, sig });
  const r = SL.shortlist3([mk("A", base), mk("B", { ...base, yearsBand: "10+" }), mk("C", base)], { size: 10, ...SL.DEFAULT_SHORT });
  assert.equal(r.chosen.length, 2); assert.deepEqual(r.chosen.find((c) => c.rep.id === "A" || c.rep.id === "C")!.members.sort(), ["A", "C"]);
  assert.equal(SL.EMPLOYMENT("Data Analyst (6-month contract)"), "contract"); assert.equal(SL.EMPLOYMENT("Summer Internship - Finance"), "internship");
});
t("16 a cluster member is never displayed on its representative's verdict", () => {
  // only verdicts reach present(); a member without its own verdict cannot appear, whatever its cluster
  const out = G.present([V({ job_id: "REP" })], (id) => ctx({ title: "Software Engineer", employer: "BigCo" }));
  assert.deepEqual(out.strong.map((s) => s.job_id), ["REP"]);
});
t("17 a vocabulary gap is not a capability gap", () => {
  const nurse = AN.candidateAnchors(person({ work: ["Managed ward rounds and medication schedules for 30 beds"] }));
  const ja = AN.jobAnchors(job("Clinical Research Associate")); assert.ok(ja.defining.length > 0);
  const st = AN.checkAnchors(ja, nurse).status; assert.ok(["unrecognised", "missing"].includes(st));
  const hr = AN.candidateAnchors(person({ work: ["Ran end-to-end hiring for 40 engineering roles"] })); assert.equal(AN.checkAnchors(AN.jobAnchors(job("Talent Acquisition Partner")), hr).status, "met");
  assert.equal(AN.checkAnchors(AN.jobAnchors(job("HR Business Partner")), hr).status, "sibling_only");
  const blind = AN.candidateAnchors(person({ work: ["Coordinated weekly vendor visits"] })); assert.equal(AN.checkAnchors(AN.jobAnchors(job("Procurement Manager")), blind).status, "unrecognised");
  assert.equal(G.decide(V({ fit: "adjacent", confidence: "high" }), ctx({ anchors: { status: "unrecognised", detail: [] } })).tier, "strong", "the judge's evidence decides");
});
t("18 every planned test profession has defining anchors that a plain job title and a plain work line both reach", () => {
  const cases: [string, string, string][] = [["software", "Backend Engineer (Java)", "Built Spring Boot microservices for payments"], ["data", "Data Analyst", "Built dashboards and analytics for the ops team"], ["finance", "FP&A Manager", "Owned annual operating plan and monthly forecasting"],
    ["lending", "Credit Underwriter - SME", "Underwrote SME loans and wrote credit appraisal memos"], ["sales", "Key Account Manager", "Managed key accounts worth 12 Cr and drove upsell"], ["marketing", "Performance Marketing Manager", "Ran paid search and paid social for user acquisition"],
    ["hr", "Talent Acquisition Lead", "Ran end-to-end hiring for 60 roles a quarter"], ["scm", "Procurement Specialist", "Ran strategic sourcing and supplier negotiation for packaging"], ["support", "Application Support Engineer (L2)", "Handled L2 support and incident management on ServiceNow"],
    ["product", "Product Manager - Payments", "Wrote PRDs and owned the product roadmap for UPI"], ["design", "Product Designer (UX)", "Ran user research and designed flows in Figma"], ["legal", "Legal Counsel", "Handled contract drafting and negotiation for vendor agreements"],
    ["compliance", "AML Compliance Analyst", "Performed KYC reviews and AML transaction monitoring"], ["health", "Clinical Research Coordinator", "Coordinated clinical trials across 3 sites"], ["cx", "Customer Success Manager", "Owned renewals and churn reduction for 40 SaaS clients"],
    ["admin", "Executive Assistant to CEO", "Calendar management and office administration for the CEO"], ["education", "Mathematics Teacher", "Prepared lesson plans and curriculum for grades 8-10"], ["devops", "DevOps Engineer", "Managed Kubernetes clusters with Terraform and CI/CD"]];
  for (const [area, title, line] of cases) { const ja = AN.jobAnchors(job(title)); assert.ok(ja.defining.length, `${area}: job title not covered`); assert.equal(AN.checkAnchors(ja, AN.candidateAnchors(person({ work: [line] }))).status, "met", `${area}: plain work line not recognised`); }
});
console.log(`${n} tests passed`);
