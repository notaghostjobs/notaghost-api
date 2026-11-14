// QA fixtures: invented employers, invented roles and invented job pages with known properties. Nothing here is a real
// company, person or posting. The roles feed Radar (as rows the reader would have taken from an employer's hiring system),
// Sharpen (as job descriptions) and Ghost Meter (as pages with a documented expected outcome).

export type Level = "junior" | "mid" | "senior" | "head";
export const BAND: Record<Level, [number, number]> = { junior: [0, 2], mid: [3, 6], senior: [6, 10], head: [10, 16] };

/** Employers. `feed` = our reader follows their hiring system (the role can be confirmed there); "none" = they publish no
 *  readable list; "unknown" = never resolved. */
export const EMPLOYERS: { name: string; slug: string; feed: "followed" | "none" | "unknown"; about: string }[] = [
  { name: "Kestrel Foods", slug: "kestrel-foods", feed: "followed", about: "Packaged foods and quick-commerce grocery, Bengaluru." },
  { name: "Lumio Payments", slug: "lumio-payments", feed: "followed", about: "Payments and settlements for small merchants." },
  { name: "Tessel Software", slug: "tessel-software", feed: "followed", about: "Workflow software for lenders." },
  { name: "Northwind Retail", slug: "northwind-retail", feed: "followed", about: "Omnichannel fashion and home retail." },
  { name: "Harbor Health", slug: "harbor-health", feed: "followed", about: "Clinics and diagnostics network." },
  { name: "Quillon Logistics", slug: "quillon-logistics", feed: "followed", about: "Warehousing and last-mile delivery." },
  { name: "Pallas Finance", slug: "pallas-finance", feed: "followed", about: "Consumer lending and wealth products." },
  { name: "Orbit Mobility", slug: "orbit-mobility", feed: "followed", about: "Electric two-wheeler sharing." },
  { name: "Sundial Media", slug: "sundial-media", feed: "none", about: "Regional news and video." },
  { name: "Marlow Education", slug: "marlow-education", feed: "unknown", about: "After-school learning centres." },
];

