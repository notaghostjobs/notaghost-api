// Matching v3, improvement 3: shortlist construction (which jobs reach the paid judge). Deterministic.
//  - near-duplicate postings (same employer, same normalised title) form one cluster: one representative is judged,
//    the others travel with it instead of consuming slots;
//  - a per-channel quota (each retrieval channel keeps its best few) is supported but OFF: on the 19 seen profiles it
//    lowered recall at every size (it spends slots on jobs one weak channel liked); fused ranks are used instead;
//  - the score uses defining anchors and scope compatibility; generic shared skills add little and never decide;
//  - hard deterministic mismatches (scope below or far above, defining anchor missing) are kept out unless nothing
//    else is left, and are never used to fill slots.
import type { Compat } from "./scope.js";
import type { AnchorCheck } from "./anchors.js";

export const SHORTLIST3_VERSION = "s3.2";   // s3.2: per-channel quota 0, 8 clusters per employer (sweep on the 19 seen profiles)
export const DEFAULT_SHORT = { perChannel: 0, perEmployerClusters: 8 };
export type SCand = { id: string; title: string; employer: string; channels: Record<string, number | null>; agree: number | null; compat: Compat; anchors: AnchorCheck; cover: number };
export type ShortOpts = { size: number; perChannel: number; perEmployerClusters: number };
/** Near-duplicate key: the title's distinct words, order-free, without locations, codes and requisition numbers. */
export const normTitle = (t: string) => [...new Set(t.toLowerCase().replace(/\(.*?\)|\[.*?\]|r-?\d{4,}|\b\d{3,}\b/g, " ").replace(/[^a-z0-9+#&]+/g, " ").replace(/\b(bengaluru|bangalore|india|blr|karnataka|remote|hybrid|dm|in|the|and|of|for)\b/g, " ").split(/\s+/).filter(Boolean))].sort().join(" ");
const ANCHOR_W: Record<string, number> = { met: 1, partial: 0.7, claimed_only: 0.55, none: 0.5, sibling_only: 0.15, missing: 0.05 };
const SCOPE_W: Record<string, number> = { fit: 1, below_mild: 0.8, step_up: 0.7, unknown: 0.6, too_far_up: 0.15, below: 0.1 };
export const hardMismatch = (x: SCand) => x.compat.verdict === "below" || x.compat.verdict === "too_far_up" || x.anchors.status === "missing" || x.anchors.status === "sibling_only";
/** Reciprocal-rank fusion over every channel the job appeared in (k = 60, the usual constant). */
export const rrf = (ch: Record<string, number | null>) => Object.values(ch).reduce<number>((a, r) => a + (r ? 1 / (60 + r) : 0), 0);
export function score3(x: SCand): number {
  const ret = Math.min(1, rrf(x.channels) / 0.06);   // ~ top-3 in four channels saturates
  const intent = x.agree === null ? 0.5 : Math.min(1, x.agree);
  return 0.3 * ANCHOR_W[x.anchors.status] + 0.25 * SCOPE_W[x.compat.verdict] + 0.25 * ret + 0.1 * intent + 0.1 * x.cover;
}
export type Cluster = { key: string; rep: SCand; members: string[]; score: number };
export function shortlist3(cands: SCand[], o: ShortOpts) {
  // 1. clusters of near-duplicates
  const byKey = new Map<string, SCand[]>(); for (const x of cands) { const k = `${x.employer.toLowerCase().trim()}|${normTitle(x.title)}`; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k)!.push(x); }
  const clusters: Cluster[] = [...byKey].map(([key, xs]) => { const s = xs.map((x) => ({ x, s: score3(x) })).sort((a, b) => b.s - a.s); return { key, rep: s[0].x, members: xs.map((x) => x.id), score: s[0].s }; });
  const ok = clusters.filter((c) => !hardMismatch(c.rep)).sort((a, b) => b.score - a.score);
  const chosen: Cluster[] = []; const perEmp = new Map<string, number>(); const emp = (c: Cluster) => c.rep.employer.toLowerCase().trim();
  const take = (c: Cluster) => { if (chosen.includes(c) || chosen.length >= o.size || (perEmp.get(emp(c)) ?? 0) >= o.perEmployerClusters) return; chosen.push(c); perEmp.set(emp(c), (perEmp.get(emp(c)) ?? 0) + 1); };
  // 2. each channel keeps its best few
  const chans = new Set(cands.flatMap((x) => Object.keys(x.channels)));
  for (const ch of chans) ok.filter((c) => c.rep.channels[ch]).sort((a, b) => a.rep.channels[ch]! - b.rep.channels[ch]!).slice(0, o.perChannel).forEach(take);
  // 3. fill by score
  for (const c of ok) take(c);
  return { chosen, clusters, held: clusters.filter((c) => hardMismatch(c.rep)).length };
}
