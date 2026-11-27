// Matching v3: employment-date reading (27 Nov 2026). V3-owned; the product's reader in src/lib/career.ts is untouched.
//
// Why: the shared reader matched only "Mon YYYY - Mon YYYY"-style ranges. On real résumés it (a) missed common
// employment formats (Sep’19-Oct’20, June 22 - Present, March 30, 2020 to August 28, 2021, Jan-2017 to Mar-2020,
// "to till now") and (b) counted ranges that are not employment (a bare "2010 To 2011" education table row; a metric
// period "…in 2021-2022 to 85%"), so two senior people were read as 1.9 years.
//
// What this does: finds every date range, keeps the exact source line and matched text, classifies it (employment,
// internship, education, project, prose/other), resolves two-digit years by a fixed rule and flags what is
// ambiguous instead of guessing, and totals professional experience as the UNION of employment intervals (overlaps
// are not double-counted; gaps are preserved). Ongoing roles end at the evaluation date passed in.
const MON = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const Y4 = "(?:19|20)\\d{2}", APO = "['’‘`´]";
const ORD = "(?:st|nd|rd|th)?";
// one date, longest forms first; no capture groups (parsed separately by parseDate)
const D = [
  `(?:\\d{1,2}${ORD}\\s+)?\\b${MON}\\b\\.?(?:\\s+\\d{1,2}${ORD}\\s*,?\\s+(?=${Y4}))?\\s*[,.\\-/]?\\s*(?:${Y4}|${APO}\\s?\\d{2}(?!\\d)|\\d{2}(?!\\d))`,   // 11 Feb 2022 · Feb 11, 2022 · Feb-2022 · Sep’19 · June 22
  `(?<![\\d/.])(?:\\d{1,2}[/.\\-])?\\d{1,2}[/.\\-]${Y4}(?!\\d)`,                                                                                   // 30/03/2020 · 03/2020 · 03-2020
  `(?<![\\d/.])${Y4}(?![\\d])`,                                                                                                                    // 2019
  `${APO}\\d{2}(?!\\d)`,                                                                                                                              // ’19
].join("|");
const SEP = "\\s*(?:-|–|—|−|→|\\bto\\b|\\btill\\b|\\buntil\\b|\\bthrough\\b|\\bthru\\b|\\bupto\\b)\\s*";
const ONG = "(?:till\\s+now|till\\s+date|to\\s+date|present(?:ly)?|current(?:ly)?|now|date|ongoing|today|continuing)";
const RANGE = new RegExp(`(${D})${SEP}(?:(${ONG})\\b|(${D}))`, "gi");
const SHORT_YEARS = new RegExp(`(?<![\\d/.\\-])(${Y4})\\s*[-–—]\\s*(\\d{2})(?![\\d/.\\-])`, "gi");   // 2014-16
const OPEN = new RegExp(`\\b(?:since|from)\\s+(${D})(?:\\s+onwards?)?\\s*$|(${D})\\s+onwards?\\b`, "gi");   // since Jan 2020 · Jan 2020 onwards
const MI: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

