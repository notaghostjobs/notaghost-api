// Job intelligence v2: a posting's kind of work, domain and seniority, read in code from what the job asks the person
// to DO, not from the title's keywords or the employer's description of itself.
//
// What changed from v1 (tagger.ts, kept unchanged for comparison), each answering a measured cause of error:
//   1. The employer's own text is set aside before anything is scored: "about us", mission statements, listing codes,
//      equal-opportunity and benefits text, cookie and language menus. v1 counted words there.
//   2. Duties weigh most: sentences that say what the person will do, then what the posting requires; the title
//      contributes its role words, never the employer's internal codes ("I&P - GN - SONG", "National - CNS", "L2").
//   3. A title names a specialisation only through its role phrase: the object of the job ("Transition Manager Tax"
//      is a transition manager, not tax; "Manager - Mergers and Acquisition" is not digital marketing).
//   4. A skills line ("Must have skills", "Skill required", "Mandatory Skills") counts for a specialisation only when it
//      names it, not when it shares one generic word.
//   5. Seniority from the posting as a whole: the years it asks, who reports to the role, scope words, and the
//      employer's own grade ladders, with the title's rank words as one signal among them.
//   6. When the evidence is thin, it says so (no tag) rather than guessing.
import { SPECS, FUNCTIONS, FN, fieldsOf, type Spec } from "./ontology.js";
import { titleNames, sigHits } from "./tagger.js";
import { statedBand } from "../reader/experience.js";
import type { Level } from "./usmatch.js";

export type Tag2 = { spec: string | null; fn: string | null; conf: number; alt: { spec: string; s: number }[]; level: Level; levelWhy: string; manages: boolean; yearsMin: number | null; fields: string[]; why: string };

