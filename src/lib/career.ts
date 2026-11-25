// Adaptive career intelligence, offline: a résumé read in code against the ontology, the doubts that reading leaves,
// the questions that could settle them, and the choice of which question to ask by how much it is expected to improve
// the roles shown. No model call anywhere. Not wired to any route.
//
// Pieces, in the order a visitor meets them:
//   analyse(resume)            → the first reading: specialisations with weights, years, level, field, named doubts
//   questions(analysis)        → every question that could be asked of this person, with its options
//   Belief                     → what the system believes the person wants; each answer updates it
//   rank(belief, pool)         → previews and the ordered list, from the posting tags
//   quality(list, belief)      → how good a list is for what the person wants: kind of work × level
//   nextQuestion(...)          → expected value of information on quality; the mandatory direction confirmation
import { SPECS, SPEC, FN, FUNCTIONS, transfer, fieldsOf, FIELDS } from "./ontology.js";
import { scoreAll, titleNames } from "./tagger.js";
import { asTitle } from "./discover.js";
import { levelOf, near, LEVELS, titleFit, type Level } from "./usmatch.js";

// ── 1. the first reading ─────────────────────────────────────────────────────────────────────────────────────────────
const SCHOOL = /\b(b\.?\s?tech|b\.?\s?e\b|bachelor|master|m\.?\s?tech|mba|pgdm|b\.?\s?com|b\.?\s?sc|m\.?\s?sc|university|college|school|institute|cgpa|gpa|percentage|higher secondary|class x|icse|cbse|diploma|ph\.?d)\b/i;
const LEARNING = /\b(intern(ship)?|trainee|apprentice|student|volunteer)\b/i;
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const RANGE = new RegExp(`(?:(${MONTH})\\s*[' ,]*)?((?:19|20)\\d{2}|'\\d{2})\\s*(?:-|–|—|to|till|until)\\s*(?:(present|current|now|till date|date|ongoing)|(?:(${MONTH})\\s*[' ,]*)?((?:19|20)\\d{2}|'\\d{2}))`, "gi");
const MI: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const yr = (s: string) => (s.startsWith("'") ? 2000 + Number(s.slice(1)) : Number(s));
/** What the person says they want, in their own summary or objective: "seeking a role in product management". */
const INTENT = /\b(seeking|looking (for|to)|aspir\w*|aim(ing)? to|want(ing)? to|transition\w*|move into|pivot\w*|career change|switch\w* (to|into)|interested in (a )?(role|career|position)s? (in|as))\b/i;

export type Job = { title: string; from: number; to: number; spec: string | null };
export type Doubt = { kind: "split" | "diffuse" | "direction" | "level" | "years" | "gap" | "field" | "none_named"; detail: string };
export type Analysis = {
  specs: { id: string; p: number; evidence: string[] }[];   // what the résumé shows, weighted; never what the person wants
  jobs: Job[]; years: number | null; yearsBy: "stated" | "dated" | "none"; worked: number | null;
  level: Level; field: string | null; fields: string[]; intent: string | null; intentLine: string | null; doubts: Doubt[];
};

