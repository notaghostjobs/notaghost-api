import { placeTold, holdLines, dedupe } from "./refile.js";
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
  candidate_added_facts?: { requirement: string; fact: string }[];   // answers the candidate typed for requirements the résumé lacked; part of the "original" for every audit, never a section of the document
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
  options?: string[];             // missing only: three honest ways someone could have done this, for the candidate to tap
  told?: boolean;                 // the requirement was missing from the résumé; the candidate answered it in one vetted line (evidence = their words, line = the bullet)
  remembered?: boolean;           // told, but from an answer they gave on an earlier posting (the answers bank), pre-filled
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
/** The clerk. Given the page itself (PDF) it reads the layout the way a person does — which column is which, where each
 *  role starts and ends — and fills the form from that; the extracted text rides along as the character-exact copy, so
 *  every word, number and date is copied from text, never read off pixels. A .docx/.doc has no page to show: text only,
 *  which is already in reading order. */
export function parseResume(text: string, pages: number, pdf?: Buffer) {
  const form = `Return: {name, headline, contact{email,phone,city,links[]}, years_total (number), roles[{company,title,start,end,bullets[]}], skills[{name, evidence}], education[{school,degree,year}], extra_sections[{title, items[]}], pages: ${pages}}. Keep every string compact; this must fit in one response. extra_sections = any other block on the résumé (entrepreneurial ventures, certifications, languages, awards, publications), items verbatim. Skip personal details like DOB or marital status.`;
  const rules = `You turn a résumé into a structured profile. Copy facts exactly; do not improve, infer or embellish. Dates as written. If something is absent, use an empty string or empty array. Bullets are the candidate's own lines, verbatim — every line under a role, none skipped, none merged, each under the role it is written under. A role's lines are everything between its heading and the next role's heading, including any "Responsibilities" or "Highlights" block and lines that continue onto the next page or column; those sub-heading labels themselves are not bullets. Sidebar content (contact, skills, education, languages, personal details) is never a role's bullet; a bullet appears once, under one role.`;
  if (pdf && !text.trim()) return json<ResumeProfile>(
    rules + ` This PDF has no text layer: you are given the page(s) only. Read every word from the page carefully — names, numbers, dates and symbols exactly as printed; if a character is not legible, leave that field empty rather than guess.`,
    `The résumé is the ${pages} page(s) above.\n\n${form}`,
    8000, MODEL, pdf
  );
  if (pdf) return json<ResumeProfile>(
    rules + ` You are given the résumé twice: the PDF page(s), and the plain text extracted from them. Use the PAGE to understand the layout — which column is which, where each role begins and ends, what sits under which heading (a two-column résumé's plain text comes out interleaved; the page does not). Use the TEXT to copy characters: every word, number, date, name and symbol exactly as the text has it.`,
    `PLAIN TEXT of the ${pages} page(s) above:\n\n${text}\n\n${form}`,
    8000, MODEL, pdf
  );
  return json<ResumeProfile>(rules, `Résumé (${pages} page(s)):\n\n${text}\n\n${form}`, 8000);
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
    `POSTING:\n${JSON.stringify(posting)}\n\nReturn: {matches:[{requirement, kind:"must"|"nice", bucket, evidence, evidence_kind, suggestion, line}], fits}. fits = one plain sentence, under 18 words, naming the kind of role this résumé is actually built for (e.g. "Salesforce technical lead roles on enterprise CRM programmes"). Based on the résumé alone, not this posting.`,
    6000, MODEL, undefined, `RÉSUMÉ PROFILE:\n${JSON.stringify(resume)}`
  );
}

