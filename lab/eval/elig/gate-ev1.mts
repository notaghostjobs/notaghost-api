// The eligibility gate applied directly to evaluate-1's 121 labelled pairs (matched to the frozen inventory by title and
// employer), so the gate and evaluate-1 can be compared on the same jobs. No model call.
//   SUPABASE_URL=https://offline.invalid SUPABASE_SERVICE_ROLE_KEY=offline npx tsx lab/eval/elig/gate-ev1.mts <out.json>
import { readFileSync, writeFileSync } from "node:fs";
const { gate, jobFromDet } = await import("../../../src/lab/elig.ts"); const { validity2 } = await import("../../../src/lab/validity.ts");
const S = "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad";
const det = new Map(readFileSync(`${S}/arch/jir-det.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => { const j = JSON.parse(l); return [j.posting.id, j]; }));
const views = new Map(readFileSync(`${S}/arch/views-det.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => { const v = JSON.parse(l); return [v.id, v]; }));
const profiles = new Map(JSON.parse(readFileSync(`${S}/bench/profiles-19-local.json`, "utf8")).map((p: any) => [p.id, p]));
const inv = new Map<string, string>();
for (const l of readFileSync(`${S}/bench/prod/inventory.jsonl`, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l); const k = `${String(r.title).trim().toLowerCase()}|${String(r.company_name ?? "").trim().toLowerCase()}`; if (!inv.has(k)) inv.set(k, String(r.id)); }
const csv = readFileSync(`${S}/review/benchmark-final-labels.csv`, "utf8");
// minimal CSV reader (quoted fields)
const rows: string[][] = []; let f = "", row: string[] = [], q = false;
for (let i = 0; i < csv.length; i++) { const ch = csv[i]; if (q) { if (ch === '"' && csv[i + 1] === '"') { f += '"'; i++; } else if (ch === '"') q = false; else f += ch; } else if (ch === '"') q = true; else if (ch === ",") { row.push(f); f = ""; } else if (ch === "\n") { row.push(f); rows.push(row); row = []; f = ""; } else f += ch; }
const head = rows.shift()!; const ix = (n: string) => head.indexOf(n);
const out: Record<string, boolean | null> = {}; let matched = 0, noRecord = 0;
for (const r of rows) {
  if (r.length < head.length) continue;
  const p = r[ix("profile")], id = inv.get(`${r[ix("job title")].trim().toLowerCase()}|${r[ix("employer")].trim().toLowerCase()}`);
  if (!id) continue; matched++;
  const j: any = det.get(id); if (!j) { out[`${p}|${id}`] = null; noRecord++; continue; }
  const c = JSON.parse(readFileSync(`${S}/arch/cand/${p}.json`, "utf8")); const resume = readFileSync((profiles.get(p) as any).resume, "utf8");
  const v: any = views.get(id); const invalid = v && validity2(v.title, v.whole_raw.slice(v.title.length + 2));
  const g = gate(jobFromDet(j), { want: c.belief.want, level: c.belief.level, years: Number(c.belief.years) || 0, stretch: !!c.belief.stretch, resume, experience: String(c.cir.views.experience ?? "") });
  out[`${p}|${id}`] = !invalid && g.eligible;
}
writeFileSync(process.argv[2], JSON.stringify(out));
console.log(`pairs ${rows.length} · matched to inventory ${matched} · without a job record ${noRecord} · eligible ${Object.values(out).filter((x) => x === true).length}`);
