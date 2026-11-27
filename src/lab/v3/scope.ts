// Matching v3, improvement 1: scope-aware seniority. Deterministic. A level is read from what a person actually did
// (evidence lines, with quotes) and what a job actually asks (requirements, responsibilities, stated years), not from
// title words or years alone. Title rungs are used only as a weak tie-breaker and to flag title inflation.
// Lab code; not wired to any route.
import { rungOf } from "../v2/terms.js";

/** Scope categories, in order. They are distinct; one does not imply another. */
export const SCOPES = ["hands_on", "project_ownership", "team_leadership", "functional_management", "department_leadership", "business_pnl", "principal_technical"] as const;
export type Scope = (typeof SCOPES)[number];
const PAT: Record<Exclude<Scope, "hands_on">, RegExp> = {
  project_ownership: /\b(owned|own(ed)? (the )?(end[- ]to[- ]end|delivery|roadmap)|end[- ]to[- ]end (ownership|delivery)|led (the )?(design|development|migration|implementation|launch|rollout|project|initiative|programme|program)|spearheaded|drove (the )?(launch|migration|rollout|initiative))\b/i,
  team_leadership: /\b(led|lead|leading|managed|managing|mentored|mentoring|supervised|supervising|coached)\b[^.;]{0,40}\b(team|teams|engineers|developers|analysts|members|people|associates|executives|officers|reports|reportees|staff|squad)\b|\bteam (size )?of \d+|\b\d+[- ]member team\b|\bdirect reports?\b|\bteam lead\b/i,
  functional_management: /\b(managed|managing|led|leading|built|building|set up|established|heading)\b[^.;]{0,30}\b(function|department|vertical|practice|managers|team leads)\b|\bmanager of managers\b|\b\d+ (managers|team leads)\b/i,
  department_leadership: /\b(head of|headed|heading the|regional head|zonal head|national head|department head|country head|led (the )?(region|zone|division|business unit)|across \d+ (branches|regions|zones|teams|countries|cities))\b/i,
  business_pnl: /\b(p&l|p ?& ?l|profit (and|&) loss|revenue (ownership|responsibility|target)|owned (the )?(revenue|budget|p&l)|budget of|managed (a )?budget|business unit (head|owner)|gmv (ownership|of))\b/i,
  principal_technical: /\b(principal (engineer|scientist|architect)|distinguished|org(anisation|anization)?[- ]wide (architecture|technical)|technical strategy|set (the )?technical direction|research (lead|leadership|agenda)|led (a )?research|published (in|at)|first author|patents? (filed|granted)|peer[- ]reviewed)\b/i,
};
export const LEVELS = ["entry", "junior", "mid", "senior", "lead", "head", "executive"] as const;
const L = (s: string | null | undefined): number | null => { if (!s) return null; const k = s.toLowerCase(); const m: Record<string, number> = { entry: 0, fresher: 0, intern: 0, junior: 1, mid: 2, senior: 3, lead: 4, manager: 4, head: 5, leader: 5, director: 5, executive: 6 }; return k in m ? m[k] : null; };
export const yearsLevel = (y: number | null) => (y === null ? null : y < 1 ? 0 : y < 3 ? 1 : y < 6 ? 2 : y < 10 ? 3 : y < 15 ? 4 : 5);

export type CandidateScope = { years: number | null; yearsLevel: number | null; scopes: { scope: Scope; quote: string }[]; top: Scope; evidenceLevel: number | null; titleRung: number | null; titleInflated: boolean;
  statedLevel: number | null; level: number | null; recentHandsOn: boolean; basis: string[] };
const SCOPE_LEVEL: Record<Scope, number> = { hands_on: 0, project_ownership: 2, team_leadership: 4, functional_management: 4, department_leadership: 5, business_pnl: 5, principal_technical: 4 };
const HANDS = /\b(built|developed|implemented|coded|wrote|designed|configured|tested|debugged|analy[sz]ed|prepared|reconciled|processed|underwrote|appraised|modell?ed|automated|deployed|executed|handled|resolved)\b/i;

