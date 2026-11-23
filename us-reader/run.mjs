// A counting run: asks the boards found for their open roles, keeps the US ones, and curates them. Nothing is stored
// in the database; it writes us-reader/out/summary.json (the funnel from every US role down to the curated pool) and
// samples for a person to look over. LIMIT is boards per system; "all" checks every board found.
import { readBoard } from "./lib.mjs";
import { curate } from "./curate.mjs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const ALL = process.env.LIMIT === "all", LIMIT = ALL ? Infinity : Number(process.env.LIMIT ?? 60);
const SEED = { greenhouse: ["stripe", "databricks", "datadog", "airbnb", "figma"], lever: ["palantir", "spotify"], ashby: ["ramp", "notion", "linear", "openai"] };
const file = new URL("./out/boards.json", import.meta.url);
const found = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { greenhouse: [], lever: [], ashby: [] };
const spread = (a, n) => a.length <= n ? a : Array.from({ length: n }, (_, i) => a[Math.floor(i * a.length / n)]);
const uniq = (a) => { const seen = new Set(); return a.filter((v) => { const k = v.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); };
const boards = [], sample = [], middlemen = [];
const tot = { boards: 0, answered: 0, gone: 0, other_status: 0, roles: 0, us: 0, us_employers: 0, curated: 0, curated_employers: 0, curated_remote: 0, curated_text_mb: 0 };
const why = { not_fresh: 0, thin_text: 0, same_role_elsewhere: 0, middleman: 0, commission: 0 };
const by = { func: {}, level: {}, visa: {} }; const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
const started = Date.now(); let bytes = 0;
await Promise.all(["greenhouse", "lever", "ashby"].map(async (system) => {
  for (const ref of uniq([...SEED[system], ...spread(found[system] ?? [], LIMIT)])) {
    const r = await readBoard(system, ref); const us = r.jobs.filter((j) => j.us);
    tot.boards++; if (r.ok) tot.answered++; else if (r.status === 404) tot.gone++; else tot.other_status++;
    tot.roles += r.jobs.length; tot.us += us.length; if (us.length) tot.us_employers++;
    const c = curate(r.jobs, { ref });
    for (const k of Object.keys(why)) why[k] += c.why[k];
    if (c.middleman) middlemen.push({ system, ref, us: us.length });
    if (c.keep.length) tot.curated_employers++;
    tot.curated += c.keep.length;
    for (const j of c.keep) { bytes += Buffer.byteLength(j.text); if (j.remote) tot.curated_remote++; bump(by.func, j.func); bump(by.level, j.level); bump(by.visa, j.visa); }
    boards.push({ system, ref, status: r.status, roles: r.jobs.length, us: us.length, curated: c.keep.length });
    if (c.keep.length && tot.curated_employers % (ALL ? 25 : 3) === 0 && sample.length < 110) { const j = c.keep[Math.floor(c.keep.length / 2)]; sample.push({ system, ref, title: j.title, location: j.location.slice(0, 70), places: j.places, level: j.level, func: j.func, visa: j.visa, posted_at: j.posted_at?.slice(0, 10), url: j.url }); }
  }
}));
tot.curated_text_mb = Math.round(bytes / 1e6); tot.seconds = Math.round((Date.now() - started) / 1000);
writeFileSync(new URL("./out/summary.json", import.meta.url), JSON.stringify({ at: new Date().toISOString(), limit: ALL ? "all" : LIMIT, found: found.counts ?? null, archive: found.archive ?? null, totals: tot, left_behind: why, by,
  middlemen: middlemen.sort((a, b) => b.us - a.us).slice(0, 40), middlemen_count: middlemen.length,
  biggest_curated: [...boards].sort((a, b) => b.curated - a.curated).slice(0, 50).map((b) => [b.ref, b.curated, b.us]),
  by_system: ["greenhouse", "lever", "ashby"].map((s) => { const b = boards.filter((x) => x.system === s); return { system: s, boards: b.length, answered: b.filter((x) => x.status === 200).length, us: b.reduce((n, x) => n + x.us, 0), curated: b.reduce((n, x) => n + x.curated, 0) }; }) }, null, 1));
writeFileSync(new URL("./out/sample.json", import.meta.url), JSON.stringify(sample, null, 1));
writeFileSync(new URL("./out/perboard.json", import.meta.url), JSON.stringify(boards));
console.log(tot, why);
