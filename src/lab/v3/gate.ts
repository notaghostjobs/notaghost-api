// Matching v3, improvement 4: final recommendation controls. 0–5 strong recommendations, stretch kept separate, never
// padded. Hard mismatches (scope too far either way, a defining anchor missing or only a sibling craft, a verdict that
// contradicts its own checks) never reach the strong list, whatever the judge said. Pure function of its inputs.
import type { Compat } from "./scope.js";
import type { AnchorCheck } from "./anchors.js";

export const GATE3_VERSION = "g3v3.1";
export type V = { job_id: string; fit: string; function: string; specialisation: string; seniority: string; confidence: string; core: { status: string; resume_quote: string | null; job_quote: string; requirement: string }[]; why: string; failed?: string };
export type Ctx = { compat: Compat; anchors: AnchorCheck; eligible: boolean; employer: string; title: string };
export type Decision = { tier: "strong" | "stretch" | "rejected"; reasons: string[] };
export type GateOpts = { admitAdjacentMedium: boolean; requireAnchorForAdjacent: boolean; directStepUpMedium?: boolean };
export const DEFAULT_OPTS: GateOpts = { admitAdjacentMedium: true, requireAnchorForAdjacent: true, directStepUpMedium: true };   // g3v3.1, chosen on the 19 seen profiles (replay sweep)

const coreCounts = (v: V) => { const n = (s: string) => v.core.filter((k) => k.status === s).length; return { dem: n("demonstrated"), tr: n("transferable"), un: n("unverified"), gap: n("confirmed_gap"), all: v.core.length }; };

export function decide(v: V, x: Ctx, o: GateOpts = DEFAULT_OPTS): Decision {
  const r: string[] = [];
  if (!x.eligible) return { tier: "rejected", reasons: ["not eligible"] };
  if (v.failed) return { tier: "rejected", reasons: [`judge output failed validation: ${v.failed.split(":")[0]}`] };
  if (v.fit === "unsuitable" || v.fit === "cannot_judge") return { tier: "rejected", reasons: [`judged ${v.fit}`] };
  // hard mismatches: deterministic evidence overrides the judge
  if (x.compat.verdict === "too_far_up") return { tier: v.fit === "stretch" || v.fit === "adjacent" ? "stretch" : "stretch", reasons: ["scope: too far a step up", ...x.compat.reasons] };
  if (x.compat.verdict === "below") return { tier: "rejected", reasons: ["scope: below the person's demonstrated level", ...x.compat.reasons] };
  if (x.anchors.status === "missing") return { tier: "stretch", reasons: ["defining requirement not shown: " + x.anchors.detail.filter((d) => d.status === "missing").map((d) => d.label).join(", ")] };
  if (x.anchors.status === "sibling_only") return { tier: "stretch", reasons: ["different specialisation in the same field: " + x.anchors.detail.filter((d) => d.status === "sibling_only").map((d) => d.label).join(", ")] };
  if (v.fit === "stretch") return { tier: "stretch", reasons: ["judged stretch"] };
  const k = coreCounts(v);
  if (!k.all) return { tier: "stretch", reasons: ["no requirement checks"] };
  if (k.gap) return { tier: "rejected", reasons: ["confirmed gap in a mandatory requirement"] };
  if (k.dem < 1) return { tier: "stretch", reasons: ["no mandatory requirement demonstrated"] };
  if (v.function === "different") return { tier: "rejected", reasons: ["different function"] };
  if (v.fit === "direct") {
    if (v.specialisation === "different") return { tier: "stretch", reasons: ["direct, but a different specialisation"] };
    if (v.confidence === "low") return { tier: "stretch", reasons: ["low confidence"] };
    if (x.compat.verdict === "step_up" && v.confidence !== "high" && !o.directStepUpMedium) return { tier: "stretch", reasons: ["a step up, not at high confidence"] };
    if ((k.dem + k.tr) / k.all < 0.6 || k.un / k.all > 0.4) return { tier: "stretch", reasons: ["too few requirements shown"] };
    r.push("direct fit"); return { tier: "strong", reasons: r };
  }
  // adjacent: neighbouring craft or one step up, with strong transferable evidence
  if (v.function === "different" || v.seniority === "too_far") return { tier: "stretch", reasons: ["adjacent, but too far"] };
  if (v.confidence === "low") return { tier: "stretch", reasons: ["low confidence"] };
  if (v.confidence === "medium" && !o.admitAdjacentMedium) return { tier: "stretch", reasons: ["adjacent at medium confidence"] };
  if (o.requireAnchorForAdjacent && x.anchors.status !== "met") return { tier: "stretch", reasons: ["adjacent without a demonstrated defining requirement"] };
  if (x.compat.verdict !== "fit" && x.compat.verdict !== "below_mild") return { tier: "stretch", reasons: ["adjacent and a step up"] };
  if (k.dem / k.all < 0.5 || k.un / k.all > 0.25) return { tier: "stretch", reasons: ["adjacent with too little demonstrated"] };
  r.push(`adjacent fit (${v.confidence} confidence, anchors met, scope ${x.compat.verdict})`); return { tier: "strong", reasons: r };
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** At most `max` strong, one per employer+title, direct before adjacent; stretch listed separately; never padded. */
export function present(vs: V[], ctx: (id: string) => Ctx, max = 5, o: GateOpts = DEFAULT_OPTS) {
  const d = vs.map((v) => ({ v, x: ctx(v.job_id), d: decide(v, ctx(v.job_id), o) }));
  const seen = new Set<string>(); const strong: typeof d = [];
  for (const it of d.filter((z) => z.d.tier === "strong").sort((a, b) => (a.v.fit === "direct" ? 0 : 1) - (b.v.fit === "direct" ? 0 : 1) || (a.v.confidence === "high" ? 0 : 1) - (b.v.confidence === "high" ? 0 : 1))) {
    const key = `${it.x.employer.toLowerCase()}|${norm(it.x.title)}`; if (seen.has(key)) continue; seen.add(key); strong.push(it); if (strong.length >= max) break; }
  return { strong: strong.map((z) => ({ job_id: z.v.job_id, fit: z.v.fit, reasons: z.d.reasons, evidence: z.v.core.filter((k) => k.resume_quote && (k.status === "demonstrated" || k.status === "transferable")).slice(0, 2).map((k) => ({ job: k.job_quote, resume: k.resume_quote! })) })),
    stretch: d.filter((z) => z.d.tier === "stretch").map((z) => ({ job_id: z.v.job_id, reasons: z.d.reasons })).slice(0, 5),
    none_reason: strong.length ? null : "No sufficiently strong matches were established from the evidence.", decisions: d };
}
