// The fit number. One function, deterministic, used everywhere a number is shown: the preview, the target, the delivered
// document. The model decides the buckets (said / have_not_said / missing); this decides what they add up to. Nothing else
// produces a fit score.
//
// Rules (playbook, 28 Oct):
//   floor 8   — something always transfers; a tech résumé against a business role is in the 10s–20s, not 0
//   ceiling 97 — 100 only when every must-have is "said" with evidence
//   target   — after = current + (100 − current) × 0.4, at least +8, capped at 92; and never above what the résumé's
//              own material can reach (every have_not_said becomes said; missing stays missing)
import type { Match } from "./sharpen.js";

export const FLOOR = 8;
export const CEILING = 97;
export const TARGET_CAP = 92;
export const TARGET_RATE = 0.4;
export const MIN_LIFT = 8;

const W = { must: 2, nice: 1 } as const;
/** What a screener ticks for each bucket. A quoted line counts most; a keyword mention a little; missing nothing. */
const CREDIT = { said: 1, line: 0.5, keyword: 0.2, missing: 0 } as const;

function credit(m: Match): number {
  if (m.bucket === "said") return CREDIT.said;
  if (m.bucket === "have_not_said") return m.evidence_kind === "keyword" ? CREDIT.keyword : CREDIT.line;
  return CREDIT.missing;
}

/** The fit of a document as the buckets describe it. 8–97, integer. */
export function fit(matches: Match[]): number {
  let tot = 0, got = 0;
  for (const m of matches) { const w = W[m.kind] ?? 1; tot += w; got += w * credit(m); }
  if (!tot) return FLOOR;
  const raw = (got / tot) * 100;
  const everyMustSaid = matches.filter((m) => m.kind === "must").every((m) => m.bucket === "said");
  const cap = everyMustSaid && matches.every((m) => m.bucket !== "missing") ? 100 : CEILING;
  return Math.max(FLOOR, Math.min(cap, Math.round(raw)));
}

/** Sharpen v2 (audited promise) is on for everyone when SHARPEN_V2=on; a caller can also force it (the server self-test). */
export const v2On = (force?: boolean) => force ?? process.env.SHARPEN_V2 === "on";
/** Bumped whenever the matcher, the audit or the scorer changes meaning: cached previews from an older engine are not reused. */
export const ENGINE_VERSION = "v2.5";

/** The most a rewrite can reach from this résumé.
 *  v1: every have_not_said becomes said.
 *  v2: only an unsaid item whose proposed line was audited at preview as supported by the résumé AND satisfying the
 *      requirement (m.sayable) becomes said; everything else stays where it is; missing stays missing. */
export function reachable(matches: Match[], v2 = v2On()): number {
  return fit(matches.map((m) => (m.bucket === "have_not_said" && (!v2 || m.sayable) ? { ...m, bucket: "said" as const } : m)));
}

/** The number we promise before payment.
 *  v1: pro-rata lift (cur + 40% of the gap, at least +8), capped at 92 and by reachable.
 *  v2: exactly what the audited lines reach, capped at 92 — promised and delivered are the same calculation. */
export function target(matches: Match[], v2 = v2On()): number {
  if (v2) return Math.min(TARGET_CAP, reachable(matches, true));
  const cur = fit(matches);
  const want = Math.min(TARGET_CAP, Math.max(cur + MIN_LIFT, Math.round(cur + (100 - cur) * TARGET_RATE)));
  return Math.min(want, reachable(matches, false));
}

export type Band = "low" | "medium" | "high";
/** Three outcomes. Read from the honest number; never nudged across a line. */
export function band(cur: number): Band {
  return cur >= 90 ? "high" : cur >= 40 ? "medium" : "low";
}

/** Everything the fit page needs, in one place. */
export function assess(matches: Match[], v2 = v2On()) {
  const current = fit(matches);
  const max = reachable(matches, v2);
  const promised = target(matches, v2);
  const b = band(current);
  // Sharpen is offered only where the résumé's own material gives a real lift (v2: at least MIN_LIFT; v1: +5).
  // Medium with nothing unsaid (everything either said or missing) is honest to show and nothing to sell.
  // medium ALWAYS offers Sharpen (the promise may be modest; the user decides). high offers it only when something is left to say.
  const anySayable = matches.some((m) => m.bucket === "have_not_said" && (!v2 || m.sayable));
  const canLift = b === "medium" ? true : b === "high" ? anySayable && promised > current : false;
  return { current, promised, reachable: max, band: b, can_lift: canLift };
}