export type DatePoint = { t: number; year: number; month: number | null; precision: "month" | "year"; flags: string[] };
/** Two-digit years, one fixed rule: NN ≤ the evaluation year's last two digits → 20NN, otherwise 19NN. */
export const resolveYY = (yy: number, now: Date) => (yy <= now.getFullYear() % 100 ? 2000 + yy : 1900 + yy);
export function parseDate(s: string, now: Date, end: boolean): DatePoint | null {
  const flags: string[] = []; const low = s.toLowerCase().trim(); let year: number | null = null, month: number | null = null;
  const mon = new RegExp(`\\b(${MON})\\b`, "i").exec(low);
  if (mon) {
    month = MI[mon[1].slice(0, 3)]; const rest = low.slice(mon.index + mon[1].length);
    const y4 = new RegExp(Y4).exec(rest) ?? new RegExp(Y4).exec(low);
    if (y4) year = +y4[0];
    else { const apo = new RegExp(`${APO}\\s?(\\d{2})`).exec(rest); const bare = /(\d{2})(?!\d)/.exec(rest);
      if (apo) { year = resolveYY(+apo[1], now); flags.push("two_digit_year"); }
      else if (bare) { year = resolveYY(+bare[1], now); flags.push("two_digit_year"); if (+bare[1] >= 1 && +bare[1] <= 31) flags.push("two_digit_year_could_be_a_day"); } }
  } else {
    const num = /^(?:(\d{1,2})[/.\-])?(\d{1,2})[/.\-]((?:19|20)\d{2})$/.exec(low);
    if (num) { year = +num[3]; const a = num[1] ? +num[1] : null, b = +num[2];
      if (a === null) { if (b >= 1 && b <= 12) month = b - 1; else flags.push("month_out_of_range"); }
      else if (b >= 1 && b <= 12 && a > 12) month = b - 1; else if (a >= 1 && a <= 12 && b > 12) month = a - 1;
      else if (a >= 1 && a <= 12 && b >= 1 && b <= 12) { month = b - 1; if (a !== b) flags.push("day_month_order_assumed"); } else flags.push("month_out_of_range"); }
    else { const y4 = /^((?:19|20)\d{2})$/.exec(low); const apo = new RegExp(`^${APO}(\\d{2})$`).exec(low);
      if (y4) year = +y4[1]; else if (apo) { year = resolveYY(+apo[1], now); flags.push("two_digit_year"); } }
  }
  if (year === null) return null;
  const precision = month === null ? "year" : "month";
  // a closed month or year counts in full: "to Mar 2020" ends at the end of March; "to 2020" at the end of 2020
  // A year with no month is read as mid-year (the unbiased point; flagged as year-only, ± half a year at each end).
  const t = month === null ? year + 0.5 : year + (month + (end ? 1 : 0)) / 12;
  return { t, year, month, precision, flags };
}
export const nowT = (now: Date) => now.getFullYear() + (now.getMonth() + (now.getDate() - 1) / 31) / 12;

export type Kind = "employment" | "internship" | "education" | "project" | "other";
export type Interval = { kind: Kind; from: number; to: number; ongoing: boolean; precision: "month" | "year"; line_no: number; source_line: string; matched_text: string; flags: string[]; counted: boolean; why?: string; canon_key: number };
const SCHOOL = /\b(b\.?\s?tech|b\.?\s?e\b|bachelor|master|m\.?\s?tech|mba|pgdm|b\.?\s?com|m\.?\s?com|b\.?\s?sc|m\.?\s?sc|bca|mca|university|college|school|institute of|cgpa|gpa|percentage|higher secondary|secondary education|pre-?university|puc|sslc|hsc|class x|icse|cbse|diploma|ph\.?d|degree)\b/i;
const LEARNING = /\b(intern(ship)?|trainee|apprentice(ship)?|student|volunteer|summer project|academic project)\b/i;
const H_EDU = /^\W*(education(al)?( (details|qualifications?|background))?|academic(s| (details|profile|qualifications?|background|credentials))?|qualifications?|scholastic\w*)\W*$/i;
const H_EXP = /^\W*((professional|work|employment|career|relevant|industry) )?(experience|employment|work history|career history|employment history|experience summary|professional summary|organi[sz]ational experience)( (details|summary|history))?\W*$/i;
const H_PROJ = /^\W*((key|major|academic|personal|notable) )?projects?( (details|undertaken|handled|summary))?\W*$/i;
const H_OTHER = /^\W*(certifications?|courses?|trainings?|awards?|achievements?|personal (details|information|profile)|declaration|hobbies|interests|languages?|skills|technical skills|publications?|references?|extra[- ]curricular\w*)( .{0,20})?\W*$/i;
const PERSONAL = /\b(date of birth|d\.?o\.?b|born)\b/i;
const strip = (l: string) => l.replace(/^[\s|•●◦▪\-–*·​]+|[\s|.,;:​]+$/g, "");

export type Employment = { evaluated_at: string; intervals: Interval[]; total_years: number | null; basis: "dated_roles" | "stated" | "none"; internship_years: number; gaps: { from: number; to: number; years: number }[];
  stated: { years: number; source_line: string }[]; flags: string[]; canonical_text: string };
