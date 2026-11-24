// Free discovery: "roles in your line of work", found and ordered with no model call. A résumé is read in code (its own
// recent titles, its years, its distinctive words); every eligible posting is looked at through an index built once per
// posting (is it a posting; its level; the years it asks; the terms that mark it out); the best few are shown with the
// words that put them there. This is not a judgement of fit. Radar makes that.
import { titleFit, levelOf, near, LEVELS, type Level } from "./usmatch.js";
import { postingProblem, postingTerms, fitTo, resumeTerms, type Idf } from "./textfit.js";
import { bandGate, cityGate, languageGate } from "../radar/gates.js";

// ── the résumé, read in code ─────────────────────────────────────────────────────────────────────────────────────────
const ROLE = /\b(engineer|developer|programmer|architect|manager|analyst|consultant|specialist|executive|associate|officer|lead|head|director|president|designer|scientist|accountant|coordinator|administrator|advisor|strategist|recruiter|underwriter|auditor|controller|planner|buyer|merchandiser|trainer|writer|editor|marketer|founder|partner|owner|intern|trainee|sde|swe)\b/i;
const SCHOOL = /\b(b\.?\s?tech|b\.?\s?e\b|bachelor|master|m\.?\s?tech|mba|pgdm|b\.?\s?com|b\.?\s?sc|m\.?\s?sc|university|college|school|institute|cgpa|gpa|percentage|higher secondary|class x|icse|cbse|diploma|ph\.?d)\b/i;
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const RANGE = new RegExp(`(?:(${MONTH})\\s*[' ,]*)?((?:19|20)\\d{2}|'\\d{2})\\s*(?:-|–|—|to|till|until)\\s*(?:(present|current|now|till date|date|ongoing)|(?:(${MONTH})\\s*[' ,]*)?((?:19|20)\\d{2}|'\\d{2}))`, "gi");
const M: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const yr = (s: string) => (s.startsWith("'") ? 2000 + Number(s.slice(1)) : Number(s));

