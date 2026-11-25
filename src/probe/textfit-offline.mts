// postingProblem, textFit and forReading on made-up postings. No network, no model.
import { postingProblem, corpus, resumeTerms, textFit, forReading, weight } from "../lib/textfit.js";
import { closest, type Row } from "../lib/usmatch.js";
let bad = 0; const check = (name: string, ok: boolean, got?: unknown) => { if (!ok) bad++; console.log(`${ok ? "ok   " : "WRONG"} ${name}${ok ? "" : "  got " + JSON.stringify(got)}`); };

// 1. postings that are not postings
const P = (title: string, raw: string) => postingProblem(title, raw).problem;
check("a page that could not show the job", P("Analyst", "Job Details About this role Requirements Couldn't load job details The job may have been removed or is no longer available.") === "the page could not show the job");
check("a test job, by its text", P("SJ_LEVER_ATTACHMENT", "SJ_LEVER_ATTACHMENT LinkedIn Partner Sandbox - RSC testing Bangalore This is a test job to test attachments. Need a Backend Engineer with 2 yr exp.") === "a test job");
check("a test job, by its title", P("SJ TEST E2E Bug Bash Job 2", "Some words about a role that say nothing in particular but are long enough to look like a posting to a careless reader.") === "a test job");
check("a Test Engineer is a real job", P("Test Engineer", "You will write and run test plans for embedded braking software, automate regression suites in Python and report defects to the platform team. 3+ years in automotive testing.") === null);
check("a careers search page stored in place of the posting", P("Senior Manager", "Explore career opportunities at Example Search results Explore jobs Corporate Sales Technology What makes us different? " + "It is the people and the culture. ".repeat(60)) === "a careers search page, not the posting");
check("a real posting on a page that also says 'Search results' is kept when it names the job", P("Credit Analyst", "Careers at Example Search results Credit Analyst Bengaluru You will appraise mid-market borrowers, prepare credit notes and present them to the committee. " + "Requirements: 4+ years of corporate credit appraisal. ".repeat(12)) === null);
check("an employer's empty template", P("Technical Lead", "Country/Region: IN Requisition ID: 41310 Work Model: Position Type: Salary Range: Location: INDIA - BENGALURU Title: Technical Lead Description: Area(s) of responsibility .") === "the employer left the description empty");
check("a title and nothing else", P("Director of Product", "Director of Product Product Management") === "the employer left the description empty");
check("a redirect record", P("Engineer", '{"widget":"redirect","url":"/External/job/Bangalore/Engineer"}') === "not the posting: a redirect or an empty record");
check("the careers site's page code stored in place of the posting", P("Linux Software Engineer", 'Probably not needed --> Careers at Eightfold {"themeOptions": {"customTheme": {"varTheme": {"accent-color": "#054d7b", "label": "Single color"}}, "sectionsConfig": {"perks": {"items": [{"title": "Lunch", "description": "Free Catered Meals"}]}}, "searchBoxConfig": {"presetOptions": []}}' + ' {"k": "v"}'.repeat(80)) === "not the posting: the careers site\'s page code");
check("…even when a word of the title happens to sit in the code", P("Manager, Compliance", 'Careers at Eightfold {"themeOptions": {"compliance": true, "manager": "x"}}' + ' {"k": "v"}'.repeat(80)) === "not the posting: the careers site\'s page code");
check("a style sheet with no job in it", P("Customer Service Executive", "table {mso-displayed-decimal-separator:\".\"; mso-displayed-thousand-separator:\",\";} tr {mso-height-source:auto;} col {mso-width-source:auto;} td {padding-top:1px; padding-right:1px;} " + "td {padding:1px;} ".repeat(30)) === "not the posting: the careers site\'s page code");
check("a real posting with leftover markup that names its job is kept", P("Banquet Sales Manager", '{"@context": "https://schema.org", "@type": "Hotel", "name": "The Hotel"} Banquet Sales Manager Full-Time. You will sell weddings and corporate events, meet monthly revenue targets and manage key accounts across Bengaluru. 3+ years in hotel banquet sales required. ' + '{"a": "b"} '.repeat(30)) === null);
check("a real posting of 40 words is kept", P("Business Development Executive", "The Business Development Executive will identify and secure new business opportunities, generate leads, build client relationships and contribute to revenue growth. Graduates with one year of inside sales experience and fluent Kannada are preferred. Salary 3.2 LPA plus incentives.") === null);
check("a real posting of 20 words is kept", P("Collections Officer", "Collections Officer for two-wheeler loans. Field visits across Bengaluru, recover overdue instalments, update the tracker daily. One to five years in collections.") === null);

