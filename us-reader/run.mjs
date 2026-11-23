// A counting run: asks the boards found for their open roles and counts the US ones. Nothing is stored in the database;
// it writes us-reader/out/summary.json (totals, per-board counts, what the locations look like) and a sample of roles
// for a person to look over. LIMIT is boards per system; "all" checks every board found.
import { readBoard } from "./lib.mjs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const ALL = process.env.LIMIT === "all", LIMIT = ALL ? Infinity : Number(process.env.LIMIT ?? 60);
const SEED = { greenhouse: ["stripe", "databricks", "datadog", "airbnb", "figma"], lever: ["palantir", "spotify"], ashby: ["ramp", "notion", "linear", "openai"] };
const file = new URL("./out/boards.json", import.meta.url);
const found = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { greenhouse: [], lever: [], ashby: [] };
const spread = (a, n) => a.length <= n ? a : Array.from({ length: n }, (_, i) => a[Math.floor(i * a.length / n)]);
const boards = [], sample = [], usLoc = new Map(), otherLoc = new Map();
const tot = { boards: 0, answered: 0, gone: 0, other_status: 0, roles: 0, us: 0, us_remote: 0, with_text: 0, employers_with_us: 0, us_text_mb: 0, us_posted_30d: 0, us_posted_90d: 0, us_no_date: 0 };
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
const started = Date.now(), now = Date.now();
let textBytes = 0;
// the three systems are three different hosts, so they are asked side by side; each host still gets one request at a time
await Promise.all(["greenhouse", "lever", "ashby"].map(async (system) => {
  for (const ref of [...new Set([...SEED[system], ...spread(found[system] ?? [], LIMIT)])]) {
    const r = await readBoard(system, ref); const us = r.jobs.filter((j) => j.us);
    tot.boards++; if (r.ok) tot.answered++; else if (r.status === 404) tot.gone++; else tot.other_status++;
    tot.roles += r.jobs.length; tot.us += us.length; tot.us_remote += us.filter((j) => j.remote).length; tot.with_text += us.filter((j) => j.text.length >= 200).length; if (us.length) tot.employers_with_us++;
    for (const j of us) { textBytes += Buffer.byteLength(j.text); const age = j.posted_at ? (now - Date.parse(j.posted_at)) / 86400e3 : null; if (age == null || Number.isNaN(age)) tot.us_no_date++; else { if (age <= 30) tot.us_posted_30d++; if (age <= 90) tot.us_posted_90d++; } bump(usLoc, j.location.slice(0, 60)); }
    for (const j of r.jobs) if (!j.us) bump(otherLoc, j.location.slice(0, 60));
    boards.push({ system, ref, status: r.status, roles: r.jobs.length, us: us.length });
    // one role from about every twentieth employer, for a person to read
    if (us.length && tot.employers_with_us % (ALL ? 20 : 4) === 0 && sample.length < 120) { const j = us[Math.floor(us.length / 2)]; sample.push({ system, ref, title: j.title, location: j.location, url: j.url, posted_at: j.posted_at, text_chars: j.text.length }); }
  }
}));
tot.us_text_mb = Math.round(textBytes / 1e6); tot.seconds = Math.round((Date.now() - started) / 1000);
const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
writeFileSync(new URL("./out/summary.json", import.meta.url), JSON.stringify({ at: new Date().toISOString(), limit: ALL ? "all" : LIMIT, found: found.counts ?? null, archive: found.archive ?? null, blocks: found.blocks ?? null, notes: (found.notes ?? []).slice(0, 12), totals: tot,
  us_locations: top(usLoc, 60), other_locations: top(otherLoc, 120), biggest: [...boards].sort((a, b) => b.us - a.us).slice(0, 40), by_system: ["greenhouse", "lever", "ashby"].map((s) => { const b = boards.filter((x) => x.system === s); return { system: s, boards: b.length, answered: b.filter((x) => x.status === 200).length, us: b.reduce((n, x) => n + x.us, 0) }; }) }, null, 1));
writeFileSync(new URL("./out/sample.json", import.meta.url), JSON.stringify(sample, null, 1));
writeFileSync(new URL("./out/perboard.json", import.meta.url), JSON.stringify(boards));
console.log(tot);