/** What the person actually did. Every scope carries the line it was read from. */
export function candidateScope(c: { years_total: { value: number | null }; roles: { title: string; from: any; to: any; lines?: string[] }[]; work_lines: string[]; achievement_lines: string[]; led_lines: string[] }, stated?: string | null): CandidateScope {
  const lines = [...c.work_lines, ...c.achievement_lines, ...c.led_lines]; const scopes: { scope: Scope; quote: string }[] = [];
  for (const s of SCOPES.slice(1) as Exclude<Scope, "hands_on">[]) { const q = lines.find((l) => PAT[s].test(l)); if (q) scopes.push({ scope: s, quote: q }); }
  if (lines.some((l) => HANDS.test(l))) scopes.unshift({ scope: "hands_on", quote: lines.find((l) => HANDS.test(l))! });
  // a held manager/lead/head title is leadership evidence too (one level below what it claims, when inflated)
  // only from about six years: a "Senior Manager" title at four years is not people-leadership evidence by itself
  const ledTitle = c.roles.slice(0, 2).find((r) => /\b(manager|lead|head|director)\b/i.test(r.title || "") && !/\b(assistant|associate|asst)\b/i.test(r.title || ""));
  if (ledTitle && (c.years_total.value ?? 0) >= 6 && !scopes.some((s) => s.scope === "team_leadership")) scopes.push({ scope: "team_leadership", quote: `title: ${ledTitle.title}` });
  const years = c.years_total.value ?? null; const yl = yearsLevel(years); const basis: string[] = [];
  let top: Scope = "hands_on"; for (const s of scopes) if (SCOPE_LEVEL[s.scope] > SCOPE_LEVEL[top]) top = s.scope;
  // scope can lift the level by at most one band above what the years support: a "head" title at 3 years is not head scope
  const sl = scopes.length ? Math.max(...scopes.map((s) => SCOPE_LEVEL[s.scope])) : null;
  const evidenceLevel = yl === null ? sl : sl === null ? yl : Math.max(yl, Math.min(sl, yl + 1));
  const titleRung = Math.max(-1, ...c.roles.slice(0, 2).map((r) => rungOf(r.title || "").rung ?? -1)); const tr = titleRung >= 0 ? titleRung : null;
  // rung scale (0..5) maps to levels 0,1,3,4,5,6; inflated when the title claims two or more levels above the evidence
  const titleLevel = tr === null ? null : [0, 1, 3, 4, 5, 6][tr];
  const titleInflated = titleLevel !== null && evidenceLevel !== null && titleLevel - evidenceLevel >= 2;
  if (titleInflated) basis.push(`title claims ${LEVELS[titleLevel!]}, evidence supports ${LEVELS[evidenceLevel!]}`);
  const statedLevel = L(stated); let level = evidenceLevel;
  if (level === null && titleLevel !== null) { level = titleLevel; basis.push("level from title (no dated evidence)"); }
  if (statedLevel !== null && level !== null && Math.abs(statedLevel - level) >= 2) basis.push(`stated target ${LEVELS[statedLevel]} differs from evidence ${LEVELS[level]}`);
  const recent = c.roles.slice(0, 1).flatMap((r) => r.lines ?? []); const recentHandsOn = recent.length ? recent.some((l) => HANDS.test(l) && !PAT.functional_management.test(l)) : lines.some((l) => HANDS.test(l));
  return { years, yearsLevel: yl, scopes, top, evidenceLevel, titleRung: tr, titleInflated, statedLevel, level, recentHandsOn, basis };
}

