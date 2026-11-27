// Candidate Intelligence Record (CIR), offline lab code. The résumé read in code (the existing analysis: jobs, dates,
// years, level, specialisations shown) plus the candidate's confirmed intent, kept apart: what they have done never
// becomes what they want, and what they want never becomes evidence. Contact details are dropped from every text view.
import { analyse } from "../lib/career.js";
import { employment, unionYears } from "./v3/dates.js";
import { levelOf } from "../lib/usmatch.js";
import { transfer } from "../lib/ontology.js";
import { SPEC } from "../lib/ontology.js";
import type { Level } from "../lib/usmatch.js";

export const CIR_SCHEMA = "cir-1";
export type Intent = { primary: string; secondary: string | null; adjacent: boolean; transition: boolean; level: Level; years: number; domain: string | null; stretch: boolean; source: "simulated" | "candidate" };
export type CIR = {
  schema: typeof CIR_SCHEMA; id: string;
  done: { jobs: { title: string; from: number; to: number; spec: string | null }[]; years_read: number | null; years_basis: string; specs_shown: { id: string; p: number; evidence: string[] }[]; level_read: Level; fields: string[]; employment?: any };
  intent: Intent;
  views: { experience: string; skills: string; intent: string };
};

const PII = /@|\+?\d[\d\s-]{8,}\d|linkedin|github\.com|https?:|\b(address|d\/o|s\/o|date of birth|dob|marital|nationality|gender)\b/i;
const EDU = /\b(b\.?\s?tech|b\.?e\b|bachelor|master|m\.?\s?tech|mba|pgdm|b\.?\s?com|m\.?\s?com|university|college|school|cgpa|gpa|puc|class x|higher secondary)\b/i;
const HEAD_SKILLS = /^\s*(technical |key |core )?(skills|competenc|expertise|tools|technologies|proficienc)/i;
const HEAD_OTHER = /^\s*(education|languages?|interests|hobbies|certifications?|awards|achievements|personal|declaration|references|projects?)\b/i;
const HEAD_EXP = /^\s*(professional |work )?(experience|employment|career history|work history)/i;

/** opts.dates "v3": employment dates, years and level come from the V3 date reader (src/lab/v3/dates.ts); the frozen
 *  reader then sees a copy of the résumé whose employment ranges are in its own format, so titles and specialisations
 *  are read as before. Default (no opts): the original behaviour, unchanged, for the V2 development records. */
export function cir(id: string, resume: string, intent: Intent, now = new Date("2026-11-24"), opts: { dates?: string } = {}): CIR {
  const E = opts.dates === "v3" ? employment(resume, now) : null;
  const a = analyse(E ? E.canonical_text : resume, now);
  let v3: any = null;
  if (E) {
    const emp = E.intervals.filter((x) => x.counted);
    // each job the frozen reader found gets the V3 interval with the same start month; its own end-of-range arithmetic is replaced
    const key = (t: number) => Math.round(t * 12);
    for (const j of a.jobs) { const m = emp.find((x) => x.canon_key === key(j.from)); if (m) { j.from = m.from; j.to = m.to; } }
    const years = E.total_years; const titleLevel = a.jobs[0]?.title ? levelOf(a.jobs[0].title) : null;
    const level = titleLevel === "leader" && (years ?? 0) >= 8 ? "leader" : years === null ? "mid" : years < 2 ? "entry" : years < 6 ? "mid" : "senior";
    const targets = [intent.primary, intent.secondary].filter(Boolean) as string[]; const fnOf = (x: string) => (SPEC.get(x) as any)?.fn;
    const rel = a.jobs.filter((j) => j.spec && targets.some((t) => t === j.spec || fnOf(t) === fnOf(j.spec!) || transfer(t, j.spec!) >= 0.5));
    v3 = { years, basis: E.basis === "dated_roles" ? "dated" : E.basis === "stated" ? "stated" : "none", level,
      employment: { reader: "v3-dates/1", evaluated_at: E.evaluated_at, total_years: E.total_years, basis: E.basis, relevant_to_target_years: rel.length ? unionYears(rel).years : null, relevance_unknown_years: unionYears(a.jobs.filter((j) => !j.spec)).years,
        internship_years: E.internship_years, gaps: E.gaps, stated: E.stated, flags: E.flags, intervals: E.intervals } };
  }
  const lines = resume.split(/\r?\n/).map((l) => l.replace(/\s{3,}/g, " | ").replace(/[ \t]+/g, " ").trim()).filter(Boolean).filter((l) => !PII.test(l));
  // experience: what follows the experience heading (or everything), minus education and other sections; skills: the skills section
  let mode: "exp" | "skills" | "other" | "none" = "none"; const exp: string[] = [], skills: string[] = [];
  for (const l of lines) {
    if (HEAD_EXP.test(l)) { mode = "exp"; continue; } if (HEAD_SKILLS.test(l)) { mode = "skills"; continue; } if (HEAD_OTHER.test(l)) { mode = "other"; continue; }
    if (EDU.test(l)) continue;
    if (mode === "skills") skills.push(l); else if (mode === "exp" || mode === "none") exp.push(l);
  }
  const p = SPEC.get(intent.primary), s = intent.secondary ? SPEC.get(intent.secondary) : null;
  const intentText = [p && `${p.label}: ${p.sig.slice(0, 10).join(", ")}`, s && `${s.label}: ${s.sig.slice(0, 6).join(", ")}`].filter(Boolean).join(". ");
  return {
    schema: CIR_SCHEMA, id,
    done: { jobs: a.jobs.map((j) => ({ title: j.title, from: j.from, to: j.to, spec: j.spec })), years_read: v3 ? v3.years : a.years, years_basis: v3 ? v3.basis : a.yearsBy, specs_shown: a.specs, level_read: v3 ? v3.level : a.level, fields: a.fields, ...(v3 ? { employment: v3.employment } : {}) },
    intent,
    views: { experience: exp.join(". ").replace(/\s+/g, " ").slice(0, 2500), skills: (skills.join(", ") || a.specs.map((x) => SPEC.get(x.id)?.label).join(", ")).replace(/\s+/g, " ").slice(0, 1200), intent: intentText },
  };
}

/** The frozen simulated answers (sim2/answers.json) as an Intent. */
export function intentFrom(x: any): Intent {
  return { primary: x.direction_primary, secondary: x.direction_secondary && x.direction_secondary !== "none" ? x.direction_secondary : null, adjacent: x.open_to_adjacent === "yes", transition: x.transition === "yes", level: x.level, years: Number(x.years), domain: x.domain && x.domain !== "any" ? x.domain : null, stretch: x.stretch === "yes", source: "simulated" };
}
