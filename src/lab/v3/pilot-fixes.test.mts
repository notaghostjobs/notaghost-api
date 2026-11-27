// Regression tests for the four defects found in the three-candidate pilot (27 Nov 2026) and the review count.
// Invented fixtures only: no résumé, posting or verdict text from the pilot.
//   SUPABASE_URL=https://offline.invalid SUPABASE_SERVICE_ROLE_KEY=offline npx tsx src/lab/v3/pilot-fixes.test.mts
import assert from "node:assert/strict";
const SC = await import("./scope.js"); const AN = await import("./anchors.js"); const G = await import("./gate.js"); const SL = await import("./shortlist.js"); const VA = await import("./validate3.js");
let n = 0; const t = (name: string, f: () => void) => { f(); n++; console.log("ok", n, name); };
const person = (o: any) => ({ years_total: { value: o.years ?? 5 }, roles: o.roles ?? [{ title: o.title ?? "Analyst", from: 2020, to: 2026, lines: o.recent ?? o.work ?? [] }], work_lines: o.work ?? [], achievement_lines: [], led_lines: o.led ?? [], project_lines: [], listed_lines: o.listed ?? [], summary_lines: [] });
const job = (title: string, text = "") => ({ title, text });
const check = (title: string, p: any, text = "") => AN.checkAnchors(AN.jobAnchors(job(title, text)), AN.candidateAnchors(p));
const fit = { verdict: "fit" as const, reasons: [] };
const cand = (id: string, title: string, p: any, rank: number) => ({ id, title, employer: `E${id}`, channels: { hybrid: rank }, agree: 0.6, compat: fit, anchors: check(title, p), cover: 0.5 });

// ── 1. operations people are not matched to accounting, audit or actuarial work ─────────────────────────────────
const loanOps = person({ years: 8, title: "Senior Process Associate", work: ["Responsible for the processing of mortgage loans for a banking client", "Prepared daily reconciliation and audit reports for the insurance and banking process"] });
const claims = person({ years: 6, title: "Claims Analyst", work: ["Handled claims processing and adjudication for a health insurer"] });
t("1a an accounting, audit or actuarial title is a different craft for a banking/insurance operations person", () => {
  for (const title of ["Senior Accountant - Record to Report", "Accounting Manager", "Manager, Accounting (Cost Analysis)", "Senior Regulatory Auditor", "Senior Actuarial Analyst", "Legal Entity Controller"]) {
    const a = check(title, loanOps); assert.equal(a.status, "missing", title); assert.equal(SL.anchorWeight(a), SL.MISSING_IN_TITLE_W, title); }
  // shared industry words in the person's lines ("reconciliation", "audit reports", "banking", "insurance") change nothing
  assert.ok(!AN.candidateAnchors(loanOps).demonstrated.has("fin.audit"));
});
t("1b neighbouring operations crafts stay in reach; the same craft ranks first", () => {
  assert.equal(check("Loan Servicing Associate", loanOps).status, "met");
  for (const title of ["Claims Supervisor", "Policy Administration Manager", "Payments Operations Analyst", "Service Delivery Team Lead"]) assert.equal(check(title, loanOps).status, "neighbour", title);
  assert.equal(check("Policy Servicing Executive", claims).status, "neighbour", "soft family: claims ↔ policy administration");
  assert.ok(!SL.hardMismatch(cand("1", "Claims Supervisor", loanOps, 1) as any), "a neighbour craft is judged, not held");
  // a craft the person only lists (skills or summary) places them in the field: neighbours stay in reach, the craft itself is not "met"
  const listed = person({ years: 8, title: "Process Associate", work: ["Handled customer service calls for a banking client"], listed: ["Mortgage processing, loan servicing"] });
  assert.equal(check("Claims Supervisor", listed).status, "neighbour"); assert.equal(check("Loan Servicing Associate", listed).status, "claimed_only"); assert.equal(check("Senior Accountant", listed).status, "missing");
});
t("1c shortlist: accounting/audit/actuarial postings lose to operations postings even when retrieval ranked them first", () => {
  const wrong = ["Senior Accountant", "Record to Report Specialist", "Senior IT Auditor", "Actuarial Analyst", "Accountant III", "Ledger Accountant"].map((x, i) => cand(`w${i}`, x, loanOps, i + 1));
  const right = ["Loan Servicing Associate", "Mortgage Operations Lead", "Claims Supervisor", "Policy Administration Manager", "Payments Operations Analyst", "Service Delivery Team Lead"].map((x, i) => cand(`r${i}`, x, loanOps, i + 20));
  const sl = SL.shortlist3([...wrong, ...right] as any, { size: 6, ...SL.DEFAULT_SHORT });
  assert.deepEqual(sl.chosen.map((c) => c.rep.id).filter((id) => id.startsWith("w")), [], "no wrong-field posting in the shortlist");
  // and they are not thrown away: when nothing else is left they can still be judged
  assert.equal(SL.shortlist3(wrong as any, { size: 3, ...SL.DEFAULT_SHORT }).chosen.length, 3);
});
t("1d the rule is about the craft, not one candidate: an accountant is equally not matched to claims operations", () => {
  const acct = person({ years: 7, title: "Senior Accountant", work: ["Owned month-end close and general ledger reconciliations"] });
  assert.equal(check("Claims Supervisor", acct).status, "missing"); assert.equal(check("Senior Accountant - R2R", acct).status, "met");
  assert.equal(check("Internal Audit Manager", acct).status, "sibling_only", "hard siblings inside finance are unchanged");
});