// ---------- 4. rewrite ----------
export function rewriteResume(resume: ResumeProfile, posting: PostingProfile, model = MODEL, matches: Match[] = []) {
  return json<Rewrite>(
    `You sharpen a résumé for one specific posting. Rules, in order of importance:
0. CHECKLIST. You are given the requirements with their current status. Every requirement marked "have_not_said" MUST end up clearly stated in the rewrite, using the evidence quoted, in the employer's words — in the relevant block AND in the role where the evidence lives. Requirements marked "missing" are never claimed. Stating a have_not_said item means putting the QUOTED EVIDENCE in the employer's framing — never adding a verb the evidence doesn't support ("set targets", "made decisions from data", "owned end-to-end") unless the original says it. If the evidence genuinely doesn't carry the requirement, leave it unsaid and say so in fit_line.
0a. A requirement marked told:true was answered by the candidate in our questionnaire; its line is theirs, not any employer's. Put that line in the relevant block, exactly as given. Put it inside a role ONLY if the line itself names that employer ("… at Ninjacart"); never file it under any other company, however plausible.
0b. Facts that sit in the original's profile/summary (e.g. "led teams of 250", "reduced CAC") stay in the summary or relevant block; do NOT pin them to a specific employer unless the original does. No derived numbers (years in a sector, totals, averages).
1. NEVER invent. No new employers, titles, dates, degrees, tools, numbers or outcomes. Every bullet must be traceable to the original résumé.
2. The posting's priorities drive the headline area, the summary and the relevant block — whatever the role is built around (its first three "own/responsibilities" items) must be visible there, with the candidate's evidence for it, wherever it sits in the résumé. Mirror the posting's language where it is true of the candidate. Under EXPERIENCE the candidate's own lines rule: a bullet that is NOT the quoted evidence for a checklist requirement is copied EXACTLY, character for character, in its original position — not tightened, not "improved", not re-ordered. Only a bullet that IS quoted evidence for a have_not_said requirement may be reworded into the employer's words (or split into two), and it stays in that bullet's position. New lines (the owed lines, the candidate's told lines) go AFTER the role's existing lines. NEVER cut a bullet, merge bullets, or move a bullet to another role or section. A venture or side project that is the candidate's best evidence stays in its own block; mention it in the summary or relevant block instead of moving it.
2b. Generic lines ("collaborated with teams to drive growth") are left exactly as the candidate wrote them. Never cut them; make the specifics visible in the summary or relevant block instead.
3. Do not pad. Unpacking a compressed bullet into 2-3 specific ones is allowed ONLY for a bullet that is quoted evidence, and only with facts present in the résumé; the original bullet's words and numbers survive in the result. Everything else stays as written. EVERY role keeps its OWN bullets: never a role with only a title and dates, never a role's lines moved elsewhere.
3b. relevant: at most 3 short statements (each at most 24 words) mapping the candidate's proof to the posting's must-haves, in the employer's language — each one a pointer to proof, never a copy of an experience bullet (a fact lives in one place: if it is a bullet under a role, the relevant block refers to it in a few words, it does not repeat it). Only requirements with real evidence — never an absent one. Omit the block entirely if nothing earns it.
3b2. skills: the candidate's skills section exactly as written — if it is grouped ("Tools: SQL, Tableau, …"), keep every group and every item as one string per group ("Tools: SQL, Tableau, Amplitude"); you may put the group the posting cares about first. Never drop an item, never collapse a group to its name.
3c. extra_sections: keep the résumé's own extra blocks (ventures, certifications, languages, awards) as written; drop personal details. Never add a block that restates experience ("Skills detail", "Key achievements"): a fact appears once.
3d. Length: ${resume.pages} page(s) in, ${Math.min(2, Math.max(1, resume.pages))} page(s) out — never more than two pages. Never cut a fact to fit — shorten the summary and the relevant block first. The summary never repeats a bullet; it says what the bullets add up to.
3e. TODAY is ${new Date().toISOString().slice(0, 10)}. A role or degree whose end date is before today is finished: a completed degree is stated as held ("MBA, Mannheim Business School"), never as "candidate", "pursuing" or "in progress"; an ended role is never described as current. Education entries keep their school, degree and dates exactly.
4. Bullets: start with a verb, one line each, concrete, numbers kept exactly as the original had them.
5. headline: the candidate's real current (or most recent) title, at most 6 words, no pipes or lists (e.g. "Director, FMCG and Grocery"). NEVER the posting's title. The summary (not the headline) is where you frame them for this role. summary: 2-3 lines for this posting, no adjectives like "passionate" or "results-driven".
6. referral_note: under 200 characters INCLUDING spaces (LinkedIn's connection-note limit), first person, to someone at the company — names the role, one specific reason the candidate fits, asks for a referral. No greeting line, no flattery, no sign-off.
7. fit_line: one honest sentence to the candidate about their odds here (e.g. "Strong on the core stack; two of five must-haves are missing — apply, but expect questions on X").
8. contact: if the résumé address is in a different country from the posting location, drop the street/area and keep only the country or nothing; note it in changes.
9. changes: every meaningful edit with a one-line why, so the candidate can see exactly what moved.`,
    `ORIGINAL:\n${JSON.stringify(resume)}\n\nPOSTING:\n${JSON.stringify(posting)}\n\nCHECKLIST:\n${JSON.stringify(matches.map((m) => ({ requirement: m.requirement, status: m.bucket, evidence: m.evidence, how: m.suggestion })))}${matches.some((m) => m.sayable && m.line) ? `\n\nMANDATORY BULLETS — these sentences were audited against the original and MUST appear in the rewrite word for word (you may only trim trailing words), each as a bullet in the role whose evidence it quotes, or in the "relevant" block if the evidence is from the profile. Do not paraphrase them; do not merge them into other bullets:\n${JSON.stringify(matches.filter((m) => m.sayable && m.line).map((m) => ({ requirement: m.requirement, bullet: m.line, evidence: m.evidence })))}` : ""}\n\nReturn: {headline, summary, relevant[], roles[{company,title,start,end,bullets[]}], skills[], education[], extra_sections[{title,items[]}], changes[{what,why}], referral_note, fit_line}`,
    16000, model
  );
}

