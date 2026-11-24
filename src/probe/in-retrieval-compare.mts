// Change 1 on a real title corpus, for several people at once: the old title-word search against Radar's long list, each
// followed by the same level filter and the same cut to 40 that the live list applies. No network, no model.
//   BENCH_POOL=/path/to/pool.json npx tsx src/probe/in-retrieval-compare.mts
// pool.json: rows of {id, title, company_name, location, url, first_seen, last_seen, employer_key, description} read from
// our own inventory. Profiles: target titles and level only (no person's data). A profile's "own-word roles" are the open
// roles whose title carries its rarest target word: a mechanical stand-in for relevance, NOT a reviewed label.
process.env.SUPABASE_URL ??= "https://offline.invalid"; process.env.SUPABASE_SERVICE_ROLE_KEY ??= "offline";
import { readFileSync } from "node:fs";
const { titleIdf, fwords } = await import("../routes/radar.js");
const { cleanTitle } = await import("../radar/v2.js");
const { inLongList, inRows, telling } = await import("../routes/us.js");
const { keywords, closest, near, levelOf } = await import("../lib/usmatch.js");

const path = process.env.BENCH_POOL; if (!path) { console.log("set BENCH_POOL to a pool file; nothing run"); process.exit(0); }
const raw = JSON.parse(readFileSync(path, "utf8")) as any[];
const now = Math.max(...raw.map((r) => Date.parse(r.last_seen)));
const pool = raw.map((r) => ({ ...r, title: cleanTitle(r.title), posted_at: null, readable: true }));   // title search only: text is not needed for it
const idf = titleIdf(pool as any);
const rare = (titles: string[]) => { const ws = [...new Set(titles.flatMap((t) => fwords(t)))].filter((w) => (idf.df.get(w) ?? 0) > 0); return ws.sort((a, b) => (idf.df.get(a) ?? 0) - (idf.df.get(b) ?? 0))[0] ?? null; };

type P = { id: string; what: string; level: "intern" | "entry" | "mid" | "senior" | "leader"; titles: string[] };
const people: P[] = JSON.parse(readFileSync(process.env.BENCH_PROFILES ?? new URL("./in-retrieval-profiles.json", import.meta.url), "utf8"));

const pad = (s: string | number, n: number) => String(s).padEnd(n);
console.log(`${raw.length} open roles, ${new Set(raw.map((r) => r.company_name)).size} employers, as of ${new Date(now).toISOString().slice(0, 10)}\n`);
console.log(pad("who", 30) + pad("word", 12) + pad("in pool", 8) + "| old: " + pad("matched", 8) + pad("kept", 6) + pad("levels", 7) + pad("40", 4) + pad("own", 5) + "| new: " + pad("long", 6) + pad("fallbk", 7) + pad("levels", 7) + pad("40", 4) + pad("own", 5) + "| same in both 40s");
let regress = 0; const detail: string[] = [];
for (const p of people) {
  const levels = near(p.level), kw = keywords(p.titles);
  const fresh = pool.filter((r) => Date.parse(r.last_seen) >= now - 2 * 864e5);
  // old: any title word, newest first, the first 1,000
  const matched = fresh.filter((r) => kw.some((w) => r.title.toLowerCase().includes(w))).sort((a, b) => b.first_seen.localeCompare(a.first_seen));
  const kept = matched.slice(0, 1000);
  const oldRows = inRows(kept, levels, new Map()); const old40 = closest(oldRows, p.titles, p.level, 40, now);
  // new: Radar's long list; the old search only when no target title says what the work is
  const long = inLongList(pool as any, p, false, now); const fb = !telling(p.titles);
  const have = new Set(long.map((r: any) => r.id));
  const rawNew = fb ? [...long, ...kept.filter((r) => !have.has(r.id))] : long;
  const newRows = inRows(rawNew, levels, new Map()); const new40 = closest(newRows, p.titles, p.level, 40, now);
  const w = rare(p.titles); const own = (t: string) => !!w && fwords(t).includes(w);
  const inPool = fresh.filter((r) => own(r.title) && levels.includes(levelOf(r.title)));
  const distinct = new Set(inPool.map((r) => `${r.company_name}|${r.title}`.toLowerCase())).size;
  const o = old40.filter((r) => own(r.title)).length, n = new40.filter((r) => own(r.title)).length;
  const both = new40.filter((r) => old40.some((x) => x.job_id === r.job_id)).length;
  if (n < o) regress++;
  const ownLong = new Set(long.filter((r: any) => own(r.title)).map((r: any) => `${r.company_name}|${r.title}`.toLowerCase())).size, ownLv = newRows.filter((r) => own(r.title)).length;
  const fromFb = new40.filter((r) => !have.has(Number(r.job_id))).length;
  detail.push(pad(p.id, 5) + pad(`own-word roles: in long list ${ownLong}, after level filter ${ownLv}, in the 40: ${n}`, 66) + `| rows in the 40 that came from the fallback: ${fromFb} of ${new40.length}` + (fromFb ? ` (their words: ${kw.join(", ")})` : ""));
  console.log(pad(`${p.id} ${p.what}`.slice(0, 29), 30) + pad(w ?? "-", 12) + pad(distinct, 8) + "| old: " + pad(matched.length, 8) + pad(kept.length, 6) + pad(oldRows.length, 7) + pad(old40.length, 4) + pad(o, 5) + "| new: " + pad(long.length, 6) + pad(fb ? "yes" : "no", 7) + pad(newRows.length, 7) + pad(new40.length, 4) + pad(n, 5) + `| ${both}`);
  if (process.env.BENCH_SHOW === p.id) { console.log("  old 40: " + old40.slice(0, 40).map((r) => r.title).join(" ; ").slice(0, 1500)); console.log("  new 40: " + new40.slice(0, 40).map((r) => r.title).join(" ; ").slice(0, 1500)); console.log("  long-list roles the level filter removed: " + long.filter((r: any) => !levels.includes(levelOf(r.title))).slice(0, 12).map((r: any) => `${r.title} [${levelOf(r.title)}]`).join(" ; ")); }
}
console.log("\n" + detail.join("\n"));
console.log(`\npeople whose final 40 holds fewer own-word roles than before: ${regress}`);
