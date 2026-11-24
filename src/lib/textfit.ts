// The free reading of a posting against a résumé, before anything is sent to a model. Words only, deterministic.
//
// Three things live here:
//   1. postingProblem: postings that are not postings (a page that failed to load, a search-results page, an employer's
//      empty template, a test job). Short is not a problem: a real 40-word posting stays.
//   2. textFit: how much of what a posting is specifically about the résumé speaks to. "Specifically" is measured, not
//      listed: a word that appears in a large share of all postings ("team", "stakeholders", an employer's standard
//      paragraph) carries no weight, and a word in a handful of postings ("underwriting", "apex triggers") carries a lot.
//   3. forReading: the roles to read closely, chosen by title AND text, with the employer limit of closest().
//
// Nothing here decides that a person is suitable. It decides which roles are worth the careful reading that does.
import { postingBody } from "./posting.js";
import { CLOSE, titleFit, titleScore, type Level, type Row } from "./usmatch.js";

// ── 1. postings that are not postings ────────────────────────────────────────────────────────────────────────────────
const LABELS = new Set("country region requisition id work model position type salary range location title description date company about us purpose scope experience qualification qualifications key responsibilities responsibility competencies area areas job details apply now posted full time india bengaluru bangalore karnataka ka in of the and for".split(" "));
const TEST_TEXT = /\bthis is a test (job|posting|requisition)\b|\btest job (created|to test)\b|\bfor (system validation|integration testing|ntegration testing) purposes\b|\bpartner sandbox\b/i;
const TEST_TITLE = /(^|[\s_])TEST([\s_]|$)[\s\S]*\b(JOB|E2E|LEVER|REQ)\b|\bbug bash\b|\bjobReq\s*\d/;   // "SJ TEST E2E Bug Bash Job"; never "Test Engineer"
const LISTING = /\bSearch results\b|JavaScript is turned off in your web browser|^Careers Home \|/;

