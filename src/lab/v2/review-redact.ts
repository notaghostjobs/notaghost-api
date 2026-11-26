// Review-package privacy boundary (defence in depth). Builds a minimal, allowlisted professional-evidence record from
// a candidate evidence record and removes personal data that is not needed to judge professional fit. Detection runs
// on normalised text so PDF symbol codes, private-use glyphs, odd Unicode and letter-spaced headings cannot hide a
// label. This does not claim to catch every sensitive string: `audit()` must report zero hits on the serialized
// package, and `uncertain` items are listed for manual review. Lab code; matching does not use it.

/** Text as a detector sees it: NFKC, no PDF (cid:N) codes or private-use glyphs, letter-spaced words joined. */
export function normalise(s: string): string {
  let t = s.normalize("NFKC").replace(/\(cid:\d+\)/g, " ").replace(/[-•●▪◦‣∙·⁃■□❖➢✓✔→»]/g, " ");
  t = t.replace(/\b((?:[A-Za-z] ){2,}[A-Za-z])\b/g, (m) => m.replace(/ /g, ""));   // "D A T E" → "DATE"
  return t.replace(/\s+/g, " ").trim();
}

const LABEL = [
  /\bdate\s*of\s*birth\b/i, /\bd\.?\s?o\.?\s?b\b/i, /\bbirth\s?(date|day|place)\b/i, /\bborn\s+(on|in)\b/i, /\bage\s*[:\-]\s*\d{2}\b/i,
  /\b(father|mother|husband|wife|spouse|guardian|parent)('?s)?\s*(name|occupation)?\s*[:\-]/i, /\b(s\/o|d\/o|w\/o|son of|daughter of|wife of)\b/i,
  /\bmarital\b/i, /\b(married|unmarried)\b\s*$/i, /\bgender\s*[:\-]?/i, /^\s*sex\s*[:\-]/i, /\bnationality\b/i, /\breligion\b/i, /\bcaste\b/i, /\bblood\s*group\b/i,
  /\b(aadha?ar|passport\s*(no|number)?|pan\s*(no|number|card)|voter\s*id|driving\s*licen[cs]e)\b/i,
  /\b(permanent|present|current|residential|home|correspondence)\s*address\b/i, /^\s*address\s*[:\-]?/i,
  /^\s*(personal\s*(details|information|profile|data)|declaration|hobbies|interests|languages\s*known)\b/i, /^\s*(place|date)\s*[:\-]/i,
  /\bsignature\b/i, /\bemergency\s*contact\b/i, /^\s*(name|full\s*name)\s*[:\-]/i,
  /^\s*(contact|mobile|phone|tel|telephone|cell|e-?mail|email\s*id|whatsapp)\s*(no\.?|number|details)?\s*[:\-]/i,
];
const VALUE = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/,                                           // email
  /(?<!\d)(?:\+?\s?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/, /(?<!\d)\d{3}[\s-]\d{3}[\s-]\d{4}(?!\d)/, // phones
  /https?:\/\/\S+|www\.\S+|\blinkedin\b|\bgithub\.com\b|\bbehance\b/i,                        // links / handles
  /\b[A-Z]{5}\d{4}[A-Z]\b/, /(?<!\d)\d{4}\s\d{4}\s\d{4}(?!\d)/, /\b[A-Z]\d{7}\b/,             // PAN, Aadhaar, passport
  /#\s?\d+\s?\/\s?\d+/, /\b(flat|house|door|plot)\s*(no\.?|number|#)\s*\d+/i, /\b\d+(st|nd|rd|th)\s+(cross|main|block|stage|phase)\b/i, // street-level
  /(?<!\d)\d{3}\s?\d{3}(?!\d)(?!\s*(%|\+|cr\b|crore|lakh|lakhs|k\b|users|employees|members|clients|customers|tickets|records|rows|skus?|invoices|accounts|transactions|orders|loans|units|inr|usd|rs))/i, // PIN code
];
const DATE_FULL = /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](19\d{2}|200\d)\b|\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*,?\s+(19\d{2}|200\d)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(st|nd|rd|th)?,?\s+(19\d{2}|200\d)\b/i;
const RANGE = /\b(to|till|until|present|current|now|since)\b|[–—]|\s-\s|\d{4}\s*-\s*\d{2,4}/i;
const WORK = /\b(led|managed|built|developed|designed|implemented|delivered|handled|processed|prepared|analy[sz]ed|reduced|increased|improved|created|owned|launched|executed|supported|coordinated|maintained|achieved|drove|resolved|underwrote|reviewed|reconciled)\b/i;
const PLACEWORD = /(nagar|puram|halli|pet|wadi|layout|colony)\b|\b(apartments?|apts?|residency|enclave|road|street|main\s*road|sector\s*\d+)\b/i;
const EDU = /\b(college|university|school|institute|academy|vidyalaya|vidyapeeth|b\.?\s?com|b\.?\s?tech|b\.?e\b|b\.?sc|mba|pgdm|m\.?\s?com|m\.?\s?tech|degree|diploma|cbse|icse|hsc|ssc|puc?)\b/i;
const HEADING = /^\s*(work|professional)?\s*(experience|employment|projects?|education|skills|achievements|certifications?|summary|profile)\b/i;

