// Offline check of the own-site sitemap reader (Hitachi, GE Vernova, Nike) against stand-in pages.
// Run: npx tsx src/probe/sitejobs-offline.mts   Nothing here touches the network or the database.
process.env.SITEJOBS_DETAIL_CAP = "3";
const { sitejobs, __deps, englishFiles, jobPages, fromPage, SITES, plainPlace } = await import("../reader/systems/sitejobs.js");
const { isBlr } = await import("../reader/blr.js");
const { detect } = await import("../reader/systems/index.js");
let fail = 0; const ok = (n: string, c: boolean, d = "") => { if (c) console.log("  ✓", n); else { fail++; console.log("  ✗", n, d); } };
const H = "careers.hitachi.com", B = `https://${H}`;
const INDEX = `<?xml version="1.0"?><sitemapindex><sitemap><loc>${B}/sitemap-07cbf468-de.xml</loc></sitemap><sitemap><loc>${B}/sitemap-07cbf468-en.xml</loc></sitemap><sitemap><loc>https://elsewhere.example/sitemap-x-en.xml</loc></sitemap></sitemapindex>`;
const U = (slug: string, id: string, d: string) => `<url><loc>${B}/${slug}/job/${id}</loc><lastmod>${d}</lastmod></url>`;
const EN = `<?xml version="1.0"?><urlset>${U("power-apps-developer", "R0100001", "2026-11-01")}${U("field-engineer", "R0100002", "2026-11-02")}${U("data-engineer", "R0100006", "2026-11-21")}${U("tax-analyst", "R0100005", "2026-11-20")}${U("no-place-role", "R0100004", "2026-11-19")}${U("oldest-new", "R0100003", "2026-10-01")}<url><loc>${B}/energy</loc></url><url><loc>https://other.example/x/job/R1</loc></url></urlset>`;
const page = (title: string, city: string | null, country = "India") => `<html><head><title>${title}</title><script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title, datePosted: "2026-11-20", jobLocation: city ? { address: { addressLocality: city, addressRegion: "Karnataka", addressCountry: country } } : undefined })}</script></head><body><h1>${title}</h1></body></html>`;
const calls: string[] = [];
globalThis.fetch = (async (u: any) => { const url = String(u); calls.push(url);
  if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200, headers: { "content-type": "text/plain" } });
  if (url === `${B}/sitemap.xml`) return new Response(INDEX, { status: 200 });
  if (url.endsWith("-en.xml")) return new Response(EN, { status: 200 });
  if (url.includes("R0100006")) return new Response(page("Data Engineer", "Bengaluru"), { status: 200 });
  if (url.includes("R0100005")) return new Response(page("Tax Analyst", "Zurich", "Switzerland"), { status: 200 });
  if (url.includes("R0100004")) return new Response(page("No Place Role", null), { status: 200 });
  return new Response("nope", { status: 500 }); }) as any;
__deps.loadKnown = async () => new Map([
  ["R0100001", { title: "Power Apps Developer", location: "Bengaluru", posted_at: "2026-11-01T00:00:00.000Z" }],
  ["R0100002", { title: "Field Engineer", location: "Chennai", posted_at: null }],
  ["R0999999", { title: "Closed Role", location: "Bengaluru", posted_at: null }],   // held by us, no longer in the sitemap
]);
ok("index: only this host's English file", englishFiles(INDEX, H).join() === `${B}/sitemap-07cbf468-en.xml`);
ok("job pages: only /job/<id> on this host", jobPages(EN, H).size === 6 && jobPages(EN, H).get("R0100006")?.url === `${B}/data-engineer/job/R0100006`);
ok("page: title and place", fromPage(page("Data Engineer", "Bengaluru"), "x").place.startsWith("Bengaluru") && fromPage(page("X", null), "x").place === "");
ok("page without JobPosting: place fields in the page", fromPage(`<h1>Lead</h1><script>{"addressLocality":"Bengaluru","addressCountry":"India"}</script>`, "x").place === "Bengaluru, India");
ok("page without JobPosting: the place in the page title", (() => { const r = fromPage(`<html><head><title>Power Apps, Power Automate Developer | Chennai, Tamil Nadu | Hitachi</title></head></html>`, "x"); return r.title === "Power Apps, Power Automate Developer" && r.place === "Chennai, Tamil Nadu"; })());
ok("a place read through Workday keeps Bengaluru", plainPlace("Bengaluru (Bengaluru facet)") === "Bengaluru" && isBlr(plainPlace("2 Locations (Bengaluru facet)")) && isBlr(plainPlace("3 Locations (incl. Bengaluru)")) && plainPlace("Chennai") === "Chennai" && !isBlr(plainPlace("2 Locations")));
ok("no URL is detected as this system", detect(`${B}/energy`)?.system !== "sitejobs" && detect(`${B}/data-engineer/job/R0100006`)?.system !== "sitejobs");
ok("a host that is not listed is not read", (await sitejobs.read("careers.example.com")) === null && calls.length === 0);
const f = (await sitejobs.read(H))!;
const by = new Map(f.jobs.map((j) => [j.id, j]));
ok("postings we already hold are confirmed without visiting their pages", by.get("R0100001")?.title === "Power Apps Developer" && by.has("R0100002") && !calls.some((c) => c.includes("R0100001") || c.includes("R0100002")));
ok("their link is the employer's own page", by.get("R0100001")?.url === `${B}/power-apps-developer/job/R0100001`);
ok("a posting gone from the sitemap is absent (so it is marked closed)", !by.has("R0999999"));
ok("new postings are read from their own page, most recently changed first", by.get("R0100006")?.title === "Data Engineer" && isBlr(by.get("R0100006")!.location) && by.get("R0100005")?.location.startsWith("Zurich") === true && !isBlr(by.get("R0100005")!.location));
ok("a page with no place is not stored", !by.has("R0100004"));
ok("the cap holds: the oldest new posting waits", !by.has("R0100003") && !calls.some((c) => c.includes("R0100003")));
ok("only the English file is fetched", !calls.some((c) => c.includes("-de.xml")) && !calls.some((c) => c.includes("elsewhere.example")));
ok("feed is under its own source", f.system === "sitejobs" && f.ref === H && f.partial !== true && f.company_name === SITES[H].name);
console.log(" ", f.debug);
console.log(fail ? `FAILED ${fail}` : "all passed"); process.exit(fail ? 1 : 0);