// 2. words: a small world of 100 postings from 20 employers
const emp = (i: number) => `employer ${i % 20}`;
const general = "We are looking for a motivated professional to join our growing team and collaborate with stakeholders across the business to deliver results in a fast paced environment.";
const world = [
  ...Array.from({ length: 20 }, (_, i) => ({ employer: emp(i), text: `${general} You will build backend services in Go and Kafka, design distributed systems, own Kubernetes deployments and write PostgreSQL queries. Standard paragraph of employer ${i % 20}: zzcorp${i % 20} values zzcorp${i % 20} mission.` })),
  ...Array.from({ length: 20 }, (_, i) => ({ employer: emp(i), text: `${general} You will underwrite loans, appraise borrowers, prepare credit notes, monitor covenants and present proposals to the credit committee. Standard paragraph of employer ${i % 20}: zzcorp${i % 20} values zzcorp${i % 20} mission.` })),
  ...Array.from({ length: 60 }, (_, i) => ({ employer: emp(i), text: `${general} You will coordinate schedules, reply to queries and keep records up to date for the wider organisation in general terms only.` })),
];
const idf = corpus(world);
check("a word in every posting carries no weight", weight(idf, "motivated") === 0 && weight(idf, "professional") === 0, [weight(idf, "motivated"), weight(idf, "professional")]);
check("a how-you-work word never becomes a term", weight(idf, "stakeholder") === 0 && weight(idf, "collaborate") === 0);
check("one employer's own paragraph carries no weight", weight(idf, "zzcorp3") === 0, weight(idf, "zzcorp3"));
check("a skill several employers ask for carries weight", weight(idf, "kafka") > 0 && weight(idf, "underwrite") > 0, [weight(idf, "kafka"), weight(idf, "underwrite")]);
const backendResume = "Senior backend engineer. Built Kafka pipelines and Go services, ran Kubernetes clusters, tuned PostgreSQL. Motivated professional who collaborates with stakeholders.";
const mine = resumeTerms(backendResume, idf);
const fBackend = textFit(mine, world[0].text, idf), fCredit = textFit(mine, world[20].text, idf), fGeneral = textFit(mine, world[40].text, idf);
check("a backend résumé fits the backend posting", fBackend.fit > 0.1 && fBackend.shared.includes("kafka"), fBackend);
check("the same résumé does not fit the credit posting, though both share every general word", fCredit.fit === 0, fCredit);
check("a posting of general words fits nobody: 0, not a low score for sharing 'motivated professional'", fGeneral.fit === 0, fGeneral);
check("a résumé of general words fits nothing", textFit(resumeTerms(general, idf), world[0].text, idf).fit === 0);
check("the same inputs give the same answer", JSON.stringify(textFit(mine, world[0].text, idf)) === JSON.stringify(fBackend));

// 3. the roles to read closely
const now = Date.parse("2026-11-24T12:00:00Z");
const row = (id: number, title: string, ref: string, level = "senior"): Row => ({ system: "in", ref, job_id: String(id), title, location: "Bengaluru", remote: false, url: `https://example.test/${id}`, posted_at: "2026-11-20T00:00:00Z", level, func: null });
const t = ["Backend Engineer"];
// 60 employers each with one "Backend Engineer": more close titles than places. Ten of them share the résumé's words.
const many = Array.from({ length: 60 }, (_, i) => row(i + 1, "Backend Engineer", `e${i}`));
const strong = new Set(["51", "52", "53", "54", "55", "56", "57", "58", "59", "60"]);
const fit = (r: Row) => (strong.has(r.job_id) ? 0.6 : 0);
const byTitleOnly = closest(many, t, "senior", 40, now, true), read = forReading(many, t, "senior", fit, 40, now);
check("titles alone would have read none of the ten the résumé fits", byTitleOnly.filter((r) => strong.has(r.job_id)).length === 0, byTitleOnly.filter((r) => strong.has(r.job_id)).length);
check("with the text read, all ten are among the forty", read.filter((r) => strong.has(r.job_id)).length === 10 && read.length === 40, read.filter((r) => strong.has(r.job_id)).length);
check("and twelve places still go by title alone", read.filter((r) => !strong.has(r.job_id)).length === 30);
// fewer close titles than places: every close title is read whatever its text
const few = [...Array.from({ length: 10 }, (_, i) => row(i + 1, "Backend Engineer", `e${i}`)), ...Array.from({ length: 50 }, (_, i) => row(100 + i, "Backend Platform Reliability Tooling Engineer Payments India", `f${i}`))];
const r2 = forReading(few, t, "senior", (r) => (Number(r.job_id) >= 140 ? 0.7 : 0), 40, now);
check("no close title is left out for a role with better text", few.slice(0, 10).every((r) => r2.includes(r)));
check("a role whose text is not held is still read by its title", forReading([row(1, "Backend Engineer", "x")], t, "senior", () => null, 40, now).length === 1);
// a role one level away is lifted half as much
const lv = [row(1, "Backend Engineer", "a", "senior"), row(2, "Backend Engineer", "b", "leader")];
const s1 = forReading([...lv, ...Array.from({ length: 50 }, (_, i) => row(10 + i, "Backend Engineer", `g${i}`))], t, "senior", (r) => (r.job_id === "1" || r.job_id === "2" ? 0.5 : 0), 2, now, 8, 0);
check("with one place each way, the role at the person's own level comes before the one a level away", s1[0].job_id === "1", s1.map((r) => r.job_id));
check("the employer limit still holds", Math.max(...Object.values(forReading(Array.from({ length: 80 }, (_, i) => row(i + 1, "Backend Engineer", `h${i % 4}`)), t, "senior", () => 0.5, 40, now).reduce((m: Record<string, number>, r) => { m[r.ref] = (m[r.ref] ?? 0) + 1; return m; }, {}))) <= 8);
if (bad) { console.error(`${bad} wrong`); process.exit(1); } console.log("all right");
