// Shortlist recall of known-suitable jobs (AI labels, provisional; seen profiles) at sizes 20/30/40/50.
// Two recall figures, never combined:
//   raw     — the suitable posting itself is shortlisted (only these can ever be judged and displayed);
//   cluster — also counts a suitable posting whose same-requirement near-duplicate is shortlisted (an upper bound).
// Variants: V2 s1; V3 with title-only clusters (s3.2, as first reported); V3 with requirement-signature clusters (s3.3).
//   SUPABASE_URL=https://offline.invalid SUPABASE_SERVICE_ROLE_KEY=offline npx tsx src/lab/v3/shortlist-eval.mts
import { writeFileSync } from "node:fs";
const D = await import("./data.mjs"); const F = await import("./features.mjs"); const SL = await import("./shortlist.js"); const { shortlist } = await import("../v2/pipeline.js");
const { skillsIn } = await import("../skills.js"); const { GENERIC } = await import("../v2/terms.js");
const SIZES = [20, 30, 40, 50]; const ALL = { yearsBand: "*", city: "*", employment: "*", manages: false, anchors: "*", unit: "*", tools: [] };
const out: any = { sizes: SIZES, sets: {}, cluster_audit: {} };
const audit = { groups_same_title: 0, postings_in_groups: 0, split_groups: 0, split_by: {} as Record<string, number> };
for (const [set, ps] of [["development", D.split.development], ["held_out_seen", D.split.heldout]] as const) {
  const agg: any = {};
  for (const p of ps) {
    const { c, cands } = D.candidates(p, { fallbackDepth: 50 }); const r = D.pools.get(p);
    const suit = new Set([...D.labels].filter(([k, L]) => k.startsWith(p + "|") && D.SU.has(L.grade) && !D.closed.has(k.split("|")[1])).map(([k]) => k.split("|")[1]));
    const eligibleSuit = [...new Set(cands.filter((x: any) => suit.has(x.id)).map((x: any) => x.id))];
    const have = new Map(c.skills.map((s: any) => [s.id, s.basis]));
    const sc: any[] = cands.map((x: any) => { const f = F.features(p, x.id); const need = [...skillsIn(x.reqText)]; let num = 0, den = 0;
      for (const s of need) { const w = GENERIC.has(s) ? 0.25 : 1; den += w; const b = have.get(s); num += w * (b === "work" || b === "achievement" ? 1 : b === "project" ? 0.7 : b ? 0.3 : 0); }
      const sg = F.signature(x.id);
      return { id: x.id, title: x.title, employer: x.employer, channels: Object.fromEntries(Object.entries<any>(r.channels).map(([k, l]) => [k, l.indexOf(x.id) + 1 || null])), agree: x.agree, compat: f.compat, anchors: f.anchors, cover: den ? num / den : 0.5, sig: sg.sig, reqHash: sg.reqHash }; });
    // clustering audit: same employer + title groups, and why they split
    const g = new Map<string, any[]>(); for (const x of sc) { const k = `${x.employer.toLowerCase().trim()}|${SL.normTitle(x.title)}`; if (!g.has(k)) g.set(k, []); g.get(k)!.push(x); }
    for (const xs of g.values()) if (xs.length > 1) { audit.groups_same_title++; audit.postings_in_groups += xs.length; const a = xs[0].sig; const diff = Object.keys(a).filter((f) => xs.some((y) => f === "tools" ? !SL.sameRequirements({ ...a, tools: a.tools }, { ...a, tools: y.sig.tools }) : JSON.stringify(y.sig[f]) !== JSON.stringify(a[f])));
      if (diff.length) { audit.split_groups++; for (const f of diff) audit.split_by[f] = (audit.split_by[f] ?? 0) + 1; } }
    for (const n of SIZES) {
      const v2 = new Set(shortlist(cands, c, n).map((x: any) => x.j.id));
      const opts = { size: n, ...SL.DEFAULT_SHORT };
      const variants: Record<string, any> = { "v3_title_only": SL.shortlist3(sc.map((x) => ({ ...x, sig: ALL })), opts), "v3_signature": SL.shortlist3(sc, opts) };
      const k = (name: string) => (agg[`${name}@${n}`] ??= { raw: 0, cluster: 0, eligible_suitable: 0, judged_jobs: 0 });
      k("v2").eligible_suitable += eligibleSuit.length; k("v2").raw += eligibleSuit.filter((j) => v2.has(j)).length; k("v2").cluster = k("v2").raw; k("v2").judged_jobs += v2.size;
      for (const [name, v] of Object.entries<any>(variants)) { const reps = new Set(v.chosen.map((c2: any) => c2.rep.id)); const mem = new Set(v.chosen.flatMap((c2: any) => c2.members));
        k(name).eligible_suitable += eligibleSuit.length; k(name).raw += eligibleSuit.filter((j) => reps.has(j)).length; k(name).cluster += eligibleSuit.filter((j) => mem.has(j)).length; k(name).judged_jobs += reps.size;
        if (name === "v3_signature" && n === 40) for (const j of eligibleSuit) if (!reps.has(j)) { const x = sc.find((y) => y.id === j); const why = mem.has(j) ? "member of a judged same-requirement cluster" : SL.hardMismatch(x) ? `deterministic veto: ${x.compat.verdict === "below" || x.compat.verdict === "too_far_up" ? `scope ${x.compat.verdict}` : `anchor ${x.anchors.status}`}` : "ranked below the cut"; (out.lost40 ??= {})[why] = ((out.lost40 ?? {})[why] ?? 0) + 1; } }
    }
  }
  out.sets[set] = agg;
}
out.cluster_audit = audit;
writeFileSync(`${D.S}/v3/shortlist-eval.json`, JSON.stringify(out, null, 1));
const tot = (v: string, n: number, f: string) => Object.values<any>(out.sets).reduce((a, s) => a + s[`${v}@${n}`][f], 0);
console.log("size | variant | raw recall | cluster-adjusted recall | judged jobs (19 profiles)");
for (const n of SIZES) for (const v of ["v2", "v3_title_only", "v3_signature"]) console.log(`${n} | ${v} | ${tot(v, n, "raw")}/${tot(v, n, "eligible_suitable")} | ${tot(v, n, "cluster")}/${tot(v, n, "eligible_suitable")} | ${tot(v, n, "judged_jobs")}`);
console.log("cluster audit:", JSON.stringify(audit)); console.log("V3 s3.3 @40, suitable postings not judged:", JSON.stringify(out.lost40));
