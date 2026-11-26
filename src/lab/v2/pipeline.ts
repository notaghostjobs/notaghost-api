// Matching v2: eligibility (hard conflicts only), deterministic shortlist, the Sonnet judge's contract, and the 0–5
// display gate. Lab code; not wired to any route, database or message.
import { skillsIn } from "../skills.js";
import { GENERIC, SUBSPEC, FULLSTACK, rungOf, MANAGES, subspecs } from "./terms.js";
import { quoted, norm, type CJR } from "./cjr.js";
import type { CER } from "./cer.js";

// ── D. eligibility: only demonstrated hard conflicts ──────────────────────────────────────────────────────────────
export type Exclusion = { excluded: boolean; reasons: string[] };
const BLR = /\b(bengaluru|bangalore|blr|karnataka|remote|anywhere in india|pan[- ]india|multiple locations)\b/i;
const OTHER_CITY = /\b(mumbai|pune|hyderabad|chennai|delhi|gurgaon|gurugram|noida|kolkata|ahmedabad|jaipur|kochi|coimbatore|indore|chandigarh|singapore|dubai|london|new york|usa|united states)\b/i;
const LICENCE: { id: string; need: RegExp; have: RegExp }[] = [
  { id: "mbbs", need: /\b(mbbs|registered medical practitioner)\b/i, have: /\bmbbs\b|\bmd\b/i },
  { id: "advocate", need: /\b(enrolled (as an )?advocate|bar council|licensed (attorney|lawyer))\b/i, have: /\badvocate\b|bar council|\bllb\b|\bll\.b\b/i },
  { id: "ca", need: /\b(qualified chartered accountant|must be a (qualified )?(ca|chartered accountant)|ca qualification is mandatory)\b/i, have: /\bchartered accountant\b|\bca\b(?= ?(\(|final|qualified|inter))|\bicai\b/i },
];
const ALT = /\b(or|\/|equivalent|alternatively|any of)\b/i;
export function eligibility(job: { id: string; title: string; location: string; text: string; invalid: boolean; closed: boolean; stale?: boolean }, c: CER, resumeText: string): Exclusion {
  const r: string[] = [];
  if (job.invalid) r.push("invalid posting");
  if (job.closed) r.push("closed");
  if (job.stale) r.push("not confirmed within 72 hours");
  for (const x of c.target.exclusions) if (x && new RegExp(`\\b${x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(`${job.title}\n${job.text}`)) r.push(`candidate excludes "${x}"`);
  if (job.location && OTHER_CITY.test(job.location) && !BLR.test(job.location)) r.push(`location: ${job.location.slice(0, 60)}`);
  const hasEdu = c.education_lines.length > 0;
  for (const l of LICENCE) {
    const line = job.text.split(/\n|(?<=[.;])\s/).find((s) => l.need.test(s));
    if (line && !ALT.test(line.replace(l.need, "")) && hasEdu && !l.have.test(resumeText)) r.push(`requires ${l.id} (stated as mandatory), not held`);
  }
  return { excluded: r.length > 0, reasons: r };
}

// ── E. shortlist: deterministic, at most 30, generic terms cannot decide ──────────────────────────────────────────
export type Cand = { id: string; title: string; employer: string; text: string; reqText: string; poolRank: number | null; channel: string; agree: number | null };
export function candidateSubspecs(c: CER): Set<string> { return new Set(subspecs([...c.work_lines, ...c.project_lines, ...c.roles.map((r) => r.title)].join("\n"))); }
export function personRung(c: CER): number { const yrs = c.years_total.value ?? 0; const fromTitle = Math.max(-1, ...c.roles.slice(0, 2).map((r) => rungOf(r.title).rung ?? -1)); const fromYears = yrs < 1 ? 0 : yrs < 3 ? 1 : yrs < 7 ? 2 : yrs < 12 ? 3 : 4; return fromTitle >= 0 ? Math.round((fromTitle + fromYears) / 2) : fromYears; }
export function shortlistScore(j: Cand, c: CER, subs: Set<string>, rung: number, n: number): { score: number; why: string[] } {
  const why: string[] = [];
  const jobSubs = subspecs(`${j.title}\n${j.reqText}`), fam = (id: string) => SUBSPEC.find((s) => s.id === id)?.family;
  const myFams = new Set([...subs].map(fam));
  const sameSub = jobSubs.filter((s) => subs.has(s)), otherSub = jobSubs.filter((s) => !subs.has(s) && myFams.has(fam(s)));
  let spec = sameSub.length ? 1 : jobSubs.length ? 0.4 : 0.6;
  const titleSubs = subspecs(j.title).filter((s) => !subs.has(s) && myFams.has(fam(s)));
  if (titleSubs.length) { spec -= 0.5; why.push(`title is ${titleSubs.join(",")}, not shown`); } else if (otherSub.length) { spec -= 0.2; why.push(`also asks ${otherSub.join(",")}`); }
  if (FULLSTACK.test(j.title) && subs.has("eng.backend") && !subs.has("eng.frontend")) { spec -= 0.3; why.push("full-stack title, no frontend work shown"); }
  // core capabilities: role-defining tools weigh 1, generic shared terms 0.25
  const need = [...skillsIn(j.reqText)]; const have = new Map(c.skills.map((s) => [s.id, s.basis]));
  let num = 0, den = 0;
  for (const s of need) { const w = GENERIC.has(s) ? 0.25 : 1; den += w; const b = have.get(s); num += w * (b === "work" || b === "achievement" ? 1 : b === "project" ? 0.7 : b === "listed" || b === "summary_claim" ? 0.3 : 0); }
  const cover = den ? num / den : 0.5;
  // seniority and scope
  const jr = rungOf(j.title).rung; const gap = jr === null ? 0 : jr - rung;
  const lvl = jr === null ? 0.7 : gap === 0 ? 1 : gap === 1 ? 0.75 : gap === -1 ? 0.7 : 0.2;
  if (jr !== null && Math.abs(gap) >= 2) why.push(`title rung ${jr} vs person ${rung}`);
  const mgr = MANAGES.test(j.text) && !c.led_lines.length ? -0.15 : 0; if (mgr) why.push("manages people; no leadership shown");
  const intent = j.agree === null ? 0.5 : Math.min(1, j.agree);
  const ret = j.poolRank ? 1 - (j.poolRank - 1) / Math.max(1, n) : 0.15;
  const score = 0.3 * Math.max(0, spec) + 0.25 * cover + 0.15 * lvl + 0.1 * intent + 0.2 * ret + mgr;
  return { score, why };
}
/** Setup change s1 (26 Nov, development only, before any paid run): retrieval's own top 10 eligible jobs are always kept
 *  (the scorer was demoting jobs retrieval ranked 1–7), and up to 5 per employer (large employers post many real fits). */
export const SHORTLIST_VERSION = "s1";
export function shortlist(cands: Cand[], c: CER, max = 30, perEmployer = 5, keepTop = 10) {
  const subs = candidateSubspecs(c), rung = personRung(c), n = cands.length;
  const byScore = cands.map((j) => ({ j, ...shortlistScore(j, c, subs, rung, n) })).sort((a, b) => b.score - a.score);
  const top = byScore.filter((x) => x.j.poolRank !== null).sort((a, b) => a.j.poolRank! - b.j.poolRank!).slice(0, keepTop);
  const scored = [...top, ...byScore.filter((x) => !top.includes(x))];
  const per = new Map<string, number>(), seen = new Set<string>(), out: typeof scored = [];
  for (const x of scored) { const e = x.j.employer.toLowerCase(), k = `${e}|${norm(x.j.title)}`; if (seen.has(k) || (per.get(e) ?? 0) >= perEmployer) continue; seen.add(k); per.set(e, (per.get(e) ?? 0) + 1); out.push(x); if (out.length >= max) break; }
  return out;
}

// ── F. the judge's contract ─────────────────────────────────────────────────────────────────────────────────────
export const JUDGE_VERSION = "j1";
export type Fit = "direct" | "adjacent" | "stretch" | "unsuitable" | "cannot_judge";
export type ReqCheck = { requirement: string; job_quote: string; status: "demonstrated" | "transferable" | "unverified" | "confirmed_gap"; resume_quote: string | null };
export type Verdict = { job_id: string; fit: Fit; function: "same" | "neighbour" | "different"; specialisation: "same" | "neighbour" | "different"; seniority: "right" | "one_up" | "below" | "too_far"; core: ReqCheck[]; gaps: string[]; unverified: string[]; why: string; confidence: "high" | "medium" | "low"; failed?: string };
export const JUDGE_SYSTEM = (candidateBlock: string) => `You are a careful Bengaluru recruiter. For each job, compare the candidate's EVIDENCE with the job's REQUIREMENTS and return JSON.
Rules:
- Evidence types matter. WORK and ACHIEVEMENT lines are demonstrated. PROJECT lines are exposure. LISTED lines (skills lists, sidebars) are claims only: a listed skill alone never counts as demonstrated.
- For each MANDATORY requirement give one check: "demonstrated" (a work/achievement line shows it), "transferable" (closely related work shown; say which), "unverified" (nothing shows it either way), "confirmed_gap" (the résumé shows the opposite, or the posting requires something the résumé clearly lacks, e.g. a credential absent from a listed education).
- job_quote and resume_quote must be EXACT excerpts copied from the job text and the candidate evidence below. resume_quote is null when nothing shows it. Never invent or paraphrase a quote.
- function / specialisation: "same", "neighbour" (a recruiter would still consider it) or "different" (e.g. SAP ABAP vs SAP Fiori/UI5 vs SAP CPI/BTP are different specialisations; Salesforce development vs Marketing Cloud are different; backend vs hands-on full-stack are different; credit underwriting vs loan operations are different).
- seniority: "right", "one_up" (a realistic step up), "below", "too_far".
- fit: "direct" = same function and specialisation, right level, mandatory requirements demonstrated. "adjacent" = neighbouring craft or one step up, with strong transferable evidence and no confirmed gap in a mandatory requirement. "stretch" = plausible but missing core evidence or too big a step. "unsuitable" = different function, wrong level, or a confirmed gap in a mandatory requirement. "cannot_judge" = the posting or résumé lacks enough information.
- The candidate's stated direction may break ties; it never makes up for an unmet core requirement.
- why: at most two factual sentences. confidence: high / medium / low (a category, not a probability).
Reply with JSON only: {"verdicts":[{"job_id":"","fit":"","function":"","specialisation":"","seniority":"","core":[{"requirement":"","job_quote":"","status":"","resume_quote":null}],"gaps":[""],"unverified":[""],"why":"","confidence":""}]}

CANDIDATE EVIDENCE (names and contacts removed; target direction is a simulated answer):
${candidateBlock}`;
export function candidateBlock(c: CER): string {
  const sec = (h: string, xs: string[], n = 60) => xs.length ? `${h}:\n${xs.slice(0, n).map((x) => `- ${x}`).join("\n")}` : `${h}: (none found)`;
  return [`Years (${c.years_total.basis}): ${c.years_total.value ?? "unknown"}. Level read: ${c.level_read ?? "unknown"}.`,
    `Roles: ${c.roles.map((r) => `${r.title || "(untitled)"} ${r.from ?? "?"}–${r.to ?? "?"}`).join("; ") || "unknown"}`,
    sec("WORK", c.work_lines), sec("ACHIEVEMENT", c.achievement_lines, 20), sec("PROJECT", c.project_lines, 20), sec("SUMMARY (claims)", c.summary_lines, 12), sec("LISTED (no work evidence)", c.listed_lines, 30), sec("EDUCATION", c.education_lines, 10),
    `Target (simulated): ${c.target.functions.map(([f, w]) => `${f} ${w}`).join(", ")}; level ${c.target.level}; open to related work: ${c.target.open_to_adjacent}; exclusions: ${c.target.exclusions.join(", ") || "none"}`].join("\n\n");
}
export const judgeUser = (jobs: { id: string; title: string; company: string; text: string; cjr: CJR }[]) => jobs.map((j) => `JOB ${j.id}: ${j.title} — ${j.company}\nREQUIREMENTS (extracted, each with its source text):\n${JSON.stringify({ function: j.cjr.function, specialisation: j.cjr.specialisation, mandatory: j.cjr.mandatory, secondary: j.cjr.secondary, years: j.cjr.years, seniority: j.cjr.seniority, manages_people: j.cjr.manages_people, credentials: j.cjr.credentials })}\nJOB TEXT:\n${j.text.slice(0, 6000)}`).join("\n\n=====\n\n");

const FITS = new Set(["direct", "adjacent", "stretch", "unsuitable", "cannot_judge"]), FN = new Set(["same", "neighbour", "different"]), SEN = new Set(["right", "one_up", "below", "too_far"]), ST = new Set(["demonstrated", "transferable", "unverified", "confirmed_gap"]), CONF = new Set(["high", "medium", "low"]);
const closed = (job_id: string, failed: string): Verdict => ({ job_id, fit: "cannot_judge", function: "different", specialisation: "different", seniority: "too_far", core: [], gaps: [], unverified: [], why: "", confidence: "low", failed });
/** Validate one verdict against its sources. Any invented quote, schema breach or contradiction fails closed. */
export function validateVerdict(raw: any, job: { id: string; text: string; title: string }, evidenceText: string): Verdict {
  if (!raw || typeof raw !== "object") return closed(job.id, "missing verdict");
  if (String(raw.job_id) !== job.id) return closed(job.id, "job id mismatch");
  if (!FITS.has(raw.fit) || !FN.has(raw.function) || !FN.has(raw.specialisation) || !SEN.has(raw.seniority) || !CONF.has(raw.confidence) || !Array.isArray(raw.core) || typeof raw.why !== "string") return closed(job.id, "schema");
  const src = `${job.title}\n${job.text}`;
  for (const k of raw.core) {
    if (!k || typeof k.requirement !== "string" || !ST.has(k.status)) return closed(job.id, "schema: core item");
    if (!quoted(k.job_quote, src)) return closed(job.id, `job quote not in posting: ${String(k.job_quote).slice(0, 60)}`);
    if (k.resume_quote !== null && k.resume_quote !== undefined && !quoted(k.resume_quote, evidenceText)) return closed(job.id, `résumé quote not in evidence: ${String(k.resume_quote).slice(0, 60)}`);
    if ((k.status === "demonstrated" || k.status === "transferable") && !k.resume_quote) return closed(job.id, "demonstrated without a résumé quote");
  }
  const v: Verdict = { job_id: job.id, fit: raw.fit, function: raw.function, specialisation: raw.specialisation, seniority: raw.seniority, core: raw.core, gaps: (raw.gaps ?? []).map(String), unverified: (raw.unverified ?? []).map(String), why: raw.why.slice(0, 400), confidence: raw.confidence };
  // contradictions: a strong fit cannot carry a confirmed gap, a different function, or a too-far level
  if ((v.fit === "direct" || v.fit === "adjacent") && (v.core.some((k) => k.status === "confirmed_gap") || v.function === "different" || v.seniority === "too_far")) return closed(job.id, "verdict contradicts its own checks");
  if (v.fit === "direct" && (v.specialisation === "different" || v.seniority === "below")) return closed(job.id, "direct with different specialisation or level");
  return v;
}

// ── G. the display gate: 0–5 strong fits; stretch separate; never padded ───────────────────────────────────────────
export type Shown = { strong: { job_id: string; fit: Fit; why: string; evidence: { job: string; resume: string }[] }[]; stretch: string[]; none_reason: string | null };
export function display(verdicts: Verdict[], c: CER, jobs: Map<string, { title: string; employer: string; eligible: boolean }>, max = 5): Shown {
  const openAdj = !/^(no|false)/i.test(c.target.open_to_adjacent);
  const ok = (v: Verdict) => {
    const j = jobs.get(v.job_id); if (!j || !j.eligible || v.failed) return false;
    if (v.fit === "direct") return v.function === "same" && v.specialisation !== "different" && (v.seniority === "right" || v.seniority === "one_up") && v.confidence === "high";
    if (v.fit === "adjacent") return openAdj && v.function !== "different" && v.seniority !== "too_far" && v.confidence === "high";
    return false;
  };
  const strongEnough = (v: Verdict) => { const core = v.core; if (!core.length) return false; const dem = core.filter((k) => k.status === "demonstrated").length, tr = core.filter((k) => k.status === "transferable").length, un = core.filter((k) => k.status === "unverified").length;
    return !core.some((k) => k.status === "confirmed_gap") && dem >= 1 && (dem + tr) / core.length >= (v.fit === "direct" ? 0.6 : 0.5) && un / core.length <= 0.4; };
  const seen = new Set<string>(); const order = (v: Verdict) => (v.fit === "direct" ? 0 : 1);
  const strong = verdicts.filter((v) => ok(v) && strongEnough(v)).sort((a, b) => order(a) - order(b)).filter((v) => { const j = jobs.get(v.job_id)!; const k = `${j.employer.toLowerCase()}|${norm(j.title)}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, max)
    .map((v) => ({ job_id: v.job_id, fit: v.fit, why: v.why, evidence: v.core.filter((k) => k.resume_quote).slice(0, 2).map((k) => ({ job: k.job_quote, resume: k.resume_quote! })) }));
  const stretch = verdicts.filter((v) => v.fit === "stretch" && !v.failed && jobs.get(v.job_id)?.eligible).map((v) => v.job_id).slice(0, 5);
  return { strong, stretch, none_reason: strong.length ? null : "No sufficiently strong matches were established from the evidence." };
}