export type JobScope = { floor: number | null; ceiling: number | null; juniorBand: boolean; levelBasis: string[]; yearsMin: number | null; yearsMax: number | null; demands: { scope: Scope; quote: string }[]; managesPeople: boolean; handsOnIC: boolean; principal: boolean; seniority: string | null };
const YRS = /(\d{1,2})\s*\+?\s*(?:(?:-|to|–)\s*(\d{1,2}))?\s*\+?\s*(?:years|yrs)/i;
const IC = /\b(hands[- ]on|individual contributor|write (clean |production )?code|coding|you will (build|develop|code|write))\b/i;
const PRINCIPAL_JOB = /\b(principal (engineer|scientist|architect|researcher)|distinguished|research (lead|leadership|agenda|direction)|set (the )?technical (direction|strategy)|org(anisation|anization)?[- ]wide|publication record|track record of (publications|research))\b/i;
/** A job's own demands are read more strictly than a person's evidence: "operations across 12 countries" in a
 *  company description is not a department-leadership requirement. */
const JOB_PAT: Partial<Record<Scope, RegExp>> = {
  business_pnl: /\b(p&l|p ?& ?l|profit (and|&) loss)\b[^.;]{0,30}\b(ownership|owner|responsibilit\w*|accountab\w*)|\b(own|owning|manage|managing)\b[^.;]{0,15}\b(p&l|p ?& ?l|profit (and|&) loss)\b|\brevenue (ownership|responsibility)\b/i,
  department_leadership: /\b(head (of )?the (department|function|region|zone|business)|lead (the|a) (region|zone|division|department|business unit)|(regional|zonal|national|country) head)\b/i,
};
/** What a title says about the band of a role, used as a ceiling only when the title is explicit about it. */
export function titleBand(title: string): { ceiling: number | null; floor: number | null; word: string | null } {
  const t = title.toLowerCase();
  if (/\b(intern|trainee|apprentice|fresher|graduate engineer)\b/.test(t)) return { ceiling: 0, floor: null, word: "entry title" };
  if (/\b(vice president|vp|chief|cxo|general manager|country manager)\b/.test(t)) return { ceiling: null, floor: 5, word: "executive title" };
  if (/\b(director|head of|head -|senior staff|lead principal|distinguished)\b|\bhead\b/.test(t) && !/\bassociate director\b/.test(t)) return { ceiling: null, floor: 5, word: "director/head title" };
  if (/\b(staff (engineer|scientist|software|data|ml|machine)|principal|senior manager|sr\.? manager|engineering manager|associate director|architect)\b/.test(t)) return { ceiling: null, floor: 4, word: "staff/principal/senior manager title" };
  if (/\b(assistant manager|associate manager|deputy manager|asst\.? manager)\b/.test(t)) return { ceiling: 3, floor: null, word: "assistant/associate manager title" };
  if (/\blead (associate|executive|analyst)\b/.test(t)) return { ceiling: 2, floor: null, word: "lead associate/analyst title" };
  if (/\b(manager|lead)\b/.test(t)) return { ceiling: null, floor: 3, word: "manager/lead title" };
  if (/\b(senior associate|sr\.? associate|senior executive|sr\.? executive|senior analyst|sr\.? analyst|specialist|analyst (ii|2)|\bl2\b)/.test(t)) return { ceiling: 2, floor: null, word: "senior associate/analyst title" };
  if (/\b(account executive|executive director)\b/.test(t)) return { ceiling: null, floor: null, word: null };
  if (/\b(junior|jr\.?|associate|executive|officer|teller|representative|\bl1\b)\b/.test(t) && !/\b(senior|sr\.?)\b/.test(t)) return { ceiling: 1, floor: null, word: "associate/executive title" };
  if (/\banalyst\b/.test(t) && !/\b(senior|sr\.?|lead)\b/.test(t)) return { ceiling: 2, floor: null, word: "analyst title" };   // "analyst" spans junior to mid across employers
  return { ceiling: null, floor: null, word: null };
}

/** What the job actually asks, as a floor (the least it needs) and, only when the posting says so, a ceiling.
 *  "5+ years" is a floor: someone with 8 years is not over-qualified because of it. */