type Fn = { key: string; name: string; titles: Record<Level, string>; adjacent: string; does: string[]; needs: string[] };
export const FUNCTIONS: Fn[] = [
  { key: "swe", name: "software engineering", titles: { junior: "Software Engineer I", mid: "Software Engineer II, Backend", senior: "Senior Software Engineer, Backend", head: "Engineering Manager, Platform" }, adjacent: "QA Automation Engineer",
    does: ["Design, build and operate backend services in Java or Go", "Write unit and integration tests and review teammates’ code", "Own REST APIs and their data models in PostgreSQL", "Take part in the on-call rotation and fix production incidents", "Work with product managers to break features into deliverable pieces", "Improve build and deployment pipelines"],
    needs: ["Strong programming skills in Java, Go or Python", "Data structures, algorithms and system design fundamentals", "Experience with SQL databases and REST APIs", "Familiarity with AWS or another cloud platform", "B.E./B.Tech in Computer Science or equivalent"] },
  { key: "pm", name: "product management", titles: { junior: "Associate Product Manager", mid: "Product Manager, Payments", senior: "Senior Product Manager, Merchant Platform", head: "Director of Product" }, adjacent: "Technical Program Manager",
    does: ["Own the roadmap and outcomes for a product area", "Write product requirements and work with engineering and design to ship them", "Run customer interviews and turn findings into priorities", "Define success metrics and run A/B experiments", "Work with risk, compliance and operations on launches", "Present plans and results to leadership"],
    needs: ["Experience shipping software products end to end", "Comfort with SQL and product analytics", "Clear written requirements and stakeholder management", "Experience in payments, lending or another fintech domain", "MBA or equivalent experience"] },
  { key: "cat", name: "category management", titles: { junior: "Category Executive", mid: "Category Manager, Grocery", senior: "Senior Category Manager, FMCG", head: "Head of Category, Fresh and Grocery" }, adjacent: "Key Account Manager, Modern Trade",
    does: ["Own the category P&L: revenue, margin and working capital", "Build assortment, pricing and promotion plans", "Negotiate terms with brands and vendors", "Track availability, wastage and inventory health", "Work with marketing on category growth plans", "Lead a team of category associates"],
    needs: ["Experience running a category in e-commerce or retail", "Vendor negotiation and pricing experience", "Strong Excel and comfort with SQL dashboards", "P&L ownership", "Graduate degree; MBA preferred"] },
  { key: "data", name: "data and product analytics", titles: { junior: "Data Analyst", mid: "Product Analyst", senior: "Senior Analyst, Product Analytics", head: "Analytics Manager" }, adjacent: "Business Intelligence Developer",
    does: ["Build dashboards and reports for product and business teams", "Analyse funnels, cohorts and experiments", "Write SQL against the warehouse and maintain core metrics", "Size opportunities and recommend priorities", "Partner with product managers on experiment design", "Automate recurring analysis in Python"],
    needs: ["Advanced SQL", "Python or R for analysis", "Experience with Tableau, Looker or Power BI", "A/B testing and basic statistics", "Degree in engineering, statistics or economics"] },
  { key: "hr", name: "human resources", titles: { junior: "HR Executive", mid: "HR Business Partner", senior: "Senior HR Business Partner", head: "Head of People" }, adjacent: "Talent Acquisition Partner",
    does: ["Partner with business leaders on workforce planning", "Run performance and compensation cycles", "Handle employee relations cases and investigations", "Drive engagement and retention programmes", "Own HR policies and compliance for the business unit", "Coach managers on people decisions"],
    needs: ["Experience as an HR business partner", "Knowledge of Indian labour law", "Performance management and compensation experience", "Employee relations experience", "MBA or PGDM in HR"] },
  { key: "sales", name: "sales and account management", titles: { junior: "Sales Development Representative", mid: "Key Account Manager", senior: "Senior Key Account Manager, Enterprise", head: "Regional Sales Head, South" }, adjacent: "Customer Success Manager",
    does: ["Own revenue targets for a portfolio of accounts", "Build relationships with decision makers at client companies", "Negotiate contracts and renewals", "Maintain an accurate pipeline in the CRM", "Work with product and operations to resolve client issues", "Forecast monthly and quarterly revenue"],
    needs: ["B2B sales or account management experience", "A record of meeting revenue targets", "Negotiation and contract experience", "Experience with Salesforce or another CRM", "Graduate degree"] },
  { key: "fin", name: "finance", titles: { junior: "Finance Analyst", mid: "Senior Analyst, FP&A", senior: "Manager, Financial Planning and Analysis", head: "Finance Controller" }, adjacent: "Internal Auditor",
    does: ["Build the annual operating plan and monthly forecasts", "Prepare variance analysis and management reports", "Partner with business teams on budgets", "Model unit economics and pricing scenarios", "Support month-end close and audits", "Present financial results to leadership"],
    needs: ["FP&A or business finance experience", "Advanced Excel and financial modelling", "Understanding of accounting and Ind AS", "Experience with ERP systems such as SAP or Oracle", "CA or MBA in Finance"] },
  { key: "mkt", name: "growth marketing", titles: { junior: "Marketing Associate", mid: "Growth Marketing Manager", senior: "Senior Manager, Performance Marketing", head: "Head of Growth" }, adjacent: "Brand Manager",
    does: ["Own paid acquisition across Google and Meta", "Plan budgets and optimise CAC and ROAS", "Run lifecycle campaigns with CRM tools", "Design landing-page and funnel experiments", "Work with creative and analytics teams", "Report channel performance weekly"],
    needs: ["Performance marketing experience", "Hands-on experience with Google Ads and Meta Ads Manager", "Funnel analytics and attribution", "Experience with CleverTap, MoEngage or similar", "Graduate degree; MBA preferred"] },
  { key: "ops", name: "supply chain and operations", titles: { junior: "Operations Executive", mid: "Operations Manager, Warehousing", senior: "Senior Manager, Supply Chain", head: "Head of Supply Chain" }, adjacent: "Procurement Manager",
    does: ["Run day-to-day warehouse and last-mile operations", "Own service levels, cost per order and productivity", "Plan capacity and manpower for peak periods", "Manage transport and 3PL vendors", "Drive process improvements with Lean or Six Sigma methods", "Lead a team of shift managers"],
    needs: ["Experience in warehousing, logistics or supply chain", "Vendor and contract management", "Comfort with WMS and Excel", "Experience leading large teams", "Graduate degree; Six Sigma certification preferred"] },
  { key: "ux", name: "product design", titles: { junior: "Junior UX Designer", mid: "Product Designer", senior: "Senior Product Designer", head: "Design Manager" }, adjacent: "Visual Designer, Marketing",
    does: ["Design end-to-end user flows for web and mobile", "Run usability tests and synthesise research", "Create wireframes, prototypes and final UI in Figma", "Contribute to the design system", "Work with product managers and engineers through delivery", "Present design decisions to stakeholders"],
    needs: ["A portfolio of shipped product design work", "Proficiency in Figma", "Interaction design and usability testing experience", "Understanding of design systems", "Degree or diploma in design"] },
];

