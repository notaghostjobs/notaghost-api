// Offline check of the 72-hour freshness gate (src/lib/fresh.ts and its uses in Radar, the public lists, the MCP tools,
// the Instagram list and the free check's count). The database is an in-memory stand-in that answers the requests
// supabase-js makes and records every write; employer pages are stubbed. No network, no paid calls.
// Run: npx tsx src/probe/fresh-offline.mts
process.env.SUPABASE_URL = "http://db.test"; process.env.SUPABASE_SERVICE_ROLE_KEY = "x";
let fail = 0; const ok = (n: string, c: boolean, d: unknown = "") => { if (c) console.log("  ✓", n); else { fail++; console.log("  ✗", n, JSON.stringify(d)); } };

// ---- stand-in database ------------------------------------------------------------------------------------------
type Row = Record<string, any>;
const T: Record<string, Row[]> = {}; const writes: { table: string; method: string; body: any }[] = []; const fetched: string[] = [];
const filters = (u: URL) => {
  const f: ((r: Row) => boolean)[] = []; let order: [string, boolean] | null = null, limit = Infinity, offset = 0;
  for (const [k, v] of u.searchParams) {
    if (["select", "columns", "on_conflict"].includes(k)) continue;
    if (k === "order") { const [c, d] = v.split("."); order = [c, d !== "desc"]; continue; }
    if (k === "limit") { limit = Number(v); continue; } if (k === "offset") { offset = Number(v); continue; }
    const neg = v.startsWith("not."); const vv = neg ? v.slice(4) : v; const i = vv.indexOf("."); const op = vv.slice(0, i), x = vv.slice(i + 1);
    const val = x === "null" ? null : x === "true" ? true : x === "false" ? false : x;
    let g: (r: Row) => boolean;
    if (op === "eq") g = (r) => String(r[k]) === String(val);
    else if (op === "neq") g = (r) => String(r[k]) !== String(val);
    else if (op === "is") g = (r) => (r[k] ?? null) === val;
    else if (op === "gte") g = (r) => r[k] != null && r[k] >= val!;
    else if (op === "gt") g = (r) => r[k] != null && r[k] > val!;
    else if (op === "lt") g = (r) => r[k] != null && r[k] < val!;
    else if (op === "in") { const set = String(val).replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/^"|"$/g, "")); g = (r) => set.includes(String(r[k])); }
    else if (op === "like" || op === "ilike") { const re = new RegExp("^" + String(val).split(/[%*]/).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", op === "ilike" ? "i" : ""); g = (r) => re.test(String(r[k] ?? "")); }
    else throw new Error(`stand-in: ${k}=${v}`);
    f.push(neg ? (r) => !g(r) : g);
  }
  return (rows: Row[]) => { let o = rows.filter((r) => f.every((g) => g(r))); if (order) { const [c, a] = order; o = [...o].sort((x, y) => (x[c] < y[c] ? -1 : x[c] > y[c] ? 1 : 0) * (a ? 1 : -1)); } return o.slice(offset, offset + limit); };
};
const json = (b: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...extra } });
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = String(init?.method ?? "GET").toUpperCase(); const h = new Headers(init?.headers);
  if (url.host !== "db.test") { fetched.push(url.href); return new Response(`<html><body><h1>Role</h1><p>${"We are hiring in Bengaluru. ".repeat(20)}</p></body></html>`, { status: 200, headers: { "content-type": "text/html" } }); }
  const table = url.pathname.replace(/^\/rest\/v1\//, ""); const rows = (T[table] ??= []); const pick = filters(url);
  const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : null;
  const range = h.get("range"); let sel = pick(rows);
  if (method === "GET" || method === "HEAD") {
    if (range) { const [a, b] = range.split("-").map(Number); sel = sel.slice(a, b + 1); }
    const count: Record<string, string> = (h.get("prefer") ?? "").includes("count=exact") ? { "content-range": `0-${Math.max(0, sel.length - 1)}/${pick(rows).length}` } : {};
    if ((h.get("accept") ?? "").includes("vnd.pgrst.object")) return sel.length === 1 ? json(sel[0], 200, count) : json({ code: "PGRST116", message: "0 rows" }, 406);
    return method === "HEAD" ? new Response(null, { status: 200, headers: count }) : json(sel, 200, count);
  }
  writes.push({ table, method, body });
  if (method === "POST") { for (const b of (Array.isArray(body) ? body : [body])) { const i = table === "reader_control" ? rows.findIndex((r) => r.key === b.key) : -1; if (i >= 0) rows[i] = { ...rows[i], ...b }; else rows.push({ ...b }); } return json([], 201); }
  if (method === "PATCH") { for (const r of sel) Object.assign(r, body); return json(sel); }
  return json([]);
}) as any;