export type CodeProfile = { titles: string[]; years: number | null; level: Level; stated: boolean; dated: number };
const NOT_A_TITLE = /\b(summary|objective|skills?|expertise|seeking|experience in|responsible|professional with|years|highlights?|competenc|education|certification|achievement|award|languages?|interests?|declaration|references?|coursework|publications?)\b/i;
const VERB = /^(led|lead the|built|managed|developed|designed|worked|drove|owned|created|implemented|spearheaded|collaborated|partnered|handled|prepared|conducted|ensured|supported|delivered|achieved|improved|reduced|increased|appointed|recognized)\b/i;
const RANK_ONLY = /^(senior|sr|staff|principal|lead|junior|jr|associate|head|director|vp|chief|manager|deputy|asst|assistant|executive|consultant|specialist|officer|general|regional|zonal|area|team|group)$/;
const LEARNING = /\b(intern(ship)?|trainee|apprentice|research intern|student|volunteer|coordinator at)\b/i;
/** A line as a job title, or null: short, names a job, is not a sentence, a heading or a skills list. */
export function asTitle(raw: string): string | null {
  if (SCHOOL.test(raw) || /@|https?:|linkedin|\+91|\b\d{10}\b/i.test(raw)) return null;
  let t = raw.replace(RANGE, " ").replace(new RegExp(`\\b${MONTH}\\b`, "gi"), " ").replace(/\b(19|20)\d{2}\b|'\d{2}\b|\b(present|current|till date)\b/gi, " ");
  t = t.replace(/^\s*(designation|role|position|title)\s*[:\-–]\s*/i, "").replace(/[()]/g, " | ");
  // a line is often "Employer - Title | place": the title is the first piece that names a job. A piece that is only a
  // rank ("Deputy Manager", "Asst Manager") takes the piece after it, which says what the work is.
  const pieces = t.split(/\s[|•·—–@]\s|\s-\s| at |,|;|\t| {3,}|\s\|\s|\|/).map((x) => x.replace(/[[\]:*●◦▪]+/g, " ").replace(/^[^A-Za-z]+/, "").replace(/[^A-Za-z+#./& -]+$/, "").replace(/\s+/g, " ").trim()).filter(Boolean);
  const i = pieces.findIndex((x) => ROLE.test(x) && x.split(" ").length <= 6); if (i < 0) return null;
  t = pieces[i]; const rankOnly = (x: string) => x.toLowerCase().split(/[ .]+/).filter(Boolean).every((w) => RANK_ONLY.test(w));
  if (rankOnly(t) && pieces[i + 1] && pieces[i + 1].split(" ").length <= 5 && !NOT_A_TITLE.test(pieces[i + 1]) && !/\b(ltd|limited|pvt|inc|bank|services|technologies|solutions)\b/i.test(pieces[i + 1])) t = `${t} ${pieces[i + 1]}`;
  const words = t.split(" ");
  if (!ROLE.test(t) || words.length > 9 || t.length < 4 || /[.!?]\s/.test(t) || /[.!?]$/.test(raw.trim())) return null;
  if (VERB.test(t) || NOT_A_TITLE.test(t) || (t === t.toUpperCase() && words.length > 8)) return null;
  if (/\s(&|and)\s/i.test(t) && words.length >= 3) return null;            // "Building & Executive Leadership": a list of strengths, not a job
  return t;
}
/** The person's own recent job titles, their years of work and a level, from the text alone.
 *  Jobs are found by their dates: a date range on a line, with the title on that line or the one beside it. Education,
 *  internships and projects are not jobs. Years: what the résumé states ("8+ years of experience") when it does, otherwise
 *  from the first job's start to the last job's end. Titles: the most recent jobs first. A résumé with no dated jobs
 *  falls back to a title in its heading. */
export function codeProfile(resume: string, now = new Date()): CodeProfile {
  const lines = resume.split(/\r?\n/).map((l) => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean);
  const today = now.getFullYear() + now.getMonth() / 12; const jobs: { title: string; from: number; to: number }[] = [], spans: { from: number; to: number }[] = [];
  lines.forEach((l, i) => {
    if (SCHOOL.test(l)) return;
    for (const m of l.matchAll(RANGE)) {
      const from = yr(m[2]) + (m[1] ? M[m[1].slice(0, 3).toLowerCase()] ?? 0 : 0) / 12;
      const to = m[3] ? today : yr(m[5]!) + (m[4] ? M[m[4].slice(0, 3).toLowerCase()] ?? 11 : 11) / 12;
      if (!(from >= 1980 && to >= from && to <= today + 1)) continue;
      const here = [l, lines[i - 1] ?? "", lines[i + 1] ?? ""]; if (here.slice(0, 2).some((x) => LEARNING.test(x))) continue;
      spans.push({ from, to });                                         // a dated line that is not study or an internship counts toward the years, title found or not
      const title = here.map(asTitle).find(Boolean); if (title && !LEARNING.test(title)) jobs.push({ title, from, to });
    }
  });
  let years: number | null = null, stated = false;
  const said = resume.slice(0, 2500).match(/(\d{1,2})(?:\.\d)?\s*\+?\s*(?:years|yrs)\b[^.\n]{0,40}\b(?:experience|exp\b)|(?:experience|exp)[^.\n]{0,25}?(\d{1,2})(?:\.\d)?\s*\+?\s*(?:years|yrs)/i);
  if (said) { years = Number(said[1] ?? said[2]); stated = true; }
  else if (spans.length) years = Math.round((Math.max(...spans.map((j) => j.to)) - Math.min(...spans.map((j) => j.from))) * 10) / 10;
  const titles: string[] = [];
  for (const j of [...jobs].sort((a, b) => b.to - a.to || b.from - a.from)) { if (titles.length >= 3) break; if (!titles.some((x) => x.toLowerCase() === j.title.toLowerCase())) titles.push(j.title); }
  if (!titles.length) for (const l of lines.slice(0, 8)) { const t = asTitle(l); if (t && !LEARNING.test(t)) { titles.push(t); break; } }
  // level: a leader's title says so; otherwise the years
  const top = titles.slice(0, 2).map((t) => levelOf(t));
  const byYears: Level = years === null ? "mid" : years < 2 ? "entry" : years < 6 ? "mid" : "senior";
  const level: Level = top.includes("leader") && (years === null || years >= 8) ? "leader" : byYears;
  return { titles, years, level, stated, dated: jobs.length };
}

// ── the index: one entry per posting, made once ──────────────────────────────────────────────────────────────────────
export type Entry = { id: string; title: string; employer: string; level: Level; text: string; marked: { w: string; x: number }[] };
/** One posting's entry, or the reason it has none. No model. `title` is the cleaned title. */
export function entryFor(p: { id: string | number; title: string; employer: string; description: string | null }, idf: Idf): { entry: Entry | null; problem: string | null } {
  const v = postingProblem(p.title, p.description); if (v.problem) return { entry: null, problem: v.problem };
  const lv = levelOf(p.title);
  return { entry: { id: String(p.id), title: p.title, employer: p.employer, level: (LEVELS as readonly string[]).includes(lv) ? (lv as Level) : "mid", text: v.text, marked: postingTerms(v.text, idf) }, problem: null };
}

// ── the search ───────────────────────────────────────────────────────────────────────────────────────────────────────
export type Found = { id: string; title: string; employer: string; score: number; fit: number; titleFit: number; shared: string[] };
export const MIN_FIT = 0.3;          // below this the résumé and the posting share too little that is specific
export const TITLE_HELP = 0.5;       // how much a title like one of the person's own adds
/** Every entry the person could act on, best first. Left out, with the reason counted in `why`: a level too far from
 *  theirs, a years band they are outside (Radar's own rule), a title naming another city, a language the résumé lacks,
 *  and anything sharing too little with the résumé. Nothing here calls a role suitable. */
export function search(resume: string, index: Entry[], idf: Idf, profile = codeProfile(resume)): { found: Found[]; why: Record<string, number>; profile: CodeProfile } {
  const mine = resumeTerms(resume, idf), levels = near(profile.level), why: Record<string, number> = {}; const out: Found[] = [];
  const no = (k: string) => { why[k] = (why[k] ?? 0) + 1; };
  for (const e of index) {
    const f = fitTo(mine, e.marked), tf = profile.titles.length ? titleFit(e.title, profile.titles) : 0;
    if (f.fit < MIN_FIT && !(tf >= 0.6 && f.fit >= MIN_FIT / 2)) { no("shares too little"); continue; }
    if (!levels.includes(e.level)) { no("level too far"); continue; }
    if (cityGate(e.title)) { no("another city"); continue; }
    if (profile.years && bandGate(profile.years, e.text, e.title)) { no("years asked"); continue; }
    if (languageGate(e.text, resume)) { no("language"); continue; }
    out.push({ id: e.id, title: e.title, employer: e.employer, fit: f.fit, titleFit: tf, score: f.fit + TITLE_HELP * tf + (e.level === profile.level ? 0.05 : 0), shared: f.shared });
  }
  return { found: out.sort((a, b) => b.score - a.score), why, profile };
}
/** The previews: best first, a title at an employer once, at most `perEmployer` from one employer, at most `keep`. */
export function previews(found: Found[], keep = 5, perEmployer = 1): Found[] {
  const per = new Map<string, number>(), seen = new Set<string>(), out: Found[] = [];
  for (const f of found) {
    const emp = f.employer.toLowerCase(), k = `${emp}|${f.title.toLowerCase()}`; if (seen.has(k)) continue; seen.add(k);
    if ((per.get(emp) ?? 0) >= perEmployer) continue; per.set(emp, (per.get(emp) ?? 0) + 1); out.push(f); if (out.length >= keep) break;
  }
  return out;
}
