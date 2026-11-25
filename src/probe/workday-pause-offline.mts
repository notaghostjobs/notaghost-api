// Offline check of WORKDAY_PAUSED (src/lib/workdayPause.ts): every Workday path, paused and not paused, with a stubbed
// network and database. Nothing leaves the machine. Run: npx tsx src/probe/workday-pause-offline.mts
process.env.SUPABASE_URL = "http://db.test"; process.env.SUPABASE_SERVICE_ROLE_KEY = "x";
let fail = 0; const ok = (n: string, c: boolean, d: unknown = "") => { if (c) console.log("  ✓", n); else { fail++; console.log("  ✗", n, JSON.stringify(d)); } };
type Call = { url: string; method: string; body: string };
const calls: Call[] = []; let employersRows: any[] = [];
const WD = /myworkday|workday\.com/i;
// the stubbed outside world: the database answers empty or with the rows a test sets; every other host answers 404
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url; const method = String(init?.method ?? "GET").toUpperCase();
  calls.push({ url, method, body: String(init?.body ?? "") });
  if (url.startsWith("http://db.test")) {
    if (method === "GET" && url.includes("/employers")) return new Response(JSON.stringify(employersRows), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200 });
  if (WD.test(url)) return new Response(JSON.stringify({ total: 1, jobPostings: [{ title: "Analyst", externalPath: "/job/Bengaluru/Analyst_R1", locationsText: "Bengaluru", bulletFields: ["R1"] }], jobPostingInfo: { title: "Analyst", jobDescription: "<p>" + "Real work. ".repeat(40) + "</p>", startDate: "2026-11-01" } }), { status: 200, headers: { "content-type": "application/json" } });
  return new Response("not found", { status: 404 });
}) as any;
const P = await import("../lib/workdayPause.js");
P.installWorkdayPause();
const { workday, workdayDiscover } = await import("../reader/systems/ats.js");
const { enrichOne, enrichDue, readPostingText } = await import("../reader/enrich.js");
const { readDue } = await import("../reader/read.js");
const { resolveBatch } = await import("../reader/resolve.js");
const { findAts } = await import("../engine/ghost/ats.js");
const { readPosting } = await import("../engine/ghost/read.js");
const { fetchPosting } = await import("../engine/extract.js");
const JOB = "https://acme.wd5.myworkdayjobs.com/External/job/Bengaluru/Analyst_R1";
const wdCalls = () => calls.filter((c) => { try { return WD.test(new URL(c.url).hostname); } catch { return false; } }).length;   // by host: the database query itself mentions "myworkday"
const writes = () => calls.filter((c) => c.url.startsWith("http://db.test") && c.method !== "GET" && c.method !== "HEAD");
const reset = () => { calls.length = 0; P.refusedByPause.clear(); };
const settle = async (p: Promise<unknown>) => { try { return { ok: true, v: await p }; } catch (e) { return { ok: false, e: e as any }; } };

console.log("Paused (WORKDAY_PAUSED=true)");
process.env.WORKDAY_PAUSED = "true";
reset(); { const r = await settle(workday.read("acme/wd5/External")); ok("list read: refused before any request", !r.ok && r.e instanceof P.WorkdayPaused && wdCalls() === 0, r); }
reset(); ok("tenant discovery by name: nothing sent", (await workdayDiscover("Acme Corp")) === null && wdCalls() === 0);
reset(); ok("enrichment of a Workday row: skipped, row untouched", (await enrichOne({ id: 7, url: JOB, posted_at: null, salary_text: null, raw: {} })) === false && wdCalls() === 0 && writes().length === 0, writes());
reset(); await enrichDue(10, 1); { const q = calls.find((c) => c.url.includes("/sightings") && c.method === "GET")?.url ?? ""; ok("enrichment batch: Workday URLs are not picked", decodeURIComponent(q).includes("url=not.ilike.%myworkday%") && wdCalls() === 0, q); }
reset(); ok("Radar's live check (readPostingText): no request, empty text (shown as not confirmed)", (await readPostingText(JOB)) === "" && wdCalls() === 0);
reset(); employersRows = []; await readDue(5, 20, 1); { const q = calls.find((c) => c.url.includes("/employers") && c.method === "GET")?.url ?? ""; ok("reader pass: Workday employers left out", decodeURIComponent(q).includes('ats=not.in.("none","workday")') && wdCalls() === 0, q); }
reset(); employersRows = [{ key: "acme", name: "Acme", website: null, careers_url: JOB, ats: "workday", ats_ref: "acme/wd5/External", priority: 1 }, { key: "beta", name: "Beta", website: null, careers_url: "https://acme.wd5.myworkdayjobs.com/External", ats: null, ats_ref: null, priority: 1 }];
{ const r = await resolveBatch(5, 1); const q = decodeURIComponent(calls.find((c) => c.url.includes("/employers") && c.method === "GET")?.url ?? "");
  ok("resolver: Workday employers and Workday careers links are left out of the queue", q.includes("or=(ats.is.null,ats.neq.workday)") && q.includes("or=(careers_url.is.null,careers_url.not.ilike.*myworkday*)"), q);
  ok("resolver: even if one reaches it, nothing is requested and no employer is written (not turned into 'none')", wdCalls() === 0 && writes().filter((w) => w.url.includes("/employers")).length === 0, { r, writes: writes().map((w) => w.url) }); }
