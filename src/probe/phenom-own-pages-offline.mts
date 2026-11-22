// Offline check: a Phenom site whose apply links leave for Workday gets each job linked to its page on the employer's own
// careers site. Run: npx tsx src/probe/phenom-own-pages-offline.mts   Nothing here touches the network or the database.
for (const k of ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL"]) process.env[k] ??= k.endsWith("_URL") ? "https://offline.invalid" : "offline";
const { phenom } = await import("../reader/systems/big.js");
let fail = 0; const ok = (n: string, c: boolean, d = "") => { if (c) console.log("  ✓", n); else { fail++; console.log("  ✗", n, d); } };
const WD = (id: string) => `https://acme.wd5.myworkdayjobs.com/Careers/job/Bangalore-India/Role_${id}/apply`;
const sites: Record<string, { jobs: any[]; own: string | null }> = {
  "jobs.acme.example": { own: "global/en", jobs: [{ jobId: "R-1", title: "IT Intern", city: "Bangalore", country: "India", applyUrl: WD("R-1") }, { jobId: "R-2", title: "Analyst", city: "Bangalore", country: "India", applyUrl: WD("R-2") }] },
  "careers.usfirst.example": { own: "us/en", jobs: [{ jobId: "77", title: "Engineer", city: "Bengaluru", country: "India", applyUrl: WD("77") }] },
  "careers.nopage.example": { own: null, jobs: [{ jobId: "9", title: "Engineer", city: "Bengaluru", country: "India", applyUrl: WD("9") }] },
  "careers.ownapply.example": { own: "in/en", jobs: [{ jobId: "P-1", title: "Designer", city: "Bengaluru", country: "India", applyUrl: "https://careers.ownapply.example/job/P1ENIN" }] },
};
const calls: string[] = [];
globalThis.fetch = (async (u: any, init?: any) => { const url = String(u); const h = new URL(url).host; calls.push(`${init?.method ?? "GET"} ${url}`);
  if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200, headers: { "content-type": "text/plain" } });
  const site = sites[h]; if (!site) return new Response("no", { status: 404 });
  if (url.endsWith("/widgets")) return new Response(JSON.stringify({ refineSearch: { totalHits: site.jobs.length, data: { jobs: site.jobs } } }), { status: 200, headers: { "content-type": "application/json" } });
  const m = /^https:\/\/[^/]+\/([a-z]+\/[a-z]+)\/job\/(.+)$/.exec(url);
  if (m && site.own === m[1]) return new Response(`<script>phApp.ddo = {"jobDetail":{"data":{"job":{"description":"<p>x</p>"}}}}; phApp.x=1</script>`, { status: 200 });
  return new Response("not found", { status: 404 }); }) as any;
const a = (await phenom.read("jobs.acme.example"))!;
ok("jobs whose apply link is Workday are linked to the employer's own page", a.jobs.length === 2 && a.jobs[0].url === "https://jobs.acme.example/global/en/job/R-1" && a.jobs[1].url === "https://jobs.acme.example/global/en/job/R-2", JSON.stringify(a.jobs.map((j) => j.url)));
ok("the prefix is found once, from the first job", calls.filter((c) => c.includes("jobs.acme.example") && c.includes("/job/")).length === 1);
ok("no Workday address is asked for", !calls.some((c) => c.includes("myworkdayjobs.com")));
const b = (await phenom.read("careers.usfirst.example"))!;
ok("a site on another prefix is found by trying the next one", b.jobs[0].url === "https://careers.usfirst.example/us/en/job/77");
const c = (await phenom.read("careers.nopage.example"))!;
ok("where no own page answers, the apply link is kept as it was", c.jobs[0].url === WD("9") && /not found/.test(c.debug ?? ""));
const n0 = calls.length; const d = (await phenom.read("careers.ownapply.example"))!;
ok("a site whose apply link is already its own is left alone, and nothing extra is asked", d.jobs[0].url === "https://careers.ownapply.example/job/P1ENIN" && !calls.slice(n0).some((x) => x.includes("/in/en/job/") || x.includes("/global/en/job/")));
ok("ids stay as they were (so held rows line up)", a.jobs[0].id === "R-1" && b.jobs[0].id === "77");
console.log(" ", a.debug);
console.log(fail ? `FAILED ${fail}` : "all passed"); process.exit(fail ? 1 : 0);
