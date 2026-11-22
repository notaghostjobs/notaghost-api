// Offline check of the Accenture own-site reader against stand-in pages. Run: npx tsx src/probe/accenture-offline.mts
// Nothing here touches the network or the database.
process.env.ACCENTURE_DETAIL_CAP = "3";
const { accenture, __deps, idOf, sitemapIds } = await import("../reader/systems/accenture.js");
const { isBlr } = await import("../reader/blr.js");
let fail = 0; const ok = (n: string, c: boolean, d = "") => { if (c) console.log("  ✓", n); else { fail++; console.log("  ✗", n, d); } };
const U = (id: string) => `https://www.accenture.com/in-en/careers/jobdetails?id=${id}`;
const SITEMAP = `<?xml version="1.0"?><urlset>${["ATCI-100-S900_en", "ATCI-101-S901_en", "ATCI-200-S950_en", "ATCI-201-S960_en", "ATCI-202-S970_en", "ATCI-203-S980_en", "AIOC-S01660790_en"].map((i) => `<url><loc>${U(i)}</loc></url>`).join("")}<url><loc>https://www.accenture.com/us-en/careers/jobdetails?id=US-1_en</loc></url></urlset>`;
const page = (title: string, city: string | null) => `<html><head><title>${title}</title><script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title, datePosted: "2026-11-20", jobLocation: city ? { address: { addressLocality: city, addressRegion: "" } } : undefined })}</script></head></html>`;
const calls: string[] = [];
globalThis.fetch = (async (u: any) => { const url = String(u); calls.push(url);
  if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: */careers/jobsearch?\n", { status: 200, headers: { "content-type": "text/plain" } });
  if (url.endsWith("/in-en/jobpostings-sitemap.xml")) return new Response(SITEMAP, { status: 200 });
  if (url.includes("ATCI-203-S980")) return new Response(page("Data Engineer", "Bengaluru"), { status: 200 });
  if (url.includes("ATCI-202-S970")) return new Response(page("Tax Analyst", "Mumbai"), { status: 200 });
  if (url.includes("ATCI-201-S960")) return new Response(page("No Place Role", null), { status: 200 });
  return new Response("nope", { status: 500 }); }) as any;
__deps.loadKnown = async () => new Map([
  ["ATCI-100-S900", { title: "LLM Model Developer", location: "Bengaluru", posted_at: "2026-11-01T00:00:00.000Z" }],
  ["AIOC-S01660790", { title: "Capital Projects Specialist", location: "Bengaluru", posted_at: null }],
  ["ATCI-999-S1", { title: "Closed Role", location: "Bengaluru", posted_at: null }],   // held by us, no longer in the sitemap
]);
ok("id drops the language suffix", idOf("ATCI-5440292-S1980130_en") === "ATCI-5440292-S1980130" && idOf("AIOC-S01660790_en") === "AIOC-S01660790");
ok("sitemap: only this country's postings", sitemapIds(SITEMAP, "in-en").size === 7);
ok("detect", accenture.detect("https://www.accenture.com/in-en/careers/jobsearch?location=Bengaluru") === "in-en" && accenture.detect("https://accenture.wd103.myworkdayjobs.com/x") === null);
const f = (await accenture.read("in-en"))!;
const by = new Map(f.jobs.map((j) => [j.id, j]));
ok("postings we already hold are confirmed without visiting their pages", by.get("ATCI-100-S900")?.title === "LLM Model Developer" && by.has("AIOC-S01660790") && !calls.some((c) => c.includes("ATCI-100-S900")));
ok("their link is Accenture's own page", by.get("ATCI-100-S900")?.url === U("ATCI-100-S900_en"));
ok("a posting gone from the sitemap is absent (so it is marked closed)", !by.has("ATCI-999-S1"));
ok("new postings are read from their own page, newest first, up to the cap", by.get("ATCI-203-S980")?.title === "Data Engineer" && isBlr(by.get("ATCI-203-S980")!.location) && by.get("ATCI-202-S970")?.location.startsWith("Mumbai") === true);
ok("a page with no place is not stored", !by.has("ATCI-201-S960"));
ok("the cap holds: the oldest new posting waits", !by.has("ATCI-200-S950") && !calls.some((c) => c.includes("ATCI-200-S950")) && !by.has("ATCI-101-S901"));
ok("the search-with-query address is never asked for", !calls.some((c) => c.includes("/careers/jobsearch?")));
ok("feed is under its own source", f.system === "accenture" && f.ref === "in-en" && f.partial !== true);
console.log(" ", f.debug);
console.log(fail ? `FAILED ${fail}` : "all passed"); process.exit(fail ? 1 : 0);
