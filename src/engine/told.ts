// "Things we couldn't see": a requirement the résumé lacks, answered by the candidate in one line.
// The line is vetted (specific, relevant, written only from their words) before it moves the promise; it is then treated
// exactly like an audited line from the résumé — mandatory and verbatim in the document, counted only once it is said.
import { json, FAST } from "./claude.js";
import { reachable } from "./fit.js";
import type { Match, ResumeProfile } from "./sharpen.js";

export type Gap = { requirement: string; kind: "must" | "nice"; weight: number; why: string; told?: { text: string; line: string } };

const flip = (ms: Match[], req: string): Match[] => ms.map((m) => (m.requirement === req ? { ...m, bucket: "have_not_said" as const, sayable: true, told: true, line: m.line || "x" } : m));

/** The missing requirements as questions, must-haves first, at most five. weight = what the promise gains if this one is answered. */
export function gapsOf(matches: Match[]): Gap[] {
  const base = reachable(matches, true);
  const pool = matches.filter((m) => m.bucket === "missing" || m.told);
  pool.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "must" ? -1 : 1));
  return pool.slice(0, 5).map((m) => ({
    requirement: m.requirement, kind: m.kind,
    weight: m.told ? Math.max(0, base - reachable(matches.map((x) => (x.requirement === m.requirement ? { ...x, bucket: "missing" as const, told: false, sayable: false } : x)), true)) : Math.max(0, reachable(flip(matches, m.requirement), true) - base),
    why: m.suggestion || "",
    ...(m.told ? { told: { text: m.evidence, line: m.line ?? "" } } : {}),
  }));
}

const nums = (s: string) => new Set((s.match(/\d[\d,.]*%?/g) ?? []).map((x) => x.replace(/[\s,]/g, "").replace(/[.,]+$/, "")));

/** Vets one typed answer. ok → a bullet built only from the candidate's words. */
export async function vetAnswer(resume: ResumeProfile, requirement: string, text: string): Promise<{ ok: boolean; reason?: string; line?: string }> {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.split(" ").length < 6) return { ok: false, reason: "Add where and when, and one number — a screener will ask." };
  const r = await json<{ ok: boolean; reason: string; line: string }>(
    `A candidate typed one statement about themselves as proof for a job requirement their résumé did not show. Judge it the way a fair screener would, then write it down.
specific: it names WHERE (an employer, team, market or product) or WHEN (a year or period), AND gives at least one concrete number or named thing. "Yes, lots" or "I have done this" is not specific.
relevant: it is this requirement's core activity, not something adjacent.
If both hold: ok=true and line = one résumé bullet, at most 28 words, starting with a verb, built ONLY from facts in the statement — no new number, tool, scope, employer or outcome; you may drop words, never add them. Keep the candidate's numbers exactly.
Otherwise ok=false and reason = one plain sentence to the candidate saying what is missing (where or when, a number, or that it does not answer this requirement). Never lecture; never mention policy.`,
    `REQUIREMENT: ${requirement}\n\nCANDIDATE'S STATEMENT: ${t}\n\nRÉSUMÉ (for context only — the statement must stand on its own): ${JSON.stringify({ roles: resume.roles.map((r) => ({ company: r.company, title: r.title, start: r.start, end: r.end })) })}\n\nReturn: {ok, reason, line}`,
    800, FAST);
  if (!r.ok) return { ok: false, reason: (r.reason || "Add where and when, and one number — a screener will ask.").slice(0, 200) };
  let line = (r.line || "").trim();
  // the bullet may not carry a number the candidate did not type; if it does, their own sentence is the bullet
  const given = nums(t);
  if (!line || [...nums(line)].some((n) => !given.has(n) && !/^(19|20)\d\d$/.test(n))) line = t.charAt(0).toUpperCase() + t.slice(1).replace(/[.。]+$/, "") + ".";
  return { ok: true, line };
}

/** Writes an accepted answer into the match list: the missing item becomes a sayable, told line. */
export function acceptInto(matches: Match[], requirement: string, text: string, line: string): Match[] {
  return matches.map((m) => (m.requirement === requirement ? { ...m, bucket: "have_not_said" as const, evidence: text.trim(), evidence_kind: "line" as const, line, sayable: true, told: true, vet_reason: "told · vetted answer" } : m));
}
/** Takes an answer back out: the item is missing again. */
export function withdrawFrom(matches: Match[], requirement: string): Match[] {
  return matches.map((m) => (m.requirement === requirement && m.told ? { ...m, bucket: "missing" as const, evidence: "", line: undefined, sayable: false, told: false, vet_reason: undefined } : m));
}
/** The facts the candidate added, as the auditors must see them: part of the original. */
export function addedFacts(matches: Match[]): { requirement: string; fact: string }[] {
  return matches.filter((m) => m.told && m.evidence).map((m) => ({ requirement: m.requirement, fact: m.evidence }));
}
