// Privacy regression tests for the review-package boundary. Fixtures are invented; no real résumé text.
//   SUPABASE_URL=https://offline.invalid SUPABASE_SERVICE_ROLE_KEY=offline npx tsx src/lab/v2/review-redact.test.mts
import assert from "node:assert/strict";
const { cleanLines, isPersonal, nameTokens, audit, normalise, cleanJobText } = await import("./review-redact.js");
let n = 0; const t = (name: string, f: () => void) => { f(); n++; console.log("ok", n, name); };
const C = (lines: string[], names: string[] = []) => cleanLines(lines, names, "work").value;

t("1 personal information at the top of a résumé", () => { const names = nameTokens("Asha Verma\nasha.v@example.com | +91 98765 43210\nBengaluru 560034\nExperience");
  assert.deepEqual(names.sort(), ["Asha", "Verma"]); assert.deepEqual(C(["Asha Verma", "asha.v@example.com | +91 98765 43210", "Bengaluru 560034", "Built payment APIs in Java"], names), ["Built payment APIs in Java"]); });
t("2 personal details at the bottom of a résumé (block with continuation lines)", () => assert.deepEqual(C(["Reconciled ledgers for 40 entities", "PERSONAL DETAILS", "Date of Birth: 12/04/1991", "Husband Name: Rakesh K", "Address: #12/3, Lake View Layout,", "Indiranagar", "Bengaluru", "Nationality: Indian"]), ["Reconciled ledgers for 40 entities"]));
t("3 personal details inside table cells (several fields on one line)", () => assert.equal(C(["Gender: Female    Marital Status: Married    Nationality: Indian"]).length, 0));
t("4 symbol-font bullets and PDF codes before labels", () => { assert.ok(isPersonal("(cid:127) Date of Birth 03-05-1990")); assert.ok(isPersonal(" DOB: 3rd May 1990")); assert.ok(isPersonal("• Marital Status : Single")); });
t("5 mixed-case, letter-spaced and nonstandard labels", () => { assert.ok(isPersonal("D A T E  O F  B I R T H : 03/05/1990")); assert.ok(isPersonal("dAtE oF bIrTh - 1990")); assert.ok(isPersonal("Father's Name : S. Kumar")); assert.equal(normalise("P E R S O N A L"), "PERSONAL"); });
t("6 date of birth in several formats, without a label", () => { for (const d of ["03/05/1990", "3-5-1990", "03.05.1990", "3rd May 1990", "May 3, 1990", "12 Mar 1991"]) assert.ok(isPersonal(d), d); });
t("7 family names and relationships", () => { for (const l of ["S/O Ramesh Kumar", "Spouse: Priya", "Mother's Name: Lakshmi", "W/o Suresh"]) assert.ok(isPersonal(l), l); });
t("8 phone numbers and addresses split across lines", () => { assert.deepEqual(C(["Contact: +91 98765", "43210", "Built dashboards in Power BI"]), ["Built dashboards in Power BI"]); assert.deepEqual(C(["Address:", "No. 45, 2nd Cross,", "HSR Layout,", "Bengaluru 560102", "Led a team of 6 analysts"]), ["Led a team of 6 analysts"]); });
t("9 sensitive values inside skill or employment quotes", () => { const names = ["Asha", "Verma"]; const r = cleanLines(["Java, SQL, asha.v@example.com", "Asha Verma led migration of billing to AWS"], names, "skills");
  assert.deepEqual(r.value, ["[name] [name] led migration of billing to AWS"]); assert.equal(r.removed, 1); });
t("10 hidden data: the audit reads serialized JSON, not just visible text", () => { const blob = JSON.stringify({ cands: { A: "Built APIs\\nDate of Birth: 01/01/1990" } }); assert.ok(audit(blob).hits.length > 0); assert.equal(audit(JSON.stringify({ cands: { A: "Built APIs in Go" } })).hits.length, 0); });
t("11 exported answers carry no candidate fields", () => { const exp = { package: { name: "x", version: "2", data_sha: "abc" }, reviewer: "R1", answers: { R001: { suitability: "direct", apply: "yes", reasons: { primary: null, secondary: [] }, confidence: "high", note: "", at: "t" } } };
  assert.equal(audit(JSON.stringify(exp)).hits.length, 0); assert.ok(!/cand|resume|profile|B\d\d/.test(JSON.stringify(exp))); });
t("12 legitimate employment dates are preserved", () => { const keep = ["Analyst, Acme (Jan 2019 – Present)", "03/2020 - 12/2023 Credit Analyst", "Software Engineer 2018 to 2022", "Joined in 2021; promoted 2023"]; assert.deepEqual(C(keep), keep); });
t("13 credentials and professional work history are preserved", () => { const keep = ["B.Com, Christ University, 2014", "Chartered Accountant (ICAI), 2017", "MBA Finance, IIM Indore 2016–2018", "Managed 120 Cr loan book across 3 branches", "Reduced reconciliation time by 40% for 600 accounts"]; assert.deepEqual(C(keep), keep); });
t("job text: third-party contacts removed, requirements unchanged", () => { const j = "Must have 5+ years in Java. Apply to hr@acme.example or call 9876543210. See https://acme.example/jobs"; const c = cleanJobText(j); assert.ok(c.startsWith("Must have 5+ years in Java.")); assert.ok(!/@|\d{10}|https?:/.test(c)); });
t("residual risk is surfaced: a kept place word is listed for manual review", () => { const r = cleanLines(["Branch Operations, Jayanagar branch"], [], "work"); assert.equal(r.value.length, 1); assert.ok(r.uncertain.length >= 1); });
t("education lines with a locality and cross-functional work are kept", () => { const keep = ["B.Com, Sri Vidya College, Rajajinagar, Bengaluru 2012", "Drove cross-functional M&A integration across 4 business units, FY 2021", "PGDM (Finance), XYZ Institute, Malleswaram 2016"]; assert.deepEqual(C(keep), keep); });
console.log(`${n} tests passed`);
