// Tests for core-versus-supporting requirements and evidence provenance. Offline. Run: npx tsx src/probe/req2-offline.mts
process.env.SUPABASE_URL ??= "https://offline.invalid"; process.env.SUPABASE_SERVICE_ROLE_KEY ??= "offline";
const { evaluate2, CORE_CAP } = await import("../lab/req2.js"); const { provenance } = await import("../lab/provenance.js"); const { validity2 } = await import("../lab/validity.js");
let ok = 0, bad = 0; const t = (n: string, c: boolean) => { if (c) ok++; else { bad++; console.log("FAIL", n); } };
const ev = (demo: string[], listed: string[] = [], strength?: [string, number][]) => ({ demonstrated: new Set(demo), listed: new Set(listed), scope: 1, scopeWhy: "", owns: false, ownsWhy: "", domains: [], quals: new Set<string>(), strength: strength ? new Map(strength) : undefined }) as any;
const rq = (mand: [string, string][], title = "", ment: [string, string][] = []) => ({ mandatory: new Map(mand), preferred: new Map(), mentioned: new Map(ment), level: "mid", manages: false, owns: false, domainMandatory: null, quals: [], spec: "swe.backend", source: "det", title, mandatoryText: mand.map((m) => m[1]).join("\n") }) as any;
const intent = { want: [["swe.backend", 1]], level: "mid", years: 5, domain: null, stretch: false } as any;
const node = ev(["nodejs", "javascript", "typescript", "sql", "aws", "docker"]);
const javaJob = rq([["java", "Strong Java and Spring Boot experience required"], ["spring", "Strong Java and Spring Boot experience required"], ["sql", "SQL databases"], ["aws", "AWS"]], "Senior Java Developer");
const nodeJob = rq([["nodejs", "Strong Node.js experience required"], ["sql", "SQL databases"], ["aws", "AWS"]], "Backend Engineer (Node.js)");
const o = { provenance: false, core: true };
const a = evaluate2(node, javaJob, intent, 0.9, o), b = evaluate2(node, nodeJob, intent, 0.6, o);
t("a Node.js engineer is capped on a Java/Spring role despite shared SQL and AWS", a.capped);
t("…so the Node.js role outranks it even from a lower retrieval position", b.score > a.score);
t("the control (no core logic) does not cap", !evaluate2(node, javaJob, intent, 0.9, { provenance: false, core: false }).capped);
const flex = rq([["java", "Experience in Java, Go or Node.js"], ["golang", "Experience in Java, Go or Node.js"], ["nodejs", "Experience in Java, Go or Node.js"]], "Backend Engineer");
t("an either/or stack requirement the candidate meets is not capped", !evaluate2(node, flex, intent, 0.8, o).capped);
const sqlOnly = rq([["sql", "SQL required"], ["excel", "Excel"]], "Data Analyst");
t("supporting skills alone never cap", !evaluate2(ev([]), sqlOnly, intent, 0.8, o).capped);
const k8 = rq([["kubernetes", "Hands-on Kubernetes in production required"]], "Platform Engineer");
const listedOnly = ev([], ["kubernetes"], [["kubernetes", 0.35]]), operated = ev(["kubernetes"], [], [["kubernetes", 1]]);
const pl = evaluate2(listedOnly, k8, intent, 0.8, { provenance: true, core: true }), po = evaluate2(operated, k8, intent, 0.8, { provenance: true, core: true });
t("Kubernetes only in a skills list scores below Kubernetes run in production", pl.score < po.score);
t("…and is 'unknown', not 'unsupported': no cap", !pl.capped && pl.checks.some((c: any) => c.req === "kubernetes" && c.status === "unknown"));
t("the cap is a multiplier, never a removal", CORE_CAP > 0 && CORE_CAP < 1);
const ca = rq([["accounting", "CA qualification is mandatory; product costing"]], "Business Analyst - Product Controlling"); ca.mandatoryText = "CA qualification is mandatory for this role";
t("a stated mandatory qualification not on the résumé caps", evaluate2(ev(["accounting"]), ca, intent, 0.8, o).capped);
// provenance from a layout reading
const lay = { layout: [{ two_column: true }], lines: [
  { page: 1, column: "left", section: "skills", text: "Kubernetes, Terraform, AWS" }, { page: 1, column: "right", section: "experience", text: "Senior Engineer, Acme  Jan 2021 - Present" },
  { page: 1, column: "right", section: "experience", text: "Built payment APIs in Node.js on AWS Lambda" }, { page: 1, column: "right", section: "summary", text: "Familiar with Kafka" } ] } as any;
const p = provenance(lay);
t("a sidebar skill is listed, with its line kept", p.best.get("kubernetes")?.basis === "listed" && !!p.best.get("kubernetes")?.text.includes("Kubernetes"));
t("a skill used in a job line is work, hands-on, under its role", p.best.get("nodejs")?.basis === "work" && p.best.get("nodejs")?.ownership === "hands_on" && !!p.best.get("nodejs")?.role);
t("AWS used at work beats AWS listed", (p.strength.get("aws") ?? 0) >= 0.9);
t("a summary claim is weaker than work", (p.strength.get("kafka") ?? 1) < 0.9);
// validity
t("a metadata-only careers page is invalid", !!validity2("Package Consultant", "Skip to content IBM Careers Login < Back to search results Job ID 1 City / Township / Village Bangalore State / Province Karnataka Work arrangement Hybrid Area of work Consulting Employment type Regular Position type Professional Travel required Up to 20% Apply now"));
t("an application form alone is invalid", !!validity2("PM", "Apply for this job * indicates a required field First Name * Last Name *"));
t("a real short posting stays valid", !validity2("Teller", "We are hiring a teller. You will handle cash deposits and withdrawals, maintain records and serve customers at the branch. Requirements: graduate, 1-2 years in banking."));
console.log(`${ok} passed, ${bad} failed`); if (bad) process.exit(1);
