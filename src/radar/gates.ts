// Radar's screen-out rules — the things a fair recruiter decides in ten seconds, before reading for fit.
// Deterministic, free, and run before any model sees a posting. Each returns a reason or null.
import { statedBand, titleBucket } from "../reader/experience.js";

/** Years the candidate has vs the band the posting states. One year over the ceiling is out ("2-3 years" is not for a
 *  six-year manager); two or more under the floor is out. A posting that states nothing passes here. */
export function bandGate(years: number, text: string): string | null {
  if (!years) return null;
  const b = statedBand(text);
  if (!b) return null;
  if (b.max !== null && years > b.max + 1) return `asks ${b.min}–${b.max} years; you have ${years}`;
  if (years + 2 <= b.min) return `asks ${b.min}+ years; you have ${years}`;
  return null;
}

/** The title's rung vs the candidate's level. A manager who did not ask to stretch is not shown associate, analyst or
 *  executive roles; a senior person is not shown a manager's seat unless the posting's own band says otherwise. */
const RUNG: Record<string, number> = { fresher: 0, "2-4": 1, "4-6": 2, "6-8": 3, "8-10": 4, "10+": 5, unknown: -1 };
const LEVEL_RUNG: Record<string, number> = { ic: 2, manager: 3, senior: 4, head: 5 };
export function titleGate(title: string, level: string, stretch: boolean, years: number, text: string): string | null {
  const r = RUNG[titleBucket(title)] ?? -1, want = LEVEL_RUNG[level] ?? -1;
  if (r < 0 || want < 0) return null;
  if (r <= want - 2 || (r === want - 1 && !stretch && r <= 1)) {
    // the title says junior; only a stated band that fits the candidate rescues it ("Principal Associate, 1-6 years")
    const b = statedBand(text);
    if (b && b.max !== null && years <= b.max + 1 && years >= b.min) return null;
    return `the title is ${titleBucket(title).replace("2-4", "an associate-level").replace("fresher", "an entry-level")} seat`;
  }
  return null;
}

/** Pedigree and credential requirements are gates, not gaps: Sharpen cannot supply McKinsey, an IIM or a CA.
 *  Fires only when the posting states the requirement and nothing in the résumé answers it. */
const PEDIGREE: { re: RegExp; label: string; resume: RegExp }[] = [
  { re: /\b(tier[\s-]?(1|i|one)|top[\s-]tier|premier)\b[^.\n]{0,40}\b(college|institute|school|b-?school|engineering|university|consulting|firm)/i, label: "a Tier-1 college or firm", resume: /\b(IIT|IIM|ISB|BITS|NIT|XLRI|FMS|IIFT|MDI|SPJIMR|McKinsey|BCG|Bain|Boston Consulting|Kearney|Oliver Wyman|Goldman|Morgan Stanley|JP ?Morgan)\b/i },
  { re: /\b(MBB|McKinsey|BCG|Bain|Boston Consulting)\b/i, label: "MBB consulting", resume: /\b(McKinsey|BCG|Bain|Boston Consulting|Kearney|Oliver Wyman|Roland Berger|Accenture Strategy|Deloitte|PwC|EY|KPMG)\b/i },
  { re: /\b(management consulting|strategy consulting|investment banking)\b[^.\n]{0,60}\b(required|must|mandatory|years|experience|background)/i, label: "a consulting or banking background", resume: /\b(consult(ing|ant)|McKinsey|BCG|Bain|Kearney|Deloitte|PwC|EY|KPMG|Accenture|investment bank|Goldman|Morgan Stanley|JP ?Morgan)\b/i },
  { re: /\b(IIT|IIM|ISB)\b[^.\n]{0,30}\b(only|preferred|required|must|mandatory|graduate|alumni)/i, label: "an IIT/IIM/ISB degree", resume: /\b(IIT|IIM|ISB)\b/ },
  { re: /\bpost[\s-]?MBA\b|\bMBA\b[^.\n]{0,25}\b(mandatory|required|must|is a must|from)\b/i, label: "an MBA", resume: /\b(MBA|PGDM|PGP|PGDBM|Master of Business)\b/i },
  { re: /\b(chartered accountant|\bCA\b[^.\n]{0,20}(qualified|required|mandatory)|\bCFA\b[^.\n]{0,20}(charter|required|mandatory))/i, label: "a CA/CFA qualification", resume: /\b(chartered accountant|\bCA\b|\bCFA\b|ICAI)\b/i },
];
export function pedigreeGate(text: string, resumeBlob: string): string | null {
  const t = (text ?? "").slice(0, 12000);
  for (const p of PEDIGREE) {
    if (p.re.test(t) && !p.resume.test(resumeBlob)) return `requires ${p.label}`;
  }
  return null;
}

/** The same idea read off the model's own "missing" list after stage 3: a missing must that is a credential, a pedigree
 *  or a years requirement caps the role out of the shot tiers — it is not a gap Sharpen closes. */
const GATE_WORDS = /\b(tier[\s-]?1|MBB|McKinsey|BCG|Bain|IIT|IIM|ISB|post[\s-]?MBA|\bMBA\b|chartered accountant|\bCA\b|\bCFA\b|CPA|PhD|\bMD\b|licen[cs]e|certif(ied|ication)\b[^,;]{0,30}(required|mandatory)|\d+\+?\s*(-|to)?\s*\d*\s*years?)/i;
export function gateFromMissing(missingMust: string[]): string | null {
  const hit = missingMust.find((m) => GATE_WORDS.test(m));
  return hit ? `requires ${hit.slice(0, 80)}` : null;
}

/** Everything the gates look at in a résumé: schools, employers, titles, the raw text when we have it. */
export function resumeBlob(parsed: unknown, text?: string | null): string {
  try { return `${text ?? ""}\n${JSON.stringify(parsed ?? {})}`; } catch { return text ?? ""; }
}

export const GATE_CAP = 55;   // a gated role can never read as a shot or almost: it sits in "close the gap" with the gate named