export type Job = { slug: string; employer: string; title: string; fn: string; level: Level | "adjacent"; band: [number, number]; pay: string | null; posted_days: number; state: "live" | "gone"; text: string };
const PAY: Record<Level, string> = { junior: "₹6–10 LPA", mid: "₹16–26 LPA", senior: "₹30–45 LPA", head: "₹55–80 LPA" };
const followed = EMPLOYERS.filter((e) => e.feed === "followed");
function describe(f: Fn, title: string, employer: string, band: [number, number], pay: string | null) {
  const e = EMPLOYERS.find((x) => x.name === employer)!;
  return `${title}\n${employer} · Bengaluru, Karnataka, India\n\nAbout ${employer}\n${e.about}\n\nAbout the role\nWe are hiring a ${title} to join our ${f.name} team in Bengaluru. This is a full-time, on-site role.\n\nWhat you will do\n${f.does.map((d) => `• ${d}`).join("\n")}\n\nWhat we are looking for\n• ${band[0]}–${band[1]} years of experience in ${f.name}\n${f.needs.map((d) => `• ${d}`).join("\n")}\n${pay ? `\nCompensation: ${pay}\n` : ""}\nHow to apply\nApply on this page. We reply to every applicant.`;
}
/** Sixty roles: for each function, four levels, one neighbouring craft, and one that has since closed. */
export const JOBS: Job[] = FUNCTIONS.flatMap((f, i) => {
  const emp = (k: number) => followed[(i + k) % followed.length].name;
  const lv: Level[] = ["junior", "mid", "senior", "head"];
  const main = lv.map((l, k): Job => { const e = emp(k), pay = k % 2 === 0 ? PAY[l] : null; return { slug: `${f.key}-${l}`, employer: e, title: f.titles[l], fn: f.key, level: l, band: BAND[l], pay, posted_days: 3 + ((i * 7 + k * 5) % 24), state: "live", text: describe(f, f.titles[l], e, BAND[l], pay) }; });
  const adj: Job = { slug: `${f.key}-adjacent`, employer: emp(4), title: f.adjacent, fn: f.key, level: "adjacent", band: BAND.mid, pay: null, posted_days: 9 + i, state: "live", text: describe({ ...f, name: f.adjacent.toLowerCase(), does: f.does.slice(2), needs: f.needs.slice(1) }, f.adjacent, emp(4), BAND.mid, null) };
  const gone: Job = { slug: `${f.key}-closed`, employer: emp(5), title: `${f.titles.mid} (closed)`.replace(" (closed)", ""), fn: f.key, level: "mid", band: BAND.mid, pay: null, posted_days: 40 + i, state: "gone", text: describe(f, f.titles.mid, emp(5), BAND.mid, null) };
  return [...main, adj, gone];
});