// ── 1. the employer's own text, set aside ───────────────────────────────────────────────────────────────────────────
const COMPANY = /\b(we are (a|an|the|one of)|is (a|an|the) (leading|global|world|trusted|fast|pioneer)|is india'?s|founded in|headquartered|our mission|our vision|our purpose|our values|nasdaq|nyse|bse:|nse:|fortune \d+|trusted by|customers (globally|worldwide|in over)|countries|employees (across|in|worldwide)|offices (in|across)|at [A-Z][a-z]+, we|join (us|our team) (and|to|in)|great place to work|life at|why join|why (work|us)|who we are|about (us|the company))\b/i;
const LEGAL = /\b(equal (employment )?opportunit|discriminat|race, (color|colour)|religion|gender identity|sexual orientation|disabilit|veteran status|reasonable accommodation|background (check|verification)|privacy (notice|policy)|personal data|recruitment fraud|never ask(s)? for (money|payment)|e-?verify|affirmative action|protected (characteristic|status))\b/i;
const PERKS = /\b(benefits? (include|package)|health insurance|paid (time off|leave)|wellness|flexible working|parental leave|retirement|401\(k\)|hybrid work policy|perks)\b/i;
const MENU = /\b(sign in|employee login|search jobs|job details|apply now|back to jobs|share this job|cookie|language english)\b/i;
const DUTY = /^(\W*)(develop|design|build|lead|manage|own|drive|deliver|implement|create|maintain|support|analy[sz]e|prepare|process|handle|perform|ensure|coordinate|collaborate|work (with|closely|on)|review|conduct|monitor|configure|test|write|define|identify|execute|plan|oversee|establish|partner|engage|negotiate|sell|acquire|recruit|source|train|resolve|troubleshoot|administer|operate|install|commission|reconcile|audit|assess|evaluate|research|model|deploy|automate|optimi[sz]e|track|report|serve|respond|you will|you'll|responsible for|the role|as a|in this role)\b/i;
const REQ = /\b(experience (in|with|of)|years|degree|bachelor|master|knowledge of|proficien|familiar|expertise|hands[- ]on|skills?|certif|qualification|must have|should have|required|preferred)\b/i;

/** The posting as weighted sentences: duties 1.5, requirements 1, other job text 0.6; employer text 0. */
export function jobText(text: string): { duties: string; reqs: string; other: string; dropped: number } {
  const raw = text.replace(/\r/g, "").split(/\n+|(?<=[.!?])\s+(?=[A-Z•\-–])|\s•\s|\s·\s/).map((x) => x.trim()).filter(Boolean);
  let duties = "", reqs = "", other = "", dropped = 0;
  for (const s of raw) {
    if (s.length < 3) continue;
    if (LEGAL.test(s) || PERKS.test(s) || (MENU.test(s) && s.length < 200) || (COMPANY.test(s) && !DUTY.test(s))) { dropped++; continue; }
    if (DUTY.test(s)) duties += s + "\n"; else if (REQ.test(s)) reqs += s + "\n"; else other += s + "\n";
  }
  return { duties, reqs, other, dropped };
}

// ── 2. the title: role words only ───────────────────────────────────────────────────────────────────────────────────
const CODES = [
  /#?\bACN\b/gi, /\bI&P\b|\bS&C\b|\bGN\b|\bSONG\b|\bSC&E\b|\bI&F\b|\bTMT\b|\bCNS\b|\bASU\b|\bPAS\b|\bWKFA\b|\bPC\b|\bBC\b|\bPI\b|\bTC\b|\bCS\b(?=\s*-)|\bCDTR\b|\bTVM\b|\bGBS\b|\bINC\b|\bEYP\b|\bTD\b(?=\s*-)/g,
  /\b(national|global network|bangalore|bengaluru|chennai|hyderabad|mumbai|pune|gurgaon|india|kengeri|krishna tower|prestige corniche)\b/gi,
  /\b[LJ]\d\b|\(contract\)|\bcontract\b|\d+\s*[-–to]+\s*\d+\s*(years?|yrs?)|\d+\+?\s*(years?|yrs?)|\(\s*\)|\bview details\b/gi,
];
export function roleTitle(title: string): string {
  let t = title.replace(/\s+/g, " ");
  for (const c of CODES) t = t.replace(c, " ");
  // listing pieces split by " - ", "|", "," : keep the pieces that carry role words, the first one first
  const pieces = t.split(/\s[-–—|]\s|\s*\|\s*|,\s+|\s-(?=[A-Z])|(?<=[a-z])-\s/).map((x) => x.replace(/[^A-Za-z0-9+#.&/' ()-]+/g, " ").replace(/\s+/g, " ").trim()).filter((x) => x.length > 1);
  return pieces.slice(0, 3).join(" | ") || title;
}
/** The specialisations a title names, the most specific first: a title rule that matches a longer stretch of the title
 *  (the role phrase, "payroll operations analyst") beats one that matches a single word ("analyst"). */
function titleHits(title: string): { id: string; len: number }[] {
  // the role phrase is the first listing piece; in English its head noun comes last, so a match that ends nearer the
  // end of that piece is the job's own name ("Supply Chain Product FP&A Analyst" is FP&A, not supply chain)
  const first = title.split(" | ")[0], rest = title.slice(first.length);
  const out: { id: string; len: number }[] = [];
  for (const s of SPECS) {
    if (!s.title) continue;
    for (const [piece, w] of [[first, 1], [rest, 0.4]] as const) {
      if (!piece || !titleNames(s, piece)) continue;
      const m = piece.match(s.title)!; const end = (m.index ?? 0) + m[0].length;
      out.push({ id: s.id, len: w * (m[0].length + 2 * (end / Math.max(1, piece.length)) * 10) }); break;
    }
  }
  return out.sort((a, b) => b.len - a.len);
}
// ── 3. the skills line ──────────────────────────────────────────────────────────────────────────────────────────────
const MUST = /(must[- ]have skills?|primary skills?|mandatory skills?|key skills?|skills? required|skill required|technical skills?)\s*[:\-–]\s*([^\n]{3,200})/i;

// ── 5. seniority ────────────────────────────────────────────────────────────────────────────────────────────────────
const LEADER_T = /\b(chief|cxo|cto|cfo|coo|ceo|vp|vice president|svp|evp|director|head\b|head of|global head|country manager|general manager|managing director|partner\b|executive director|principal (consultant|director))\b/i;
const SENIOR_T = /\b(senior|sr\.?|lead|staff|principal|manager|architect|team lead|tl\b|supervisor|specialist ii|expert|deputy manager|assistant manager|associate manager|chief manager|avp|assistant vice president)\b/i;
const ENTRY_T = /\b(junior|jr\.?|associate(?! (manager|director|vice|partner|principal))|trainee|graduate|fresher|entry|apprentice|executive(?! (director|assistant))|analyst(?! (ii|iii|iv|3|4))|engineer i\b|level 1|i$)\b/i;
const INTERN_T = /\b(intern|internship|apprentice(ship)?|co-?op|trainee|young graduate)\b/i;
// employer grade ladders, as their own postings print them
const WIPRO = /\b(?:L|level\s*)([1-5])\b/i;
const MANAGES = /\b(lead(ing)? a team|manage (a|the) team|managing a team|team of \d+|direct reports|people manager|people management|line manag|build and lead|lead and mentor|head(ing)? a team|team management)\b/i;
const SCOPE_LEAD = /\b(p&l (ownership|responsibility)|own(s|ing)? the p&l|business head|functional head|org(anisation)?[- ]wide|across (india|the region|regions|apac|geographies)|global (team|function)|strategy for the (function|business))\b/i;
const RUNG: Level[] = ["intern", "entry", "mid", "senior", "leader"];
export function seniority(title: string, text: string): { level: Level; why: string; manages: boolean; yearsMin: number | null } {
  const band = statedBand(text) ?? statedBand(title); const y = band?.min ?? null;
  const manages = MANAGES.test(text);
  const t = title;
  if (INTERN_T.test(t)) return { level: "intern", why: "title", manages, yearsMin: y };
  let fromTitle: number | null = null;
  if (LEADER_T.test(t)) fromTitle = 4; else if (SENIOR_T.test(t)) fromTitle = 3; else if (ENTRY_T.test(t)) fromTitle = 1;
  const w = t.match(WIPRO); if (w && /\b(developer|engineer|analyst|consultant|administrator|lead|architect|specialist|manager)\b/i.test(t)) { const n = Number(w[1]); const base = /\b(lead|architect|manager|principal|managing)\b/i.test(t) ? 3 : n <= 1 ? 1 : n <= 3 ? 2 : 3; fromTitle = Math.max(fromTitle ?? 0, base); }
  let fromYears: number | null = null; if (y !== null) fromYears = y < 2 ? 1 : y < 6 ? 2 : y < 12 ? 3 : 4;
  let r: number; let why: string;
  if (fromYears !== null && fromTitle !== null) {
    // years settle the individual-contributor rungs; a leader's title needs the years (or the scope) to stand
    if (fromTitle === 4) { r = fromYears >= 3 || SCOPE_LEAD.test(text) ? 4 : 3; why = "title and years"; }
    else if (fromTitle === 3 && fromYears <= 1) { r = 2; why = "title says senior, years say otherwise"; }
    else { r = Math.max(fromYears === 4 ? 3 : fromYears, fromTitle === 3 && fromYears === 2 && /\b(manager|lead|architect|principal|staff)\b/i.test(t) ? 3 : 0, fromTitle === 1 && fromYears === 2 ? 2 : 0); why = "years asked"; }
  } else if (fromYears !== null) { r = fromYears === 4 ? (manages || SCOPE_LEAD.test(text) ? 4 : 3) : fromYears; why = "years asked"; }
  else if (fromTitle !== null) { r = fromTitle; why = "title"; }
  else { r = manages ? 3 : 2; why = manages ? "manages people" : "nothing said: experienced individual contributor"; }
  if (manages && r < 3 && (y ?? 0) >= 4) { r = 3; why += ", manages people"; }
  return { level: RUNG[r], why, manages, yearsMin: y };
}

// ── the classifier ──────────────────────────────────────────────────────────────────────────────────────────────────
const GENERAL = new Set(["swe.general"]);
/** Specialisations whose title words name the shape of a role ("Solution Architect", "Operations Associate",
 *  "Web Developer"), not its subject. When the title or the skills line also names a subject ("Order to Cash",
 *  "ServiceNow", "Oracle"), the subject decides. */
const SHAPE = new Set(["swe.general", "swe.frontend", "cloud.arch", "qa.manual", "qa.auto", "support.app", "support.it", "ops.backoffice", "cs.backoffice", "ops.mgmt", "consult.strategy", "consult.process", "pm.project", "pm.program", "pm.delivery", "presales.solution", "cs.success", "ba.business", "data.analyst"]);
export const W2 = { title: 3.5, titleShort: 2.2, general: 2.4, fnGeneric: 0.8, duty: 0.55, req: 0.3, other: 0.12, cap: 7, must: 2.6, mustHits: 2 };
export const MIN2 = 2.2, TEXT_ONLY2 = { score: 1.6, lead: 0.5 };
export function scoreAll2(title: string, text: string): { spec: string; s: number; t: boolean; m: boolean; d: number; r: number }[] {
  const role = roleTitle(title), jt = jobText(text.slice(0, 16000)), must = text.match(MUST)?.[2] ?? "";
  const hits = titleHits(role); const best = hits[0]?.len ?? 0;
  const fnHit = new Set(FUNCTIONS.filter((f) => f.generic && f.generic.test(role) && !(f.genericNot && f.genericNot.test(role))).map((f) => f.id));
  const out: { spec: string; s: number; t: boolean; m: boolean; d: number; r: number }[] = [];
  const mustNames = new Set(must ? SPECS.filter((s) => !GENERAL.has(s.id) && (titleNames(s, must) || sigHits(s.id, must) >= W2.mustHits)).map((s) => s.id) : []);
  const subjectNamed = hits.some((x) => !SHAPE.has(x.id)) || [...mustNames].some((id) => !SHAPE.has(id));
  for (const s of SPECS) {
    const h = hits.find((x) => x.id === s.id); const t = !!h;
    const d = sigHits(s.id, jt.duties), r = sigHits(s.id, jt.reqs), o = sigHits(s.id, jt.other);
    const m = mustNames.has(s.id);
    const tw = !t ? 0 : SHAPE.has(s.id) && subjectNamed ? W2.titleShort - 0.4 : GENERAL.has(s.id) ? W2.general : h!.len >= best * 0.8 ? W2.title : W2.titleShort;
    const textScore = Math.min(W2.cap, W2.duty * d + W2.req * r + W2.other * o);
    const score = tw + (fnHit.has(s.fn) && !GENERAL.has(s.id) ? W2.fnGeneric : 0) + textScore + (m ? W2.must : 0);
    if (score > 0) out.push({ spec: s.id, s: Math.round(score * 100) / 100, t, m, d, r });
  }
  return out.sort((a, b) => b.s - a.s);
}
export function tagPosting2(title: string, text: string): Tag2 {
  const all = scoreAll2(title, text), top = all[0], second = all[1]?.s ?? 0;
  const sen = seniority(title, text), fields = fieldsOf(jobText(text).duties + jobText(text).reqs || text).slice(0, 2).map((f) => f.id);
  const base = { level: sen.level, levelWhy: sen.why, manages: sen.manages, yearsMin: sen.yearsMin, fields };
  const ok = top && (top.s >= MIN2 || (top.s >= TEXT_ONLY2.score && top.s - second >= TEXT_ONLY2.lead && top.d + top.r >= 3));
  if (!ok) return { spec: null, fn: null, conf: 0, alt: all.slice(0, 3).map(({ spec, s }) => ({ spec, s })), ...base, why: "nothing names the work" };
  const spec = SPECS.find((s) => s.id === top.spec)!;
  const conf = Math.round(Math.min(1, (top.s - second) / 3 + top.s / 12) * 100) / 100;
  const why = [top.t ? "title role" : "", top.m ? "skills line" : "", top.d ? `${top.d} duty words` : "", top.r ? `${top.r} requirement words` : ""].filter(Boolean).join(", ");
  return { spec: spec.id, fn: spec.fn, conf, alt: all.slice(1, 4).map(({ spec, s }) => ({ spec, s })), ...base, why };
}
export { FN };