function jobsOf(lines: string[], today: number): Job[] {
  const jobs: Job[] = [];
  lines.forEach((l, i) => {
    if (SCHOOL.test(l)) return;
    for (const m of l.matchAll(RANGE)) {
      const from = yr(m[2]) + (m[1] ? MI[m[1].slice(0, 3).toLowerCase()] ?? 0 : 0) / 12;
      const to = m[3] ? today : yr(m[5]!) + (m[4] ? MI[m[4].slice(0, 3).toLowerCase()] ?? 11 : 11) / 12;
      if (!(from >= 1980 && to >= from && to <= today + 1)) continue;
      const here = [l, lines[i - 1] ?? "", lines[i + 1] ?? ""]; if (here.slice(0, 2).some((x) => LEARNING.test(x))) continue;
      const title = here.map(asTitle).find(Boolean) ?? "";
      if (title && LEARNING.test(title)) continue;
      jobs.push({ title, from, to, spec: null });
    }
  });
  // one job per (title, start): a date range repeated on two lines is one job
  const seen = new Set<string>(); return jobs.filter((j) => { const k = `${j.title}|${j.from.toFixed(2)}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => b.to - a.to || b.from - a.from);
}
/** Years actually worked: the union of the job intervals, so overlapping jobs and gaps are not counted twice or at all. */
function union(jobs: Job[]): number {
  const iv = jobs.map((j) => [j.from, j.to]).sort((a, b) => a[0] - b[0]); let tot = 0, s = -1, e = -1;
  for (const [a, b] of iv) { if (a > e) { if (e > s) tot += e - s; s = a; e = b; } else e = Math.max(e, b); }
  if (e > s) tot += e - s; return Math.round(tot * 10) / 10;
}
const LEVEL_OF_YEARS = (y: number | null): Level => (y === null ? "mid" : y < 2 ? "entry" : y < 6 ? "mid" : "senior");
const SOFT = 1.1;   // how sharply evidence turns into weights

export function analyse(resume: string, now = new Date()): Analysis {
  const lines = resume.split(/\r?\n/).map((l) => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean);
  const today = now.getFullYear() + now.getMonth() / 12;
  const jobs = jobsOf(lines, today);
  // evidence per specialisation: a job title that names it (weighted by recency and length), and the résumé's words
  const raw = new Map<string, { s: number; ev: string[] }>();
  const add = (id: string, s: number, ev: string) => { const x = raw.get(id) ?? { s: 0, ev: [] }; x.s += s; if (ev && x.ev.length < 3 && !x.ev.includes(ev)) x.ev.push(ev); raw.set(id, x); };
  jobs.forEach((j, i) => {
    if (!j.title) return;
    const recency = i === 0 ? 1 : i === 1 ? 0.7 : i === 2 ? 0.5 : 0.3, length = Math.min(1.5, 0.5 + (j.to - j.from) / 4);
    const hits = SPECS.filter((s) => titleNames(s, j.title));
    if (hits.length) { j.spec = hits[0].id; for (const s of hits) add(s.id, (s.id === "swe.general" ? 1.5 : 3) * recency * length / hits.length, j.title); }
  });
  if (!jobs.some((j) => j.title)) for (const l of lines.slice(0, 8)) { const t = asTitle(l); if (t) { for (const s of SPECS.filter((x) => titleNames(x, t))) add(s.id, 2, t); break; } }
  for (const x of scoreAll("", resume.slice(0, 14000)).filter((x) => x.h >= 2)) add(x.spec, 0.35 * x.h, `${x.h} of its skill words`);
  const ranked = [...raw.entries()].sort((a, b) => b[1].s - a[1].s).slice(0, 8);
  const z = ranked.reduce((a, [, v]) => a + Math.exp(v.s / SOFT), 0);
  const specs = ranked.map(([id, v]) => ({ id, p: Math.round((Math.exp(v.s / SOFT) / z) * 1000) / 1000, evidence: v.ev }));

  // years: stated, else from the dates; and what the dates actually add up to
  const said = resume.slice(0, 2500).match(/(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years|yrs)\b[^.\n]{0,40}\b(?:experience|exp\b)|(?:experience|exp)[^.\n]{0,25}?(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years|yrs)/i);
  const worked = jobs.length ? union(jobs) : null;
  let years: number | null = null, yearsBy: Analysis["yearsBy"] = "none";
  if (said) { years = Number(said[1] ?? said[2]); yearsBy = "stated"; } else if (worked !== null) { years = worked; yearsBy = "dated"; }
  const titleLevel = jobs[0]?.title ? levelOf(jobs[0].title) : null;
  const level: Level = titleLevel === "leader" && (years ?? 0) >= 8 ? "leader" : LEVEL_OF_YEARS(years);
  const fl = fieldsOf(resume); const field = fl[0] && fl[0].n >= 4 ? fl[0].id : null;

  // what they say they want
  let intent: string | null = null, intentLine: string | null = null;
  for (const l of lines.slice(0, 40)) {
    if (!INTENT.test(l) || l.length > 400) continue;
    const s = scoreAll(l, "").find((x) => x.t && x.spec !== "swe.general");
    if (s) { intent = s.spec; intentLine = l.slice(0, 160); break; }
  }

  // the doubts, each named
  const doubts: Doubt[] = [];
  const [a, b] = specs;
  if (a && b && SPEC.get(a.id)!.fn !== SPEC.get(b.id)!.fn && b.p / a.p > 0.5 && transfer(a.id, b.id) < 0.5) doubts.push({ kind: "split", detail: `${SPEC.get(a.id)!.label} (${a.p}) or ${SPEC.get(b.id)!.label} (${b.p})` });
  if (!a || a.p < 0.4) doubts.push({ kind: "diffuse", detail: a ? `no clear lead: ${specs.slice(0, 3).map((s) => `${s.id} ${s.p}`).join(", ")}` : "no work named" });
  const recentFn = jobs[0]?.spec ? SPEC.get(jobs[0].spec)!.fn : null, earlier = jobs.slice(1).filter((j) => j.spec).map((j) => SPEC.get(j.spec!)!.fn);
  if (intent && a && transfer(a.id, intent) < 0.5) doubts.push({ kind: "direction", detail: `résumé shows ${a.id}; says it wants ${intent}: "${intentLine}"` });
  else if (recentFn && earlier.length >= 2 && earlier.every((f) => f !== recentFn)) doubts.push({ kind: "direction", detail: `latest job is ${jobs[0].spec}; earlier jobs were ${[...new Set(earlier)].join(", ")}` });
  if (years === null) doubts.push({ kind: "years", detail: "no years found" });
  else if (yearsBy === "stated" && worked !== null && Math.abs(years - worked) > 2) doubts.push({ kind: "years", detail: `states ${years}; dated jobs add up to ${worked}` });
  else if (yearsBy === "dated" && jobs.length && (Math.max(...jobs.map((j) => j.to)) - Math.min(...jobs.map((j) => j.from))) - (worked ?? 0) > 1.5) doubts.push({ kind: "years", detail: `dates span more than the ${worked} years the jobs add up to` });
  if ((years ?? 0) >= 6 && titleLevel !== "leader" && !/\b(manager|lead|head)\b/i.test(jobs[0]?.title ?? "") && /\b(led|managed|mentor\w*|team of \d+|reporting to me|direct reports)\b/i.test(resume)) doubts.push({ kind: "level", detail: `${years} years; leads people in the text but the title does not say a level` });
  if (jobs[0] && today - jobs[0].to > 0.6) doubts.push({ kind: "gap", detail: `last job ended ${(today - jobs[0].to).toFixed(1)} years ago` });
  if (field) doubts.push({ kind: "field", detail: `résumé is mostly in ${field}` });
  return { specs, jobs, years, yearsBy, worked, level, field, fields: fl.slice(0, 3).map((f) => f.id), intent, intentLine, doubts };
}

// ── 2. belief: what the system takes the person to want ─────────────────────────────────────────────────────────────
export type Belief = { want: Map<string, number>; level: Level; years: number | null; field: string | null; stretch: boolean; move: boolean };
export function firstBelief(a: Analysis): Belief {
  const want = new Map<string, number>(); for (const s of a.specs) want.set(s.id, s.p);
  return { want, level: a.level, years: a.years, field: null, stretch: false, move: false };
}
const norm = (m: Map<string, number>) => { const z = [...m.values()].reduce((x, y) => x + y, 0) || 1; for (const [k, v] of m) m.set(k, v / z); return m; };

// ── 3. questions: every one that could be asked of this person, with what each answer does ───────────────────────────
export type Option = { key: string; label: string; taps: number; apply: (b: Belief) => Belief; p: (b: Belief) => number };
export type Question = { id: string; family: "direction" | "split" | "level" | "years" | "field" | "stretch"; text: string; options: Option[]; settlesDirection: boolean };
const clone = (b: Belief): Belief => ({ ...b, want: new Map(b.want) });
const LEVEL_WORDS: Record<Level, string> = { intern: "An internship", entry: "Entry level or associate", mid: "Experienced individual contributor", senior: "Senior, lead or manager", leader: "Head, director or above" };
const YEAR_BANDS = [{ key: "y0", label: "Under 2 years", v: 1 }, { key: "y2", label: "2 to 5 years", v: 3.5 }, { key: "y5", label: "5 to 8 years", v: 6.5 }, { key: "y8", label: "8 to 12 years", v: 10 }, { key: "y12", label: "More than 12 years", v: 14 }];
const bandOfYears = (y: number | null) => (y === null ? null : YEAR_BANDS.find((b, i) => y < (YEAR_BANDS[i + 1]?.v ?? 99) - (i + 1 < YEAR_BANDS.length ? (YEAR_BANDS[i + 1].v - b.v) / 2 : 0))?.key ?? "y12");
/** Specialisation options for a want question: the person's own, then their strongest neighbours. At most four, plus
 *  "something else" and "changing careers", which open the ontology's plain list (two taps). */
function specOptions(a: Analysis, b: Belief, around: string | null): string[] {
  const own = [...b.want.entries()].sort((x, y) => y[1] - x[1]).map(([k]) => k);
  const nb = around ? Object.entries(SPEC.get(around)!.near).sort((x, y) => y[1] - x[1]).map(([k]) => k) : [];
  const out: string[] = []; for (const k of [...own, ...nb]) if (!out.includes(k) && out.length < 4) out.push(k);
  return out;
}
const setWant = (id: string, move = false) => (b: Belief) => { const c = clone(b); c.want = new Map([[id, 1]]); c.move = move; return c; };
const otherOptions = (): Option[] => [
  { key: "else", label: "Something else (choose from the list)", taps: 2, apply: (b) => b, p: () => 0.04 },
  { key: "change", label: "I'm changing careers (choose where to)", taps: 2, apply: (b) => ({ ...clone(b), move: true }), p: () => 0.02 },
];
/** Options keyed "spec:<id>" pick that specialisation; "else:<id>" and "change:<id>" are the two-tap answers, built at answer time. */
export function pickOption(q: Question, key: string): Option | null {
  const o = q.options.find((x) => x.key === key); if (o) return o;
  const m = key.match(/^(else|change):(.+)$/); if (!m || !SPEC.has(m[2])) return null;
  return { key, label: SPEC.get(m[2])!.label, taps: 2, apply: setWant(m[2], m[1] === "change"), p: () => 0 };
}

export function questions(a: Analysis): Question[] {
  const b0 = firstBelief(a), top = a.specs[0]?.id ?? null, qs: Question[] = [];
  // the mandatory one: confirm the direction in one tap
  if (top) {
    const alts = specOptions(a, b0, top).filter((k) => k !== top).slice(0, 3);
    qs.push({ id: "direction", family: "direction", settlesDirection: true, text: `Keep looking for ${SPEC.get(top)!.label.toLowerCase()} roles?`, options: [
      { key: `spec:${top}`, label: "Yes", taps: 1, apply: setWant(top), p: (b) => (b.want.get(top) ?? 0) * 0.85 + 0.1 },
      ...alts.map((k) => ({ key: `spec:${k}`, label: `Closer to ${SPEC.get(k)!.label.toLowerCase()}`, taps: 1, apply: setWant(k), p: (b: Belief) => (b.want.get(k) ?? 0) * 0.85 + 0.02 })),
      ...otherOptions()] });
  } else {
    qs.push({ id: "direction", family: "direction", settlesDirection: true, text: "What kind of work do you want next?", options: otherOptions() });
  }
  // split, diffuse or change of direction: "which do you want more of?"; it also settles the direction
  const d = a.doubts.find((x) => x.kind === "split" || x.kind === "diffuse" || x.kind === "direction");
  if (d && a.specs.length >= 2) {
    const opts = a.intent ? [...new Set([a.specs[0].id, a.intent, ...a.specs.slice(1, 3).map((s) => s.id)])].slice(0, 4) : a.specs.slice(0, 4).map((s) => s.id);
    qs.push({ id: "split", family: "split", settlesDirection: true, text: d.kind === "direction" ? `Do you want to stay in ${SPEC.get(a.specs[0].id)!.label.toLowerCase()} or move toward something else?` : "Which part of your work do you want more of?", options: [
      ...opts.map((k) => ({ key: `spec:${k}`, label: SPEC.get(k)!.label, taps: 1, apply: setWant(k, k === a.intent && transfer(a.specs[0].id, k) < 0.5), p: (b: Belief) => (b.want.get(k) ?? 0) + (k === a.intent ? 0.3 : 0) })),
      ...otherOptions()] });
  }
  // level
  qs.push({ id: "level", family: "level", settlesDirection: false, text: "Which level of role are you aiming for?", options: (["entry", "mid", "senior", "leader"] as Level[]).map((l) => ({ key: `level:${l}`, label: LEVEL_WORDS[l], taps: 1, apply: (b: Belief) => ({ ...clone(b), level: l }), p: (b: Belief) => (l === b.level ? 0.6 : near(b.level).includes(l) ? 0.2 : 0.02) })) });
  // years: a one-tap correction of the first reading
  qs.push({ id: "years", family: "years", settlesDirection: false, text: a.years === null ? "How many years have you worked full-time?" : `We read about ${a.years} years of work. Is that right?`, options: YEAR_BANDS.map((y) => ({ key: `years:${y.key}`, label: y.label, taps: 1, apply: (b: Belief) => ({ ...clone(b), years: y.v, level: LEVEL_OF_YEARS(y.v) === "senior" && b.level === "leader" ? "leader" : b.level }), p: (b: Belief) => (bandOfYears(b.years) === y.key ? (a.doubts.some((x) => x.kind === "years") ? 0.5 : 0.85) : 0.1) })) });
  // field
  if (a.fields.length) {
    const f = a.field ?? a.fields[0]; const lab = FIELDS.find((x) => x.id === f)!.label;
    qs.push({ id: "field", family: "field", settlesDirection: false, text: `Do you want to stay in ${lab.toLowerCase()}?`, options: [
      { key: `field:${f}`, label: "Yes, stay in it", taps: 1, apply: (b) => ({ ...clone(b), field: f }), p: () => 0.45 },
      { key: "field:any", label: "Open to any field", taps: 1, apply: (b) => ({ ...clone(b), field: null }), p: () => 0.55 }] });
  }
  // eligibility: roles asking a little more than they have
  qs.push({ id: "stretch", family: "stretch", settlesDirection: false, text: "Show roles one level above yours too?", options: [
    { key: "stretch:yes", label: "Yes, show stretch roles", taps: 1, apply: (b) => ({ ...clone(b), stretch: true }), p: () => 0.5 },
    { key: "stretch:no", label: "No, my level only", taps: 1, apply: (b) => ({ ...clone(b), stretch: false }), p: () => 0.5 }] });
  return qs;
}

// ── 4. ranking from the posting tags ─────────────────────────────────────────────────────────────────────────────────
export type Posting = { id: string; title: string; employer: string; spec: string | null; level: Level; fields: string[]; fit: number; eligible: (years: number | null) => boolean };
export type Shown = { id: string; title: string; employer: string; spec: string | null; agree: number; score: number };
const RUNG: Record<Level, number> = { intern: 0, entry: 1, mid: 2, senior: 3, leader: 4 };
/** Level fit: the same rung 1, one below 0.7, one above 0.7 when stretch is on (else 0.35), further 0. */
export function levelFit(want: Level, got: Level, stretch: boolean): number {
  const d = RUNG[got] - RUNG[want]; if (d === 0) return 1; if (d === -1) return 0.7; if (d === 1) return stretch ? 0.7 : 0.35; return 0;
}
/** How well a posting's kind of work agrees with what the person wants: expected transfer under the belief. */
export function agreement(b: Belief, spec: string | null): number {
  if (!spec) return 0; let s = 0; for (const [k, p] of b.want) s += p * transfer(k, spec); return s;
}
export const MIN_AGREE = 0.5;   // below this a role is not in the line of work the person wants: never shown
/** The ordered list: in the wanted line of work (strong neighbours count), level near, the posting's own screens passed;
 *  then the existing text fit, title closeness, the chosen field. One role per employer, a title at an employer once. */
export function rank(b: Belief, pool: Posting[], titles: string[], keep = 40): Shown[] {
  const out: Shown[] = [];
  for (const p of pool) {
    const ag = agreement(b, p.spec); if (ag < MIN_AGREE) continue;
    const lf = levelFit(b.level, p.level, b.stretch); if (lf < 0.5) continue;
    if (!p.eligible(b.years)) continue;
    const score = ag * lf + 0.35 * p.fit + 0.1 * (titles.length ? titleFit(p.title, titles) : 0) + (b.field && p.fields.includes(b.field) ? 0.1 : 0);
    out.push({ id: p.id, title: p.title, employer: p.employer, spec: p.spec, agree: Math.round(ag * 100) / 100, score: Math.round(score * 1000) / 1000 });
  }
  out.sort((x, y) => y.score - x.score);
  const per = new Set<string>(), seen = new Set<string>(), list: Shown[] = [];
  for (const s of out) { const e = s.employer.toLowerCase(), k = `${e}|${s.title.toLowerCase()}`; if (seen.has(k)) continue; seen.add(k); if (list.length < 5 && per.has(e)) continue; per.add(e); list.push(s); if (list.length >= keep) break; }
  return list;
}
export const countInLine = (b: Belief, pool: Posting[]) => pool.reduce((n, p) => n + (agreement(b, p.spec) >= MIN_AGREE && levelFit(b.level, p.level, b.stretch) >= 0.5 && p.eligible(b.years) ? 1 : 0), 0);

/** The quality of five previews for a person whose wants are `b`: the average of kind-of-work agreement × level fit,
 *  with a shortfall (fewer than five roles) counted as zero. A changed list is not a better list unless this rises. */
export function quality(list: Shown[], b: Belief, pool: Map<string, Posting>): number {
  let s = 0; for (const x of list.slice(0, 5)) { const p = pool.get(x.id)!; s += agreement(b, p.spec) * levelFit(b.level, p.level, b.stretch) * (p.eligible(b.years) ? 1 : 0); }
  return s / 5;
}

// ── 5. which question next ───────────────────────────────────────────────────────────────────────────────────────────
/** Expected value of information of a question on matching quality:
 *     VOI(q) = Σ_a P(a) · [ Q_a(top five after a) − Q_a(top five now) ]
 *  where Q_a judges a list by what the person would want if they answered a. A question whose answers change the list
 *  only toward other lists of the same quality is worth nothing. Ties go to the more basic doubt: function and
 *  specialisation first, then intent, level, years, field, eligibility. */
const PRIORITY: Record<Question["family"], number> = { split: 6, direction: 5, level: 3, years: 2.5, field: 2, stretch: 1 };
export function voi(q: Question, b: Belief, pool: Posting[], byId: Map<string, Posting>, titles: string[]): { v: number; per: { key: string; p: number; gain: number }[] } {
  const now = rank(b, pool, titles, 5); const ps = q.options.map((o) => Math.max(0, o.p(b))); const z = ps.reduce((x, y) => x + y, 0) || 1;
  let v = 0; const per: { key: string; p: number; gain: number }[] = [];
  q.options.forEach((o, i) => {
    const p = ps[i] / z; if (p < 0.01 || o.key === "else" || o.key === "change") return;   // the two-tap answers carry no belief to rank on
    const ba = o.apply(b), after = rank(ba, pool, titles, 5), gain = quality(after, ba, byId) - quality(now, ba, byId);
    v += p * gain; per.push({ key: o.key, p: Math.round(p * 100) / 100, gain: Math.round(gain * 1000) / 1000 });
  });
  return { v: Math.round(v * 10000) / 10000, per };
}
export const STOP_BELOW = 0.02;   // an expected gain under 0.02 (a tenth of one preview's worth) is not worth a tap
export const MOST = 4;            // adaptive questions after the direction is settled; the direction confirmation is extra

export type Step = { q: string; answer: string; taps: number; voi: number; why: string };
/** The adaptive journey, given a frozen answer sheet (question id → option key). The direction is settled first, by the
 *  question that best settles it (a split question if the doubts call for it, else the one-tap confirmation); then the
 *  highest-VOI questions, at most MOST, until none is worth asking. */
export function journey(a: Analysis, sheet: Record<string, string>, pool: Posting[], titles: string[]): { belief: Belief; steps: Step[]; taps: number } {
  const byId = new Map(pool.map((p) => [p.id, p])); const qs = questions(a); let b = firstBelief(a); const steps: Step[] = []; const asked = new Set<string>();
  const ask = (q: Question, v: number, why: string) => {
    const o = pickOption(q, sheet[q.id] ?? q.options[0].key) ?? q.options[0]; b = o.apply(b); asked.add(q.id);
    if (q.settlesDirection) for (const x of qs) if (x.settlesDirection) asked.add(x.id);
    steps.push({ q: q.id, answer: o.key, taps: o.taps, voi: v, why });
  };
  // 1. direction: of the questions that settle it, the one with the larger VOI (the split question only exists when there is a doubt)
  const dirs = qs.filter((q) => q.settlesDirection).map((q) => ({ q, v: voi(q, b, pool, byId, titles).v })).sort((x, y) => y.v - x.v || PRIORITY[y.q.family] - PRIORITY[x.q.family]);
  ask(dirs[0].q, dirs[0].v, dirs[0].q.family === "direction" ? "mandatory direction confirmation" : "settles a named doubt and the direction");
  // 2. the rest, by VOI
  for (let n = 0; n < MOST; n++) {
    const open = qs.filter((q) => !asked.has(q.id)).map((q) => ({ q, v: voi(q, b, pool, byId, titles).v })).sort((x, y) => y.v - x.v || PRIORITY[y.q.family] - PRIORITY[x.q.family]);
    if (!open.length || open[0].v < STOP_BELOW) break;
    ask(open[0].q, open[0].v, "highest expected gain");
  }
  return { belief: b, steps, taps: steps.reduce((t, s) => t + s.taps, 0) };
}
/** The fixed confirmation (approach B): the same four items for everyone, in a fixed order. */
export function fixed(a: Analysis, sheet: Record<string, string>): { belief: Belief; steps: Step[]; taps: number } {
  const qs = questions(a); let b = firstBelief(a); const steps: Step[] = [];
  for (const id of ["direction", "years", "level", "field"]) {
    const q = qs.find((x) => x.id === id); if (!q) continue;
    const o = pickOption(q, sheet[q.id] ?? q.options[0].key) ?? q.options[0]; b = o.apply(b); steps.push({ q: id, answer: o.key, taps: o.taps, voi: 0, why: "fixed item" });
  }
  return { belief: b, steps, taps: steps.reduce((t, s) => t + s.taps, 0) };
}
export { FUNCTIONS, FN, LEVELS };
