// Replays the V3 gate on V2's frozen judge verdicts (no model call) and compares it with the frozen V2 display.
// Scored against the existing AI labels: provisional, previously seen profiles, not independent validation.
//   SUPABASE_URL=https://offline.invalid SUPABASE_SERVICE_ROLE_KEY=offline npx tsx src/lab/v3/replay.mts [variant]
import { writeFileSync } from "node:fs";
const D = await import("./data.mjs"); const F = await import("./features.mjs"); const G = await import("./gate.js");
const wilson = (k: number, n: number) => { if (!n) return [null, null]; const z = 1.96, p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d; return [+(c - h).toFixed(2), +(c + h).toFixed(2)]; };
const VARIANTS: Record<string, any> = { "v3.strict": { admitAdjacentMedium: false, requireAnchorForAdjacent: true, directStepUpMedium: false }, "v3.no_stepup_medium": { ...G.DEFAULT_OPTS, directStepUpMedium: false }, "v3.default": G.DEFAULT_OPTS, "v3.loose": { admitAdjacentMedium: true, requireAnchorForAdjacent: false } };
export function run(opts: any, ps: string[]) {
  const per: any = {}; let shown = 0, lab = 0, su = 0, cov = 0; const items: any[] = [];
  for (const p of ps) {
    const V = D.verdicts.get(p); const elig = new Set(D.stage.get(p).shortlist.map((x: any) => x.id));
    const ctx = (id: string) => { const f = F.features(p, id); return { compat: f.compat, anchors: f.anchors, eligible: elig.has(id), employer: f.job.employer, title: f.job.title }; };
    const out = G.present(V.verdicts, ctx, 5, opts); per[p] = out.strong.length; if (out.strong.length) cov++;
    for (const s of out.strong) { shown++; const L = D.labels.get(`${p}|${s.job_id}`); if (L) { lab++; if (D.SU.has(L.grade)) su++; } items.push({ p, job: s.job_id, title: ctx(s.job_id).title, label: L?.grade ?? "unlabelled", reasons: s.reasons }); }
  }
  return { shown, labelled: lab, suitable: su, precision: lab ? +(su / lab).toFixed(3) : null, ci95: wilson(su, lab), coverage: `${cov}/${ps.length}`, per_candidate: per, items };
}
function v2(ps: string[]) { let shown = 0, lab = 0, su = 0, cov = 0; const per: any = {};
  for (const p of ps) { const s = D.verdicts.get(p).shown.strong; per[p] = s.length; if (s.length) cov++; for (const x of s) { shown++; const L = D.labels.get(`${p}|${x.job_id}`); if (L) { lab++; if (D.SU.has(L.grade)) su++; } } }
  return { shown, labelled: lab, suitable: su, precision: lab ? +(su / lab).toFixed(3) : null, ci95: wilson(su, lab), coverage: `${cov}/${ps.length}`, per_candidate: per }; }
const res: any = {};
for (const [name, ps] of [["development", D.split.development], ["held_out_seen", D.split.heldout]] as const) {
  res[name] = { "v2.frozen": v2(ps) }; for (const [k, o] of Object.entries(VARIANTS)) res[name][k] = run(o, ps);
}
writeFileSync(`${D.S}/v3/replay.json`, JSON.stringify(res, null, 1));
for (const [set, r] of Object.entries<any>(res)) { console.log(`\n${set}`); for (const [k, x] of Object.entries<any>(r)) console.log(`  ${k.padEnd(11)} shown ${x.shown} labelled ${x.labelled} suitable ${x.suitable} precision ${x.precision} ci ${JSON.stringify(x.ci95)} coverage ${x.coverage} | ${JSON.stringify(x.per_candidate)}`); }
if (process.argv[2]) for (const it of res[process.argv[3] ?? "development"][process.argv[2]].items) if (!D.SU.has(it.label)) console.log("  NOT SUITABLE/UNLABELLED", it.p, it.title.slice(0, 50), it.label, "|", it.reasons.join("; ").slice(0, 120));
