// "Things we couldn't see": a requirement the résumé lacks, answered by the candidate in one line.
// The line is vetted (specific, relevant, written only from their words) before it moves the promise; it is then treated
// exactly like an audited line from the résumé — mandatory and verbatim in the document, counted only once it is said.
import { json, FAST } from "./claude.js";
import { reachable } from "./fit.js";
import type { Match, ResumeProfile } from "./sharpen.js";

export type Gap = { requirement: string; kind: "must" | "nice"; weight: number; why: string; options: string[]; told?: { text: string; line: string } };

const flip = (ms: Match[], req: string): Match[] => ms.map((m) => (m.requirement === req ? { ...m, bucket: "have_not_said" as const, sayable: true, told: true, line: m.line || "x" } : m));

/** The missing requirements as questions, must-haves first, at most five. weight = what the promise gains if this one is answered. */
export function gapsOf(matches: Match[]): Gap[] {
  const base = reachable(matches, true);
  const pool = matches.filter((m) => m.bucket === "missing" || m.told);
  pool.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "must" ? -1 : 1));
  // every missing requirement is asked, musts first — nothing is decided for the person by leaving one out
  return pool.map((m) => ({
    requirement: m.requirement, kind: m.kind,
    weight: m.told ? Math.max(0, base - reachable(matches.map((x) => (x.requirement === m.requirement ? { ...x, bucket: "missing" as const, told: false, sayable: false } : x)), true)) : Math.max(0, reachable(flip(matches, m.requirement), true) - base),
    why: m.suggestion || "",
    options: m.options ?? [],
    ...(m.told ? { told: { text: m.evidence, line: m.line ?? "" } } : {}),
  }));
}

const nums = (s: string) => new Set((s.match(/\d[\d,.]*%?/g) ?? []).map((x) => x.replace(/[\s,]/g, "").replace(/[.,]+$/, "")));

/** For each missing requirement, three honest ways a person could have done that thing — short clauses, no employer, no
 *  number, each a complete "what" the candidate can tap. Generated once per preview and kept on the match. */
export async function fillOptions(matches: Match[]): Promise<Match[]> {
  const need = matches.filter((m) => m.bucket === "missing" && !(m.options && m.options.length));
  if (!need.length) return matches;
  const r = await json<{ items: { id: number; options: string[] }[] }>(
    `For EACH numbered job requirement, write THREE short résumé clauses describing three different, realistic ways a candidate might genuinely have done it. Rules: each starts with a past-tense verb, 6–12 words, states the requirement's core activity in plain words, names NO employer, NO number and NO outcome (the candidate adds those). The three must differ in kind of involvement (e.g. owned it / partnered on it / built it), not in wording. Plain, specific, screener-readable. Answer every id.`,
    `REQUIREMENTS:\n${JSON.stringify(need.map((m, i) => ({ id: i + 1, requirement: m.requirement })))}\n\nReturn: {items:[{id, options:[a,b,c]}]}`,
    3000, FAST);   // enough for every missing requirement on a long posting (≈60 tokens per item)
  const by = new Map<string, string[]>();
  for (const it of r.items ?? []) { const m = need[Number(it.id) - 1]; if (m) by.set(m.requirement, (it.options ?? []).map((o) => String(o).trim().replace(/[.。]+$/, "")).filter(Boolean).slice(0, 3)); }
  return matches.map((m) => (by.has(m.requirement) ? { ...m, options: by.get(m.requirement) } : m));
}

export type Facts = { what: string; where?: string; when?: string; size?: string; unit?: string; free?: string };

/** The bullet, from the facts the candidate tapped. Deterministic: what they chose, where, when, how big. Nothing added. */
export function assembleLine(f: Facts): string {
  const what = (f.what || "").trim().replace(/[.。]+$/, "");
  const where = (f.where || "").trim(), when = (f.when || "").trim(), size = (f.size || "").trim(), unit = (f.unit || "").trim();
  let s = what.charAt(0).toUpperCase() + what.slice(1);
  if (where) s += ` at ${where}`;
  if (when) s += `, ${when}`;
  if (size) s += ` — ${size}${unit ? ` ${unit}` : ""}`;
  return s + ".";
}

/** "Say it my way": their words, shaped into one bullet. Never refused; never given a number they did not type. */
export async function shapeFree(requirement: string, text: string): Promise<string> {
  const t = text.trim().replace(/\s+/g, " ");
  const fallback = t.charAt(0).toUpperCase() + t.slice(1).replace(/[.。]+$/, "") + ".";
  if (t.split(" ").length < 4) return fallback;
  try {
    const r = await json<{ line: string }>(
      `Turn the candidate's statement into ONE résumé bullet for the given requirement: at most 26 words, starts with a past-tense verb, keeps every fact, number, employer and date exactly as given, adds nothing — no new number, tool, scope or outcome. If the statement is already a clean bullet, return it unchanged.`,
      `REQUIREMENT: ${requirement}\nSTATEMENT: ${t}\n\nReturn: {line}`, 300, FAST);
    const line = (r.line || "").trim();
    const given = nums(t);
    if (!line || [...nums(line)].some((n) => !given.has(n) && !/^(19|20)\d\d$/.test(n))) return fallback;
    return line;
  } catch { return fallback; }
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
