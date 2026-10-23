import { json, FAST, MODEL } from "./claude.js";
import { checkRules, tidy } from "./rules.js";

// ---------- types ----------
export interface ResumeProfile {
  name: string;
  headline: string;
  contact: { email?: string; phone?: string; city?: string; links?: string[] };
  years_total: number;
  roles: { company: string; title: string; start: string; end: string; bullets: string[] }[];
  skills: { name: string; evidence: string }[];
  education: { school: string; degree: string; year?: string }[];
  extra_sections: { title: string; items: string[] }[];  // ventures, certifications, languages, awards...
  pages: number;
}

export interface PostingProfile {
  company: string;
  title: string;
  location: string;
  years_required: string;
  must_have: string[];
  nice_to_have: string[];
  company_language: string[];     // phrases they use that a candidate should mirror when true
  red_flags: string[];            // things in the posting worth knowing (e.g. "no salary", "generic JD")
}

export interface Match {
  requirement: string;
  kind: "must" | "nice";
  bucket: "said" | "have_not_said" | "missing";
  evidence: string;               // quote from résumé, or "" if missing
  suggestion: string;             // how to surface it, or what to do about the gap
}

export interface Rewrite {
  headline: string;
  summary: string;                // 2-3 lines, specific to this posting
  roles: { company: string; title: string; start: string; end: string; bullets: string[] }[];
  skills: string[];
  education: ResumeProfile["education"];
  relevant: string[];             // 3-4 lines: proof mapped to the must-haves, in the employer's words
  extra_sections: { title: string; items: string[] }[];
  changes: { what: string; why: string }[];
  referral_note: string;          // ~60 words
  fit_line: string;               // one honest sentence on fit, shown to the user
}

export interface Verification {
  ok: boolean;
  problems: { claim: string; reason: string }[];
}

// ---------- 1. parse résumé (once per upload) ----------
export function parseResume(text: string, pages: number) {
  return json<ResumeProfile>(
    `You turn a résumé into a structured profile. Copy facts exactly; do not improve, infer or embellish. Dates as written. If something is absent, use an empty string or empty array. Bullets are the candidate's own lines, verbatim.`,
    `Résumé (${pages} page(s)):\n\n${text}\n\nReturn: {name, headline, contact{email,phone,city,links[]}, years_total (number), roles[{company,title,start,end,bullets[]}], skills[{name, evidence}], education[{school,degree,year}], extra_sections[{title, items[]}], pages: ${pages}}. Keep every string compact; this must fit in one response. extra_sections = any other block on the résumé (entrepreneurial ventures, certifications, languages, awards, publications), items verbatim. Skip personal details like DOB or marital status.`,
    8000
  );
}

// ---------- 2. parse posting ----------
export function parsePosting(text: string) {
  return json<PostingProfile>(
    `You read a job posting and extract what the employer is actually asking for. Read the WHOLE posting — "what you'll own / responsibilities" bullets count as much as the "requirements" list; a responsibility the role is built around is a must-have. Merge duplicates. Aim for 8–14 must-haves and 2–6 nice-to-haves. Must-haves are explicit requirements or things the role cannot be done without. Nice-to-haves are preferences. company_language = 6-10 short phrases the posting uses to describe the work (e.g. "owning the roadmap", "SQL-first analysis"). red_flags = only things visible in the text (no salary, vague scope, unrealistic stack list, "urgent", posting older than 45 days if dated). Be concrete and short.`,
    `Posting:\n\n${text}\n\nReturn: {company, title, location, years_required, must_have[], nice_to_have[], company_language[], red_flags[]}`,
    2500, FAST
  );
}

// ---------- 3. match ----------
export function matchResume(resume: ResumeProfile, posting: PostingProfile) {
  return json<{ matches: Match[] }>(
    `You compare a candidate against a posting, requirement by requirement. For each requirement pick ONE bucket:
- "said": the résumé clearly states it.
- "have_not_said": the résumé shows the candidate has done it, but under a different name or buried — quote the evidence.
- "missing": no evidence. Do not stretch. A missing must-have is useful information, not a failure.
Evidence must be a verbatim quote from the résumé. suggestion: for said/have_not_said, how to phrase it in the employer's words; for missing, one honest line (adjacent experience to mention, or "don't claim this").`,
    `RÉSUMÉ PROFILE:\n${JSON.stringify(resume)}\n\nPOSTING:\n${JSON.stringify(posting)}\n\nReturn: {matches:[{requirement, kind:"must"|"nice", bucket, evidence, suggestion}]}`,
    6000
  );
}

