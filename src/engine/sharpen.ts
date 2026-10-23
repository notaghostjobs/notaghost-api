import { json } from "./claude.js";

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
    `Résumé (${pages} page(s)):\n\n${text}\n\nReturn: {name, headline, contact{email,phone,city,links[]}, years_total (number), roles[{company,title,start,end,bullets[]}], skills[{name, evidence}], education[{school,degree,year}], extra_sections[{title, items[]}], pages: ${pages}}. extra_sections = any other block on the résumé (entrepreneurial ventures, certifications, languages, awards, publications), items verbatim. Skip personal details like DOB or marital status.`,
    8000
  );
}

// ---------- 2. parse posting ----------
export function parsePosting(text: string) {
  return json<PostingProfile>(
    `You read a job posting and extract what the employer is actually asking for. Must-haves are explicit requirements or things the role cannot be done without. Nice-to-haves are preferences. company_language = 6-10 short phrases the posting uses to describe the work (e.g. "owning the roadmap", "SQL-first analysis"). red_flags = only things visible in the text (no salary, vague scope, unrealistic stack list, "urgent", posting older than 45 days if dated). Be concrete and short.`,
    `Posting:\n\n${text}\n\nReturn: {company, title, location, years_required, must_have[], nice_to_have[], company_language[], red_flags[]}`
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
export function rewriteResume(resume: ResumeProfile, posting: PostingProfile, matches: Match[]) {
  return json<Rewrite>(
    `You sharpen a résumé for one specific posting. Rules, in order of importance:
1. NEVER invent. No new employers, titles, dates, degrees, tools, numbers or outcomes. Every bullet must be traceable to the original résumé or to evidence in the matches.
2. Reorder and reword: lift the proof that answers the must-haves to the top of each role; mirror the posting's language where it is true of the candidate; cut bullets that don't serve this role (list what you cut in changes).
3. EXPAND, don't pad. Most résumés under-write. Where a bullet compresses real work ("managed P&L for key categories"), unpack it into 2-3 specific bullets using only facts present anywhere in the résumé (summary, competencies, other roles). Each unpacked bullet must still be traceable. Never add numbers, tools or outcomes that aren't in the source. Target: a dense page — 4-6 bullets per recent role, 2-3 for older ones.
3b. relevant: 3-4 one-line statements mapping the candidate's proof to the posting's must-haves, in the employer's language (e.g. "Category P&L: ran FMCG & grocery P&L at Ninjacart; 60% of revenue, 5x volume in 100 days"). Only "said" and "have_not_said" matches — never a missing one.
3c. extra_sections: keep the résumé's own extra blocks (ventures, certifications, languages) tightened to what serves this role; drop personal details.
3d. Length: ${resume.pages} page(s) in, ${resume.pages} page(s) out — full pages, not half.
4. Bullets: start with a verb, one line each, concrete, numbers kept exactly as the original had them.
5. summary: 2-3 lines for this posting, no adjectives like "passionate" or "results-driven".
6. referral_note: ~60 words, first person, to someone at the company — names the role, gives one specific reason the candidate fits, asks for a referral. No flattery.
7. fit_line: one honest sentence to the candidate about their odds here (e.g. "Strong on the core stack; two of five must-haves are missing — apply, but expect questions on X").
8. changes: every meaningful edit with a one-line why, so the candidate can see exactly what moved.`,
    `ORIGINAL:\n${JSON.stringify(resume)}\n\nPOSTING:\n${JSON.stringify(posting)}\n\nMATCHES:\n${JSON.stringify(matches)}\n\nReturn: {headline, summary, relevant[], roles[{company,title,start,end,bullets[]}], skills[], education[], extra_sections[{title,items[]}], changes[{what,why}], referral_note, fit_line}`,
    8000
  );
}

// ---------- 5. verify (separate pass, strict) ----------
export function verifyRewrite(original: ResumeProfile, rewrite: Rewrite) {
  return json<Verification>(
    `You are an auditor. Compare a rewritten résumé against the original profile. Flag ANY claim in the rewrite that the original does not support: a tool, number, outcome, title, employer, date, degree, or responsibility that isn't there. Rewording and reordering are fine. Mirroring an employer's phrase is fine if the underlying fact exists. Be strict about numbers and tools; be reasonable about synonyms. If nothing is unsupported, ok=true with an empty list.`,
    `ORIGINAL:\n${JSON.stringify(original)}\n\nREWRITE:\n${JSON.stringify({ headline: rewrite.headline, summary: rewrite.summary, relevant: rewrite.relevant, roles: rewrite.roles, skills: rewrite.skills, education: rewrite.education, extra_sections: rewrite.extra_sections })}\n\nReturn: {ok: boolean, problems:[{claim, reason}]}`,
    3000
  );
}

// ---------- orchestration ----------
export async function runSharpen(resume: ResumeProfile, postingText: string) {
  const posting = await parsePosting(postingText);
  const { matches } = await matchResume(resume, posting);
  let rewrite = await rewriteResume(resume, posting, matches);
  let verification = await verifyRewrite(resume, rewrite);
  if (!verification.ok) {
    // one repair pass: feed the problems back
    rewrite = await json<Rewrite>(
      `Fix a résumé rewrite so it contains no unsupported claims. Remove or reword exactly the flagged items; change nothing else. Keep the same JSON shape.`,
      `ORIGINAL:\n${JSON.stringify(resume)}\n\nREWRITE:\n${JSON.stringify(rewrite)}\n\nPROBLEMS:\n${JSON.stringify(verification.problems)}`,
      8000
    );
    verification = await verifyRewrite(resume, rewrite);
  }
  return { posting, matches, rewrite, verification };
}
