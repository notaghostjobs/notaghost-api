// Offline tests for the eligibility gate. No network, no model.
//   SUPABASE_URL=https://offline.invalid SUPABASE_SERVICE_ROLE_KEY=offline npx tsx src/lab/elig.test.mts
import assert from "node:assert/strict";
const { gate, rankScore } = await import("./elig.ts");
const job = (o: any = {}) => ({ id: "1", title: "Senior Analyst, FP&A", specs: ["fin.fpa"], yearsMin: 4, yearsMax: null, level: "mid", mustLines: [], allReq: "", ...o });
const person = (o: any = {}) => ({ want: [["fin.fpa", 1]] as [string, number][], level: "mid", years: 5, stretch: false, resume: "EDUCATION\nB.Com\nEXPERIENCE\nFP&A analyst, budgeting, forecasting in Excel", experience: "FP&A analyst, budgeting, forecasting in Excel", ...o });
let n = 0; const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("same function, years within range: eligible", () => assert.equal(gate(job(), person()).eligible, true));
t("different function: not eligible", () => { const v = gate(job({ specs: ["swe.backend"] }), person()); assert.equal(v.eligible, false); assert.match(v.why[0], /different function/); });
t("unclassified job: not excluded for function", () => assert.equal(gate(job({ specs: [] }), person()).eligible, true));
t("years: short by 1 of 6 allowed (slack max(1, 25%))", () => assert.equal(gate(job({ yearsMin: 6 }), person({ years: 5 })).eligible, true));
t("years: short by 3 of 8 not allowed", () => assert.equal(gate(job({ yearsMin: 8 }), person({ years: 5 })).eligible, false));
t("years: a step back beyond max + 3", () => assert.equal(gate(job({ yearsMin: 1, yearsMax: 3 }), person({ years: 8 })).eligible, false));
t("no years stated: seniority two rungs apart excludes", () => assert.equal(gate(job({ yearsMin: null, level: "leader" }), person({ level: "mid" })).eligible, false));
t("title tool absent from résumé: explicitly missing", () => { const v = gate(job({ title: "SAP FICO Consultant", specs: [] }), person()); assert.equal(v.eligible, false); assert.equal(v.specialist[0].status, "missing"); });
t("one unverified specialist must-have: eligible, flagged", () => { const v = gate(job({ mustLines: ["Must have hands-on Anaplan experience"] }), person()); assert.equal(v.eligible, true); assert.equal(v.unverified, 1); });
t("two unverified, none shown: not eligible", () => assert.equal(gate(job({ mustLines: ["Must have Anaplan experience", "Strong Hyperion skills required"] }), person()).eligible, false));
t("two unverified but one shown: eligible", () => assert.equal(gate(job({ mustLines: ["Must have Anaplan experience", "Strong Hyperion skills required", "Advanced SQL required"] }), person({ resume: "EDUCATION\nB.Com\nSQL, Excel", experience: "wrote SQL reports" })).eligible, true));
t("alternatives on one line: one held is enough", () => assert.equal(gate(job({ mustLines: ["Must have Anaplan or Hyperion"] }), person({ resume: "EDUCATION\nHyperion planning", experience: "built Hyperion models" })).eligible, true));
t("required credential absent, education listed: explicitly missing", () => { const v = gate(job({ mustLines: ["Must be a qualified Chartered Accountant"] }), person()); assert.equal(v.eligible, false); assert.match(v.why[0], /requires ca/); });
t("credential with a degree alternative: unverified, not missing", () => assert.equal(gate(job({ mustLines: ["CA / MBA Finance required"] }), person()).eligible, true));
t("credential required, no education section: unverified, not missing", () => assert.equal(gate(job({ mustLines: ["Must be a qualified Chartered Accountant"] }), person({ resume: "FP&A analyst" })).eligible, true));
t("nice-to-have lines never count", () => assert.equal(gate(job({ mustLines: [] , allReq: "Anaplan is a plus" }), person()).eligible, true));
t("rank: verified specialist evidence ranks above unverified", () => {
  const a = gate(job({ mustLines: ["Must have SQL"] }), person({ resume: "EDUCATION\nSQL", experience: "SQL reports" })), b = gate(job({ mustLines: ["Must have SQL"] }), person());
  assert.ok(rankScore(a, 0.5, 0.5) > rankScore(b, 0.5, 0.5)); });
console.log(`${n} tests passed`);
