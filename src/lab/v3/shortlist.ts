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

export const SHORTLIST3_VERSION = "s3.4";   // s3.4: a defining craft named in the title that the person has not worked in (and no neighbouring one) weighs 0.15; "neighbour" crafts 0.6 (27 Nov, after the pilot; synthetic fixtures).  s3.3: clusters split on requirement signature (27 Nov, synthetic fixtures); s3.2: per-channel quota 0, 8 clusters per employer (sweep on the 19 seen profiles)
export const DEFAULT_SHORT = { perChannel: 0, perEmployerClusters: 8 };
/** What must match for two same-title postings to be treated as one: a posting that differs in any of these is
 *  judged on its own. tools: the role-defining tools the posting asks for (generic terms excluded). */
export type Signature = { yearsBand: string; city: string; employment: string; manages: boolean; anchors: string; unit: string; tools: string[] };
export type SCand = { id: string; title: string; employer: string; channels: Record<string, number | null>; agree: number | null; compat: Compat; anchors: AnchorCheck; cover: number; sig?: Signature; reqHash?: string };
export const yearsBand = (y: number | null) => (y === null ? "unstated" : y <= 2 ? "0-2" : y <= 5 ? "3-5" : y <= 9 ? "6-9" : "10+");
export const EMPLOYMENT = (t: string) => (/\b(intern(ship)?|trainee|apprentice)\b/i.test(t) ? "internship" : /\b(contract(ual)?|fixed[- ]term|temporary|consultant on contract|freelance)\b/i.test(t) ? "contract" : /\bpart[- ]time\b/i.test(t) ? "part-time" : "full-time");
const jacc = (a: string[], b: string[]) => { if (!a.length && !b.length) return 1; const A = new Set(a), B = new Set(b); let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); };
/** Same cluster only if every signature field matches and the tool sets overlap by at least 60%. */
export function sameRequirements(a?: Signature, b?: Signature): boolean {
  if (!a || !b) return false;   // without a signature, never merge
  return a.yearsBand === b.yearsBand && a.city === b.city && a.employment === b.employment && a.manages === b.manages && a.anchors === b.anchors && a.unit === b.unit && jacc(a.tools, b.tools) >= 0.6;
}
export type ShortOpts = { size: number; perChannel: number; perEmployerClusters: number };
/** Near-duplicate key: the title's distinct words, order-free, without locations, codes and requisition numbers. */
export const normTitle = (t: string) => [...new Set(t.toLowerCase().replace(/\(.*?\)|\[.*?\]|r-?\d{4,}|\b\d{3,}\b/g, " ").replace(/[^a-z0-9+#&]+/g, " ").replace(/\b(bengaluru|bangalore|india|blr|karnataka|remote|hybrid|dm|in|the|and|of|for)\b/g, " ").split(/\s+/).filter(Boolean))].sort().join(" ");
const ANCHOR_W: Record<string, number> = { met: 1, partial: 0.7, neighbour: 0.6, claimed_only: 0.55, unrecognised: 0.5, none: 0.5, sibling_only: 0.15, missing: 0.3 };
/** The job's title itself names a craft from a family the person has not worked in, nor a neighbouring one: sharing
 *  an industry's words (an operations person and an accountant both write "reconciliation") must not carry it. */
export const MISSING_IN_TITLE_W = 0.15;
export const anchorWeight = (a: AnchorCheck) => (a.status === "missing" && a.detail.some((d) => d.status === "missing" && d.source === "title") ? MISSING_IN_TITLE_W : ANCHOR_W[a.status]);
const SCOPE_W: Record<string, number> = { fit: 1, below_mild: 0.8, step_up: 0.7, unknown: 0.6, too_far_up: 0.15, below: 0.1 };
/** Kept out of judging: scope clearly below or far above, or the person's recognised craft is a different sibling in
 *  the job's own family. A "missing" anchor only lowers the score (s3.3): the vocabulary may not know the person's
 *  words for it, so the judge reads the evidence. */
export const hardMismatch = (x: SCand) => x.compat.verdict === "below" || x.compat.verdict === "too_far_up" || x.anchors.status === "sibling_only";
/** Reciprocal-rank fusion over every channel the job appeared in (k = 60, the usual constant). */
export const rrf = (ch: Record<string, number | null>) => Object.values(ch).reduce<number>((a, r) => a + (r ? 1 / (60 + r) : 0), 0);
export function score3(x: SCand): number {
  const ret = Math.min(1, rrf(x.channels) / 0.06);   // ~ top-3 in four channels saturates
  const intent = x.agree === null ? 0.5 : Math.min(1, x.agree);
  return 0.3 * anchorWeight(x.anchors) + 0.25 * SCOPE_W[x.compat.verdict] + 0.25 * ret + 0.1 * intent + 0.1 * x.cover;
}
export type Cluster = { key: string; rep: SCand; members: string[]; score: number };
export function shortlist3(cands: SCand[], o: ShortOpts) {
  // 1. clusters of near-duplicates
  //    same employer + same title words is only a candidate group; inside it, postings merge only when their
  //    requirement signatures match (experience band, city, employment type, people management, defining anchors,
  //    business unit, tool set). Members are never displayed on the representative's verdict (see gate.present).
  const byKey = new Map<string, SCand[]>(); for (const x of cands) { const k = `${x.employer.toLowerCase().trim()}|${normTitle(x.title)}`; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k)!.push(x); }
  const clusters: Cluster[] = [];
  for (const [key, xs] of byKey) {
    const groups: SCand[][] = [];
    for (const x of xs.map((x) => ({ x, s: score3(x) })).sort((a, b) => b.s - a.s).map((z) => z.x)) { const g = groups.find((g) => sameRequirements(g[0].sig, x.sig)); if (g) g.push(x); else groups.push([x]); }
    groups.forEach((g, i) => clusters.push({ key: `${key}#${i}`, rep: g[0], members: g.map((x) => x.id), score: score3(g[0]) }));
  }
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