// ── 2. anchor coverage across functional areas ──────────────────────────────────────────────────────────────────
t("2a common titles in every functional area carry a defining anchor", () => {
  const titles: [string, string][] = [["Software Engineer II", "software"], ["Embedded Firmware Engineer", "software"], ["Network Engineer", "it_ops"], ["RTL Design Engineer", "hardware"], ["Mechanical Design Engineer", "engineering"], ["Electrical Engineer - Switchgear", "engineering"], ["Civil Engineer", "engineering"],
    ["Claims Processing Analyst", "insurance"], ["Policy Servicing Executive", "insurance"], ["Actuarial Analyst", "actuarial"], ["Payments Operations Analyst", "banking_ops"], ["Trade Finance Officer", "banking_ops"], ["Relationship Manager - Priority Banking", "banking_front"],
    ["Service Delivery Manager", "bizops"], ["Process Excellence Lead", "bizops"], ["Senior Accountant", "finance"], ["Internal Auditor", "finance"], ["Credit Risk Analyst", "finance"], ["Equity Research Associate", "finance"], ["Management Consultant", "consulting"],
    ["Sales Operations Analyst", "sales"], ["Digital Marketing Executive", "marketing"], ["Product Marketing Manager", "marketing"], ["HR Operations Specialist", "hr"], ["Facilities Management Lead", "admin"], ["Graphic Designer", "design"], ["Research Scientist", "science"],
    ["Project Manager", "product"], ["Technical Program Manager", "product"], ["Talent Acquisition Partner", "hr"], ["Category Manager", "retail"], ["Procurement Specialist", "scm"], ["Legal Counsel", "legal"], ["Staff Nurse", "health"], ["Customer Success Manager", "cx"]];
  const byId = new Map(AN.ANCHORS.map((a) => [a.id, a.family]));
  for (const [title, family] of titles) { const d = AN.jobAnchors(job(title)).defining; assert.ok(d.length, `no anchor for "${title}"`); assert.ok(d.some((x) => byId.get(x.id) === family), `"${title}" should be in ${family}, got ${d.map((x) => x.id)}`); }
  // a wrapper title is never held against someone from another domain
  const fpa = person({ title: "FP&A Manager", work: ["Owned budgeting and forecasting and variance analysis"] }); assert.equal(check("Delivery Operations Team Lead", fpa).status, "none");
  assert.equal(new Set(AN.ANCHORS.map((a) => a.id)).size, AN.ANCHORS.length, "anchor ids are unique"); assert.ok(new Set(AN.ANCHORS.map((a) => a.family)).size >= 28);
});
t("2b generic words do not create an anchor; earlier hard distinctions hold", () => {
  for (const line of ["Improved processes and worked with stakeholders across teams", "Strong communication, Excel and problem-solving skills", "Managed daily operations reporting"]) assert.deepEqual(AN.anchorsIn(line), [], line);
  const abap = person({ title: "SAP ABAP Consultant", work: ["Built ABAP reports and BAPIs"] }); assert.equal(check("SAP Fiori Developer", abap).status, "sibling_only");
  const fe = person({ title: "Frontend Engineer", work: ["Built React components as a software engineer"] });
  assert.equal(check("Backend Engineer", fe).status, "sibling_only"); assert.equal(check("Software Engineer", fe).status, "met");
});