export function jobScope(job: { title: string; text: string; cjr?: any; det?: any }): JobScope {
  const cj = job.cjr; const reqText = cj ? [...cj.mandatory.map((m: any) => m.quote ?? m.text), ...cj.responsibilities].join("\n") : `${job.det?.text?.requirements ?? ""}\n${job.det?.text?.duties ?? ""}`;
  const all = `${job.title}\n${reqText}\n${job.text.slice(0, 6000)}`; const basis: string[] = [];
  let yearsMin: number | null = cj?.years?.min ?? job.det?.years_min?.value ?? null, yearsMax: number | null = cj?.years?.max ?? null;
  const m = YRS.exec(`${job.title} ${reqText} ${job.text.slice(0, 4000)}`); if (m) { if (yearsMin === null) yearsMin = +m[1]; if (yearsMax === null && m[2] && +m[2] > +m[1]) yearsMax = +m[2]; }
  const demands: { scope: Scope; quote: string }[] = []; const src = `${job.title}\n${reqText}`.split(/\n|(?<=[.;])\s/);
  for (const s of SCOPES.slice(1) as Exclude<Scope, "hands_on">[]) { const re = JOB_PAT[s] ?? PAT[s]; const q = src.find((l) => re.test(l)); if (q) demands.push({ scope: s, quote: q.slice(0, 200) }); }
  const managesPeople = !!(cj?.manages_people ?? job.det?.manages_people?.value ?? demands.some((d) => d.scope === "team_leadership"));
  const principal = PRINCIPAL_JOB.test(`${job.title}\n${reqText}`);
  const sen = cj?.seniority && cj.seniority !== "unknown" ? cj.seniority : null; const cs = L(sen);
  let floor: number | null = null; const yl = yearsMin === null ? null : yearsLevel(yearsMin);
  if (yl !== null) { floor = yl; basis.push(`asks ${yearsMin}${yearsMax ? `–${yearsMax}` : "+"} years`); }
  if (cs !== null && (floor === null || cs > floor)) { floor = cs; basis.push(`extracted seniority ${sen}`); }
  if (principal) { floor = Math.max(floor ?? 0, 4); basis.push("principal-level scope stated"); }
  if (managesPeople) { floor = Math.max(floor ?? 0, 3); basis.push("manages people"); }
  if (demands.some((d) => d.scope === "department_leadership" || d.scope === "business_pnl")) { floor = Math.max(floor ?? 0, 4); basis.push("department or P&L scope"); }
  const tb = titleBand(job.title);
  if (tb.floor !== null && (floor === null || tb.floor > floor)) { floor = tb.floor; basis.push(tb.word!); }
  let ceiling: number | null = null; const juniorBand = sen === "entry" || sen === "junior" || tb.ceiling !== null;
  if (yearsMax !== null) { ceiling = yearsLevel(yearsMax)!; basis.push(`at most ${yearsMax} years`); }
  if (juniorBand) { let c = tb.ceiling !== null ? tb.ceiling + (tb.ceiling <= 1 && yearsMin !== null && yearsMin >= 3 ? 1 : 0) : sen === "entry" ? 0 : 1; if (yearsMin !== null) c = Math.max(c, yearsLevel(yearsMin)!); ceiling = Math.min(ceiling ?? 9, c); basis.push(`band ceiling ${LEVELS[c]} (${tb.word ?? sen})`); }
  return { floor, ceiling, juniorBand, levelBasis: basis, yearsMin, yearsMax, demands, managesPeople, handsOnIC: IC.test(all) && !managesPeople, principal, seniority: sen };
}

/** basis (v3.2): why a "step_up" was given. "track_change" = the only reason is a move from recent management work to
 *  a hands-on role, which is a change of track and not a more senior job; "level" = years, floor or scope asked. */