// ---------- 4. rewrite ----------
export function rewriteResume(resume: ResumeProfile, posting: PostingProfile, model = MODEL, matches: Match[] = []) {
  return json<Rewrite>(
    `You sharpen a résumé for one specific posting. Rules, in order of importance:
0. CHECKLIST. You are given the requirements with their current status. Every requirement marked "have_not_said" MUST end up clearly stated in the rewrite, using the evidence quoted, in the employer's words — in the relevant block AND in the role where the evidence lives. Requirements marked "missing" are never claimed. Stating a have_not_said item means putting the QUOTED EVIDENCE in the employer's framing — never adding a verb the evidence doesn't support ("set targets", "made decisions from data", "owned end-to-end") unless the original says it. If the evidence genuinely doesn't carry the requirement, leave it unsaid and say so in fit_line.
0b. Facts that sit in the original's profile/summary (e.g. "led teams of 250", "reduced CAC") stay in the summary or relevant block; do NOT pin them to a specific employer unless the original does. No derived numbers (years in a sector, totals, averages).
1. NEVER invent. No new employers, titles, dates, degrees, tools, numbers or outcomes. Every bullet must be traceable to the original résumé.
2. The posting's priorities drive the structure. Whatever the role is built around (its first three "own/responsibilities" items) must be visible in the headline area, the summary, the relevant block and the first bullet of the most recent role — if the candidate has evidence for it anywhere, including older roles, ventures or projects, pull it forward. Mirror the posting's language where it is true of the candidate. Cut bullets that don't serve this role (list what you cut in changes). A venture or side project that is the candidate's best evidence for the role moves UP, into or next to Experience, not buried at the end.
2b. Do not leave generic lines ("collaborated with teams to drive growth") in the two most recent roles; either make them specific from facts elsewhere in the résumé or cut them.
3. EXPAND, don't pad. Most résumés under-write. Where a bullet compresses real work ("managed P&L for key categories"), unpack it into 2-3 specific bullets using only facts present anywhere in the résumé (summary, competencies, other roles). Each unpacked bullet must still be traceable. Never add numbers, tools or outcomes that aren't in the source. Target: a dense page — 4-6 bullets per recent role, 2-3 for older ones.
3b. relevant: 3-4 statements, each a complete sentence of at most 28 words, mapping the candidate's proof to the posting's must-haves, in the employer's language (e.g. "Category P&L: ran FMCG & grocery P&L at Ninjacart; 60% of revenue, 5x volume in 100 days"). Only requirements with real evidence — never an absent one.
3c. extra_sections: keep the résumé's own extra blocks (ventures, certifications, languages) tightened to what serves this role; drop personal details.
3d. Length: ${resume.pages} page(s) in, ${resume.pages} page(s) out — full pages, not half.
4. Bullets: start with a verb, one line each, concrete, numbers kept exactly as the original had them.
5. headline: the candidate's real current (or most recent) title, at most 6 words, no pipes or lists (e.g. "Director, FMCG and Grocery"). NEVER the posting's title. The summary (not the headline) is where you frame them for this role. summary: 2-3 lines for this posting, no adjectives like "passionate" or "results-driven".
6. referral_note: ~60 words, first person, to someone at the company — names the role, gives one specific reason the candidate fits, asks for a referral. No flattery.
7. fit_line: one honest sentence to the candidate about their odds here (e.g. "Strong on the core stack; two of five must-haves are missing — apply, but expect questions on X").
8. contact: if the résumé address is in a different country from the posting location, drop the street/area and keep only the country or nothing; note it in changes.
9. changes: every meaningful edit with a one-line why, so the candidate can see exactly what moved.`,
    `ORIGINAL:\n${JSON.stringify(resume)}\n\nPOSTING:\n${JSON.stringify(posting)}\n\nCHECKLIST:\n${JSON.stringify(matches.map((m) => ({ requirement: m.requirement, status: m.bucket, evidence: m.evidence, how: m.suggestion })))}\n\nReturn: {headline, summary, relevant[], roles[{company,title,start,end,bullets[]}], skills[], education[], extra_sections[{title,items[]}], changes[{what,why}], referral_note, fit_line}`,
    16000, model
  );
}

// ---------- 5. verify (separate pass, strict) ----------
export function verifyRewrite(original: ResumeProfile, rewrite: Rewrite) {
  return json<Verification>(
    `You are an auditor. Compare a rewritten résumé against the original profile. Flag ANY claim in the rewrite that the original does not support: a tool, number, outcome, title, employer, date, degree, or responsibility that isn't there. Rewording, reordering, tense changes and synonyms (launched/ran/built; managed/owned) are fine. Mirroring an employer's phrase is fine if the underlying fact exists. Flag only a different FACT: a number, tool, employer, title, date, degree, scope or outcome that the original does not contain. Attributing a fact to the wrong employer/role IS a problem. If nothing is unsupported, ok=true with an empty list.`,
    `ORIGINAL:\n${JSON.stringify(original)}\n\nREWRITE:\n${JSON.stringify({ headline: rewrite.headline, summary: rewrite.summary, relevant: rewrite.relevant, roles: rewrite.roles, skills: rewrite.skills, education: rewrite.education, extra_sections: rewrite.extra_sections })}\n\nReturn: {ok: boolean, problems:[{claim, reason}]}`,
    3000, FAST
  );
}

