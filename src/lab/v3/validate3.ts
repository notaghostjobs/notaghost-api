// Matching v3: verdict validation (val3.1). Same rules as the V2 validator (src/lab/v2/pipeline.ts, frozen and left
// untouched) with three defects found in the three-candidate pilot corrected:
//  1. Quotes are compared word for word, ignoring only spacing, punctuation, case and line wrapping. A quote whose
//     words match a contiguous run of the source is accepted and replaced by the source's own text. A quote with a
//     word added, dropped, changed or reordered is still rejected.
//  2. The computed-years rule applies to experience requirements only. "15 years full time education" is a schooling
//     requirement: it was being compared with years of work and turned into a "confirmed gap", which then failed the
//     verdict as a contradiction.
//  3. A requirement decided by the computed years needs no résumé line: the evidence is the computed-years line of
//     the candidate block, and the validator sets the status itself. Any other "demonstrated"/"transferable" item
//     without a résumé quote still fails.
// Unchanged: schema checks, invented or paraphrased quotes, missing evidence, contradictory verdicts → fail closed.
import { norm, quoted } from "../v2/cjr.js";
import { speaksTo, joinWrapped } from "../v2/pipeline.js";

export const VALIDATE3_VERSION = "val3.1";
const FITS = new Set(["direct", "adjacent", "stretch", "unsuitable", "cannot_judge"]), FN = new Set(["same", "neighbour", "different"]), SEN = new Set(["right", "one_up", "below", "too_far"]), ST = new Set(["demonstrated", "transferable", "unverified", "confirmed_gap"]), CONF = new Set(["high", "medium", "low"]);
const closed = (job_id: string, failed: string) => ({ job_id, fit: "cannot_judge", function: "different", specialisation: "different", seniority: "too_far", core: [] as any[], gaps: [] as string[], unverified: [] as string[], why: "", confidence: "low", failed });

type Tok = { w: string; s: number; e: number };
/** Words of a text with their positions: letters, digits, "+" and "#" (so "C++" and "C#" stay distinct from "C"). */
export function words(t: string): Tok[] { const out: Tok[] = []; const re = /[\p{L}\p{N}+#]+/gu; let m: RegExpExecArray | null; while ((m = re.exec(t))) out.push({ w: m[0].normalize("NFKC").toLowerCase(), s: m.index, e: m.index + m[0].length }); return out; }
/** The source's own text for a quote whose words appear in the source as one contiguous run, in order; else null.
 *  At least two words and eight letters or digits, the same floor the exact check uses. */
export function locate(q: string | null | undefined, source: string): string | null {
  if (!q) return null; const a = words(q); if (a.length < 2 || a.reduce((n, t) => n + t.w.length, 0) < 8) return null;
  const b = words(source);
  for (let i = 0; i + a.length <= b.length; i++) { if (b[i].w !== a[0].w) continue; let k = 1; while (k < a.length && b[i + k].w === a[k].w) k++; if (k === a.length) return source.slice(b[i].s, b[i + k - 1].e); }
  return null;
}
/** Exact (V2) match first; otherwise a word-for-word match, returned as the source's text. null = not a quote. */
export function resolveQuote(q: string | null | undefined, source: string): { quote: string; normalised: boolean } | null {
  if (!q) return null; if (quoted(q, source)) return { quote: q, normalised: false };
  const span = locate(q, source); return span && quoted(span, source) ? { quote: span, normalised: true } : null;
}

const YEARS_REQ = /(\d{1,2})\s*\+?\s*(?:-|to|–)?\s*(\d{1,2})?\s*\+?\s*(years|yrs)/i;
const NOT_EXPERIENCE = /\b(education|schooling|academic|stud(y|ies)|of age|years? old|degree programme|degree program)\b/i;
/** A requirement about years of experience (decided by the computed years), not years of education or age. */
export const isExperienceYears = (requirement: string, jobQuote: string) => YEARS_REQ.test(`${requirement} ${jobQuote}`) && !NOT_EXPERIENCE.test(requirement) && !(NOT_EXPERIENCE.test(jobQuote) && !/experience|exp\b/i.test(requirement));

export function validateVerdict3(raw: any, job: { id: string; text: string; title: string }, evidenceText: string, block?: string) {
  const ev = joinWrapped(evidenceText); const yearsLine = /^Years \(computed[^)]*\): ([\d.]+).*$/m.exec(block ?? ""); const yearsTotal = Number((yearsLine ?? [])[1]);
  if (!raw || typeof raw !== "object") return closed(job.id, "missing verdict");
  if (String(raw.job_id) !== job.id) return closed(job.id, "job id mismatch");
  if (!FITS.has(raw.fit) || !FN.has(raw.function) || !FN.has(raw.specialisation) || !SEN.has(raw.seniority) || !CONF.has(raw.confidence) || !Array.isArray(raw.core) || typeof raw.why !== "string") return closed(job.id, "schema");
  const src = `${job.title}\n${job.text}`; const core: any[] = [];
  for (const k0 of raw.core) {
    if (!k0 || typeof k0.requirement !== "string" || !ST.has(k0.status)) return closed(job.id, "schema: core item");
    const k: any = { ...k0 };
    const jq = resolveQuote(k.job_quote, src); if (!jq) return closed(job.id, `job quote not in posting: ${String(k.job_quote).slice(0, 60)}`);
    if (jq.normalised) { k.job_quote = jq.quote; k.job_quote_normalised = true; }
    if (k.resume_quote !== null && k.resume_quote !== undefined) { const rq = resolveQuote(k.resume_quote, ev); if (!rq) return closed(job.id, `résumé quote not in evidence: ${String(k.resume_quote).slice(0, 60)}`); if (rq.normalised) { k.resume_quote = rq.quote; k.resume_quote_normalised = true; } }
    // experience-years requirements are decided by the computed years, whatever the judge said
    const y = YEARS_REQ.exec(`${k.requirement} ${k.job_quote}`);
    if (y && Number.isFinite(yearsTotal) && isExperienceYears(k.requirement, k.job_quote)) { const min = Number(y[1]);
      k.status = yearsTotal >= min - 1 ? "demonstrated" : yearsTotal >= min - 2 ? "transferable" : "confirmed_gap"; k.years_check = `${yearsTotal} vs ${min}+`;
      if (!k.resume_quote && yearsLine) { k.resume_quote = yearsLine[0].trim(); k.years_evidence = "computed years"; }
      core.push(k); continue; }
    if ((k.status === "demonstrated" || k.status === "transferable") && !k.resume_quote) return closed(job.id, "demonstrated without a résumé quote");
    // a real quote that does not speak to the requirement is not evidence
    core.push((k.status === "demonstrated" || k.status === "transferable") && !speaksTo(k) ? { ...k, status: "unverified", downgraded: true } : k);
  }
  const v = { job_id: job.id, fit: raw.fit, function: raw.function, specialisation: raw.specialisation, seniority: raw.seniority, core, gaps: (raw.gaps ?? []).map(String), unverified: (raw.unverified ?? []).map(String), why: String(raw.why).slice(0, 400), confidence: raw.confidence };
  // contradictions: a strong fit cannot carry a confirmed gap, a different function, or a too-far level
  if ((v.fit === "direct" || v.fit === "adjacent") && (v.core.some((k) => k.status === "confirmed_gap") || v.function === "different" || v.seniority === "too_far")) return closed(job.id, "verdict contradicts its own checks");
  if (v.fit === "direct" && (v.specialisation === "different" || v.seniority === "below")) return closed(job.id, "direct with different specialisation or level");
  return v;
}
void norm;