// ---- fixtures ---------------------------------------------------------------------------------------------------
const H = 3600e3, NOW = Date.now(), iso = (ms: number) => new Date(ms).toISOString();
const DESC = "Bengaluru, India. We are hiring an analyst with 2 to 4 years of experience in data analysis, SQL and Excel, building reports and dashboards for business teams. ".repeat(3);
const S = (id: number, src: string, seenAgoH: number, extra: Row = {}) => ({ id, source: src, blr: true, title: `Data Analyst ${id}`, company_name: `Acme ${id}`, location: "Bengaluru", url: `https://jobs.acme${id}.com/role/${id}`,
  posted_at: null, first_seen: iso(NOW - 5 * 86400e3), employer_key: `acme${id}`, last_seen: iso(NOW - seenAgoH * H), gone_at: null, description: DESC, ...extra });
function seed() {
  for (const k of Object.keys(T)) delete T[k]; writes.length = 0; fetched.length = 0;
  T.sightings = [
    S(1, "greenhouse", 2),                    // healthy connector, read this morning
    S(2, "lever", 70),                        // just inside 72 h
    S(3, "workday", 100),                     // Workday paused since 22 Nov: never refreshed
    S(4, "oracle", 500),                      // orphaned feed (no longer read)
    S(5, "successfactors", 74),               // provider read failing for a few days
    S(6, "greenhouse", 1, { gone_at: iso(NOW - 10 * H) }),   // genuinely closed
    S(7, "greenhouse", 3, { blr: false }),    // not Bengaluru
    S(8, "sitejobs", 90, { description: null }),
  ];
  T.reader_control = []; T.users = [{ id: "u1", phone: "+910000000000" }]; T.resumes = [{ id: "res1", user_id: "u1", is_current: true, created_at: iso(NOW), parsed: { name: "B-01", years_total: 3, roles: [{ title: "Data Analyst" }], skills: ["SQL", "Excel"] } }];
  T.plans = []; T.sessions = [];
}
const sightingWrites = () => writes.filter((w) => w.table === "sightings");
const F = await import("../lib/fresh.js");

console.log("The rule (lib/fresh.ts)");
ok("default is 72 hours; FRESH_HOURS=0 turns it off; a bad value falls back to 72, never off", F.freshHours({}) === 72 && F.freshHours({ FRESH_HOURS: "0" }) === 0 && F.freshHours({ FRESH_HOURS: "48" }) === 48 && F.freshHours({ FRESH_HOURS: "x" }) === 72 && F.freshHours({ FRESH_HOURS: "-5" }) === 72);
ok("71 h old is fresh, 73 h old is not, no last_seen is not", F.isFresh(iso(NOW - 71 * H), NOW, {}) && !F.isFresh(iso(NOW - 73 * H), NOW, {}) && !F.isFresh(null, NOW, {}));
ok("gate off: everything counts as fresh", F.isFresh(iso(NOW - 900 * H), NOW, { FRESH_HOURS: "0" }) && F.freshSince(NOW, { FRESH_HOURS: "0" }) === null);

