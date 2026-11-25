// A blind labelling pack: candidate–job pairs from any arms, deduplicated, shuffled within each candidate, with no
// trace of which arm proposed them. Key (pair → arms) kept separately.
//   npx tsx mk-pack.mts <pairs.json [{profile,id,arms:[...]}]> <outdir> <batches>
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
const S = "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad";
const { postingProblem } = await import("/home/claude/wt-api/src/lib/textfit.ts");
const [pairsF, out, batchesS] = process.argv.slice(2); const nb = Number(batchesS ?? 1);
const pairs = JSON.parse(readFileSync(pairsF, "utf8")); const answers = JSON.parse(readFileSync(`${S}/sim2/answers.json`, "utf8"));
const { SPEC } = await import("/home/claude/wt-api/src/lib/ontology.ts");
const inv = new Map(readFileSync(`${S}/bench/prod/inventory.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return [String(r.id), r]; }));
let seed = 77; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const byP = new Map<string, any[]>(); for (const p of pairs) (byP.get(p.profile) ?? byP.set(p.profile, []).get(p.profile)!).push(p);
const profiles = [...byP.keys()].sort(); const key: any[] = []; let n = 0;
for (let b = 0; b < nb; b++) mkdirSync(`${out}/b${b + 1}/pairs`, { recursive: true }), mkdirSync(`${out}/b${b + 1}/resumes`, { recursive: true });
profiles.forEach((p, k) => { const b = (k % nb) + 1; const a = answers[p];
  const dir = `${SPEC.get(a.direction_primary)?.label ?? a.direction_primary}${a.direction_secondary !== "none" ? `; also ${SPEC.get(a.direction_secondary)?.label ?? a.direction_secondary}` : ""}; target level ${a.level}; open to related work: ${a.open_to_adjacent}; changing careers: ${a.transition}`;
  const items = byP.get(p)!.map((x) => ({ x, r: rnd() })).sort((u, v) => u.r - v.r).map((y) => y.x).map((x) => { n++; key.push({ pair: n, batch: b, ...x }); const r: any = inv.get(String(x.id));
    return { pair: n, candidate: p, stated_direction: dir, job_title: r.title, employer: r.company_name, location: r.location, posting_text: postingProblem(r.title, r.description).text.replace(/\s+/g, " ").slice(0, 2600) }; });
  writeFileSync(`${out}/b${b}/pairs/${p}.json`, JSON.stringify(items, null, 1)); copyFileSync(`${S}/labels/resumes/${p}.txt`, `${out}/b${b}/resumes/${p}.txt`); });
writeFileSync(`${out}/key.json`, JSON.stringify(key, null, 1)); console.log(n, "pairs in", nb, "batches", JSON.stringify(Object.fromEntries([...Array(nb)].map((_, i) => [i + 1, key.filter((k) => k.batch === i + 1).length]))));