export type Uncertain = { field: string; reason: string };
export type Redacted<T> = { value: T; removed: number; uncertain: Uncertain[] };

/** True when a line is personal data that is not professional evidence. */
export function isPersonal(line: string): string | null {
  const n = normalise(line);
  for (const r of LABEL) if (r.test(n)) return `label ${r.source.slice(0, 24)}`;
  for (const r of VALUE) if (r.test(n)) return `value ${r.source.slice(0, 24)}`;
  if (DATE_FULL.test(n) && !RANGE.test(n)) return "single full date (possible date of birth)";
  if (PLACEWORD.test(n) && /\d|,\s*\w+\s*,/.test(n) && !WORK.test(n) && !EDU.test(n) && n.length < 90) return "address-like line";   // an institution's locality is education, not a home address
  return null;
}

/** Name tokens: the résumé's first line when it looks like a name (letter-spacing removed), plus any "Name:" value. */
export function nameTokens(resumeText: string): string[] {
  const lines = resumeText.split(/\r?\n/).map((l) => normalise(l)).filter(Boolean);
  const out = new Set<string>();
  const first = lines[0] ?? ""; if (!/\d|@|:/.test(first) && first.split(" ").length <= 5) for (const t of first.split(" ")) if (/^[A-Za-z.'-]{3,}$/.test(t)) out.add(t.replace(/[.']/g, ""));
  for (const l of lines) { const m = /^(?:full\s*)?name\s*[:\-]\s*(.+)$/i.exec(l); if (m) for (const t of m[1].split(" ")) if (/^[A-Za-z.'-]{3,}$/.test(t)) out.add(t); }
  return [...out].filter((t) => !/^(resume|curriculum|vitae|profile|summary)$/i.test(t));
}

/** Clean a list of lines: drop personal lines and the short continuation lines of a personal block; replace names. */
export function cleanLines(lines: string[], names: string[], field: string): Redacted<string[]> {
  const out: string[] = []; let removed = 0, block = 0; const uncertain: Uncertain[] = [];
  const nameRe = names.length ? new RegExp(`\\b(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "gi") : null;
  for (const raw of lines) {
    const n = normalise(raw);
    const p = isPersonal(raw);
    if (p) { removed++; block = /label|address/.test(p) ? 6 : Math.max(block - 1, /value/.test(p) ? 3 : 0); continue; }   // a personal value keeps a block going
    if (block > 0) { if (HEADING.test(n) || WORK.test(n) || n.length > 70) block = 0; else { block--; removed++; continue; } }   // continuation of a personal block
    if (/^[\d\s+()-]{4,}$/.test(n)) { removed++; continue; }   // a bare run of digits is never professional evidence (split phone numbers)
    let t = raw.replace(/\(cid:\d+\)/g, "").replace(/\s+/g, " ").trim();
    if (nameRe) { const before = t; t = t.replace(nameRe, "[name]").replace(/\[name\](\s+[A-Z]\.?(?=[\s,]|$)){1,3}/g, "[name]"); if (/^(\[name\][\s,.-]*)+$/.test(t)) { removed++; continue; } if (before !== t) uncertain.push({ field, reason: "name token replaced inside a line" }); }
    if (PLACEWORD.test(n) && !WORK.test(n)) uncertain.push({ field, reason: "place word kept (check it is an employer or institution, not a home address)" });
    if (t) out.push(t);
  }
  return { value: out, removed, uncertain };
}

/** Run every detector over serialized text. Zero hits is required before a package is issued. */
export function audit(serialized: string, names: string[] = []): { hits: { kind: string; at: number }[] } {
  const hits: { kind: string; at: number }[] = []; const t = normalise(serialized.replace(/\\n/g, "\n"));
  for (const r of [...LABEL.map((x) => new RegExp(x.source.replace(/^\^\\s\*/, '(?:^|[\\n"])\\s*'), "gi")), ...VALUE.map((x) => new RegExp(x.source, "g" + (x.flags.includes("i") ? "i" : "")))]) for (const m of t.matchAll(r)) hits.push({ kind: r.source.slice(0, 30), at: m.index ?? 0 });
  for (const n of names) for (const m of t.matchAll(new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"))) hits.push({ kind: "candidate name", at: m.index ?? 0 });
  return { hits };
}

/** Job text for reviewers: unchanged except third-party contact details (emails, phones, links) shown as removed. */
export function cleanJobText(s: string): string {
  return s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/g, "[contact removed]").replace(/(?<!\d)(?:\+?\s?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g, "[contact removed]").replace(/https?:\/\/\S+/g, "[link removed]");
}
