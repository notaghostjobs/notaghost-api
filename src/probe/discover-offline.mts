// Free discovery in code: reading a résumé, the index entry, the search and the previews. Made-up text; no network, no model.
process.env.SUPABASE_URL ??= "https://offline.invalid"; process.env.SUPABASE_SERVICE_ROLE_KEY ??= "offline";   // the screens come from Radar, whose module wants these set
const { codeProfile, asTitle, entryFor, search, previews } = await import("../lib/discover.js");
const { corpus } = await import("../lib/textfit.js");
let bad = 0; const check = (name: string, ok: boolean, got?: unknown) => { if (!ok) bad++; console.log(`${ok ? "ok   " : "WRONG"} ${name}${ok ? "" : "  got " + JSON.stringify(got)}`); };
const now = new Date("2026-11-24T00:00:00Z");
const cv = `Asha Rao\nBengaluru | asha@example.com\nSUMMARY\nBackend engineer who builds payment systems.\nEXPERIENCE\nAcme Payments - Senior Backend Engineer (Mar 2022 - Present)\n• Built Kafka pipelines in Go for card settlement\nBeta Labs | Software Engineer | Jul 2019 - Feb 2022\n• Ran Kubernetes clusters and tuned PostgreSQL\nSoftware Engineer Intern, Gamma | May 2018 - Jul 2018\nEDUCATION\nB.Tech in Computer Science, XYZ University 2015 - 2019\nSKILLS\nGo, Kafka, Kubernetes, PostgreSQL, Leadership & Executive Communication`;
const p = codeProfile(cv, now);
check("jobs are found by their dates, most recent first; the internship and the degree are not jobs", JSON.stringify(p.titles) === JSON.stringify(["Senior Backend Engineer", "Software Engineer"]), p.titles);
check("years run from the first job to the last, not from the degree or the internship (7.3)", p.years !== null && Math.abs(p.years - 7.3) < 0.2 && !p.stated, p.years);
check("level follows the years", p.level === "senior", p.level);
check("stated years are taken as stated", codeProfile("Operations manager with 14+ years of experience in banking.\nDeputy Manager Operations | Jun 2024 - Apr 2026", now).years === 14 && codeProfile("Operations manager with 14+ years of experience in banking.", now).stated);
check("a title after the employer on the line is found", asTitle("ICICI Bank - Chief Manager (March 2023 - May 2024)") === "Chief Manager", asTitle("ICICI Bank - Chief Manager (March 2023 - May 2024)"));
check("a rank-only title takes the words that say what the work is", asTitle("DEPUTY MANAGER – IT APPLICATION SUPPORT ANALYST") === "DEPUTY MANAGER IT APPLICATION SUPPORT ANALYST", asTitle("DEPUTY MANAGER – IT APPLICATION SUPPORT ANALYST"));
check("a sentence, a heading, a strengths list and a contact line are not titles", [asTitle("Led a team of 12 engineers to deliver the platform."), asTitle("EXECUTIVE SUMMARY"), asTitle("Building & Executive Leadership | Stakeholder Management"), asTitle("asha@example.com | +91 9876543210"), asTitle("B.Tech, Lead Institute of Engineering")].every((x) => x === null), [asTitle("EXECUTIVE SUMMARY"), asTitle("Building & Executive Leadership | Stakeholder Management")]);
check("a résumé with no dates still gives a profile, with years unknown", codeProfile("Regulatory Operations Associate\nHandles OTC derivatives reporting.", now).years === null && codeProfile("Regulatory Operations Associate\nHandles OTC derivatives reporting.", now).titles[0] === "Regulatory Operations Associate");

// a small index
const general = "We are a growing team that values ownership.";
const mk = (i: number, title: string, employer: string, body: string) => ({ id: i, title, employer, description: `${general} ${body}` });
const backend = "You will build backend services in Go and Kafka, design distributed systems, own Kubernetes deployments and write PostgreSQL queries for settlement.";
const credit = "You will underwrite loans, appraise borrowers, prepare credit notes, monitor covenants and present proposals to the credit committee.";
const raw = [...Array.from({ length: 12 }, (_, i) => mk(i + 1, i % 2 ? "Senior Backend Engineer" : "Platform Engineer", `emp${i % 6}`, backend + ` Team ${i}.`)), ...Array.from({ length: 12 }, (_, i) => mk(100 + i, "Credit Manager", `bank${i % 6}`, credit + ` Branch ${i}.`)),
  mk(200, "Backend Engineer - Pune", "far", backend), mk(201, "Backend Engineering Intern", "big", backend), mk(202, "Backend Engineer", "strict", backend + " Requires 12-15 years of experience."), mk(203, "Backend Engineer", "tokyo", backend + " Japanese language proficiency is required."),
  { id: 204, title: "Backend Engineer", employer: "empty", description: null }, { id: 205, title: "SJ TEST E2E Bug Bash Job", employer: "sandbox", description: "This is a test job created for integration testing purposes." },
  ...Array.from({ length: 300 }, (_, i) => mk(300 + i, "Office Coordinator", `o${i}`, "You will coordinate schedules and reply to queries in general terms."))];
const texts = raw.filter((r) => r.description && !/test job/.test(r.description)).map((r) => ({ text: r.description!, employer: r.employer }));
const idf = corpus(texts); const built = raw.map((r) => entryFor(r, idf)); const index = built.filter((b) => b.entry).map((b) => b.entry!);
check("a posting with no description and a test job get no entry, with the reason", built[raw.findIndex((r) => r.id === 204)].problem === "no description" && built[raw.findIndex((r) => r.id === 205)].problem === "a test job", [built[raw.findIndex((r) => r.id === 204)].problem, built[raw.findIndex((r) => r.id === 205)].problem]);
const s = search(cv, index, idf, p); const ids = new Set(s.found.map((f) => f.id));
check("roles in the person's line of work are found; the credit roles and the general ones are not", s.found.length >= 12 && s.found.every((f) => /Engineer/.test(f.title)) && s.why["shares too little"] >= 312, [s.found.length, s.why]);
check("a title naming another city, a level too far, a years band they are outside and a language they lack are each left out and counted", !ids.has("200") && !ids.has("201") && !ids.has("202") && !ids.has("203") && s.why["another city"] === 1 && s.why["level too far"] === 1 && s.why["years asked"] === 1 && s.why["language"] === 1, s.why);
check("a title like their own comes before a different title with the same text", s.found[0].title === "Senior Backend Engineer", s.found[0].title);
check("every result says which words put it there", s.found.every((f) => f.shared.length > 0), s.found[0].shared);
const five = previews(s.found);
check("previews: at most five, one from an employer", five.length === 5 && new Set(five.map((f) => f.employer)).size === 5, five.map((f) => f.employer));
check("fewer than five when fewer are found; none when none", previews(s.found.slice(0, 2)).length === 2 && previews([]).length === 0);
check("the same résumé gives the same list", JSON.stringify(previews(search(cv, index, idf, p).found)) === JSON.stringify(five));
check("a résumé of general words finds nothing", search("Motivated professional who values ownership in a growing team.", index, idf).found.length === 0);
if (bad) { console.error(`${bad} wrong`); process.exit(1); } console.log("all right");