// ---------- 5. verify (separate pass, strict) ----------
export function verifyRewrite(original: ResumeProfile, rewrite: Rewrite) {
  return json<Verification>(
    `You are an auditor. Compare a rewritten résumé against the original profile. Flag ANY claim in the rewrite that the original does not support: a tool, number, outcome, title, employer, date, degree, or responsibility that isn't there. Rewording, reordering, tense changes and synonyms (launched/ran/built; managed/owned) are fine. Mirroring an employer's phrase is fine if the underlying fact exists. Flag only a different FACT: a number, tool, employer, title, date, degree, scope or outcome that the original does not contain. Attributing a fact to the wrong employer/role IS a problem. If nothing is unsupported, ok=true with an empty list.`,
    `ORIGINAL:\n${JSON.stringify(original)}\n\nREWRITE:\n${JSON.stringify({ headline: rewrite.headline, summary: rewrite.summary, relevant: rewrite.relevant, roles: rewrite.roles, skills: rewrite.skills, education: rewrite.education, extra_sections: rewrite.extra_sections })}\n\nReturn: {ok: boolean, problems:[{claim, reason}]}`,
    3000, MODEL
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
/** Every unsaid item with a quoted LINE of evidence gets a finished bullet. The matcher sometimes leaves `line` blank; this
 *  writes exactly those, from the evidence alone, so nothing is left unaudited for want of a sentence. */
export async function fillLines(resume: ResumeProfile, matches: Match[]): Promise<Match[]> {
  const gaps = matches.filter((m) => m.bucket === "have_not_said" && !(m.line ?? "").trim());
  if (!gaps.length) return matches;
  const r = await json<{ lines: { id: number; line: string }[] }>(
    `For EACH numbered item, write the finished résumé bullet we would insert: at most 28 words, starts with a verb, in the requirement's own words where the facts allow, built ONLY from the quoted evidence and other facts stated in the ORIGINAL résumé. Numbers exactly as the résumé has them. Add no scope, stage, seniority, tool or outcome the résumé does not state. If no honest bullet can be written, return "". Résumé text, never advice.`,
    `ITEMS:\n${JSON.stringify(gaps.map((m, i) => ({ id: i + 1, requirement: m.requirement, evidence: m.evidence })))}\n\nReturn: {lines:[{id, line}]}`,
    2500, FAST, undefined, `ORIGINAL:\n${JSON.stringify(resume)}`);
  const by = new Map<string, string>();
  for (const l of r.lines ?? []) { const m = gaps[Number(l.id) - 1]; if (m && (l.line ?? "").trim()) by.set(m.requirement, l.line.trim()); }
  return matches.map((m) => (by.has(m.requirement) ? { ...m, line: by.get(m.requirement) } : m));
}

export async function vetLines(resume: ResumeProfile, matches0: Match[]): Promise<Match[]> {
  const matches = await fillLines(resume, matches0);
  const items = matches.filter((m) => m.bucket === "have_not_said" && (m.line ?? "").trim().length > 0);
  if (!items.length) return matches;
  const r = await json<{ checks: { id: number; supported: boolean; satisfies: boolean; reason: string }[] }>(
    `You are a fair auditor. For EACH numbered proposed résumé line answer two things.
supported: is every FACT in the line already in the ORIGINAL résumé? Facts are numbers, tools, employers, titles, dates, degrees, scope, stage, outcomes. Rewording, synonyms, the employer's vocabulary, and combining two facts from the same role into one sentence are all fine ("Led a team of 6, hiring and training 4, to deliver the FMCG P&L" is supported when the team, the hires and the P&L are all in that role). Fail it ONLY for a fact that is not there: a new number, a new tool, a wider scope or stage ("negotiated terms" → "managed deals through closing"), a higher seniority ("led 6 associates" → "led a team of managers").
satisfies: would a FAIR screener, scanning for this requirement, tick this line? The bar is the requirement's CORE activity on the same kind of object — not every clause of a long requirement sentence. Employers write requirements as paragraphs ("identify gaps and track the brand's offline catalogue to ensure relevant selection is on Amazon"); a screener ticks "building selection" when they see assortment/selection ownership, and does not demand the words "offline catalogue" or "Amazon". So: "led development of product assortments aligned with customer demand" DOES satisfy a "building selection" requirement; "reviewed vendor scorecards monthly with leadership and negotiated with 40 suppliers" DOES satisfy "work with senior stakeholders"; "led a team of 6 to deliver the category P&L" DOES satisfy "lead a team to deliver org goals"; "cut stock-outs from 11% to 4% through inventory planning" DOES satisfy "make data-driven decisions". Fail it ONLY when the core activity itself is absent, or the requirement's defining qualifier is a hard fact the line cannot show: a named tool or degree ("3+ years of Excel" is not shown by "Microsoft Office Suite"; "Tier 1 MBA"), a stage ("closing deals" vs "negotiated"), a scale ("teams of 50+"), a distinct domain ("marketplace seller side" vs buying).
Answer every id; keep reason to one sentence.`,
    `PROPOSED LINES:\n${JSON.stringify(items.map((m, i) => ({ id: i + 1, requirement: m.requirement, line: m.line, rests_on: m.evidence })))}\n\nReturn: {checks:[{id, supported, satisfies, reason}]}`,
    3000, FAST, undefined, `ORIGINAL:\n${JSON.stringify(resume)}`);
  const ok = new Set<string>(); const why = new Map<string, string>(); const fixedLine = new Map<string, string>();
  const verdicts = new Map<string, { supported: boolean; satisfies: boolean; reason: string }>();
  for (const c of r.checks ?? []) { const m = items[Number(c.id) - 1]; if (!m) continue; verdicts.set(m.requirement, { supported: !!c.supported, satisfies: !!c.satisfies, reason: c.reason ?? "" }); }
  // a line that satisfies the requirement but overreaches the résumé is repaired once — cut back to the quoted evidence — and audited again.
  // The fault was the sentence, not the fact; throwing the item away would hide a real strength.
  const overreach = items.filter((m) => { const v = verdicts.get(m.requirement); return v && v.satisfies && !v.supported; });
  if (overreach.length) {
    const r2 = await json<{ lines: { id: number; line: string }[] }>(
      `Each numbered line overreaches the ORIGINAL résumé in the way described. Rewrite it so it claims ONLY what the quoted evidence and the original state — remove the added tool, scope, number or outcome — while still stating the requirement's core activity in its own words. At most 28 words, starts with a verb. Return "" only if nothing honest remains.`,
      `LINES:\n${JSON.stringify(overreach.map((m, i) => ({ id: i + 1, requirement: m.requirement, line: m.line, evidence: m.evidence, problem: verdicts.get(m.requirement)!.reason })))}\n\nReturn: {lines:[{id, line}]}`,
      2500, FAST, undefined, `ORIGINAL:\n${JSON.stringify(resume)}`);
    const retry: Match[] = [];
    for (const l of r2.lines ?? []) { const m = overreach[Number(l.id) - 1]; if (m && (l.line ?? "").trim()) { fixedLine.set(m.requirement, l.line.trim()); retry.push({ ...m, line: l.line.trim() }); } }
    if (retry.length) {
      const r3 = await json<{ checks: { id: number; supported: boolean; satisfies: boolean; reason: string }[] }>(
        `You are a fair auditor. For EACH numbered proposed résumé line: supported = every fact in the line is already in the ORIGINAL résumé (rewording and the employer's vocabulary are fine; a new tool, number, scope, stage or outcome is not). satisfies = a fair screener scanning for the requirement would tick this line on its core activity. Answer every id, one-sentence reason.`,
        `PROPOSED LINES:\n${JSON.stringify(retry.map((m, i) => ({ id: i + 1, requirement: m.requirement, line: m.line, rests_on: m.evidence })))}\n\nReturn: {checks:[{id, supported, satisfies, reason}]}`,
        3000, FAST, undefined, `ORIGINAL:\n${JSON.stringify(resume)}`);
      for (const c of r3.checks ?? []) { const m = retry[Number(c.id) - 1]; if (m) verdicts.set(m.requirement, { supported: !!c.supported, satisfies: !!c.satisfies, reason: `repaired · ${c.reason ?? ""}` }); }
    }
  }
  for (const [req, v] of verdicts) { if (v.supported && v.satisfies) ok.add(req); why.set(req, `${v.supported ? "supported" : "NOT supported"} · ${v.satisfies ? "satisfies" : "does NOT satisfy"} · ${v.reason}`.slice(0, 220)); }
  // Floor: the matcher already graded these as a LINE of the same work (same activity, same object, same scale class). When the
  // auditor's only objection is wording — "does not show X" where X is a qualifier, not a hard fact (tool, degree, number,
  // seniority, stage, domain) — the line stands. Hard-fact objections keep the no.
  const HARD = /\b(tool|degree|mba|tier|years?|\d+\+?|team of|seniority|c-level|executive|closing|close|marketplace|seller|excel|sql|tableau|python|certif)/i;
  for (const m of items) {
    if (ok.has(m.requirement) || m.evidence_kind !== "line") continue;
    const v = verdicts.get(m.requirement); if (!v || !v.supported) continue;
    if (!HARD.test(m.requirement) && !HARD.test(v.reason)) { ok.add(m.requirement); why.set(m.requirement, `supported · floor: same-work line, no hard fact missing · ${v.reason}`.slice(0, 220)); }
  }
  return matches.map((m) => (m.bucket === "have_not_said" ? { ...m, line: fixedLine.get(m.requirement) ?? m.line, sayable: ok.has(m.requirement), vet_reason: why.get(m.requirement) } : m));
}

/** v2 delivered score: not a free re-grade (that read moves ±10 between runs) but the preview's own list, each unsaid item
 *  checked one at a time — does the rewrite now state THIS requirement? A narrow yes/no per numbered line is stable. */
/** The document as a screener reads it: the six fields that are printed. The change log, referral note and fit line are NOT the document
 *  and never count as "said" — placement and scoring both read exactly this. */
export const docOf = (r: Rewrite) => ({ headline: r.headline, summary: r.summary, relevant: r.relevant, roles: r.roles, skills: r.skills, extra_sections: r.extra_sections });

export async function saidNow(items: Match[], rewrite: Rewrite): Promise<Record<string, { said: boolean; quote: string }>> {
  if (!items.length) return {};
  const doc = docOf(rewrite);
  // the promised sentence is in the document: that is a yes, no model needed. Only lines that were altered go to the checker.
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const hay = norm(JSON.stringify(doc));
  const out: Record<string, { said: boolean; quote: string }> = {};
  const ask: Match[] = [];
  for (const m of items) {
    const l = (m.line ?? "").trim();
    const core = l ? norm(l).split(" ").slice(0, 10).join(" ") : "";
    if (core && core.split(" ").length >= 3 && hay.includes(core)) out[m.requirement] = { said: true, quote: l };   // the exact sentence is in the document: said
    else ask.push(m);
  }
  if (!ask.length) return out;
  items = ask;
  const r = await json<{ checks: { id: number; said: boolean; quote: string }[] }>(
    `You check a rewritten résumé against a short numbered list of requirements. For EACH requirement, answer whether a screener searching for it would now tick it from the rewrite — the requirement is stated in plain words (the requirement's own words or an obvious equivalent) somewhere in the headline, summary, "relevant" block, a bullet, a skill or an extra section. Quote the exact line. Judge only presence: is it said, yes or no. Do not re-grade anything else and do not invent. Answer every id.`,
    `REWRITE:\n${JSON.stringify(doc)}\n\nREQUIREMENTS:\n${JSON.stringify(items.map((m, i) => ({ id: i + 1, requirement: m.requirement, evidence_it_should_rest_on: m.evidence })))}\n\nReturn: {checks:[{id, said, quote}]}`,
    2500, FAST);
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

export async function runSharpen(resume: ResumeProfile, postingText: string, onStage?: (s: string) => void, pre?: { posting: PostingProfile; matches: Match[] }, v2: boolean = v2On(), draftP: Promise<Rewrite> | null = null) {
  const t = (label: string) => { onStage?.(label); return Date.now(); };
  const timing: Record<string, number> = {};
  let t0 = t("Reading the posting");
  const posting = pre?.posting ?? (await parsePosting(postingText));
  timing.posting = Date.now() - t0;

  t0 = t("Matching and writing");
  const { matches } = pre ? { matches: pre.matches } : await matchAndGrade(resume, posting);
  const firstDraft = draftP ? await draftP.catch(() => rewriteResume(resume, posting, MODEL, matches)) : await rewriteResume(resume, posting, MODEL, matches);
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
      `Fix a résumé rewrite. For each flagged claim: delete the unsupported words or move the fact back to where the original has it (summary vs. role). Prefer deleting to rewording. Change nothing else. Rules: title = candidate's real title (≤6 words); summary 35–80 words; relevant at most 3 lines ≤24 words, pointers to proof, never a copy of a bullet; new bullets ≤30 words and start with a verb; none repeated; every original bullet stays in its role EXACTLY as written and in its original order (never touch a bullet that is not flagged); skills 6–14; no personal details; no numbers that aren't in the original. Keep the same JSON shape.`,
      `ORIGINAL:\n${JSON.stringify(resume)}\n\nREWRITE:\n${JSON.stringify(rewrite)}\n\nUNSUPPORTED CLAIMS:\n${JSON.stringify(verification.problems)}\n\nRULE BREAKS:\n${JSON.stringify(broken)}`,
      16000, MODEL
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
        `REWRITE:\n${JSON.stringify(rewrite)}\n\nUNSUPPORTED:\n${JSON.stringify(verification.problems[0])}`, 16000, MODEL));
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
        ? `A résumé rewrite is missing bullets that were promised. For EACH item below, insert the given LINE EXACTLY as written (no paraphrase, no merging, no added words) as a bullet in the role where the evidence lives — or in the "relevant" block if the evidence is from the profile. If an existing bullet covers the same fact, replace that bullet with this exact line. Change nothing else. Same JSON shape.`
        : `A résumé rewrite leaves some of the candidate's real strengths unsaid. For EACH item below, add or reword ONE line so a screener searching for the requirement would tick it: use the quoted evidence, in the employer's words, placed in the role where the evidence lives (or the relevant block). Never add a fact, number, tool or outcome the evidence does not contain. Change nothing else. Same JSON shape.`,
      `REWRITE:\n${JSON.stringify(rewrite)}\n\nSTILL UNSAID:\n${JSON.stringify(unsaid.map((m) => ({ requirement: m.requirement, evidence: m.evidence, line: v2 ? (m.line || m.suggestion) : m.suggestion })))}`, 16000, MODEL));
    let v = await verifyRewrite(resume, pushed);
    let b = checkRules(pushed, resume, posting);
    if ((!v.ok || b.length) && v2) {
      // a line or two overreached: take back exactly those, keep every clean line the pass added
      pushed = tidy(await json<Rewrite>(
        `Some lines in this rewrite overreach the original. For each UNSUPPORTED claim and RULE BREAK below, restore the wording to what the original supports (or remove the added words) — change nothing else, keep every other line exactly as it is. Same JSON shape.`,
        `ORIGINAL:\n${JSON.stringify(resume)}\n\nREWRITE:\n${JSON.stringify(pushed)}\n\nUNSUPPORTED CLAIMS:\n${JSON.stringify(v.problems)}\n\nRULE BREAKS:\n${JSON.stringify(b)}`, 16000, MODEL));
      v = await verifyRewrite(resume, pushed);
      b = checkRules(pushed, resume, posting);
    }
    if (!v.ok || b.length) { if (v2) continue; else break; }   // not clean: keep the last clean draft
    const next = v2 ? apply(await saidNow(unsaid, pushed), after_matches) : merge((await rescore(matches, pushed)).matches);
    if (fit(next) <= fit(after_matches)) { if (v2) continue; else break; }   // nothing new verified
    rewrite = pushed; verification = v; broken = b; after_matches = next;
    timing.push = (timing.push ?? 0) + (Date.now() - t0);
  }
  // The promise is a list of exact sentences we hold: audited lines from the résumé and lines the candidate told us. Any of
  // them the draft still lacks is placed by us, word for word, in the role its evidence names (else the "relevant" block).
  // The delivered number is then the promise by construction: a shot spent is a promise kept, never a refund.
  if (v2) {
    const owed = after_matches.filter((m) => m.bucket === "have_not_said" && m.sayable && (m.line ?? "").trim());
    if (owed.length) {
      const placed = placeLines(rewrite, owed, resume);
      if (placed.n) {
        rewrite = placed.rewrite; verification = await verifyRewrite(resume, rewrite); broken = checkRules(rewrite, resume, posting);
        after_matches = apply(await saidNow(owed, rewrite), after_matches);
        timing.place = placed.n;
        const still = after_matches.filter((m) => m.bucket === "have_not_said" && m.sayable && (m.line ?? "").trim());
        if (still.length) console.error("[sharpen] PLACED BUT NOT COUNTED", still.map((m) => m.line));
      }
    }
  }
  timing.rescore = Date.now() - t0;
  // never ship a role stripped of its work: any role the original describes keeps at least its share of bullets
  const restored = restoreRoles(rewrite, resume);
  if (restored.n) { rewrite = restored.rewrite; broken = checkRules(rewrite, resume, posting); timing.restored = restored.n; console.error("[sharpen] RESTORED ROLE BULLETS", restored.n); }
  // FACT GUARD (deterministic, after every model pass). Two halves:
  //  1. nothing of the original is lost — every bullet (by its numbers and words), skill, education entry and extras item is
  //     in the document, in its own place; anything missing is put back verbatim and the weaker paraphrase it replaced removed;
  //  2. nothing is in the document that the original doesn't have — every number in the output must appear in the original
  //     (or in what the candidate told us); a finished degree is never "candidate". Leftovers get one deletion pass; if any
  //     remain, the shot FAILS and is refunded — a wrong résumé is never delivered.
  const kept = preserveFacts(rewrite, resume);
  if (kept.n) { rewrite = kept.rewrite; timing.preserved = kept.n; console.error("[sharpen] PRESERVED FACTS", kept.n, kept.log); }
  // a questionnaire line sits inside a role only when it names that employer; otherwise it is the candidate's own claim, at the top
  const placedTold = placeTold(rewrite, matches.filter((m) => m.told && m.line), resume);
  if (placedTold.log.length) { rewrite = placedTold.rewrite; timing.told_moved = placedTold.log.length; console.error("[sharpen] TOLD LINES PLACED", placedTold.log); }
  // the candidate's lines rule: every bullet that is not quoted evidence goes back exactly as written, in its original order
  const held = holdLines(rewrite, resume, matches);
  if (held.log.length) { rewrite = held.rewrite; timing.held = held.log.length; console.error("[sharpen] LINES HELD", held.log); }
  // a fact lives in one place: the summary, the relevant block and extras never repeat an experience line
  const dd = dedupe(rewrite, matches.filter((m) => m.bucket === "have_not_said" && m.line).map((m) => m.line!));
  if (dd.log.length) { rewrite = dd.rewrite; timing.deduped = dd.log.length; console.error("[sharpen] REPEATS DROPPED", dd.log); }
  let foreign = factAudit(rewrite, resume);
  if (foreign.length) {
    t0 = t("Checking every number");
    const fixed = tidy(await json<Rewrite>(
      `A résumé rewrite contains claims the original résumé does not support. For each item below, DELETE the unsupported number or phrase from the sentence it appears in (do not reword, do not substitute another number), leaving a grammatical sentence; where the item says a degree is finished, state it as held. Change nothing else. Same JSON shape.`,
      `ORIGINAL:\n${JSON.stringify(resume)}\n\nREWRITE:\n${JSON.stringify(rewrite)}\n\nUNSUPPORTED:\n${JSON.stringify(foreign)}`, 16000, MODEL));
    const again = preserveFacts(fixed, resume);
    const f2 = factAudit(again.rewrite, resume);
    if (f2.length < foreign.length) { rewrite = again.rewrite; foreign = f2; verification = await verifyRewrite(resume, rewrite); broken = checkRules(rewrite, resume, posting); }
    timing.factfix = Date.now() - t0;
  }
  if (foreign.length) {
    console.error("[sharpen] FACT AUDIT FAILED — shot refused", foreign);
    throw Object.assign(new Error("We couldn’t verify every line of the result against your résumé, so we didn’t deliver it. Nothing was used — try again in a minute."), { status: 500, foreign });
  }
  // the change log is written LAST, from the final document, and every line of it must quote that document (10 Nov: the
  // first draft's log described edits the fix passes had since deleted, so the "what changed" page did not match the résumé)
  t0 = t("Writing what changed");
  rewrite = { ...rewrite, changes: await changesFromDiff(resume, rewrite), referral_note: fitNote(rewrite.referral_note) };
  timing.changes = Date.now() - t0;
  return { posting, matches, after_matches, rewrite, verification, broken, needs_review: needs_review || !verification.ok || broken.length > 0, timing, first_pass };
}