/** Why this is not a posting a person could act on, or null when it is one. `raw` is the stored description. */
export function postingProblem(title: string, raw: string | null | undefined): { problem: string | null; text: string } {
  const b = postingBody(raw);
  if (b.state === "not_loaded") return { problem: "the page could not show the job", text: "" };
  if (b.state === "empty") return { problem: "no description", text: "" };
  const text = b.text, flat = text.replace(/\s+/g, " ").trim();
  if (/^\{"(widget|uuid)"/.test(flat)) return { problem: "not the posting: a redirect or an empty record", text: "" };
  if (TEST_TEXT.test(flat.slice(0, 2000)) || TEST_TITLE.test(title)) return { problem: "a test job", text: "" };
  const words = flat.split(" ").length;
  if (words < 150 && LISTING.test(flat.slice(0, 400))) return { problem: "a careers search page, not the posting", text: "" };
  if (/Description:\s*Area\(s\) of responsibility\s*\.?\s*$/.test(flat)) return { problem: "the employer left the description empty", text: "" };
  if (words < 150) {
    // what is left when style rules, the title and field labels are taken away: a real short posting still says something
    const own = new Set(title.toLowerCase().match(/[a-z]{3,}/g) ?? []);
    const said = new Set((flat.replace(/[\w.#-]*\s*\{[^}]*\}/g, " ").toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !own.has(w) && !LABELS.has(w)));
    if (said.size < 10) return { problem: "the employer left the description empty", text: "" };
  }
  return { problem: null, text };
}

// ── 2. words ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const STOP = new Set("a an the and or of to in on at by for with from as is are was were be been being this that these those it its our your their we you they i he she will would can could should may might must shall have has had do does did not no nor so if then than but about into over under across per via within without between through during before after above below up down out off also etc such other any all each every both either more most less least very much many few new own same able including include includes using use used work working works role roles job jobs position candidate candidates company team teams years year experience experienced strong good excellent ability skills skill knowledge understanding required requirements preferred responsibilities responsible ensure ensuring provide providing support supporting manage managing management business".split(" "));
/** Words that describe how anyone works, not what the work is. They never count as evidence of suitability. */
const GENERIC = new Set("communication communicate stakeholder stakeholders collaborate collaboration collaborative cross functional crossfunctional leadership leader proactive detail oriented problem solving solve analytical interpersonal motivated passionate dynamic fast paced environment deliver delivery delivering drive driving driven results result opportunity opportunities growth global world diverse diversity inclusion inclusive equal employer benefits culture values mission vision innovative innovation excellence best practices practice high quality time timely effectively effective efficient efficiently multiple various key senior junior level client clients customer customers people process processes project projects solution solutions service services".split(" "));
const stem = (w: string) => (w.length > 4 && w.endsWith("s") && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w);
/** The terms of a text: its content words and the pairs of content words that stand next to each other. */
export function terms(text: string): string[] {
  const out: string[] = []; let prev: string | null = null;
  for (const raw of text.toLowerCase().match(/[a-z][a-z0-9+#]*(?:[.\/&-][a-z0-9+#]+)*/g) ?? []) {
    const w = stem(raw);
    if (w.length < 2 || STOP.has(w) || STOP.has(raw)) { prev = null; continue; }
    if (GENERIC.has(w) || GENERIC.has(raw)) { prev = null; continue; }
    out.push(w); if (prev) out.push(`${prev} ${w}`); prev = w;
  }
  return out;
}

export type Idf = { n: number; df: Map<string, number>; employers: Map<string, number> };
/** How many of a set of postings carry each term, and how many different employers use it. Build it from all open
 *  postings, or from a fair sample of them. */
export function corpus(postings: Iterable<{ text: string; employer: string }>, chars = 6000): Idf {
  const df = new Map<string, number>(), employers = new Map<string, number>(), last = new Map<string, string>(); let n = 0;
  const byEmployer = [...postings].sort((a, b) => a.employer.localeCompare(b.employer));   // so "a different employer" is one comparison
  for (const p of byEmployer) {
    n++;
    for (const w of new Set(terms(p.text.slice(0, chars)))) {
      df.set(w, (df.get(w) ?? 0) + 1);
      if (last.get(w) !== p.employer) { last.set(w, p.employer); employers.set(w, (employers.get(w) ?? 0) + 1); }
    }
  }
  return { n, df, employers };
}
const COMMON = 0.10;   // in more than a tenth of all postings: says nothing about a particular job
const RARE = 0.0005;   // in fewer than one posting in two thousand: a name, an id, one employer's turn of phrase
const SHARED_BY = 6;   // used by fewer employers than this: an employer's name, product or standard paragraph, not a skill
/** The weight of a term: nothing when it is in more than a tenth of all postings (generic), in almost none (a name, a
 *  typo, an id), or used by only a few employers however often (their own boilerplate); more the rarer it is in between. */
export function weight(idf: Idf, w: string): number {
  const d = idf.df.get(w) ?? 0;
  if (d < Math.max(3, idf.n * RARE) || d > idf.n * COMMON) return 0;
  if ((idf.employers.get(w) ?? 0) < Math.min(SHARED_BY, Math.max(2, Math.round(idf.n / 400)))) return 0;
  return Math.log(idf.n / (1 + d));
}

/** What a résumé says, as a set of terms that carry weight. */
export const resumeTerms = (resume: string, idf: Idf) => new Set(terms(resume).filter((w) => weight(idf, w) > 0));

/** 0 to 1: of the forty terms that most mark this posting out, the weighted share the résumé also uses. `shared` are the
 *  heaviest of them, for showing why. A posting with nothing specific in it scores 0, whatever the résumé says. */
export function textFit(mine: Set<string>, posting: string, idf: Idf, chars = 6000): { fit: number; shared: string[] } {
  const tf = new Map<string, number>(); for (const w of terms(posting.slice(0, chars))) tf.set(w, (tf.get(w) ?? 0) + 1);
  const marked = [...tf].map(([w, n]) => ({ w, x: weight(idf, w) * Math.min(3, n) })).filter((t) => t.x > 0).sort((a, b) => b.x - a.x).slice(0, 40);
  const all = marked.reduce((s, t) => s + t.x, 0); if (marked.length < 5 || !all) return { fit: 0, shared: [] };
  const hit = marked.filter((t) => mine.has(t.w));
  return { fit: hit.reduce((s, t) => s + t.x, 0) / all, shared: hit.slice(0, 6).map((t) => t.w) };
}

// ── 3. the roles to read closely ─────────────────────────────────────────────────────────────────────────────────────
/** Like closest(…, fill = true), with the text read as well. Close title matches come first, as before; among them, and
 *  among the rest, the order is title and text together, so when there are more close titles than places the résumé
 *  decides which are read. `fitOf` gives the text fit of a row, or null when its text is not held. */
export function forReading(rows: Row[], targets: string[], level: Level, fitOf: (r: Row) => number | null, keep = 40, now = Date.now(), most = 8): Row[] {
  const fits = rows.map((r) => fitOf(r)).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const mid = fits.length ? fits[Math.floor(fits.length / 2)] : 0;                     // a role whose text is not held is neither helped nor hurt
  const top = fits.length ? Math.max(fits[fits.length - 1], 1e-9) : 1;
  const scored = rows.map((r) => { const t = titleScore(r, targets, level, now); const f = fitOf(r) ?? mid; return { r, t, close: titleFit(r.title, targets) >= CLOSE, s: 0.5 * t + 0.5 * (f / top) }; })
    .filter((x) => x.t > 0.2).sort((a, b) => b.s - a.s);
  const per = new Map<string, number>(), out: Row[] = [];
  const emp = (r: Row) => `${r.system}/${r.ref}`.toLowerCase();
  const take = (list: Row[], cap: number) => { const left: Row[] = []; for (const r of list) { const k = emp(r), n = per.get(k) ?? 0; if (out.length >= keep || n >= cap) { left.push(r); continue; } per.set(k, n + 1); out.push(r); } return left; };
  let close = scored.filter((x) => x.close).map((x) => x.r);
  for (let cap = 2; cap <= most && close.length && out.length < keep; cap++) close = take(close, cap);
  take(scored.filter((x) => !x.close).map((x) => x.r), 2);
  return out;
}
