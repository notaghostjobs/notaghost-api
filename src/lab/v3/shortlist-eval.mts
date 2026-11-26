// Shortlist recall of known-suitable jobs (AI labels, provisional) at sizes 20/30/40/50: V2 s1 versus V3 s3.
// A suitable job counts as recalled when it is shortlisted itself or is a member of a shortlisted near-duplicate cluster
// (reported separately, since the judge then sees only the representative). Offline, no model call.
//   SUPABASE_URL=https://offline.invalid SUPABASE_SERVICE_ROLE_KEY=offline npx tsx src/lab/v3/shortlist-eval.mts
import { writeFileSync } from "node:fs";
const D = await import("./data.mjs"); const F = await import("./features.mjs"); const SL = await import("./shortlist.js"); const { shortlist } = await import("../v2/pipeline.js");
const { skillsIn } = await import("../skills.js"); const { GENERIC } = await import("../v2/terms.js");
const SIZES = [20, 30, 40, 50];
const out: any = { sizes: SIZES, sets: {} };
for (const [set, ps] of [["development", D.split.development], ["held_out_seen", D.split.heldout]] as const) {
  const agg: any = {}; const lostDetail: any[] = [];
  for (const p of ps) {
    const { c, cands } = D.candidates(p, { fallbackDepth: 50 }); const r = D.pools.get(p);
    const suit = new Set([...D.labels].filter(([k, L]) => k.startsWith(p + "|") && D.SU.has(L.grade) && !D.closed.has(k.split("|")[1])).map(([k]) => k.split("|")[1]));
    const eligibleSuit = new Set(cands.filter((x: any) => suit.has(x.id)).map((x: any) => x.id));
    const have = new Map(c.skills.map((s: any) => [s.id, s.basis]));
    const sc: any[] = cands.map((x: any) => { const f = F.features(p, x.id); const need = [...skillsIn(x.reqText)]; let num = 0, den = 0;
      for (const s of need) { const w = GENERIC.has(s) ? 0.25 : 1; den += w; const b = have.get(s); num += w * (b === "work" || b === "achievement" ? 1 : b === "project" ? 0.7 : b ? 0.3 : 0); }
      return { id: x.id, title: x.title, employer: x.employer, channels: Object.fromEntries(Object.entries<any>(r.channels).map(([k, l]) => [k, l.indexOf(x.id) + 1 || null])), agree: x.agree, compat: f.compat, anchors: f.anchors, cover: den ? num / den : 0.5 }; });
    for (const n of SIZES) {
      const v2 = new Set(shortlist(cands, c, n).map((x: any) => x.j.id));
      const v3 = SL.shortlist3(sc, { size: n, perChannel: +(process.env.PC ?? SL.DEFAULT_SHORT.perChannel), perEmployerClusters: +(process.env.PE ?? SL.DEFAULT_SHORT.perEmployerClusters) }); const v3ids = new Set(v3.chosen.map((c2) => c2.rep.id)); const v3mem = new Set(v3.chosen.flatMap((c2) => c2.members));
      const k = (name: string) => (agg[`${name}@${n}`] ??= { recalled: 0, via_cluster: 0, eligible_suitable: 0, judged_jobs: 0 });
      k("v2").eligible_suitable += eligibleSuit.size; k("v2").recalled += [...eligibleSuit].filter((j) => v2.has(j)).length; k("v2").judged_jobs += v2.size;
      k("v3").eligible_suitable += eligibleSuit.size; k("v3").recalled += [...eligibleSuit].filter((j) => v3mem.has(j)).length; k("v3").via_cluster += [...eligibleSuit].filter((j) => v3mem.has(j) && !v3ids.has(j)).length; k("v3").judged_jobs += v3ids.size;
      if (n === 30) for (const j of eligibleSuit) if (!v3mem.has(j)) { const x = sc.find((y) => y.id === j); lostDetail.push({ p, job: j, title: x.title, score: +SL.score3(x).toFixed(3), hard: SL.hardMismatch(x), compat: x.compat.verdict, compatWhy: x.compat.reasons.slice(-2), anchors: x.anchors.status, anchorDetail: x.anchors.detail.map((d: any) => `${d.id}:${d.status}`) }); }
    }
    // upper bound: suitable jobs that are anywhere in the eligible candidate list
    (agg.reachable ??= { eligible_suitable: 0, all_suitable_open: 0 }); agg.reachable.eligible_suitable += eligibleSuit.size; agg.reachable.all_suitable_open += suit.size;
  }
  out.sets[set] = { agg, lost_at_30: lostDetail };
}
writeFileSync(`${D.S}/v3/shortlist-eval.json`, JSON.stringify(out, null, 1));
for (const [set, r] of Object.entries<any>(out.sets)) { console.log(`\n${set}: reachable ${JSON.stringify(r.agg.reachable)}`); for (const n of SIZES) for (const v of ["v2", "v3"]) { const x = r.agg[`${v}@${n}`]; console.log(`  ${v}@${n}: recalled ${x.recalled}/${x.eligible_suitable} (${(x.recalled / x.eligible_suitable * 100).toFixed(0)}%)${v === "v3" ? `, ${x.via_cluster} via cluster` : ""}, judged jobs ${x.judged_jobs}`); }
  for (const l of r.lost_at_30) console.log("   lost@30", l.p, l.title.slice(0, 45), l.score, l.hard ? "HARD" : "", l.compat, l.anchors, l.anchorDetail.join(","), "|", l.compatWhy.join("; ").slice(0, 110)); }