const normText = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
/** What moved, read off BEFORE and AFTER by a reader who sees only those two — then kept only where its quote is really in
 *  AFTER (a removal must quote what BEFORE had and AFTER lacks). The log can no longer say something the résumé does not show. */
export async function changesFromDiff(before: ResumeProfile, after: Rewrite): Promise<{ what: string; why: string }[]> {
  const doc = docOf(after);
  const beforeDoc = { headline: before.headline, roles: before.roles, skills: before.skills, extra_sections: before.extra_sections };
  try {
    const r = await json<{ changes: { what: string; why: string; quote: string; kind: "added" | "moved" | "reworded" | "removed" }[] }>(
      `You compare two versions of a résumé, BEFORE and AFTER, and list what changed — for the candidate, who will read the AFTER document and must be able to find every change you name. Rules: list only differences that are actually there; at most 8; one line each. For each: what (what moved, in plain words), why (one line, in terms of the posting the AFTER was written for, if obvious; else "to read faster"), quote (for added/moved/reworded: an exact phrase of 4+ words copied from AFTER where the change shows; for removed: the exact phrase from BEFORE that AFTER no longer has), kind. Never describe a change you cannot quote. If nothing meaningful changed, return an empty list.`,
      `BEFORE:\n${JSON.stringify(beforeDoc)}\n\nAFTER:\n${JSON.stringify(doc)}\n\nReturn: {changes:[{what, why, quote, kind}]}`, 2500, FAST);
    const hayAfter = normText(JSON.stringify(doc)), hayBefore = normText(JSON.stringify(beforeDoc));
    const out: { what: string; why: string }[] = [];
    for (const c of r.changes ?? []) {
      const q = normText(String(c.quote ?? "")); if (q.split(" ").length < 3) continue;
      const ok = c.kind === "removed" ? (hayBefore.includes(q) && !hayAfter.includes(q)) : hayAfter.includes(q);
      if (ok) out.push({ what: String(c.what ?? "").slice(0, 200), why: String(c.why ?? "").slice(0, 200) });
    }
    return out;
  } catch (e) { console.error("[sharpen] changes", (e as Error).message); return []; }
}