/** Ghost Meter pages with a documented expected outcome. `http` other than 200 is what the page itself answers. */
export type GmCase = { slug: string; title: string; employer: string; what: string; expect: string; verdicts: string[]; http?: number; hang?: boolean; listed?: boolean; first_seen_days?: number; html: (posted: string) => string };
const page = (title: string, employer: string, where: string, posted: string, body: string) => `<h1>${title}</h1><p class="co">${employer} · ${where}</p>${posted ? `<p class="posted">${posted}</p>` : ""}${body}`;
const para = (t: string) => t.split("\n").map((l) => (l.startsWith("•") ? `<li>${l.slice(1).trim()}</li>` : `<p>${l}</p>`)).join("");
const std = FUNCTIONS[1];
export const GM: GmCase[] = [
  { slug: "gm-live-strong", title: "Product Manager, Settlements", employer: "Lumio Payments", listed: true, first_seen_days: 5, what: "A live role on a followed employer's own system, dated, with a pay band.", expect: "Real. Signals: on the company's own hiring system, pay band stated, posted recently.", verdicts: ["Real"],
    html: (p) => page("Product Manager, Settlements", "Lumio Payments", "Bengaluru", p, para(describe(std, "Product Manager, Settlements", "Lumio Payments", [4, 7], "₹22–30 LPA").split("\n\n").slice(1).join("\n"))) },
  { slug: "gm-legit-weak", title: "Operations Manager, Dark Stores", employer: "Kestrel Foods", listed: true, first_seen_days: 12, what: "A legitimate role with weak evidence: no pay band, no date on the page, a short description.", expect: "Real, with the missing pay and date shown as notes, not held against it. Must not be called Ghost or Scam.", verdicts: ["Real", "Caution"],
    html: () => page("Operations Manager, Dark Stores", "Kestrel Foods", "Bengaluru", "", para("About the role\nRun three dark stores in East Bengaluru. You own service levels, cost per order and a team of twelve shift leads.\nWhat we are looking for\n• 4–8 years in warehousing or quick-commerce operations\n• Experience leading shift teams\n• Comfort with WMS and Excel\nApply on this page.")) },
  { slug: "gm-contradictory", title: "Senior Analyst, Product Analytics", employer: "Tessel Software", listed: true, first_seen_days: 80, what: "The page says “Posted 2 days ago”; the employer's system has carried it for 80 days.", expect: "Caution or Ghost. The date contradiction (signal 8) must be named with both dates.", verdicts: ["Caution", "Ghost"],
    html: () => page("Senior Analyst, Product Analytics", "Tessel Software", "Bengaluru", "Posted 2 days ago", para(describe(FUNCTIONS[3], "Senior Analyst, Product Analytics", "Tessel Software", [5, 8], null).split("\n\n").slice(1).join("\n"))) },
  { slug: "gm-stale", title: "HR Business Partner", employer: "Harbor Health", listed: true, first_seen_days: 130, what: "Live on the employer's system, open for 130 days.", expect: "Caution or Ghost: open for more than 90 days (signal 14).", verdicts: ["Caution", "Ghost"],
    html: () => page("HR Business Partner", "Harbor Health", "Bengaluru", "Posted 130 days ago", para(describe(FUNCTIONS[4], "HR Business Partner", "Harbor Health", [5, 9], null).split("\n\n").slice(1).join("\n"))) },
  { slug: "gm-boards-only", title: "Chief Storyteller", employer: "Northwind Retail", listed: false, what: "A followed employer whose own system does not list this title.", expect: "Caution: not on the company's own hiring system (signal 9). Never Real.", verdicts: ["Caution", "Ghost"],
    html: (p) => page("Chief Storyteller", "Northwind Retail", "Bengaluru", p, para("About the role\nShape the brand narrative across campaigns and stores.\nWhat we are looking for\n• 6–10 years in brand or content leadership\n• A portfolio of campaigns\nApply on this page.")) },
  { slug: "gm-closed", title: "Key Account Manager", employer: "Quillon Logistics", listed: true, first_seen_days: 45, what: "The page says the position is no longer accepting applications; the employer's system shows it gone.", expect: "Must not be Real. The card should say the role has closed or is no longer listed.", verdicts: ["Caution", "Ghost", "error"],
    html: () => page("Key Account Manager", "Quillon Logistics", "Bengaluru", "Posted 45 days ago", "<p><strong>This position is no longer accepting applications.</strong></p>" + para(describe(FUNCTIONS[5], "Key Account Manager", "Quillon Logistics", [4, 8], null).split("\n\n").slice(1).join("\n"))) },
  { slug: "gm-duplicate", title: "Finance Analyst", employer: "Pallas Finance", listed: true, first_seen_days: 8, what: "The same description is also posted word for word under Orbit Mobility (gm-duplicate-2).", expect: "Known limitation: the duplicate-text signal (7) is switched off in production, so this is judged on its other signals and should be Real. A tester should record that the duplicate is not flagged.", verdicts: ["Real", "Caution"],
    html: (p) => page("Finance Analyst", "Pallas Finance", "Bengaluru", p, para(describe(FUNCTIONS[6], "Finance Analyst", "Pallas Finance", [1, 3], null).split("\n\n").slice(2).join("\n"))) },
  { slug: "gm-duplicate-2", title: "Finance Analyst", employer: "Orbit Mobility", listed: true, first_seen_days: 8, what: "The second copy of gm-duplicate, under another employer.", expect: "As gm-duplicate.", verdicts: ["Real", "Caution"],
    html: (p) => page("Finance Analyst", "Orbit Mobility", "Bengaluru", p, para(describe(FUNCTIONS[6], "Finance Analyst", "Pallas Finance", [1, 3], null).split("\n\n").slice(2).join("\n"))) },
  { slug: "gm-misleading-strong", title: "Global Growth Lead", employer: "Apex Meridian Worldwide", what: "Polished and impressive-sounding, but: an employer nobody can verify, a talent-community pitch, five cities on one posting, and apply by emailing a personal address.", expect: "Caution or Ghost, never Real. Should name the evergreen language, the catch-all location and the off-system apply route.", verdicts: ["Caution", "Ghost"],
    html: (p) => page("Global Growth Lead", "Apex Meridian Worldwide", "Bengaluru / Mumbai / Delhi / Hyderabad / Remote", p, para("About us\nApex Meridian Worldwide is a category-defining, award-winning global enterprise trusted by Fortune 500 leaders.\nAbout the role\nWe are always looking for exceptional people. Join our talent community to be considered for future opportunities across Bengaluru, Mumbai, Delhi, Hyderabad or fully remote.\nWhat we are looking for\n• 2–15 years of experience\n• Passion for excellence\nHow to apply\nEmail your CV to hr.apexmeridian@gmail.com or DM our recruiter on WhatsApp.")) },
  { slug: "gm-scam", title: "Data Entry Executive (Work From Home)", employer: "Brightline Global Services", what: "Asks for a registration fee and identity documents before an interview.", expect: "Scam. The request for money must be quoted.", verdicts: ["Scam"],
    html: (p) => page("Data Entry Executive (Work From Home)", "Brightline Global Services", "Bengaluru", p, para("About the role\nEarn ₹45,000 per month from home with two hours of typing work a day. No experience needed.\nHow to apply\nPay a refundable registration fee of ₹1,500 to confirm your slot, and send your Aadhaar card and bank account details on WhatsApp before the interview.")) },
  { slug: "gm-agency", title: "Senior Category Manager", employer: "Ashgrove Staffing", what: "An agency posting for an unnamed “leading client”.", expect: "Caution: posted by an agency, employer not named (signal 15).", verdicts: ["Caution"],
    html: (p) => page("Senior Category Manager", "Ashgrove Staffing", "Bengaluru", p, para("Our client, a leading e-commerce company, is hiring a Senior Category Manager.\nWhat you will do\n• Own the category P&L\n• Negotiate with brands\nWhat we are looking for\n• 6–10 years in category management\nShare your CV with our consultant.")) },
  { slug: "gm-unknown-employer", title: "Product Designer", employer: "Marlow Education", first_seen_days: 4, what: "A plausible role at an employer whose hiring system we have never read.", expect: "Caution, with the reason stated as “not on any hiring system we can read” — uncertainty, not an accusation. Must not be Ghost or Scam.", verdicts: ["Caution"],
    html: (p) => page("Product Designer", "Marlow Education", "Bengaluru", p, para(describe(FUNCTIONS[9], "Product Designer", "Marlow Education", [3, 6], "₹14–20 LPA").split("\n\n").slice(1).join("\n"))) },
  { slug: "gm-sparse", title: "Manager", employer: "Kestrel Foods", what: "Three lines; not enough to judge.", expect: "No verdict: “couldn’t read the posting” or “couldn’t see enough”. A verdict here is a failure.", verdicts: ["error"],
    html: () => "<h1>Manager</h1><p>Kestrel Foods</p><p>Apply now.</p>" },
  { slug: "gm-not-a-job", title: "About Kestrel Foods", employer: "Kestrel Foods", what: "A company page, not a posting.", expect: "No verdict: “That link isn’t a job posting”.", verdicts: ["error"],
    html: () => "<h1>About Kestrel Foods</h1><p>Kestrel Foods makes packaged foods and runs a quick-commerce grocery service in Bengaluru. Founded in 2016, we serve four lakh households a month through forty dark stores. Our brands include Kestrel Fresh and Morning Table. Read our story, meet our leadership team and see our sustainability report.</p><p>Press enquiries: press@kestrel-foods.example</p>" },
  { slug: "gm-expired", title: "Removed posting", employer: "Tessel Software", http: 410, what: "The page answers “gone”.", expect: "No verdict; the message says the posting can’t be opened. Must not be Real.", verdicts: ["error"], html: () => "<h1>410</h1><p>This posting has been removed.</p>" },
  { slug: "gm-unavailable", title: "Server error", employer: "Tessel Software", http: 503, what: "The site is down.", expect: "No verdict and no check used; a retry message.", verdicts: ["error"], html: () => "Service unavailable" },
  { slug: "gm-timeout", title: "Hanging page", employer: "Tessel Software", hang: true, what: "The page never answers.", expect: "No verdict and no check used; the request gives up within about 30 seconds.", verdicts: ["error"], html: () => "" },
];

