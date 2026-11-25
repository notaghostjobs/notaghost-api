// Offline check of the enrichment path with page shells: stubbed network and database, nothing leaves the machine.
// Run: npx tsx src/probe/enrich-shell-offline.mts
process.env.SUPABASE_URL = "http://db.test"; process.env.SUPABASE_SERVICE_ROLE_KEY = "x";
let fail = 0; const ok = (n: string, c: boolean, d: unknown = "") => { if (c) console.log("  ✓", n); else { fail++; console.log("  ✗", n, JSON.stringify(d)); } };
const writes: any[] = []; const calls: string[] = []; let api: any = null;
const FORM = `<html><head><title>Job Application for Product Analyst II at HackerRank</title></head><body><h1>Product Analyst II</h1><form><p>Apply for this job</p><p>* indicates a required field</p><label>First Name *</label><label>Last Name *</label><label>Email *</label><label>Phone *</label><label>Resume/CV *</label><p>Accepted file types: pdf, doc, docx, txt, rtf</p><p>How many years of experience do you have as a product analyst?</p></form></body></html>`;
const REAL = `<html><body><h1>Project Manager</h1><p>Why project44? We build supply chain software used by large shippers.</p><h2>What you'll be working on</h2><ul><li>Manage 10-15 client engagements concurrently and deliver on time and on budget.</li><li>Engage product and engineering to resolve issues.</li></ul><h2>Requirements</h2><ul><li>3-5 years in a customer facing role at an enterprise SaaS company.</li></ul><form><p>Apply for this job</p><p>* indicates a required field</p></form></body></html>`;
const CONTENT = "&lt;h3&gt;What you will do&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Own analytics for next-generation products, platform, content and growth areas.&lt;/li&gt;&lt;li&gt;Define metrics across adoption, engagement and retention.&lt;/li&gt;&lt;/ul&gt;&lt;h3&gt;What you need&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;3+ years in product analytics with SQL and Python; experience with A/B testing.&lt;/li&gt;&lt;/ul&gt;";
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url; calls.push(url);
  if (url.startsWith("http://db.test")) { if ((init?.method ?? "GET") !== "GET") writes.push({ url, body: JSON.parse(String(init.body ?? "{}")) }); return new Response("[]", { status: 200, headers: { "content-type": "application/json" } }); }
  if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200 });
  if (url.includes("boards-api.greenhouse.io")) return api ? new Response(JSON.stringify(api), { status: 200, headers: { "content-type": "application/json" } }) : new Response("{}", { status: 404 });
  if (url.includes("/hackerrank/")) return new Response(FORM, { status: 200, headers: { "content-type": "text/html" } });
  if (url.includes("/project44/")) return new Response(REAL, { status: 200, headers: { "content-type": "text/html" } });
  return new Response("", { status: 404 });
}) as any;
const { enrichOne } = await import("../reader/enrich.js");
const row = (url: string) => ({ id: 1, url, posted_at: null, salary_text: null, raw: {} });
const last = () => writes.at(-1)?.body ?? {};

api = { title: "Product Analyst II", content: CONTENT };
writes.length = 0; calls.length = 0; ok("form page + API text: stored, from the API", (await enrichOne(row("https://job-boards.greenhouse.io/hackerrank/jobs/8146911"))) === true && String(last().description).includes("Own analytics") && !/indicates a required field/.test(last().description), last());
ok("form page: the API was asked for that one job", calls.some((u) => u.includes("boards-api.greenhouse.io/v1/boards/hackerrank/jobs/8146911")));

api = null; writes.length = 0; ok("form page + no API text: nothing stored, marked as no job text", (await enrichOne(row("https://job-boards.greenhouse.io/hackerrank/jobs/1"))) === false && last().description === undefined && /no job text/.test(String(last().enrich_error)), last());

api = { title: "x", content: "&lt;p&gt;Apply for this job * indicates a required field&lt;/p&gt;" };
writes.length = 0; ok("form page + API returns a form too: nothing stored", (await enrichOne(row("https://job-boards.greenhouse.io/hackerrank/jobs/2"))) === false && last().description === undefined, last());

api = { title: "Project Manager", content: CONTENT }; writes.length = 0; calls.length = 0;
ok("real page with a form at the end: stored from the page, API never called", (await enrichOne(row("https://job-boards.greenhouse.io/project44/jobs/8255555"))) === true && String(last().description).includes("Manage 10-15 client engagements") && !calls.some((u) => u.includes("boards-api")), { last: last(), calls });
console.log(fail ? `${fail} failed` : "all passed"); process.exit(fail ? 1 : 0);