seed();
const st = await F.standings([1, 2, 3, 4, 5, 6, 99], NOW);
ok("standings: fresh / held (Workday, orphaned, failing feed) / gone (closed or not on file)", st.get(1) === "fresh" && st.get(2) === "fresh" && st.get(3) === "held" && st.get(4) === "held" && st.get(5) === "held" && st.get(6) === "gone" && st.get(99) === "gone", Object.fromEntries(st));

console.log("Radar's pool (livePool: Radar runs, pulse, public job pages, MCP search)");
const R = await import("../routes/radar.js");
seed(); delete process.env.FRESH_HOURS;
let pool = await R.livePool(); let ids = pool.map((s) => s.id).sort();
ok("only jobs confirmed within 72 h, open, in Bengaluru", JSON.stringify(ids) === "[1,2]", ids);
ok("Workday (100 h), orphaned (500 h), failing feed (74 h) and the undescribed stale row are held back", ![3, 4, 5, 8].some((i) => ids.includes(i)));
ok("readable is still marked from the description", pool.every((s) => s.readable === true));
process.env.FRESH_HOURS = "0"; pool = await R.livePool(); ids = pool.map((s) => s.id).sort();
ok("FRESH_HOURS=0: the old pool exactly (all open Bengaluru rows), and the cache follows the setting", JSON.stringify(ids) === "[1,2,3,4,5,8]", ids);
// reconfirmation: a successful read refreshes last_seen (recordFeed); the job is back on the next pool build
T.sightings.find((r) => r.id === 3)!.last_seen = iso(Date.now());
process.env.FRESH_HOURS = "72.0"; pool = await R.livePool(); ids = pool.map((s) => s.id).sort();
ok("a held job whose feed lists it again is back, with nothing else changed", JSON.stringify(ids) === "[1,2,3]", ids);
ok("the gate wrote nothing to sightings", sightingWrites().length === 0, sightingWrites());
delete process.env.FRESH_HOURS;

console.log("Someone's Radar list (morning refresh and the page they see)");
seed();
const item = (id: number, label = "for_you") => ({ sighting_id: id, title: `Data Analyst ${id}`, company: `Acme ${id}`, location: "Bengaluru", url: `https://jobs.acme${id}.com/role/${id}`, posted_at: null, first_seen: iso(NOW - 5 * 86400e3), why: "Your SQL and dashboards match what they ask for.", label, band_text: "2–4 years" });
const run = { status: "done", resume_id: "res1", started: iso(NOW - 3 * 86400e3), finished: iso(NOW - 3 * 86400e3), refreshed: iso(NOW - 86400e3), answers: { titles: ["Data Analyst"], level: "mid", avoid: [], stretch: false }, items: [item(1), item(3), item(5, "adjacent"), item(6)], seen: [1, 3, 5, 6] };
T.reader_control.push({ key: "radar:run:u1", value: run }, { key: "radar:unlock:u1", value: { by: "test" } });
// the pool cache is per process: rebuild it for this seed
process.env.FRESH_HOURS = "71.5"; await R.livePool();   // the pool cache is keyed on the setting: a new value rebuilds it from this seed
const r1 = await R.refreshRadar("u1");
const after = T.reader_control.find((r) => r.key === "radar:run:u1")!.value;
const byId = new Map<number, any>(after.items.map((i: any) => [i.sighting_id, i]));
ok("the closed role leaves the list as gone (as before)", !byId.has(6) && (after.gone ?? []).some((g: any) => g.sighting_id === 6), after.gone);
ok("unconfirmed roles (Workday, failing feed) stay on the list, held, and are NOT reported gone", byId.get(3)?.held === true && byId.get(5)?.held === true && !(after.gone ?? []).some((g: any) => [3, 5].includes(g.sighting_id)), { items: after.items.map((i: any) => [i.sighting_id, i.held]), gone: after.gone, violations: after.violations });
ok("the fresh role is shown, not held", byId.has(1) && !byId.get(1)!.held);
ok("counts and the morning message leave held roles out (1 shown)", after.for_you === 1 && after.adjacent === 0 && r1?.shots === 1 && r1?.gone === 1, { for_you: after.for_you, adjacent: after.adjacent, r1 });
ok("held roles' pages are not opened in the morning check; the shown role's page is", !fetched.some((u) => /acme3|acme5/.test(u)) && fetched.some((u) => /acme1\.com/.test(u)), fetched);
ok("the refresh wrote nothing to sightings", sightingWrites().length === 0, sightingWrites());

