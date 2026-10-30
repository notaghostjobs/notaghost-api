import { json, FAST, MODEL } from "./claude.js";
import { checkRules, tidy } from "./rules.js";
import { fit, target, v2On } from "./fit.js";

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
  evidence_kind?: "line" | "keyword"; // have_not_said only: a line of the same work, or just a skill/competency word
  suggestion: string;             // how to surface it, or what to do about the gap
  line?: string;                  // have_not_said only: the finished bullet we would write — résumé text, not advice — built only from facts in the résumé
  sayable?: boolean;              // have_not_said only (v2): the suggested line was audited at preview — supported by the résumé and satisfies the requirement
  vet_reason?: string;            // the auditor's one-line reason (kept for audits and the self-test; never shown to users)
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
  return json<{ matches: Match[]; fits: string }>(
    `You compare a candidate against a posting, requirement by requirement. For each requirement pick ONE bucket:
- "said": the résumé states it with specifics — a bullet or line that shows the work (what, where, with what result).
- "have_not_said": the résumé NAMES it but does not show it. Two kinds, and you must say which in evidence_kind:
  "line" — a line a screener would accept as this requirement MET once it is reworded: same activity, same object, same scale class ("Negotiated annual terms with 40 suppliers" for "vendor negotiation"; "led a team of 25 across ops" is NOT "led 5+ category managers"). Quote it verbatim. The test: the line can be restated in the requirement's words WITHOUT adding a fact. Same activity on the same kind of object is a line even if the words differ ("ran selection for 1,200 SKUs" IS a line for "identify selection gaps"; "negotiated annual terms with 40 suppliers" IS a line for "seller negotiations"). It is "keyword" when the requirement needs a scope, stage, seniority, scale or outcome the line does not have ("negotiated" is not "managed deals through closing and delivery"; "led 6 associates" is not "led a team of managers").
  "keyword" — a competency or skills entry naming the SAME specific activity or tool ("Vendor Negotiations & Contracting", "Mixpanel"), or a line that is only ADJACENT or PARTIAL (right activity, different object or scale). Quote it. If you hesitate between line and keyword, it is keyword.
  Generic words are NOT a mention of a specific requirement: "Communication" is not "writes PRDs", "Data-Driven Decision Making" is not "runs experiments", "Leadership" is not "built a team of 5". Those are missing.
- "missing": nothing in the résumé points to this specific requirement — no same-activity line, no same-activity keyword. Test: if asked "where does your résumé mention this?", the candidate could not point to a line that a screener would accept.
Do not stretch across kinds of work: SAP enhancement delivery is not product management; building a dashboard is not category management. A missing must-have is useful information, not a failure.
Grade "said" the way a fair screener would: a plain equivalent anywhere in the résumé counts ("lead a team through 1:1s" satisfies "mentor engineers"; "directly accountable for category P&L" satisfies "owned a category P&L"). Only call it have_not_said when a screener searching for the requirement would genuinely not connect the line.
Evidence must be a verbatim quote from the résumé. suggestion: for said/have_not_said, how to phrase it in the employer's words; for missing, one honest line (adjacent experience to mention, or "don't claim this").
line: for have_not_said ONLY — the finished résumé bullet we would actually write, at most 28 words, starting with a verb, in the requirement's words, built ONLY from facts already in the résumé (the quoted evidence and anything else the résumé states). Résumé text, never advice: not "Reword X as…" but the bullet itself. Numbers exactly as the résumé has them; add no scope, stage, seniority, tool or outcome the résumé does not state. If no honest bullet can satisfy the requirement, write "".`,
    `RÉSUMÉ PROFILE:\n${JSON.stringify(resume)}\n\nPOSTING:\n${JSON.stringify(posting)}\n\nReturn: {matches:[{requirement, kind:"must"|"nice", bucket, evidence, evidence_kind, suggestion, line}], fits}. fits = one plain sentence, under 18 words, naming the kind of role this résumé is actually built for (e.g. "Salesforce technical lead roles on enterprise CRM programmes"). Based on the résumé alone, not this posting.`,
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
/** Grade a résumé (original profile or rewrite) against the requirements the way a fair screener would. Same rubric for before and after. */
export function grade(matches: Match[], doc: unknown, label: "ORIGINAL RÉSUMÉ" | "REWRITE") {
  return json<{ matches: Match[] }>(
    `You grade a résumé against a list of requirements, the way a screener would. For each requirement: "said" if the text states it or a plain equivalent anywhere (headline, summary, a "relevant" block, a bullet, a skills entry) — e.g. "lead a team through 1:1s" satisfies "mentor engineers", "cryptocurrency transactions" satisfies "fintech experience", "cut turnaround 50%" satisfies "improve latency/reliability", "directly accountable for category P&L" satisfies "owned a category P&L". "have_not_said" only if the underlying fact is present but a screener searching for the requirement would not connect it. "missing" if absent. Be fair: this grades what is written, not what could be stretched. Quote the line as evidence.`,
    `${label}:\n${JSON.stringify(doc)}\n\nREQUIREMENTS:\n${JSON.stringify(matches.map((m) => ({ requirement: m.requirement, kind: m.kind })))}\n\nReturn: {matches:[{requirement, kind, bucket, evidence, suggestion}]}`,
    4000, FAST
  );
}
/** v2, at preview, before anything is promised: for each unsaid item, the exact line we would write (its suggestion) is
 *  audited against the résumé — supported (adds no fact) AND satisfies the whole requirement. Only such lines go into the
 *  promise. The same auditor checks the delivered document, so what is promised is what will pass. */
export async function vetLines(resume: ResumeProfile, matches: Match[]): Promise<Match[]> {
  const items = matches.filter((m) => m.bucket === "have_not_said" && (m.line ?? "").trim().length > 0);
  if (!items.length) return matches;
  const r = await json<{ checks: { id: number; supported: boolean; satisfies: boolean; reason: string }[] }>(
    `You are a fair auditor. For EACH numbered proposed résumé line answer two things.
supported: is every FACT in the line already in the ORIGINAL résumé? Facts are numbers, tools, employers, titles, dates, degrees, scope, stage, outcomes. Rewording, synonyms, the employer's vocabulary, and combining two facts from the same role into one sentence are all fine ("Led a team of 6, hiring and training 4, to deliver the FMCG P&L" is supported when the team, the hires and the P&L are all in that role). Fail it ONLY for a fact that is not there: a new number, a new tool, a wider scope or stage ("negotiated terms" → "managed deals through closing"), a higher seniority ("led 6 associates" → "led a team of managers").
satisfies: would a FAIR screener reading that line tick the requirement? A plain equivalent counts: "reviewed vendor scorecards monthly with leadership and negotiated with 40 suppliers" DOES satisfy "work with senior stakeholders, internal and external"; "led a team of 6 to deliver the category P&L" DOES satisfy "lead a team to deliver org goals"; "cut stock-outs from 11% to 4% through inventory planning" DOES satisfy "make data-driven decisions". Fail it ONLY when the requirement asks for something the line does not show at all: a named tool or degree ("Tier 1 MBA"), a stage ("closing deals"), a scale ("teams of 50+"), a domain ("marketplace seller side").
Answer every id; keep reason to one sentence.`,
    `ORIGINAL:\n${JSON.stringify(resume)}\n\nPROPOSED LINES:\n${JSON.stringify(items.map((m, i) => ({ id: i + 1, requirement: m.requirement, line: m.line, rests_on: m.evidence })))}\n\nReturn: {checks:[{id, supported, satisfies, reason}]}`,
    3000, FAST);
  const ok = new Set<string>(); const why = new Map<string, string>();
  for (const c of r.checks ?? []) { const m = items[Number(c.id) - 1]; if (!m) continue; if (c.supported && c.satisfies) ok.add(m.requirement); why.set(m.requirement, `${c.supported ? "supported" : "NOT supported"} · ${c.satisfies ? "satisfies" : "does NOT satisfy"} · ${c.reason ?? ""}`.slice(0, 220)); }
  return matches.map((m) => (m.bucket === "have_not_said" ? { ...m, sayable: ok.has(m.requirement), vet_reason: why.get(m.requirement) } : m));
}

/** v2 delivered score: not a free re-grade (that read moves ±10 between runs) but the preview's own list, each unsaid item
 *  checked one at a time — does the rewrite now state THIS requirement? A narrow yes/no per numbered line is stable. */
export async function saidNow(items: Match[], rewrite: Rewrite): Promise<Record<string, { said: boolean; quote: string }>> {
  if (!items.length) return {};
  const doc = { headline: rewrite.headline, summary: rewrite.summary, relevant: rewrite.relevant, roles: rewrite.roles, skills: rewrite.skills, extra_sections: rewrite.extra_sections };
  const r = await json<{ checks: { id: number; said: boolean; quote: string }[] }>(
    `You check a rewritten résumé against a short numbered list of requirements. For EACH requirement, answer whether a screener searching for it would now tick it from the rewrite — the requirement is stated in plain words (the requirement's own words or an obvious equivalent) somewhere in the headline, summary, "relevant" block, a bullet, a skill or an extra section. Quote the exact line. Judge only presence: is it said, yes or no. Do not re-grade anything else and do not invent. Answer every id.`,
    `REWRITE:\n${JSON.stringify(doc)}\n\nREQUIREMENTS:\n${JSON.stringify(items.map((m, i) => ({ id: i + 1, requirement: m.requirement, evidence_it_should_rest_on: m.evidence })))}\n\nReturn: {checks:[{id, said, quote}]}`,
    2500, FAST);
  const out: Record<string, { said: boolean; quote: string }> = {};
  for (const c of r.checks ?? []) { const m = items[Number(c.id) - 1]; if (m) out[m.requirement] = { said: !!c.said, quote: c.quote ?? "" }; }
  return out;
}

/** Re-bucket the matches against the REWRITE: which requirements does the sharpened text now say? (v1 delivery path) */
export function rescore(matches: Match[], rewrite: Rewrite) {
  return grade(matches, { headline: rewrite.headline, summary: rewrite.summary, relevant: rewrite.relevant, roles: rewrite.roles, skills: rewrite.skills, extra_sections: rewrite.extra_sections }, "REWRITE");
}
/** The before-picture: the matcher's requirements + evidence, with "said" decided by the same fair screener that grades the rewrite. */
export async function matchAndGrade(resume: ResumeProfile, posting: PostingProfile) {
  // the matcher grades as the fair screener itself (rubric in its prompt); then every proposed line is audited, so a v2
  // promise rests only on lines that will pass (v1 ignores the flag)
  const r = await matchResume(resume, posting);
  return { ...r, matches: await vetLines(resume, r.matches) };
}

export async function runSharpen(resume: ResumeProfile, postingText: string, onStage?: (s: string) => void, pre?: { posting: PostingProfile; matches: Match[] }, v2: boolean = v2On()) {
  const t = (label: string) => { onStage?.(label); return Date.now(); };
  const timing: Record<string, number> = {};
  let t0 = t("Reading the posting");
  const posting = pre?.posting ?? (await parsePosting(postingText));
  timing.posting = Date.now() - t0;

  t0 = t("Matching and writing");
  const { matches } = pre ? { matches: pre.matches } : await matchAndGrade(resume, posting);
  const firstDraft = await rewriteResume(resume, posting, MODEL, matches);
  timing.write = Date.now() - t0;
  let rewrite = tidy(firstDraft);

  t0 = t("Checking every claim");
  // the audit and the after-score are independent reads of the same draft: run them together
  let rescoredDraft: Rewrite = rewrite;
  let rescoreP = v2 ? null : rescore(matches, rewrite);
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
    // a single leftover: cut the exact words and re-verify once
    if (!verification.ok && verification.problems.length === 1) {
      rewrite = tidy(await json<Rewrite>(
        `One unsupported phrase remains in a résumé rewrite. DELETE the unsupported words from the sentence they appear in (do not reword, do not add), leaving a grammatical sentence. Change nothing else. Same JSON shape.`,
        `REWRITE:\n${JSON.stringify(rewrite)}\n\nUNSUPPORTED:\n${JSON.stringify(verification.problems[0])}`, 16000, FAST));
      verification = await verifyRewrite(resume, rewrite);
      broken = checkRules(rewrite, resume, posting);
    }
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
  const promised = target(matches, v2);
  const rank = { missing: 0, have_not_said: 1, said: 2 } as const;
  const merge = (rs: Match[]) => matches.map((m) => {
    const r = rs.find((x) => x.requirement === m.requirement);
    if (!r || !(r.bucket in rank)) return m;
    return rank[r.bucket] >= rank[m.bucket] ? { ...m, bucket: r.bucket, evidence: r.evidence || m.evidence } : m;   // never lower than before
  });
  const apply = (checks: Record<string, { said: boolean; quote: string }>, base: Match[]) => base.map((m) => {
    if (m.bucket !== "have_not_said") return m;
    const c = checks[m.requirement];
    return c?.said ? { ...m, bucket: "said" as const, evidence: c.quote || m.evidence } : m;
  });
  let after_matches: Match[];
  if (v2) {
    // v2: the preview's list with each unsaid item checked narrowly against the rewrite — never a fresh free grade
    // only audited (sayable) lines count towards the number: what was promised is exactly what is measured, so the same
    // input gives the same delivered number, run after run
    after_matches = apply(await saidNow(matches.filter((m) => m.bucket === "have_not_said" && m.sayable), rewrite), matches);
  } else {
    if (rewrite !== rescoredDraft) { rescoredDraft = rewrite; rescoreP = rescore(matches, rewrite); }   // only re-run when a repair changed the text
    const { matches: rescored } = await rescoreP!;
    after_matches = merge(rescored);
  }
  // The promise made at preview must hold: while the document falls short and sayable (v2) / quoted (v1) strengths remain
  // unsaid, state them — verified each time. v2 inserts the audited line itself and repairs an overreach instead of
  // discarding the pass. Up to three passes; the material, not the model, decides where it stops.
  for (let pass = 0; pass < 3 && verification.ok && fit(after_matches) < promised; pass++) {
    const unsaid = after_matches.filter((m) => m.bucket === "have_not_said" && m.evidence && (v2 ? m.sayable : true));
    if (!unsaid.length) break;
    t0 = t(pass ? "Closing the gap" : "Saying what you’ve done");
    let pushed = tidy(await json<Rewrite>(
      v2
        ? `A résumé rewrite leaves some of the candidate's real strengths unsaid. For EACH item below, insert the given LINE (already audited against the original — use it as written, or trim it; never widen it) as a bullet in the role where the evidence lives, or in the "relevant" block. If a bullet already covers the same fact, replace that bullet rather than adding a near-duplicate. Change nothing else. Same JSON shape.`
        : `A résumé rewrite leaves some of the candidate's real strengths unsaid. For EACH item below, add or reword ONE line so a screener searching for the requirement would tick it: use the quoted evidence, in the employer's words, placed in the role where the evidence lives (or the relevant block). Never add a fact, number, tool or outcome the evidence does not contain. Change nothing else. Same JSON shape.`,
      `REWRITE:\n${JSON.stringify(rewrite)}\n\nSTILL UNSAID:\n${JSON.stringify(unsaid.map((m) => ({ requirement: m.requirement, evidence: m.evidence, line: v2 ? (m.line || m.suggestion) : m.suggestion })))}`, 16000, FAST));
    let v = await verifyRewrite(resume, pushed);
    let b = checkRules(pushed, resume, posting);
    if ((!v.ok || b.length) && v2) {
      // a line or two overreached: take back exactly those, keep every clean line the pass added
      pushed = tidy(await json<Rewrite>(
        `Some lines in this rewrite overreach the original. For each UNSUPPORTED claim and RULE BREAK below, restore the wording to what the original supports (or remove the added words) — change nothing else, keep every other line exactly as it is. Same JSON shape.`,
        `ORIGINAL:\n${JSON.stringify(resume)}\n\nREWRITE:\n${JSON.stringify(pushed)}\n\nUNSUPPORTED CLAIMS:\n${JSON.stringify(v.problems)}\n\nRULE BREAKS:\n${JSON.stringify(b)}`, 16000, FAST));
      v = await verifyRewrite(resume, pushed);
      b = checkRules(pushed, resume, posting);
    }
    if (!v.ok || b.length) { if (v2) continue; else break; }   // not clean: keep the last clean draft
    const next = v2 ? apply(await saidNow(unsaid, pushed), after_matches) : merge((await rescore(matches, pushed)).matches);
    if (fit(next) <= fit(after_matches)) { if (v2) continue; else break; }   // nothing new verified
    rewrite = pushed; verification = v; broken = b; after_matches = next;
    timing.push = (timing.push ?? 0) + (Date.now() - t0);
  }
  timing.rescore = Date.now() - t0;
  return { posting, matches, after_matches, rewrite, verification, broken, needs_review, timing, first_pass };
}