/** The first ten synthetic candidates. The résumé files are in seed/qa/resumes (built by scripts/qa-resumes.cjs). */
export type Candidate = { n: number; name: string; fn: string; level: Level; years: number; covers: string; expect: { for_you: string[]; never: string[]; notes: string } };
const C = (n: number, name: string, fn: string, level: Level, years: number, covers: string, notes: string): Candidate => {
  const up: Level | null = level === "junior" ? "mid" : level === "mid" ? "senior" : level === "senior" ? "head" : null;
  return { n, name, fn, level, years, covers, expect: { for_you: [`${fn}-${level}`], never: FUNCTIONS.filter((f) => f.key !== fn).map((f) => `${f.key}-${level}`), notes: `${notes}${up ? ` ${fn}-${up} may appear as adjacent or stretch.` : ""} ${fn}-adjacent may appear as stretch. ${fn}-closed must never appear.` } };
};
export const CANDIDATES: Candidate[] = [
  C(1, "Aarav Menon", "swe", "junior", 1, "Entry level, one internship and one year of work.", "Must not be shown senior or manager seats."),
  C(2, "Diya Raghavan", "pm", "mid", 5, "Mid-level, clean single-column résumé.", "The reference case."),
  C(3, "Rohan Kapoor", "cat", "head", 13, "Senior leader, three pages, P&L ownership.", "Must not be shown executive or associate seats."),
  C(4, "Sneha Iyer", "data", "mid", 4, "Career switcher: two years in customer support, then analytics.", "Analytics roles only; support roles are not in the pool. Years in analytics are 2; total 4."),
  C(5, "Farah Siddiqui", "hr", "senior", 8, "A two-year employment gap (2021–2023), stated on the résumé.", "The gap must not be hidden, filled or re-dated by Sharpen."),
  C(6, "Vikram Shetty", "sales", "senior", 9, "Three roles at one employer (promotions).", "Each role’s lines must stay under that role; the employer must not be merged or split."),
  C(7, "Meenal Joshi", "fin", "mid", 6, "Two-column résumé with a sidebar.", "Sidebar skills must not become job lines."),
  C(8, "Kabir Anand", "mkt", "senior", 7, "Unusual format: dates on the right, section headings in sentence case, a table of tools.", "The reader must still file every line under the right role."),
  C(9, "Ananya Pillai", "ops", "head", 11, "Contradictory information: overlapping dates on two roles and a summary that says 14 years against 11 in the roles.", "The Record’s years should follow the roles, not the summary. Sharpen must not resolve the contradiction by inventing dates."),
  C(10, "Ishaan Verma", "ux", "mid", 3, "Sparse: no summary, one-line roles, no education dates.", "Sharpen has little to work with: a small lift is correct; an invented achievement is a failure."),
];
