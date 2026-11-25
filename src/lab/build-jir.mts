// Build deterministic JIRs and retrieval views for every valid posting in the frozen snapshot. Offline.
//   npx tsx src/lab/build-jir.mts <inventory.jsonl> <outdir>
process.env.SUPABASE_URL ??= "https://offline.invalid"; process.env.SUPABASE_SERVICE_ROLE_KEY ??= "offline";
import { readFileSync, writeFileSync } from "node:fs";
const { cleanTitle } = await import("../radar/v2.js"); const { postingProblem } = await import("../lib/textfit.js"); const { detJIR, views } = await import("./jir.js");
const [inv, out] = process.argv.slice(2);
const rows = readFileSync(inv, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.description);
const t0 = Date.now(); const jl: string[] = [], vl: string[] = []; let invalid = 0;
for (const r of rows) { const v = postingProblem(r.title ?? "", r.description); if (v.problem) { invalid++; continue; }
  const j = detJIR({ id: r.id, source: r.source, employer: r.company_name, title: cleanTitle(r.title), location: r.location, text: v.text }); jl.push(JSON.stringify(j));
  vl.push(JSON.stringify({ id: String(r.id), employer: r.company_name, title: j.posting.title, whole_raw: `${j.posting.title}. ${v.text}`.replace(/\s+/g, " ").slice(0, 3000), ...views(j) })); }
writeFileSync(`${out}/jir-det.jsonl`, jl.join("\n") + "\n"); writeFileSync(`${out}/views-det.jsonl`, vl.join("\n") + "\n");
console.log(`${jl.length} records, ${invalid} invalid left out, ${((Date.now() - t0) / jl.length).toFixed(1)} ms each`);