/** LinkedIn's connection note stops at 200 characters, and people copy this into exactly that box. Cut at a sentence end
 *  under 200; if the first sentence alone is longer, cut at a word and close it. */
export function fitNote(note: string, max = 200): string {
  const n = (note ?? "").replace(/\s+/g, " ").trim();
  if (n.length <= max) return n;
  const sentences = n.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [n];
  let out = "";
  for (const sErr of sentences) { if ((out + sErr).trim().length > max) break; out = (out + sErr); }
  out = out.trim();
  if (out.length >= 60) return out;
  const cut = n.slice(0, max - 1); return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:]$/, "") + ".";
}


/** Puts each owed line into the document verbatim: the role whose company the evidence or line names, else the most recent
 *  role when the evidence is a bullet, else the "relevant" block. Skips lines already present. Returns how many were placed. */
export function placeLines(rw: Rewrite, owed: Match[], resume: ResumeProfile): { rewrite: Rewrite; n: number } {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const next: Rewrite = JSON.parse(JSON.stringify(rw));
  let n = 0;
  for (const m of owed) {
    const line = (m.line ?? "").trim(); if (!line) continue;
    const core = norm(line).split(" ").slice(0, 10).join(" ");
    if (norm(JSON.stringify(docOf(next))).includes(core)) continue;   // present in the DOCUMENT (not merely mentioned in the change log)
    const hay = `${m.evidence} ${line}`.toLowerCase();
    let role = next.roles.find((r) => r.company && hay.includes(r.company.toLowerCase()));
    if (!role && !m.told) {
      // evidence quoted from a role's bullet: find which role in the original holds it
      const src = resume.roles.find((r) => r.bullets.some((b) => norm(b) && norm(m.evidence).includes(norm(b).split(" ").slice(0, 6).join(" "))));
      if (src) role = next.roles.find((r) => r.company === src.company);
    }
    if (role) role.bullets.unshift(line);
    else if ((next.relevant ?? []).length < 5) next.relevant = [line, ...(next.relevant ?? [])];
    else if (next.roles[0]) next.roles[0].bullets.unshift(line);
    else next.relevant = [line, ...(next.relevant ?? [])];
    n++;
  }
  return { rewrite: next, n };
}


