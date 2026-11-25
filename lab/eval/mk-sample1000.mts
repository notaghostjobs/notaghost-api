// The 1,000-posting development sample: the 700 already labelled blind for kind of work (200 + dev 250 + holdout 250),
// plus 300 drawn stratified from the rest so thin strata are present: every function, every level, short and long
// descriptions, generic titles. Partitions are fixed here and recorded; seeds are recorded.
import { readFileSync, writeFileSync } from "node:fs";
const S = "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad";
const tags = JSON.parse(readFileSync(`${S}/bench/prod/tags-v2.json`, "utf8")); const byId = new Map(tags.map((t: any) => [String(t.id), t]));
const part = new Map<string, string>();
for (const x of JSON.parse(readFileSync(`${S}/labels5/engine-tags.json`, "utf8"))) part.set(String(x.id), "seen200");
for (const x of JSON.parse(readFileSync(`${S}/labels7dev/ids.json`, "utf8"))) part.set(String(x.id), "dev");
for (const x of JSON.parse(readFileSync(`${S}/labels8hold/ids.json`, "utf8"))) part.set(String(x.id), "holdout");
const inv = new Map(readFileSync(`${S}/bench/prod/inventory.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return [String(r.id), r]; }));
const GENERIC = /^(developer|engineer|analyst|consultant|associate|executive|manager|specialist|technical lead|domain consultant|senior analyst|senior executive|assistant manager)\b|\bL\d\b|practitioner|delivery operations/i;
let seed = 1000; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const strata = new Map<string, any[]>();
for (const t of tags) { const id = String(t.id); if (part.has(id)) continue; const len = (inv.get(id)?.description ?? "").length;
  const k = `${t.fn ?? "untagged"}|${t.level}|${len < 1500 ? "short" : len > 6000 ? "long" : "mid"}|${GENERIC.test(t.t) ? "generic" : "named"}`; (strata.get(k) ?? strata.set(k, []).get(k)!).push(id); }
// round-robin across strata (shuffled), one at a time, so every stratum gets a posting before any gets two
const keys = [...strata.keys()].sort().map((k) => ({ k, r: rnd() })).sort((a, b) => a.r - b.r).map((x) => x.k);
for (const k of keys) strata.get(k)!.sort(() => rnd() - 0.5);
const extra: string[] = []; let round = 0;
while (extra.length < 300) { let added = false; for (const k of keys) { const l = strata.get(k)!; if (l.length > round && extra.length < 300) { extra.push(l[round]); added = true; } } if (!added) break; round++; }
for (const id of extra) part.set(id, "dev-extra");
const out = [...part.entries()].map(([id, p]) => ({ id, partition: p, fn_v2: (byId.get(id) as any)?.fn ?? null, level_v2: (byId.get(id) as any)?.level ?? null }));
writeFileSync(`${S}/arch/sample1000.json`, JSON.stringify({ made: "2026-11-25", seed: 1000, note: "partitions fixed before any AI call; holdout never used for prompt revision", rows: out }, null, 1));
const c: any = {}; for (const r of out) c[r.partition] = (c[r.partition] ?? 0) + 1; console.log(out.length, c, "strata", keys.length);
const fnc: any = {}; for (const r of out) fnc[r.fn_v2 ?? "-"] = (fnc[r.fn_v2 ?? "-"] ?? 0) + 1; console.log(JSON.stringify(fnc));