// the page the person sees
const { createSession } = await import("../lib/auth.js");
const tok = await createSession("u1"); for (const s of T.sessions) s.users = T.users[0];
const res = await R.radar.request("/test/result", { headers: { authorization: `Bearer ${tok}` } }); const body: any = await res.json();
const shownIds = (body.items ?? []).map((i: any) => i.sighting_id).sort();
ok("their list shows only the confirmed role; held roles are not in it", res.status === 200 && JSON.stringify(shownIds) === "[1]", { status: res.status, shownIds });
// reconfirmation: Workday comes back (feed read succeeds), the next morning puts the role back on show
T.sightings.find((r) => r.id === 3)!.last_seen = iso(Date.now());
const res2 = await R.radar.request("/test/result", { headers: { authorization: `Bearer ${tok}` } }); const body2: any = await res2.json();
ok("once its feed lists it again, the held role is back on their page at once, without a rerun", JSON.stringify((body2.items ?? []).map((i: any) => i.sighting_id).sort()) === "[1,3]", (body2.items ?? []).map((i: any) => i.sighting_id));
process.env.FRESH_HOURS = "71.25"; await R.livePool();   // rebuild the pool after the reconfirmation
// next morning: the run changes day; refreshed earlier so refresh runs again
await R.refreshRadar("u1");
const after2 = T.reader_control.find((r) => r.key === "radar:run:u1")!.value;
ok("...and the next morning it is unheld and counted again", !after2.items.find((i: any) => i.sighting_id === 3)?.held && after2.for_you === 2, { items: after2.items.map((i: any) => [i.sighting_id, i.held]), for_you: after2.for_you });
ok("the whole Radar path wrote nothing to sightings", sightingWrites().length === 0, sightingWrites());
delete process.env.FRESH_HOURS;

console.log("Other lists");
seed();
T.reader_control.push({ key: "ig:roles", value: { roles: [{ slug: "a", id: 1 }, { slug: "b", id: 3 }, { slug: "c", id: 6 }] } });
const { ig } = await import("../routes/ig.js");
const igr: any = await (await ig.request("/roles")).json();
ok("Instagram bio list: only confirmed open roles (Workday and closed roles left out)", JSON.stringify(igr.roles.map((r: any) => r.slug)) === '["a"]', igr.roles);
const { mcp } = await import("../routes/mcp.js");
const call = async (id: number) => { const r = await mcp.request("/", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_job", arguments: { job_id: id } } }) }); const t = await r.text(); const m = t.match(/\{[\s\S]*\}/); const j = m ? JSON.parse(m[0]) : null; return { ...(j?.result?.structuredContent ?? {}), text: (j?.result?.content ?? []).map((c: any) => c.text).join("\n") }; };
const g1 = await call(1), g3 = await call(3), g6 = await call(6);
ok("MCP get_job: confirmed job is live; an unconfirmed Workday job is 'not_confirmed' (never 'live', never 'closed'); a closed one is closed", g1?.status === "live" && g3?.status === "not_confirmed" && g6?.status === "closed", { g1: g1?.status, g3: g3?.status, g6: g6?.status });
const t3 = String(g3?.text ?? "");
ok("...and its text tells the person to check the employer's page before applying", /check the employer.s page/i.test(t3), t3.slice(0, 300));
ok("no list wrote anything to sightings", sightingWrites().length === 0, sightingWrites());
console.log(fail ? `${fail} failed` : "all passed"); process.exit(fail ? 1 : 0);
