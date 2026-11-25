// A posting's kind of work, read in code against the ontology: its specialisation, function, level, the years it asks
// and its field. Made once per posting and kept. The title speaks first; the text decides when the title is generic
// ("Developer L3", "Custom Software Engineer", "Analyst"); a "Must have skills" line is the employer's own word for the
// specialisation and counts most.
import { SPECS, FUNCTIONS, FN, fieldsOf, type Spec } from "./ontology.js";
import { levelOf, type Level } from "./usmatch.js";

export type Tag = { spec: string | null; fn: string | null; conf: number; alt: { spec: string; s: number }[]; level: Level; fields: string[]; why: string };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// a signature word, matched whole: "java" is not "javascript", "c#" and ".net" keep their marks
const sigRe = (w: string) => new RegExp(`(?<![a-z0-9])${esc(w)}(?![a-z0-9])`, "i");
const SIG = new Map<string, RegExp[]>(SPECS.map((s) => [s.id, s.sig.map(sigRe)]));
/** A specialisation whose title words name only the function ("Software Engineer"): the text may overrule it. */
const GENERAL = new Set(["swe.general"]);

/** The specialisation's title rule on a title (its exclusion respected). */
export function titleNames(s: Spec, title: string): boolean { return !!s.title && s.title.test(title) && !(s.not && s.not.test(title)); }
/** How many of a specialisation's signature words a text carries. */
export function sigHits(id: string, text: string): number { let n = 0; for (const r of SIG.get(id) ?? []) if (r.test(text)) n++; return n; }

const MUST = /(must[- ]have skills?|primary skills?|mandatory skills?|key skills?|skills? required)\s*[:\-–]\s*([^\n]{3,200})/i;
const TITLE_W = 3.5, GENERAL_W = 2, FN_W = 1, SIG_W = 0.4, SIG_CAP = 6, MUST_W = 2.5;   // a title that names a specialisation outweighs the skills line; the skills line outweighs a generic title

/** Every specialisation's score for one title and text, best first. Exported for the résumé side and tests. */
export function scoreAll(title: string, text: string): { spec: string; s: number; t: boolean; h: number; m: boolean }[] {
  const body = text.slice(0, 15000), must = body.match(MUST)?.[2] ?? "";
  const fnHit = new Set(FUNCTIONS.filter((f) => f.generic && f.generic.test(title) && !(f.genericNot && f.genericNot.test(title))).map((f) => f.id));
  const out: { spec: string; s: number; t: boolean; h: number; m: boolean }[] = [];
  for (const s of SPECS) {
    const t = titleNames(s, title), h = Math.min(SIG_CAP, sigHits(s.id, body));
    const m = !!must && !GENERAL.has(s.id) && (titleNames(s, must) || sigHits(s.id, must) >= 1);
    const score = (t ? (GENERAL.has(s.id) ? GENERAL_W : TITLE_W) : 0) + (fnHit.has(s.fn) && !GENERAL.has(s.id) ? FN_W : 0) + SIG_W * h + (m ? MUST_W : 0);
    if (score > 0) out.push({ spec: s.id, s: Math.round(score * 100) / 100, t, h, m });
  }
  return out.sort((a, b) => b.s - a.s);
}

export const MIN_SCORE = 2;   // below this nothing names the work: the posting stays untagged rather than guessed…
const TEXT_ONLY = { score: 1.2, hits: 3, lead: 0.4 };   // …unless the text alone carries three of one specialisation's words and clearly more than any other
export function tagPosting(title: string, text: string): Tag {
  const all = scoreAll(title, text), top = all[0];
  const level = levelOf(title), fields = fieldsOf(text).slice(0, 2).map((f) => f.id);
  if (!top || (top.s < MIN_SCORE && !(top.s >= TEXT_ONLY.score && top.h >= TEXT_ONLY.hits && top.s - (all[1]?.s ?? 0) >= TEXT_ONLY.lead - 1e-9))) return { spec: null, fn: top && top.s >= 1 ? (FN.has(top.spec.split(".")[0]) ? top.spec.split(".")[0] : null) : null, conf: 0, alt: all.slice(0, 3).map(({ spec, s }) => ({ spec, s })), level, fields, why: "nothing names the work" };
  const second = all[1]?.s ?? 0, conf = Math.round(Math.min(1, (top.s - second) / 3 + top.s / 12) * 100) / 100;
  const spec = SPECS.find((s) => s.id === top.spec)!;
  const why = [top.t ? "title" : "", top.m ? "skills line" : "", top.h ? `${top.h} signature words` : ""].filter(Boolean).join(", ");
  return { spec: spec.id, fn: spec.fn, conf, alt: all.slice(1, 4).map(({ spec, s }) => ({ spec, s })), level, fields, why };
}