employersRows = [];
reset(); await settle(findAts("Acme", JOB)); ok("Ghost Meter's hiring-system lookup: no Workday probe", wdCalls() === 0);
reset(); { const r = await settle(readPosting(JOB)); ok("Ghost Meter's link reader: no request; asks for pasted text (422)", !r.ok && r.e?.status === 422 && wdCalls() === 0, r.e?.message); }
reset(); { const r = await settle(fetchPosting(JOB, { bypassCache: true })); ok("Sharpen/free-check link fetch: no request; asks for pasted text (400)", !r.ok && r.e?.status === 400 && wdCalls() === 0, r.e?.message); }
reset(); { const r = await settle(fetch("https://acme.wd5.myworkdayjobs.com/robots.txt")); ok("any other fetch to a Workday host is refused by the guard", !r.ok && r.e instanceof P.WorkdayPaused && wdCalls() === 0 && P.refusedByPause.get("acme.wd5.myworkdayjobs.com") === 1); }
reset(); { const r = await settle(fetch("https://boards-api.greenhouse.io/v1/boards/x/jobs")); ok("non-Workday hosts are untouched", r.ok && calls.length === 1); }
ok("the guard matches Workday's hosts only", P.isWorkdayUrl(JOB) && P.isWorkdayUrl("https://x.myworkdaysite.com/a") && P.isWorkdayUrl("https://www.workday.com/") && !P.isWorkdayUrl("https://careers.example.com/workday-analyst") && !P.isWorkdayUrl("https://notworkday.com.evil.io/"));

console.log("Not paused (switch unset): behaviour as before");
delete process.env.WORKDAY_PAUSED;
reset(); { const r = await settle(workday.read("acme/wd5/External")); ok("list read goes out again", wdCalls() > 0, { r: r.ok, n: wdCalls() }); }
reset(); { const r = await settle(enrichOne({ id: 7, url: JOB, posted_at: null, salary_text: null, raw: {} })); ok("enrichment requests the Workday job again", wdCalls() > 0, r); }
reset(); await enrichDue(10, 1); { const q = calls.find((c) => c.url.includes("/sightings") && c.method === "GET")?.url ?? ""; ok("enrichment batch: no Workday filter", !decodeURIComponent(q).includes("myworkday"), q); }
reset(); { const r = await settle(fetch("https://acme.wd5.myworkdayjobs.com/robots.txt")); ok("the guard lets Workday through when unset", r.ok && wdCalls() === 1); }

// browsers: every page refuses Workday addresses while paused (needs a local Chromium; skipped if none)
try {
  const { chromium } = await import("playwright-core");
  process.env.WORKDAY_PAUSED = "true";
  const b = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
  const page = await b.newPage(); let blocked = false;
  try { await page.goto(JOB, { timeout: 5000 }); } catch (e) { blocked = /ERR_BLOCKED_BY_CLIENT/.test((e as Error).message); }
  const other = await b.newPage(); await other.goto("data:text/html,<p>ok</p>"); const okText = await other.textContent("p");
  ok("browser: a Workday page is refused; other pages open", blocked && okText === "ok");
  await b.close();
} catch (e) { console.log("  – browser check skipped:", (e as Error).message.split("\n")[0]); }
console.log(fail ? `${fail} failed` : "all passed"); process.exit(fail ? 1 : 0);