/** Every role in the original appears in the rewrite, in the original's order, with at least 4 bullets (two most recent) or
 *  2 (older) when the original has them. Missing bullets are taken verbatim from the original, so nothing new is claimed;
 *  bullets a draft moved into "extras" are not double-counted because only bullets not already in the document are added. */
export function restoreRoles(rw: Rewrite, resume: ResumeProfile): { rewrite: Rewrite; n: number } {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const key = (r: { company: string; title: string }) => norm(r.company) + "|" + norm(r.title);
  const next: Rewrite = JSON.parse(JSON.stringify(rw));
  let n = 0;
  resume.roles.forEach((orig, i) => {
    let role = next.roles.find((r) => key(r) === key(orig)) ?? next.roles.find((r) => norm(r.company) === norm(orig.company) && norm(r.start) === norm(orig.start));
    if (!role) {
      role = { company: orig.company, title: orig.title, start: orig.start, end: orig.end, bullets: [] };
      const at = next.roles.findIndex((r) => resume.roles.findIndex((o) => key(o) === key(r)) > i);
      if (at < 0) next.roles.push(role); else next.roles.splice(at, 0, role);
      n++;
    }
    const min = i < 2 ? 4 : 2;
    for (const b of orig.bullets) {
      if (role.bullets.length >= min) break;
      const core = norm(b).split(" ").slice(0, 8).join(" ");
      if (!core) continue;
      if (norm(JSON.stringify(next.roles)).includes(core) || norm(JSON.stringify(next.relevant ?? [])).includes(core)) continue;
      // a role's own line that a draft moved into an extras block goes back to the role
      for (const sec of next.extra_sections ?? []) sec.items = sec.items.filter((it) => !norm(it).includes(core));
      role.bullets.push(b.trim()); n++;
    }
  });
  next.extra_sections = (next.extra_sections ?? []).filter((x) => x.items.length);
  return { rewrite: next, n };
}