const r1 = (x: number) => Math.round(x * 10) / 10;
export function unionYears(iv: { from: number; to: number }[]): { years: number; merged: [number, number][] } {
  const s = iv.map((x) => [x.from, x.to] as [number, number]).sort((a, b) => a[0] - b[0]); const merged: [number, number][] = [];
  for (const [a, b] of s) { const last = merged[merged.length - 1]; if (last && a <= last[1] + 1e-9) last[1] = Math.max(last[1], b); else merged.push([a, b]); }
  return { years: r1(merged.reduce((t, [a, b]) => t + (b - a), 0)), merged };
}
const MONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const canon = (p: DatePoint) => (p.month === null ? String(p.year) : `${MONS[p.month]} ${p.year}`);

/** Read every date range in a résumé. `now` is the evaluation date: ongoing roles end there. */
export function employment(resume: string, now: Date): Employment {
  const raw = resume.split(/\r?\n/); const T = nowT(now); const intervals: Interval[] = []; const flags: string[] = []; const out: string[] = [];
  let section: "none" | "experience" | "education" | "project" | "other" = "none"; let sectionAt = 0; const REACH: Record<string, number> = { education: 6, other: 4, project: 10 };
  const lines = raw.map((l) => l.replace(/[ \t ]+/g, " ").trim());
  lines.forEach((l, i) => {
    const bare0 = strip(l); const words = bare0.split(/\s+/).filter(Boolean).length;
    if (words <= 6) { const was = section; if (H_EDU.test(bare0)) section = "education"; else if (H_EXP.test(bare0)) section = "experience"; else if (H_PROJ.test(bare0)) section = "project"; else if (H_OTHER.test(bare0)) section = "other"; if (section !== was || H_EDU.test(bare0) || H_OTHER.test(bare0) || H_PROJ.test(bare0)) sectionAt = i; }
    // a heading only governs the lines just under it: in two-column résumés flattened to text, a side-column heading
    // ("Education", "Skills") would otherwise swallow the employment history that follows it
    if (section !== "experience" && section !== "none" && i - sectionAt > REACH[section]) section = "none";
    let rebuilt = l; const found: { idx: number; len: number; from: DatePoint; to: DatePoint | null; ongoing: boolean; text: string }[] = [];
    const push = (idx: number, text: string, a: string, b: string | null, ongoing: boolean) => { if (found.some((f) => idx < f.idx + f.len && f.idx < idx + text.length)) return;
      const from = parseDate(a, now, false), to = ongoing ? null : parseDate(b!, now, true); if (!from || (!ongoing && !to)) return; found.push({ idx, len: text.length, from, to, ongoing, text }); };
    for (const m of l.matchAll(RANGE)) push(m.index!, m[0], m[1], m[3] ?? null, !!m[2]);   // full ranges first, so "2019 - 20 Mar 2021" is never read as 2019–2020
    for (const m of l.matchAll(SHORT_YEARS)) { const y1 = +m[1], y2 = Math.floor(y1 / 100) * 100 + +m[2]; if (y2 >= y1 && y2 - y1 <= 60) push(m.index!, m[0], m[1], String(y2), false); }
    for (const m of l.matchAll(OPEN)) push(m.index!, m[0], m[1] ?? m[2], null, true);
    for (const f of found.sort((a, b) => b.idx - a.idx)) {
      const fl = [...f.from.flags, ...(f.to?.flags ?? [])]; let from = f.from.t, to = f.ongoing ? T : f.to!.t;
      if (!f.ongoing && f.from.precision === "year" && f.to!.precision === "year" && f.from.year === f.to!.year) { from = f.from.year + 0.25; to = f.from.year + 0.75; }   // "2020 - 2020": half a year
      const rest = strip(l.slice(0, f.idx) + " " + l.slice(f.idx + f.len)); const restWords = rest.split(/\s+/).filter(Boolean).length;
      const atEdge = strip(l.slice(0, f.idx)).length <= 3 || strip(l.slice(f.idx + f.len)).length <= 3;
      const near = [lines[i - 1] ?? "", lines[i - 2] ?? ""]; const bare = restWords === 0;
      let kind: Kind = "employment", why: string | undefined;
      if (PERSONAL.test(l)) { kind = "other"; why = "personal detail line"; }
      else if (SCHOOL.test(l) || section === "education" || (bare && near.some((x) => SCHOOL.test(x)))) { kind = "education"; why = SCHOOL.test(l) ? "education words on the line" : section === "education" ? "inside the education section" : "bare dates next to an education line"; }
      else if (section === "other") { kind = "other"; why = "inside a non-employment section"; }
      else if (!atEdge && restWords > 12) { kind = "other"; why = "dates inside a sentence, not a role header"; }
      else if (l.length > 170) { kind = "other"; why = "long sentence, not a role header"; }
      else if (LEARNING.test(l) || (bare && LEARNING.test(lines[i - 1] ?? "")) || (restWords <= 2 && LEARNING.test(lines[i - 1] ?? ""))) { kind = "internship"; why = "internship or training"; }
      else if (section === "project") { kind = "project"; why = "inside a projects section"; }
      let counted = kind === "employment";
      if (!(from >= 1970)) { counted = false; fl.push("implausible_start"); }
      if (to < from) { counted = false; fl.push("end_before_start"); }
      if (from > T + 1 / 12 || (!f.ongoing && to > T + 1.01)) { counted = false; fl.push("date_in_the_future"); }
      intervals.push({ kind, from: +from.toFixed(3), to: +to.toFixed(3), ongoing: f.ongoing, precision: f.from.precision === "year" || f.to?.precision === "year" ? "year" : "month", line_no: i + 1, source_line: l.slice(0, 240), matched_text: f.text, flags: fl, counted, why, canon_key: f.from.year * 12 + (f.from.month ?? 0) });
      // canonical copy for the frozen title/specialisation reader: employment ranges in its own format; everything else made unreadable to it
      const c = counted ? `${canon(f.from)} - ${f.ongoing ? "Present" : canon(f.to!)}` : `${canon(f.from)} / ${f.ongoing ? "ongoing" : canon(f.to!)}`;
      rebuilt = rebuilt.slice(0, f.idx) + c + rebuilt.slice(f.idx + f.len);
    }
    out.push(rebuilt);
  });
  // one interval per (kind, from, to): a range repeated on two lines is one role
  const seen = new Set<string>(); const uniq = intervals.filter((x) => { const k = `${x.kind}|${x.from}|${x.to}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => b.to - a.to || b.from - a.from);
  const emp = uniq.filter((x) => x.counted); const u = unionYears(emp); const gaps = u.merged.slice(1).map((m, k) => ({ from: +u.merged[k][1].toFixed(2), to: +m[0].toFixed(2), years: r1(m[0] - u.merged[k][1]) })).filter((g) => g.years >= 0.2);
  const stated: Employment["stated"] = []; const SAID = /(\d{1,2}(?:\.\d{1,2})?)\s*\+?\s*(?:years?|yrs?)\b[^.\n]{0,60}\b(?:experience|exp\b|track record|expertise)|(?:experience|exp)\b[^.\n]{0,25}?(\d{1,2}(?:\.\d{1,2})?)\s*\+?\s*(?:years?|yrs?)\b/gi;
  lines.forEach((l) => { for (const m of l.matchAll(SAID)) { const y = Number(m[1] ?? m[2]); if (y > 0 && y <= 50 && !stated.some((s) => s.years === y)) stated.push({ years: y, source_line: l.slice(0, 200) }); } });
  let total: number | null = null, basis: Employment["basis"] = "none";
  if (emp.length) { total = u.years; basis = "dated_roles"; } else if (stated.length) { total = Math.max(...stated.map((s) => s.years)); basis = "stated"; flags.push("no_dated_employment: total taken from the résumé's own statement"); } else flags.push("no_dated_employment_and_no_stated_years");
  if (uniq.some((x) => x.kind === "project") && !emp.length) flags.push("only_project_dates_found");
  for (const s of stated) if (basis === "dated_roles" && Math.abs(s.years - total!) > 2) flags.push(`stated ${s.years} years differs from dated roles (${total})`);
  if (emp.some((x) => x.precision === "year")) flags.push("some roles dated by year only (read as mid-year; ± half a year at each such end)");
  for (const f of new Set(uniq.flatMap((x) => x.flags))) flags.push(f);
  return { evaluated_at: now.toISOString(), intervals: uniq, total_years: total, basis, internship_years: unionYears(uniq.filter((x) => x.kind === "internship" && x.to >= x.from)).years, gaps, stated, flags, canonical_text: out.join("\n") };
}
