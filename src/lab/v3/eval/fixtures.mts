// Synthetic evaluation fixtures: an invented job inventory and invented candidates (no real person, employer posting
// or résumé text). Covers the cases the acceptance tests need: long postings with requirements at the end, short and
// ambiguous postings, stale postings, same-title postings with different requirements, exact near-duplicates, and
// candidates who are valid, held (missing or contradictory answers) or rejected (consent, duplicate, unreadable).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CONSENT_TEXT, CONSENT_VERSION, TEST_ID, INTAKE_SCHEMA } from "./intake.js";
import { sha256 } from "./root.js";

const AREAS: { fn: string; titles: string[]; must: string[]; duties: string[] }[] = [
  { fn: "swe.backend", titles: ["Backend Engineer", "Senior Backend Engineer", "Java Developer", "Lead Software Engineer - Payments"], must: ["Must have 4+ years building Java and Spring Boot microservices", "Required: experience designing REST APIs and Kafka consumers", "Strong SQL and PostgreSQL performance tuning is mandatory"], duties: ["Build and run payment APIs at scale", "Own service reliability and on-call", "Review designs and mentor engineers"] },
  { fn: "fin.fpa", titles: ["FP&A Analyst", "Senior Financial Analyst - FP&A", "FP&A Manager", "Business Finance Analyst"], must: ["Must have 3+ years in financial planning and analysis", "Required: annual operating plan and monthly forecasting experience", "Advanced Excel financial modelling is mandatory"], duties: ["Prepare monthly variance analysis", "Partner with business heads on budgets", "Build the annual operating plan"] },
  { fn: "hr.ta", titles: ["Talent Acquisition Partner", "Senior Recruiter", "Talent Acquisition Lead", "Campus Hiring Specialist"], must: ["Must have 3+ years of end-to-end recruitment", "Required: sourcing candidates for technology roles", "Experience managing hiring stakeholders is mandatory"], duties: ["Run end-to-end hiring for engineering teams", "Build sourcing pipelines", "Report hiring metrics weekly"] },
  { fn: "sales.kam", titles: ["Key Account Manager", "Senior Key Account Manager", "Account Manager - Enterprise", "Strategic Account Lead"], must: ["Must have 5+ years managing key accounts in B2B", "Required: proven upsell and cross-sell to existing clients", "Revenue target ownership is mandatory"], duties: ["Grow a portfolio of enterprise accounts", "Run quarterly business reviews", "Negotiate renewals"] },
  { fn: "bank.credit", titles: ["Credit Underwriter - SME", "Credit Analyst", "Credit Manager - Retail Loans", "Senior Credit Underwriter"], must: ["Must have 3+ years of credit underwriting for SME or retail loans", "Required: preparing credit appraisal memos", "Knowledge of RBI lending norms is mandatory"], duties: ["Assess borrower financials", "Recommend loan decisions", "Monitor portfolio quality"] },
  { fn: "ops.procurement", titles: ["Procurement Specialist", "Senior Buyer", "Procurement Manager", "Strategic Sourcing Analyst"], must: ["Must have 4+ years in strategic sourcing", "Required: supplier negotiation and purchase orders in SAP", "Category spend analysis is mandatory"], duties: ["Run sourcing events", "Manage supplier performance", "Cut cost on packaging categories"] },
  { fn: "design.ux", titles: ["Product Designer", "Senior UX Designer", "UX Researcher", "Lead Product Designer"], must: ["Must have 3+ years of product design for web and mobile", "Required: user research and usability testing", "A portfolio of shipped Figma work is mandatory"], duties: ["Design flows for onboarding", "Run user interviews", "Work with engineers on delivery"] },
  { fn: "support.app", titles: ["Application Support Engineer (L2)", "Production Support Analyst", "Senior Application Support Engineer", "Support Lead"], must: ["Must have 3+ years of L2 application support", "Required: incident management under ITIL", "SQL troubleshooting on production systems is mandatory"], duties: ["Resolve production incidents", "Run root-cause analysis", "Maintain runbooks"] },
];
const EMP = ["Acme Fintech", "Bluebird Retail", "Cobalt Systems", "Delta Health", "Evergreen Logistics", "Fable Software", "Granite Bank", "Harbor Foods"];
const P = (s: string) => `<p>${s}</p>`;
const LI = (xs: string[]) => `<ul>${xs.map((x) => `<li>${x}</li>`).join("")}</ul>`;
const ABOUT = "We are a growing company in Bengaluru building products used by millions of customers across India. ";
export function inventory(capturedAt: Date) {
  const rows: any[] = []; let id = 900000; const iso = (d: Date) => d.toISOString().replace("T", " ").replace("Z", "+00");
  const fresh = new Date(capturedAt.getTime() - 6 * 3600e3), stale = new Date(capturedAt.getTime() - 9 * 86400e3);
  const mk = (title: string, employer: string, body: string, o: any = {}) => { const desc = `<h2>${title}</h2>` + P(`${employer} is hiring a ${title} in Bengaluru.`) + body; rows.push({ id: String(++id), source: "synthetic", employer_key: employer.toLowerCase().replace(/\W+/g, "_"), company_name: employer, title, location: o.location ?? "Bengaluru", url: `https://jobs.example.invalid/${id}`, posted_at: iso(new Date(capturedAt.getTime() - 20 * 86400e3)), first_seen: iso(new Date(capturedAt.getTime() - 15 * 86400e3)), last_seen: iso(o.stale ? stale : fresh), salary_text: "", fingerprint: "", description: desc }); };
  for (const [ai, a] of AREAS.entries()) for (const [ti, t] of a.titles.entries()) for (let k = 0; k < 4; k++) {
    const emp = EMP[(ai + ti + k) % EMP.length]; const yrs = 2 + ((ti + k) % 4) * 2;
    mk(t, emp, P(ABOUT.repeat(2)) + P("What you will do") + LI(a.duties) + P("What you need") + LI(a.must.map((m) => m.replace(/\d\+ years/, `${yrs}+ years`))) + P(`Work mode: ${k % 2 ? "hybrid" : "on-site"} in Bengaluru.`)); }
  // a long posting whose mandatory requirement sits at the very end (beyond 16,000 characters)
  mk("Senior Backend Engineer - Ledger", "Fable Software", P(ABOUT.repeat(200)) + P("What you need") + LI(["Must have 6+ years of Java and Spring Boot microservices", "Required: Certified Kubernetes Administrator (CKA) certification is mandatory for this role"]));
  // an oversized posting (beyond the 60,000-character limit): must be flagged, never cut
  mk("Backend Engineer - Archive Platform", "Cobalt Systems", P(ABOUT.repeat(700)) + P("Must have 5+ years of Java microservices experience"));
  // short and ambiguous postings
  mk("Associate - Special Projects", "Granite Bank", P("Join our team. Apply now."));
  mk("FP&A Analyst - Contract", "Harbor Foods", P("Good role."));
  mk("Finance Associate - Special Projects", "Harbor Foods", P("Our finance team supports the business on many interesting projects across the year. You will work with smart people on a wide variety of things and learn a lot about how a growing company operates day to day. Come and talk to us."));   // valid text, no stated requirement: extraction must flag it
  // stale postings (not seen in the last 72 hours): excluded for both arms
  for (const t of ["Backend Engineer", "FP&A Analyst", "Key Account Manager"]) mk(t, "Delta Health", P(ABOUT) + LI(["Must have 4+ years of relevant experience", "Required: strong stakeholder management"]), { stale: true });
  // same title and employer, materially different requirements (experience, stack, management, employment type)
  mk("Software Engineer", "Bluebird Retail", P(ABOUT.repeat(3)) + LI(["Must have 2+ years of Java and Spring Boot microservices", "Required: designing REST APIs and Kafka consumers"]));
  mk("Software Engineer", "Bluebird Retail", P(ABOUT.repeat(3)) + LI(["Must have 10+ years of Golang and Kubernetes", "Required: you will manage a team of 8 engineers"]));
  mk("Software Engineer", "Bluebird Retail", P(ABOUT.repeat(3)) + LI(["Must have 2+ years of Java and Spring Boot microservices", "Required: designing REST APIs and Kafka consumers", "This is a 6-month contract role"]));
  // exact near-duplicates (same requirements): one judgement may represent them, but only the judged one is shown
  for (let k = 0; k < 3; k++) mk("Credit Analyst - Retail Loans", "Granite Bank", P(ABOUT) + LI(["Must have 3+ years of credit underwriting for retail loans", "Required: preparing credit appraisal memos", "Knowledge of RBI lending norms is mandatory"]));
  return rows;
}
const RESUMES: Record<string, string> = {
  backend: "Arun Sample\nSUMMARY\nBackend engineer with 6 years building payment systems.\nEXPERIENCE\nSenior Software Engineer, Fable Software (2021 – Present)\n- Built Java and Spring Boot microservices for payment APIs handling 2 million requests a day\n- Designed REST APIs and Kafka consumers for settlement\n- Tuned PostgreSQL queries and SQL indexes, cutting latency by 40%\n- Led the design review for the refunds service and mentored three engineers\n- Ran incident reviews and wrote the on-call runbook for the payments platform\nSoftware Engineer, Cobalt Systems (2019 – 2021)\n- Developed REST services in Java\n- Wrote Kafka producers for event pipelines\nSKILLS\nJava, Spring Boot, Kafka, PostgreSQL, SQL, Docker\nEDUCATION\nB.Tech Computer Science, 2019\n",
  fpa: "Meera Sample\nSUMMARY\nFP&A professional with 5 years in consumer goods.\nEXPERIENCE\nSenior Financial Analyst, Harbor Foods (2022 – Present)\n- Owned the annual operating plan and monthly forecasting for a 400 Cr business\n- Prepared monthly variance analysis for business heads\n- Built Excel financial modelling for pricing decisions\n- Presented the quarterly forecast to the leadership team with risks and opportunities\n- Automated the monthly close pack, saving four days each cycle\nFinancial Analyst, Bluebird Retail (2020 – 2022)\n- Prepared budgets and forecasts for stores\nSKILLS\nExcel, Financial modelling, SAP\nEDUCATION\nMBA Finance, 2020\n",
  hr: "Ravi Sample\nSUMMARY\nRecruiter with 4 years hiring technology talent.\nEXPERIENCE\nTalent Acquisition Partner, Cobalt Systems (2022 – Present)\n- Ran end-to-end recruitment for 60 engineering roles a quarter\n- Built sourcing pipelines for technology roles on LinkedIn\n- Managed hiring stakeholders across five teams\n- Ran campus hiring at eight engineering colleges with a structured interview loop\n- Reduced time to hire from 45 to 30 days by fixing interview scheduling\nRecruiter, Delta Health (2021 – 2022)\n- Sourced candidates for nursing and admin roles\nSKILLS\nSourcing, Stakeholder management, ATS\nEDUCATION\nMBA HR, 2021\n",
  marine: "Kiran Sample\nSUMMARY\nMarine engineer with 7 years on merchant vessels.\nEXPERIENCE\nSecond Engineer, Ocean Lines (2019 – Present)\n- Maintained main engines and auxiliary machinery on bulk carriers\n- Led engine-room watch teams of 6 crew\n- Managed fuel and lube oil bunkering operations\n- Prepared vessels for port state control inspections with zero detentions\n- Planned dry-dock maintenance schedules with the superintendent\nThird Engineer, Coastal Shipping (2017 – 2019)\n- Overhauled purifiers and pumps\nSKILLS\nMarine engines, Bunkering, Safety drills\nEDUCATION\nB.E. Marine Engineering, 2017\n",
};
const MORE: Record<string, string> = {
  backend2: "Asha Sample\nSUMMARY\nPlatform engineer working on retail order systems.\nEXPERIENCE\nSoftware Engineer II, Bluebird Retail (2020 – Present)\n- Developed order management services in Kotlin with gRPC\n- Migrated inventory batch jobs to streaming on Apache Flink\n- Operated services on AWS with Terraform and on-call rotations\n- Introduced contract testing across twelve teams\nAssociate Engineer, Harbor Foods (2018 – 2020)\n- Maintained warehouse scanning apps\n- Automated nightly reconciliation scripts in Python\nSKILLS\nKotlin, gRPC, Flink, AWS, Terraform, Python\nEDUCATION\nB.E. Information Science, 2018\n",
  hr2: "Rohit Sample\nSUMMARY\nHR generalist moving into talent acquisition.\nEXPERIENCE\nHR Executive, Evergreen Logistics (2023 – Present)\n- Coordinated onboarding paperwork for warehouse associates\n- Scheduled interviews for drivers and loaders across three hubs\n- Maintained attendance records and leave balances in the HRMS\n- Organised monthly engagement events for 300 staff\nHR Intern, Granite Bank (2022 – 2023)\n- Screened resumes for branch roles\nSKILLS\nHRMS, Excel, Interview scheduling\nEDUCATION\nBBA, 2022\n",
  hr3: "Rina Sample\nSUMMARY\nPeople operations specialist in healthcare.\nEXPERIENCE\nPeople Operations Specialist, Delta Health (2021 – Present)\n- Ran payroll inputs and statutory compliance for 1,200 clinical staff\n- Designed the performance review calendar with department heads\n- Handled employee relations cases and exit interviews\n- Rolled out a new HR helpdesk on Freshservice\nHR Associate, Fable Software (2020 – 2021)\n- Prepared offer letters and background checks\nSKILLS\nPayroll, Employee relations, HR operations\nEDUCATION\nMA Psychology, 2020\n",
};
function intake(id: string, o: any = {}) {
  const base = { schema: INTAKE_SCHEMA, candidate_id: id, population: "synthetic", resume_file: o.file ?? "resume.txt", current_function: o.current ?? "backend engineering", target_functions: o.targets ?? ["swe.backend"], career_change: "no", target_level: o.level ?? "senior", open_to_step_up: "yes", open_to_adjacent: o.adjacent ?? "yes",
    location: { city: "Bengaluru", work_modes: ["onsite", "hybrid"] }, preferred_industry: "any", constraints: { pay_floor_lpa: null, notice_days: 30, relocate: null }, deal_breakers: o.deal ?? [], years_experience: o.years ?? 6,
    consent: { version: CONSENT_VERSION, text_sha256: sha256(CONSENT_TEXT), agreed: true, date: "2026-11-26", test: TEST_ID, follow_up: true }, recruited: { channel: "synthetic", at: o.at ?? "2026-11-26T10:00:00Z" } };
  return { ...base, ...(o.override ?? {}) };
}
export function writeCandidates(intakeDir: string) {
  const put = (id: string, text: string | null, it: any, kind: "txt" | "pdf" | "docx" = "txt") => { const d = join(intakeDir, id); mkdirSync(d, { recursive: true });
    if (text !== null) { const src = join(d, "_src.txt"); if (kind !== "txt") writeFileSync(src, text);
      if (kind === "txt") writeFileSync(join(d, "resume.txt"), text);
      else if (kind === "pdf") execFileSync("python3", ["-I", "-c", "import sys\nfrom reportlab.lib.pagesizes import A4\nfrom reportlab.pdfgen import canvas\nc=canvas.Canvas(sys.argv[1],pagesize=A4);y=800\nfor l in open(sys.argv[2]).read().split('\\n'):\n  c.drawString(50,y,l);y-=16\nc.save()", join(d, "resume.pdf"), src]);
      else execFileSync("python3", ["-I", "-c", "import sys,docx\nd=docx.Document()\nfor l in open(sys.argv[2]).read().split('\\n'): d.add_paragraph(l)\nd.save(sys.argv[1])", join(d, "resume.docx"), src]); }
    writeFileSync(join(d, "intake.json"), JSON.stringify(it, null, 1)); };
  put("S01", RESUMES.backend, intake("S01", { at: "2026-11-26T09:00:00Z" }));
  put("S02", RESUMES.fpa, intake("S02", { file: "resume.pdf", current: "FP&A", targets: ["fin.fpa"], level: "senior", years: 5, at: "2026-11-26T09:10:00Z" }), "pdf");
  put("S03", RESUMES.hr, intake("S03", { file: "resume.docx", current: "recruitment", targets: ["hr.ta"], level: "mid", years: 4, at: "2026-11-26T09:20:00Z" }), "docx");
  put("S04", RESUMES.marine, intake("S04", { current: "marine engineering", targets: ["eng.mech"], level: "senior", years: 7, at: "2026-11-26T09:30:00Z" }));   // valid, but the inventory has nothing for them
  put("S05", RESUMES.backend.replace("Arun", "Anil").replace("6 years", "six years"), intake("S05", { at: "2026-11-26T09:40:00Z" }));                         // same résumé as S01: rejected as duplicate
  put("S06", RESUMES.fpa.replace("Meera", "Mira"), intake("S06", { override: { consent: { version: CONSENT_VERSION, text_sha256: sha256("another text"), agreed: true, date: "2026-11-26", test: TEST_ID, follow_up: false } }, targets: ["fin.fpa"] }));   // consent to a different text: rejected
  put("S07", MORE.hr2, intake("S07", { targets: ["hr.ta"], level: "leader", years: 2, at: "2026-11-26T09:50:00Z", override: { years_experience: 2 } }));   // leader roles at 2 years and résumé says ~4: held
  put("S08", MORE.backend2, intake("S08", { override: { target_functions: [], open_to_adjacent: undefined } }));   // missing answers: held
  put("S09", "Name\nHello", intake("S09"));                                                                                                                 // unreadable / too short: rejected
  put("S10", MORE.hr3, intake("S10", { targets: ["hr.ta"], deal: ["talent acquisition"], years: 4, level: "mid" }));   // deal-breaker contradicts target: held
}
export const SYNTHETIC_CAPTURED_AT = "2026-11-26T12:00:00Z";
export function writeAll(dir: string) { mkdirSync(dir, { recursive: true }); const rows = inventory(new Date(SYNTHETIC_CAPTURED_AT)); writeFileSync(join(dir, "snapshot.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); return rows.length; }
