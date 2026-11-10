// Radar's screen-out rules — the things a fair recruiter decides in ten seconds, before reading for fit.
// Deterministic, free, and run before any model sees a posting. Each returns a reason or null.
import { statedBand, titleBucket } from "../reader/experience.js";

/** Years the candidate has vs the band the posting states. One year over the ceiling is out ("2-3 years" is not for a
 *  six-year manager); two or more under the floor is out. A posting that states nothing passes here. */
const SHORT_BAND = /(\d{1,2})\s*(?:Y|yrs?|years?)?\s*(?:-|–|to)\s*(\d{1,2})\s*(?:Y\b|yrs?\b|years?\b)/i;   // "1Y - 6Y", "3 - 5 yrs" as some boards print it
export function bandGate(years: number, text: string): string | null {
  if (!years) return null;
  let b = statedBand(text);
  if (!b) { const m = (text ?? "").slice(0, 12000).match(SHORT_BAND); if (m && Number(m[2]) >= Number(m[1]) && Number(m[2]) <= 30) b = { min: Number(m[1]), max: Number(m[2]) }; }
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
    const name: Record<string, string> = { fresher: "an entry-level", "2-4": "an associate-level", "4-6": "a senior-associate", "6-8": "a manager-level", "8-10": "a senior-manager", "10+": "a head-level" };
    return `the title is ${name[titleBucket(title)] ?? "a junior"} seat for your level`;
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

/** Years of experience from the résumé's own dates — earliest role start to the latest end (or today) — rather than a
 *  model's guess. "Sep 2014 → Present" is twelve years whatever the headline says. Null when no role has a parsable date. */
const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
export function parseWhen(s: string | null | undefined, end = false): Date | null {
  const t = (s ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/present|current|till date|to date|now|ongoing/.test(t)) return new Date();
  const m = t.match(/([a-z]{3,9})?[\s.,'-]*((?:19|20)\d{2})/);
  if (!m) return null;
  const y = Number(m[2]); const mo = m[1] ? MONTHS[m[1].slice(0, 4)] ?? MONTHS[m[1].slice(0, 3)] : undefined;
  return new Date(y, mo ?? (end ? 11 : 0), end ? 28 : 1);
}
export function yearsFromRoles(roles: { start?: string | null; end?: string | null; title?: string | null }[] | undefined): number | null {
  let first: Date | null = null, last: Date | null = null;
  for (const r of roles ?? []) {
    const a = parseWhen(r.start), b = parseWhen(r.end, true) ?? (r.start ? new Date() : null);
    if (a && (!first || a < first)) first = a;
    if (b && (!last || b > last)) last = b;
  }
  if (!first || !last) return null;
  const y = (last.getTime() - first.getTime()) / (365.25 * 86400e3);
  return y > 0 && y < 50 ? Math.round(y * 2) / 2 : null;
}

/** The level a recruiter reads off the latest employed title (a founder line is skipped: it says nothing about the seat
 *  they would be hired into). */
export function levelFromRoles(roles: { title?: string | null }[] | undefined): "ic" | "lead" | "manager" | "head" | null {
  const t = (roles ?? []).map((r) => (r.title ?? "").toLowerCase()).find((x) => x && !/\b(founder|co-?founder|owner|proprietor|self[- ]employed|freelanc)/.test(x));
  if (!t) return null;
  if (/\b(chief|ceo|cfo|coo|cto|president|vice president|vp|svp|evp|avp|director|head|bu head|general manager|gm|dgm)\b/.test(t)) return "head";
  if (/\b(senior manager|sr\.? manager|manager|group manager|program manager|product manager)\b/.test(t)) return "manager";
  if (/\b(lead|principal|staff|architect|supervisor)\b/.test(t)) return "lead";
  return "ic";
}