// ---------- fact guard ----------
/** "MBA candidate", "master's student", "pursuing", "in progress", "currently enrolled": a degree described as unfinished.
 *  (The bare word "candidate" is not enough — "Outstanding Candidate Scholarship" is a real award.) */
const IN_PROGRESS = /\b(?:mba|pgdm|m\.?tech|b\.?tech|m\.?sc|b\.?sc|ms|ma|ba|phd|master'?s?|bachelor'?s?|degree)\s+(?:candidate|student)\b|\b(?:pursuing|in progress|currently enrolled|expected graduation)\b/i;
const normT = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
/** Number tokens as a screener reads them: "34%", "$1.12", "16.7M", "2.8pp", "12,000", "2019" → their digit cores ("34", "1.12", "16.7", "2.8", "12000", "2019"). */
export function numbersIn(t: string): string[] {
  return [...t.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, "")).filter((d) => d.length > 0);
}
const contentWords = (t: string) => normT(t).split(" ").filter((w) => w.length > 3 && !STOP.has(w));
const STOP = new Set(["with","from","that","this","then","than","into","over","across","through","their","them","there","were","have","been","while","after","before","which","where","when","what","your","about","also","more","most","such","only","both","each","other","using","used","within","without","under","between","including","against"]);
/** Is an original bullet covered by the text of its role in the rewrite? All of its numbers must be there and most of its words. */
function covered(orig: string, roleText: string): boolean {
  const nums = numbersIn(orig), haveNums = new Set(numbersIn(roleText));
  if (nums.some((n) => !haveNums.has(n))) return false;
  const words = contentWords(orig); if (!words.length) return true;
  const hay = new Set(contentWords(roleText));
  const hit = words.filter((w) => hay.has(w) || hay.has(w.replace(/s$/, "")) || hay.has(w + "s")).length;
  return hit / words.length >= 0.6;
}
/** Nothing of the original is lost. Returns the repaired rewrite and what it had to put back. */
export function preserveFacts(rw: Rewrite, resume: ResumeProfile): { rewrite: Rewrite; n: number; log: string[] } {
  const next: Rewrite = JSON.parse(JSON.stringify(rw));
  const log: string[] = [];
  const key = (r: { company: string; title: string }) => normT(r.company) + "|" + normT(r.title);
  // roles and their bullets
  resume.roles.forEach((orig, i) => {
    let role = next.roles.find((r) => key(r) === key(orig)) ?? next.roles.find((r) => normT(r.company) === normT(orig.company) && normT(r.start) === normT(orig.start)) ?? next.roles.find((r) => normT(r.company) === normT(orig.company));
    if (!role) {
      role = { company: orig.company, title: orig.title, start: orig.start, end: orig.end, bullets: [] };
      const at = next.roles.findIndex((r) => resume.roles.findIndex((o) => key(o) === key(r)) > i);
      if (at < 0) next.roles.push(role); else next.roles.splice(at, 0, role);
      log.push(`role restored: ${orig.company}`);
    }
    // dates and title exactly as the original
    if (normT(role.start) !== normT(orig.start) || normT(role.end) !== normT(orig.end)) { log.push(`dates restored: ${orig.company}`); role.start = orig.start; role.end = orig.end; }
    if (normT(role.title) !== normT(orig.title)) { log.push(`title restored: ${orig.company} (${role.title} → ${orig.title})`); role.title = orig.title; }
    for (const b of orig.bullets) {
      if (!b.trim()) continue;
      if (covered(b, role.bullets.join(" \n "))) continue;
      // the draft's weaker version of this bullet (same words, numbers gone) makes way for the original
      const ow = new Set(contentWords(b));
      role.bullets = role.bullets.filter((x) => { const w = contentWords(x); const hit = w.filter((t) => ow.has(t)).length; return !(w.length && hit / w.length >= 0.6 && numbersIn(x).length < numbersIn(b).length); });
      // a role's own line that a draft moved into an extras block goes back to the role
      const core = normT(b).split(" ").slice(0, 8).join(" ");
      for (const sec of next.extra_sections ?? []) sec.items = sec.items.filter((it) => !normT(it).includes(core));
      role.bullets.push(b.trim());
      log.push(`bullet restored: ${orig.company}: ${b.slice(0, 60)}`);
    }
  });
  // skills: every original skill present — and when the résumé groups them ("Tools: SQL, Tableau, …"), every item in the
  // group, as the candidate wrote it. A document that keeps the group names and drops the items has lost the section.
  const skillText = normT((next.skills ?? []).join(" | "));
  const grouped = (resume.skills ?? []).map((sk: any) => { const name = (typeof sk === "string" ? sk : sk?.name ?? "").trim(); const ev = typeof sk === "string" ? "" : String(sk?.evidence ?? "").trim(); return { name, ev, items: ev.split(/,|;|·/).map((x) => x.trim()).filter((x) => x.length > 1) }; }).filter((g) => g.name);
  const isGrouped = grouped.some((g) => g.items.length >= 3);
  if (isGrouped) {
    const missing = grouped.flatMap((g) => g.items.filter((it) => !skillText.includes(normT(it))));
    if (missing.length) {
      next.skills = grouped.map((g) => (g.items.length >= 2 ? `${g.name}: ${g.ev}` : g.name));
      log.push(`skills restored as written (${missing.length} items were missing, e.g. ${missing.slice(0, 3).join(", ")})`);
    }
  } else {
    for (const g of grouped) if (!skillText.includes(normT(g.name))) { next.skills = [...(next.skills ?? []), g.name]; log.push(`skill restored: ${g.name}`); }
  }
  // education: every original entry, with its school, degree and year
  for (const ed of resume.education ?? []) {
    const have = (next.education ?? []).find((e) => normT(e.school) === normT(ed.school) || (normT(e.degree) === normT(ed.degree) && normT(e.degree)));
    if (!have) { next.education = [...(next.education ?? []), ed]; log.push(`education restored: ${ed.degree}`); continue; }
    if (normT(have.degree) !== normT(ed.degree)) { log.push(`degree restored: ${have.degree} → ${ed.degree}`); have.degree = ed.degree; }
    if (ed.year && normT(have.year ?? "") !== normT(ed.year)) { have.year = ed.year; log.push(`education year restored: ${ed.year}`); }
    if (ed.school && normT(have.school) !== normT(ed.school)) have.school = ed.school;
  }
  // extra sections (awards, languages, certifications…): every original item present somewhere in the document
  const docText = () => normT(JSON.stringify(docOf(next)));
  for (const sec of resume.extra_sections ?? []) {
    for (const it of sec.items ?? []) {
      if (!it.trim()) continue;
      const core = normT(it).split(" ").slice(0, 6).join(" ");
      if (core && docText().includes(core)) continue;
      if (covered(it, JSON.stringify(docOf(next)))) continue;
      let target = (next.extra_sections ?? []).find((x) => normT(x.title) === normT(sec.title)) ?? (next.extra_sections ?? []).find((x) => normT(x.title).includes(normT(sec.title).split(" ")[0]));
      if (!target) { target = { title: sec.title, items: [] }; next.extra_sections = [...(next.extra_sections ?? []), target]; }
      target.items.push(it.trim());
      log.push(`extra restored: ${sec.title}: ${it.slice(0, 50)}`);
    }
  }
  // a finished degree is held, not pursued
  const origAll = normT(JSON.stringify(resume));
  if (IN_PROGRESS.test(next.headline) && !IN_PROGRESS.test(origAll)) {
    const fallback = (resume.headline || "").trim() || resume.roles[0]?.title || next.headline;
    log.push(`headline restored: ${next.headline} → ${fallback}`);
    next.headline = fallback;
  }
  next.extra_sections = (next.extra_sections ?? []).filter((x) => x.items.length);
  return { rewrite: next, n: log.length, log };
}
/** Nothing in the document that the original doesn't have: every number in the output must be in the original or in what
 *  the candidate told us; a degree the original holds is not "candidate". Returns the list of offending claims (empty = clean). */
