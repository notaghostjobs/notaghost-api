// The job text inside a stored description. The reader stores what an employer's page gave it, and for some hiring systems
// that is the whole page: a cookie notice, the site's menus, the posting, then the footer; or the system's raw JSON. This
// returns the posting itself. It is deterministic (no model), never throws, and never touches the stored description: it is
// applied when a description is read. Text it does not recognise comes back unchanged.
//
// Measured on the open Bengaluru inventory, 24 Nov 2026 (25,349 descriptions): SuccessFactors 4,078 carry the cookie notice
// and menus; Amazon 960 carry menus and footer; SmartRecruiters 1,322 are raw JSON; Lever 384 carry a literal "\n".

export type PostingBody = {
  text: string;
  /** "ok": job text. "not_loaded": the page said the job could not be shown. "empty": nothing was stored. */
  state: "ok" | "not_loaded" | "empty";
  /** what was removed or converted, in order: for audits and tests */
  rules: string[];
};

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", times: "×", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", ndash: "–", mdash: "—", hellip: "…", bull: "•", middot: "·", raquo: "»", laquo: "«" };
const entities = (s: string) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});
const tags = (s: string) => s.replace(/<\s*(br|\/p|\/li|\/div|\/h[1-6]|\/tr)\s*\/?>/gi, "\n").replace(/<li[^>]*>/gi, "• ").replace(/<[^>]{1,400}>/g, " ");
const tidy = (s: string) => s.replace(/\r/g, "").replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/** A page that says the job is not there: nothing in it is a requirement. */
const NOT_LOADED = /couldn[’']t load job details|the job may have been removed or is no longer available/i;
/** SmartRecruiters' own section order, the job first: the employer's "about us" is kept, after what the role asks for. */
const SR_ORDER = ["jobDescription", "qualifications", "additionalInformation", "companyDescription"];

/** Where the posting starts on a page that opens with its menus: the hiring system's own last piece of page furniture
 *  before the job text. They are tried in this order and the FIRST place one is found, after "Skip to main content", is
 *  where the posting starts. Never a later one: a short posting has its closing "Apply now »" inside the opening stretch,
 *  and cutting there removed the whole posting (139 of 424 SuccessFactors pages, measured 24 Nov 2026). */
const HEAD_AFTER: { rule: string; re: RegExp }[] = [
  { rule: "head:amazon", re: /Apply now\s+(?=Description\s)/g },                    // "… Job ID: 10587294 | ADCI - Karnataka Apply now Description …"
  { rule: "head:successfactors", re: /Please wait\.\.\.\s*/g },                     // "… Apply now » Apply now Start applying with LinkedIn Apply Now Start Please wait... "
  { rule: "head:successfactors", re: /Apply now »(?!\s*Find similar jobs)\s*/g },   // pages without the "Please wait..." line; not the "Apply now »" that closes the posting
];
/** Where the posting ends: the first of these after the job text has begun. */
const TAIL_FROM: { rule: string; re: RegExp }[] = [
  { rule: "tail:successfactors", re: /Apply now »\s+Find similar jobs:|Find similar jobs:/ },
  { rule: "tail:cookies", re: /Cookie Consent Manager|Consent to all (Required|Functional|Advertising|Performance) Cookies|Modify Cookie Preferences|Confirm My Choices/ },
  { rule: "tail:amazon", re: /Job details\s[\s\S]{0,240}?Share this job|Share this job\s+JOIN US ON/ },
];
/** "… Apply now » Apply now Start applying with LinkedIn Apply Now Start Please wait..." as the last words of the text. */
const APPLY_BLOCK = /(?:Apply now »\s*)?Apply now\s[\s\S]{0,80}?Please wait\.\.\.\s*$/;
const OPENING = 6000;   // menus and notices sit in the opening stretch; a marker further in is the posting's own words
const LEAST = 200;      // a cut that would leave less than this is not made, unless the start of the posting was found: better the page than a stub

export function postingBody(raw: string | null | undefined): PostingBody {
  const rules: string[] = [];
  let t = String(raw ?? "");
  if (!t.trim()) return { text: "", state: "empty", rules };
  if (NOT_LOADED.test(t.slice(0, 800))) return { text: "", state: "not_loaded", rules: ["not_loaded"] };

  // 1. a hiring system's raw JSON: the sections, as text
  if (t.trimStart().startsWith("{") && /"sections"\s*:/.test(t)) {
    try {
      const j = JSON.parse(t); const sec = j?.content?.sections ?? j?.jobAd?.sections ?? j?.sections;
      if (sec && typeof sec === "object") {
        const keys = [...SR_ORDER.filter((k) => sec[k]), ...Object.keys(sec).filter((k) => !SR_ORDER.includes(k))];
        const parts = keys.map((k) => { const s = sec[k] ?? {}; const body = tidy(entities(tags(String(s.text ?? "")))); return body ? `${String(s.title ?? k).trim()}\n${body}` : ""; }).filter(Boolean);
        if (parts.length) { t = parts.join("\n\n"); rules.push("json:sections"); }
      }
    } catch { /* not whole JSON: left as it is, and the rules below do what they can */ }
  }

  // 2. escapes a careers API left in the text
  if (/\\n/.test(t)) { t = t.replace(/\\r?\\n|\\n/g, "\n").replace(/\\t/g, " "); rules.push("escapes"); }
  if (/&(#x?[0-9a-f]+|[a-z]+);/i.test(t)) { const u = entities(t); if (u !== t) { t = u; rules.push("entities"); } }

  // 3. the page's opening furniture
  let known = false;   // the text now starts at the posting itself: what follows a closing marker is furniture however short the posting
  const paged = /Skip to main content/.test(t.slice(0, OPENING));   // a stored web page, not a posting's own text
  if (paged) {
    const from = t.indexOf("Skip to main content") + "Skip to main content".length;
    let cut = -1, rule = "";
    for (const h of HEAD_AFTER) { h.re.lastIndex = from; const m = h.re.exec(t); if (m && m.index < OPENING) { cut = m.index + m[0].length; rule = h.rule; break; } }
    if (cut < 0) { cut = from; rule = "head:menu-only"; }   // no known last piece: the notice goes, the menu may remain
    if (t.length - cut >= LEAST) { t = t.slice(cut); rules.push(rule); known = rule !== "head:menu-only"; }
  }

  // 4. the page's closing furniture: only on a stored page. A posting's own words may say "cookie" or "Apply now".
  let end = -1, endRule = "";
  if (paged) for (const x of TAIL_FROM) { const m = x.re.exec(t); if (m && m.index >= (known ? 1 : LEAST) && (end < 0 || m.index < end)) { end = m.index; endRule = x.rule; } }
  if (end >= 0) { t = t.slice(0, end); rules.push(endRule); }
  // the apply buttons a SuccessFactors page repeats under the posting: only as the very last words, only button labels
  if (paged) { const m = APPLY_BLOCK.exec(t); if (m && m.index >= (known ? 1 : LEAST)) { t = t.slice(0, m.index); rules.push("tail:apply-buttons"); } }

  t = tidy(t);
  return { text: t, state: t ? "ok" : "empty", rules };
}
