// Offline checks for the career intelligence pieces. No network, no model. Run: npx tsx src/probe/career-offline.mts
process.env.SUPABASE_URL ??= "https://offline.invalid"; process.env.SUPABASE_SERVICE_ROLE_KEY ??= "offline";
const { SPECS, SPEC, transfer } = await import("../lib/ontology.js");
const { tagPosting } = await import("../lib/tagger.js");
const { analyse, questions, firstBelief, rank, quality, voi, journey, fixed, levelFit, agreement } = await import("../lib/career.js");
let ok = 0, bad = 0; const t = (name: string, c: boolean) => { if (c) ok++; else { bad++; console.log("FAIL", name); } };

// ontology
t("every neighbour exists", SPECS.every((s) => Object.keys(s.near).every((k) => SPEC.has(k))));
t("transfer is 1 to itself", transfer("fin.fpa", "fin.fpa") === 1);
t("transfer is symmetric in its larger direction", transfer("swe.backend", "swe.fullstack") === transfer("swe.fullstack", "swe.backend"));
t("unrelated work does not transfer", transfer("hw.dv", "hr.ta") === 0);
// tagger
t(".NET title reads as backend", tagPosting(".NET Developer", "We build APIs in C# and ASP.NET core.").spec === "swe.backend");
t("skills line beats a generic title", tagPosting("Custom Software Engineer", "Project Role : Custom Software Engineer\nMust have skills : SAP ABAP Development for HANA\nGood to have skills : NA").spec === "apps.saptech");
t("a specific title beats the skills line", tagPosting("Large Language Model Architect", "Must have skills : Cloud Solution Architecture\nbuild llm systems with rag and langchain").spec === "data.genai");
t("receivables plural", tagPosting("Executive - Accounts Receivables", "cash application and collections").spec === "fin.ar");
t("credit manager in construction finance is lending, not civil", tagPosting("Manager Credit - Construction Finance - Credit - Bengaluru", "credit appraisal for construction finance loans").spec === "bank.credit");
t("nothing named stays untagged", tagPosting("Executive", "Join our growing team.").spec === null);
// level fit
t("same level fits", levelFit("mid", "mid", false) === 1);
t("one up without stretch is weak", levelFit("mid", "senior", false) < 0.5 && levelFit("mid", "senior", true) >= 0.5);
t("two away never fits", levelFit("entry", "senior", true) === 0);

// a small pool and résumé to exercise the questions
const resume = `Priya Example\nSenior Financial Analyst\nExperience\nSenior FP&A Analyst | Acme Bank | Jan 2021 - Present\nBudgeting, forecasting, variance analysis, management reporting, P&L.\nFinancial Analyst | Beta Ltd | Jun 2018 - Dec 2020\nMonth-end close, journal entries, reconciliation.\nEducation\nB.Com, Some University, 2018`;
const a = analyse(resume, new Date("2026-11-24"));
t("reads FP&A first", a.specs[0]?.id === "fin.fpa");
t("years from dates", a.years !== null && a.years > 7 && a.years < 9);
const mk = (id: string, spec: string, level: any, fit = 0.5) => ({ id, title: id, employer: id, spec, level, fields: [], fit, eligible: () => true });
const pool = [mk("p1", "fin.fpa", "senior"), mk("p2", "fin.fpa", "senior"), mk("p3", "fin.reporting", "senior"), mk("p4", "fin.r2r", "senior"), mk("p5", "fin.fpa", "mid"), mk("p6", "data.eng", "senior", 0.9), mk("p7", "fin.fpa", "leader")];
const byId = new Map(pool.map((p) => [p.id, p]));
const b = firstBelief(a); const list = rank(b, pool as any, ["Senior FP&A Analyst"]);
t("unrelated work never shown, however high its text fit", !list.some((x) => x.id === "p6"));
t("quality is 0..1", quality(list, b, byId as any) >= 0 && quality(list, b, byId as any) <= 1);
const qs = questions(a);
t("a direction confirmation is always on offer", qs.some((q) => q.id === "direction" && q.options[0].label === "Yes"));
t("career change is always on offer", qs.find((q) => q.id === "direction")!.options.some((o) => o.key === "change"));
const field = { id: "noop", family: "field", text: "", settlesDirection: false, options: [{ key: "x", label: "x", taps: 1, apply: (z: any) => ({ ...z, want: new Map(z.want) }), p: () => 1 }] } as any;
t("a question that changes nothing is worth nothing", voi(field, b, pool as any, byId as any, []).v === 0);
const j = journey(a, { direction: `spec:${a.specs[0].id}` }, pool as any, []);
t("every journey confirms the direction first", ["direction", "split"].includes(j.steps[0].q));
t("at most 1 + 4 questions", j.steps.length <= 5);
const f = fixed(a, {});
t("fixed confirmation asks the same items", f.steps.map((s) => s.q).join(",").startsWith("direction,years,level"));
t("a career change answer searches the new work", journey(a, { direction: "change:product.pm", split: "change:product.pm" }, pool as any, []).belief.want.get("product.pm") === 1);
t("agreement under a settled want", agreement({ ...b, want: new Map([["fin.fpa", 1]]) }, "fin.reporting") === transfer("fin.fpa", "fin.reporting"));
console.log(`${ok} passed, ${bad} failed`); if (bad) process.exit(1);