// ---------- orchestration ----------
/** Re-bucket the matches against the REWRITE: which requirements does the sharpened text now say? */
export function rescore(matches: Match[], rewrite: Rewrite) {
  return json<{ matches: Match[] }>(
    `You re-check a list of requirement matches against a REWRITTEN résumé. For each requirement keep kind and requirement; set bucket to "said" if the rewrite now clearly states it, "have_not_said" if the evidence is in the rewrite but not framed to the requirement, "missing" if absent. Do not invent evidence. Keep evidence/suggestion short.`,
    `REWRITE:\n${JSON.stringify({ headline: rewrite.headline, summary: rewrite.summary, relevant: rewrite.relevant, roles: rewrite.roles, skills: rewrite.skills, extra_sections: rewrite.extra_sections })}\n\nREQUIREMENTS:\n${JSON.stringify(matches.map((m) => ({ requirement: m.requirement, kind: m.kind, bucket_before: m.bucket })))}\n\nReturn: {matches:[{requirement, kind, bucket, evidence, suggestion}]}`,
    4000, FAST
  );
}

export async function runSharpen(resume: ResumeProfile, postingText: string, onStage?: (s: string) => void, pre?: { posting: PostingProfile; matches: Match[] }) {
  const t = (label: string) => { onStage?.(label); return Date.now(); };
  const timing: Record<string, number> = {};
  let t0 = t("Reading the posting");
  const posting = pre?.posting ?? (await parsePosting(postingText));
  timing.posting = Date.now() - t0;

  t0 = t("Matching and writing");
  const { matches } = pre ? { matches: pre.matches } : await matchResume(resume, posting);
  const firstDraft = await rewriteResume(resume, posting, MODEL, matches);
  timing.write = Date.now() - t0;
  let rewrite = tidy(firstDraft);

  t0 = t("Checking every claim");
  let verification = await verifyRewrite(resume, rewrite);
  let broken = checkRules(rewrite, resume, posting);
  timing.verify = Date.now() - t0;
  const draft0 = { rewrite, verification, broken };

  const first_pass = { problems: verification.problems, broken };
  if (!verification.ok || broken.length) {
    // one repair pass on the fast model: feed back problems + broken rules
    t0 = t("Fixing a few things");
    rewrite = await json<Rewrite>(
      `Fix a résumé rewrite. For each flagged claim: delete the unsupported words or move the fact back to where the original has it (summary vs. role). Prefer deleting to rewording. Change nothing else. Rules: title = candidate's real title (≤6 words); summary 35–80 words; relevant 3–4 lines ≤30 words; bullets ≤30 words, start with a verb, none repeated, 4–6 on the two most recent roles and 2–4 on older ones; skills 6–14; no personal details; no numbers that aren't in the original. Keep the same JSON shape.`,
      `ORIGINAL:\n${JSON.stringify(resume)}\n\nREWRITE:\n${JSON.stringify(rewrite)}\n\nUNSUPPORTED CLAIMS:\n${JSON.stringify(verification.problems)}\n\nRULE BREAKS:\n${JSON.stringify(broken)}`,
      16000, FAST
    );
    rewrite = tidy(rewrite);
    verification = await verifyRewrite(resume, rewrite);
    broken = checkRules(rewrite, resume, posting);
    timing.repair = Date.now() - t0;
    // repair made it worse? keep the first draft
    if (verification.problems.length + broken.length > draft0.verification.problems.length + draft0.broken.length) ({ rewrite, verification, broken } = draft0);
  }
  if (!verification.ok && verification.problems.length > 1) {
    // still has more than one unsupported claim: one full regeneration on the stronger model, then accept what we have and flag for review
    t0 = t("Taking another pass");
    const second = tidy(await rewriteResume(resume, posting, MODEL));
    const v2 = await verifyRewrite(resume, second);
    const b2 = checkRules(second, resume, posting);
    if (v2.problems.length + b2.length < verification.problems.length + broken.length) { rewrite = second; verification = v2; broken = b2; }
    timing.regen = Date.now() - t0;
  }
  const needs_review = !verification.ok || broken.length > 0;
  t0 = t("Scoring the result");
  const { matches: rescored } = await rescore(matches, rewrite);
  const rank = { missing: 0, have_not_said: 1, said: 2 } as const;
  const after_matches = matches.map((m) => {
    const r = rescored.find((x) => x.requirement === m.requirement) ?? m;
    return rank[r.bucket] >= rank[m.bucket] ? r : m;   // never lower than before
  });
  timing.rescore = Date.now() - t0;
  return { posting, matches, after_matches, rewrite, verification, broken, needs_review, timing, first_pass };
}