export type Compat = { verdict: "fit" | "step_up" | "below_mild" | "below" | "too_far_up" | "unknown"; reasons: string[]; basis?: "level" | "track_change" };
const LEADS = ["team_leadership", "functional_management", "department_leadership", "business_pnl"];
/** Seniority and responsibility compatibility. "below" and "too_far_up" are hard for the strong list; "step_up" and
 *  "below_mild" may still be strong when the rest of the evidence is strong. Years alone never make someone "below":
 *  that needs a job ceiling and leadership scope above it, or the person's own stated target above it. */
export function compat(cs: CandidateScope, js: JobScope): Compat {
  const r: string[] = [...js.levelBasis.map((b) => `job: ${b}`)]; const yrs = cs.years; const leads = cs.scopes.some((s) => LEADS.includes(s.scope));
  const capacity = cs.level;   // evidence-based level
  if (capacity === null) return { verdict: "unknown", reasons: [...r, "person's level not established"] };
  let up = 0;
  if (js.yearsMin !== null && yrs !== null) { if (yrs < js.yearsMin - 2) { up = 2; r.push(`has ${yrs} years`); } else if (yrs < js.yearsMin) { up = 1; r.push(`has ${yrs} years`); } }
  if (js.principal && !cs.scopes.some((s) => s.scope === "principal_technical")) { r.push("principal-level scope asked, not shown"); up = 2; }
  if (js.managesPeople && !leads) { r.push("manages people; no people leadership shown"); up = Math.max(up, (js.floor ?? 0) >= 5 ? 2 : 1); }
  if (js.demands.some((d) => d.scope === "business_pnl") && !cs.scopes.some((s) => s.scope === "business_pnl")) { r.push("P&L ownership asked, not shown"); up = Math.max(up, 1); }
  if (js.demands.some((d) => d.scope === "department_leadership") && !cs.scopes.some((s) => s.scope === "department_leadership" || s.scope === "functional_management")) { r.push("department leadership asked, not shown"); up = Math.max(up, 1); }
  if (js.floor !== null && js.floor - capacity >= 1) { up = Math.max(up, js.floor - capacity >= 2 ? 2 : 1); r.push(`job floor ${LEVELS[js.floor]} vs person ${LEVELS[capacity]}`); }
  if (up >= 2) return { verdict: "too_far_up", reasons: r };
  let down = 0;
  if (js.ceiling !== null) {
    const gap = capacity - js.ceiling;
    if (js.juniorBand && leads && gap >= 2) { down = 2; r.push(`junior band; person leads people (${LEVELS[capacity]})`); }
    else if (gap >= 2 && yrs !== null && js.yearsMax !== null && yrs > js.yearsMax + 4) { down = 2; r.push(`asks at most ${js.yearsMax} years, has ${yrs}`); }
    else if (gap >= 2 && leads && js.yearsMax !== null && (js.floor === null || js.floor < capacity - 1)) { down = 2; r.push(`asks at most ${js.yearsMax} years; person leads people (${LEVELS[capacity]})`); }
    else if (gap >= 1) down = 1;
  }
  if (cs.statedLevel !== null && js.ceiling !== null && cs.statedLevel - js.ceiling >= 2) { down = Math.max(down, 2); r.push(`person's stated target ${LEVELS[cs.statedLevel]} is above this band`); }
  if (cs.statedLevel !== null && js.ceiling !== null && cs.statedLevel <= js.ceiling && down) { down = 0; r.push("person's stated target matches this band"); }
  const levelUp = up;
  if (js.handsOnIC && !cs.recentHandsOn && capacity >= 4) { r.push("hands-on IC role; recent work is management"); up = Math.max(up, 1); }
  if (down >= 2) return { verdict: "below", reasons: r };
  if (up === 1) return { verdict: "step_up", reasons: r, basis: levelUp >= 1 ? "level" : "track_change" };
  return { verdict: down === 1 ? "below_mild" : "fit", reasons: r };
}