export function factAudit(rw: Rewrite, resume: ResumeProfile): { claim: string; reason: string }[] {
  const out: { claim: string; reason: string }[] = [];
  const origText = JSON.stringify(resume);
  const allowed = new Set(numbersIn(origText));
  const doc = docOf(rw);
  const fields: [string, string][] = [["headline", doc.headline ?? ""], ["summary", doc.summary ?? ""], ...(doc.relevant ?? []).map((l, i) => [`relevant ${i + 1}`, l] as [string, string])];
  for (const r of doc.roles ?? []) { r.bullets.forEach((b, i) => fields.push([`${r.company} bullet ${i + 1}`, b])); fields.push([`${r.company} dates`, `${r.start} ${r.end}`]); }
  for (const sec of doc.extra_sections ?? []) sec.items.forEach((it, i) => fields.push([`${sec.title} ${i + 1}`, it]));
  for (const [where, text] of fields) {
    for (const n of numbersIn(text)) if (!allowed.has(n)) out.push({ claim: text.slice(0, 160), reason: `"${n}" is not in the original (${where})` });
  }
  // a number is also tied to its employer: "30% growth at Fashinza" when the 30% is an Unacademy line is a misattribution.
  // Every number in a bullet must be in that role's own original lines (or what the candidate told us); every sentence of the
  // summary/relevant block that names exactly one employer may only carry numbers from that employer's lines.
  const told = normT(JSON.stringify(resume.candidate_added_facts ?? []));
  const byCompany = new Map<string, Set<string>>();
  for (const r of resume.roles ?? []) { const k = normT(r.company); const set = byCompany.get(k) ?? new Set<string>(); for (const n of numbersIn([r.title, r.start, r.end, ...r.bullets].join(" "))) set.add(n); byCompany.set(k, set); }
  const profileNums = new Set(numbersIn([resume.headline ?? "", ...(resume.skills ?? []).map((x: any) => x?.evidence ?? ""), ...(resume.extra_sections ?? []).flatMap((x) => x.items)].join(" ")));   // facts the original states without an employer
  const companyIn = (text: string) => [...byCompany.keys()].filter((k) => k && (normT(text).includes(k) || (k.split(" ")[0].length > 4 && normT(text).includes(k.split(" ")[0]))));
  for (const r of doc.roles ?? []) {
    const own = byCompany.get(normT(r.company)); if (!own) continue;
    r.bullets.forEach((b, i) => { for (const n of numbersIn(b)) if (!own.has(n) && !numbersIn(told).includes(n) && !profileNums.has(n) && !/^(19|20)\d\d$/.test(n)) out.push({ claim: b.slice(0, 160), reason: `"${n}" is not in ${r.company}'s own lines in the original (${r.company} bullet ${i + 1}) — this number belongs to another employer` }); });
  }
  for (const [where, text] of [["summary", doc.summary ?? ""], ...(doc.relevant ?? []).map((l, i) => [`relevant ${i + 1}`, l] as [string, string])]) {
    for (const sent of text.split(/(?<=[.;])\s+/).flatMap((x) => (companyIn(x).length > 1 ? x.split(/[,;:]\s+/) : [x]))) {
      const cos = companyIn(sent); if (cos.length !== 1) continue;
      const own = byCompany.get(cos[0])!;
      for (const n of numbersIn(sent)) if (!own.has(n) && !numbersIn(told).includes(n) && !/^(19|20)\d\d$/.test(n)) out.push({ claim: sent.slice(0, 160), reason: `"${n}" is attributed to ${cos[0]} but is not in that employer's lines in the original (${where})` });
    }
  }
  const origNorm = normT(origText);
  for (const [where, text] of [["headline", doc.headline ?? ""], ["summary", doc.summary ?? ""]]) {
    if (IN_PROGRESS.test(text) && !IN_PROGRESS.test(origNorm)) out.push({ claim: text.slice(0, 160), reason: `says a degree is in progress; the original states it as held (${where}) — state it as held` });
  }
  // de-duplicate identical claims
  const seen = new Set<string>();
  return out.filter((o) => { const k = o.claim + o.reason; if (seen.has(k)) return false; seen.add(k); return true; });
}