// ── 3. validation: harmless differences pass; paraphrase, missing evidence and contradictions stay blocked ───────
const J = { id: "J1", title: "Platform Engineer", text: "We need 3+ years of experience in Java services. Bachelor's degree with 15 years full time education. Kubernetes in production is required." };
const block = ["Years (computed from role dates): 4.4", "ROLES", "2022 - Present Programmer", "Built Java services for payment enquiry,", "- settlement and reporting.", "EDUCATION", "Bachelor of Engineering (B.E)", "- Branch : Instrumentation and Control"].join("\n");
const raw = (core: any[], o: any = {}) => ({ job_id: "J1", fit: "direct", function: "same", specialisation: "same", seniority: "right", confidence: "high", why: "w", core, ...o });
const k = (requirement: string, job_quote: string, status: string, resume_quote: string | null) => ({ requirement, job_quote, status, resume_quote });
t("3a a quote that differs only in spacing, punctuation, case or line wrapping is accepted and replaced by the source text", () => {
  const v: any = VA.validateVerdict3(raw([k("Java services", "experience in Java services", "demonstrated", "built java services for payment enquiry - settlement and reporting"), k("Degree", "Bachelor's degree", "demonstrated", "Bachelor of Engineering (B.E) - Branch : Instrumentation and Control")]), J, block, block);
  assert.equal(v.failed, undefined, v.failed); assert.ok(v.core[0].resume_quote_normalised && v.core[1].resume_quote_normalised);
  assert.ok(block.replace(/\n-\s+/g, " ").replace(/\n+/g, " ").includes(v.core[1].resume_quote), "the stored quote is the source's own text");
  assert.equal(VA.locate("C developer for payments", "C++ developer for payments"), null, "C is not C++");
});
t("3b a paraphrase, an invented quote or a reordered quote is still rejected", () => {
  for (const q of ["Built Java services for enquiry", "Built scalable Java services for payment enquiry", "Developing and maintaining comprehensive service plans", "payment enquiry for Java services built"]) {
    const v: any = VA.validateVerdict3(raw([k("Java services", "experience in Java services", "demonstrated", q)]), J, block, block); assert.match(v.failed, /résumé quote not in evidence/, q); assert.equal(v.fit, "cannot_judge"); }
  const jv: any = VA.validateVerdict3(raw([k("Go", "experience in Go services", "unverified", null)]), J, block, block); assert.match(jv.failed, /job quote not in posting/);
});
t("3c missing evidence is still rejected, except where the computed years are the evidence", () => {
  const miss: any = VA.validateVerdict3(raw([k("Kubernetes", "Kubernetes in production is required", "demonstrated", null)]), J, block, block); assert.match(miss.failed, /demonstrated without a résumé quote/);
  const yrs: any = VA.validateVerdict3(raw([k("3+ years of experience in Java", "3+ years of experience in Java services", "demonstrated", null), k("Java services", "experience in Java services", "demonstrated", "Built Java services for payment enquiry")]), J, block, block);
  assert.equal(yrs.failed, undefined, yrs.failed); assert.equal(yrs.core[0].status, "demonstrated"); assert.equal(yrs.core[0].years_evidence, "computed years"); assert.match(yrs.core[0].resume_quote, /^Years \(computed/);
});
t("3d years of education are not years of experience; a real shortfall in experience is still a gap and a contradiction", () => {
  assert.equal(VA.isExperienceYears("15 years full time education", "15 years full time education"), false); assert.equal(VA.isExperienceYears("3+ years of experience in Java", "3+ years of experience"), true);
  const edu: any = VA.validateVerdict3(raw([k("15 years full time education", "15 years full time education", "demonstrated", "Bachelor of Engineering (B.E)"), k("Java services", "experience in Java services", "demonstrated", "Built Java services for payment enquiry")]), J, block, block);
  assert.equal(edu.failed, undefined, edu.failed); assert.notEqual(edu.core[0].status, "confirmed_gap"); assert.equal(edu.core[0].years_check, undefined);
  const J9 = { ...J, text: J.text.replace("3+ years", "9+ years") };
  const gap: any = VA.validateVerdict3(raw([k("9+ years of experience in Java", "9+ years of experience in Java services", "demonstrated", null)]), J9, block, block); assert.match(gap.failed, /contradicts its own checks/);
});
t("3e contradictory verdicts and schema breaches are still rejected", () => {
  const q = k("Java services", "experience in Java services", "demonstrated", "Built Java services for payment enquiry");
  assert.match((VA.validateVerdict3(raw([q, k("Kubernetes", "Kubernetes in production is required", "confirmed_gap", null)]), J, block, block) as any).failed, /contradicts/);
  assert.match((VA.validateVerdict3(raw([q], { function: "different" }), J, block, block) as any).failed, /contradicts/);
  assert.match((VA.validateVerdict3(raw([q], { seniority: "below" }), J, block, block) as any).failed, /direct with different specialisation or level/);
  assert.match((VA.validateVerdict3(raw([q], { fit: "great" }), J, block, block) as any).failed, /schema/); assert.match((VA.validateVerdict3(null, J, block, block) as any).failed, /missing verdict/);
});

// ── 4. the level label says what the level check found ──────────────────────────────────────────────────────────
const mgr = person({ years: 14, title: "Director of Programmes", roles: [{ title: "Director of Programmes", from: 2019, to: 2026, lines: ["Managed 4 programme managers and a 40-person department"] }], work: ["Managed 4 programme managers and a 40-person department"] });
const V = (o: any) => ({ job_id: "J1", fit: "adjacent", function: "neighbour", specialisation: "neighbour", seniority: "right", confidence: "medium", why: "", core: [{ requirement: "r", job_quote: "q", status: "demonstrated", resume_quote: "x" }, { requirement: "r2", job_quote: "q2", status: "demonstrated", resume_quote: "y" }], ...o });
const ctx = (compat: any) => ({ compat, anchors: { status: "met" as const, detail: [] }, eligible: true, employer: "Acme", title: "T" });
t("4a a move from management to a hands-on role is not called a step up", () => {
  const c = SC.compat(SC.candidateScope(mgr as any, "head"), SC.jobScope({ title: "Senior Backend Engineer", text: "Hands-on role: you will write production code daily. 5+ years of experience." } as any));
  assert.equal(c.verdict, "step_up"); assert.equal(c.basis, "track_change");
  const d = G.decide(V({ seniority: "below" }) as any, ctx(c)); assert.equal(d.tier, "stretch"); assert.deepEqual(d.reasons, ["adjacent, and a move from management to a hands-on role"]);
});
t("4b a real step up keeps its label; a disagreement with the judge is recorded, never hidden", () => {
  const ic = person({ years: 6, title: "Senior Engineer", work: ["Built payment APIs in Java"] });
  const c = SC.compat(SC.candidateScope(ic as any, "senior"), SC.jobScope({ title: "Engineering Manager", text: "You will manage a team of 8 engineers. 7+ years of experience." } as any));
  assert.equal(c.verdict, "step_up"); assert.equal(c.basis, "level");
  assert.deepEqual(G.decide(V({ seniority: "one_up" }) as any, ctx(c)).reasons, ["adjacent and a step up"]);
  const d = G.decide(V({ seniority: "below" }) as any, ctx(c)); assert.equal(d.tier, "stretch"); assert.equal(d.reasons[0], "adjacent and a step up"); assert.match(d.reasons[1], /level readings disagree/);
  assert.deepEqual(G.decide(V({}) as any, ctx({ verdict: "unknown", reasons: [] })).reasons, ["adjacent, and the level could not be established"]);
});
console.log(`\n${n} pilot-fix tests passed`);
