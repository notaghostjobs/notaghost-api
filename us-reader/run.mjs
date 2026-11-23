// A trial run: asks a sample of the boards found for their open roles and counts the US ones. Nothing is stored in the
// database yet; it writes us-reader/out/summary.json and a small sample of roles for a person to look over.
import { readBoard } from "./lib.mjs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const LIMIT = Number(process.env.LIMIT ?? 60);            // boards per system
const SEED = { greenhouse: ["stripe", "databricks", "datadog", "airbnb", "figma"], lever: ["palantir", "spotify"], ashby: ["ramp", "notion", "linear", "openai"] };
const file = new URL("./out/boards.json", import.meta.url);
const found = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { greenhouse: [], lever: [], ashby: [] };
// a spread across the alphabet, not just the first names
const spread = (a, n) => a.length <= n ? a : Array.from({ length: n }, (_, i) => a[Math.floor(i * a.length / n)]);
const boards = [], sample = []; const tot = { boards: 0, answered: 0, gone: 0, roles: 0, us: 0, us_remote: 0, with_text: 0, employers_with_us: 0 };
const started = Date.now();
for (const system of ["greenhouse", "lever", "ashby"]) {
  for (const ref of [...new Set([...SEED[system], ...spread(found[system] ?? [], LIMIT)])]) {
    const r = await readBoard(system, ref); const us = r.jobs.filter((j) => j.us);
    tot.boards++; if (r.ok) tot.answered++; else tot.gone++;
    tot.roles += r.jobs.length; tot.us += us.length; tot.us_remote += us.filter((j) => j.remote).length; tot.with_text += us.filter((j) => j.text.length >= 200).length; if (us.length) tot.employers_with_us++;
    boards.push({ system, ref, status: r.status, roles: r.jobs.length, us: us.length });
    for (const j of us.slice(0, 1)) if (sample.length < 40) sample.push({ system, ref, title: j.title, location: j.location, url: j.url, posted_at: j.posted_at, text_chars: j.text.length });
  }
}
tot.seconds = Math.round((Date.now() - started) / 1000);
writeFileSync(new URL("./out/summary.json", import.meta.url), JSON.stringify({ at: new Date().toISOString(), limit: LIMIT, found: found.counts ?? null, archive: found.archive ?? null, pages: found.pages ?? null, totals: tot, boards }, null, 1));
writeFileSync(new URL("./out/sample.json", import.meta.url), JSON.stringify(sample, null, 1));
console.log(tot);
