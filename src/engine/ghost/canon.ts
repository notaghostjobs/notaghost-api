import { createHash } from "node:crypto";

/** One key per JOB, whatever the link looks like. */
export function jobKey(url: string): { key: string; source: "linkedin" | "naukri" | "indeed" | "board" | "ats" | "careers" } {
  const u = url.trim();
  let m: RegExpMatchArray | null;
  if ((m = u.match(/linkedin\.com\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/i))) return { key: `linkedin:${m[1]}`, source: "linkedin" };
  if ((m = u.match(/linkedin\.com\/jobs\/.*currentJobId=(\d{6,})/i))) return { key: `linkedin:${m[1]}`, source: "linkedin" };
  if ((m = u.match(/naukri\.com\/.*?-(\d{8,})(?:[?#]|$)/i))) return { key: `naukri:${m[1]}`, source: "naukri" };
  if ((m = u.match(/naukri\.com\/job-listings-.*?-(\d{8,})/i))) return { key: `naukri:${m[1]}`, source: "naukri" };
  if ((m = u.match(/indeed\.[a-z.]+\/.*?(?:jk=|viewjob\?.*?jk=)([0-9a-f]{10,})/i))) return { key: `indeed:${m[1]}`, source: "indeed" };
  if ((m = u.match(/(?:boards|job-boards(?:\.eu)?)\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/i))) return { key: `greenhouse:${m[1]}:${m[2]}`, source: "ats" };
  if ((m = u.match(/jobs\.lever\.co\/([^/]+)\/([0-9a-f-]{20,})/i))) return { key: `lever:${m[1]}:${m[2]}`, source: "ats" };
  if ((m = u.match(/jobs\.ashbyhq\.com\/([^/]+)\/([0-9a-f-]{20,})/i))) return { key: `ashby:${m[1]}:${m[2]}`, source: "ats" };
  if ((m = u.match(/myworkdayjobs\.com\/.*?\/job\/.*?[_-]([A-Z0-9-]{4,})$/i))) return { key: `workday:${m[1]}`, source: "ats" };
  if (/greenhouse|lever\.co|ashbyhq|smartrecruiters|workday|darwinbox|keka|zohorecruit|bamboohr|icims|taleo|successfactors|jobvite|recruitee|freshteam/i.test(u)) return { key: `url:${sha(strip(u))}`, source: "ats" };
  if (/foundit|shine\.com|glassdoor|instahyre|cutshort|hirist|iimjobs|wellfound|internshala|apna\.co|timesjobs/i.test(u)) return { key: `url:${sha(strip(u))}`, source: "board" };
  return { key: `url:${sha(strip(u))}`, source: "careers" };
}

/** Drop tracking params and fragments. */
export function strip(url: string) {
  try {
    const x = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|ref|refid|trackingid|src|source|fbclid|gclid|_hsenc|mkt_tok|ebp|alternatechannel|isjobsearch|skipredirect|position|pageNum|currentJobId$)/i.test(k)) x.searchParams.delete(k);
    x.hash = "";
    return x.toString().replace(/\/$/, "").toLowerCase();
  } catch { return url.trim().toLowerCase(); }
}

export const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);

/** Normalised company key: "Elevation Capital (Portfolio Co.)" -> "elevation capital" */
export function companyKey(name: string) {
  return name.toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(pvt|private|ltd|limited|inc|llc|llp|technologies|technology|tech|solutions|services|india|global|group|labs|co|corp|corporation)\b\.?/g, " ")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/** LinkedIn rows scored before this instant may hold another job's text (split-view misread); nothing stored before it is trusted. */
export const CLEAN_SINCE = "2026-10-27T08:20:00.000Z";
/** Since this moment every check that ran is a line on the card (29 Oct). Rows scored earlier show a partial list and are re-scored on sight, history kept. */
export const FULL_LIST_SINCE = "2026-11-02T14:05:00.000Z";   // 2 Nov: signals 1,2,3,4,5,15 corrected after the 200-posting audit; cards scored before this re-score on sight

/**
 * The posting without the job board's furniture. LinkedIn's split view puts "see how you compare", the Premium
 * module, "about the company" and the footer inside the job pane; read as part of the description they make every
 * posting look like every other. Cut from the first such heading after the description starts.
 */
const FURNITURE_END = /\n\s*(?:About the company|See how you compare(?: to other applicants)?|Applicants for this job|Premium\s*\n|Explore Premium|People you can reach out to|Set alert for similar jobs|Looking for talent\??|Similar jobs|More jobs for you|Jobs you might be interested in|Referrals increase your chances|Skills match|Job search faster|Requirements added by the job poster|How you match|Get personalized tips)/i;
const FURNITURE_LINES = /^\s*(?:Premium|Determine your fit and how to stand out|Job match is \w+, we can help you stand out|Your profile and resume match.*|Show match details|Tailor my resume|Help me stand out|Create cover letter|BETA\s*·.*|Is this information helpful\??|No response insights available yet|Responses managed off LinkedIn|Promoted by hirer|Easy Apply|Apply|Save|Show all|more|…see more|See more|Show less)\s*$/gim;
export function stripFurniture(text: string) {
  if (!text) return text;
  const start = text.search(/About the job/i);
  // the head is our own five lines (title, company, location, posted, applicants); anything else before "About the job" is the board's
  const head = start > 0 ? text.slice(0, start).split("\n").slice(0, 6).join("\n").trimEnd() + "\n\n" : "";
  let body = start >= 0 ? text.slice(start) : text;
  const end = body.slice(14).search(FURNITURE_END);
  if (end >= 0) body = body.slice(0, 14 + end);
  return (head + body).replace(FURNITURE_LINES, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** 64-bit simhash over word shingles; near-duplicate descriptions share most bits. */
export function fingerprint(text: string) {
  const words = text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const v = new Array<number>(64).fill(0);
  for (let i = 0; i + 2 < words.length; i++) {
    const h = createHash("md5").update(words.slice(i, i + 3).join(" ")).digest();
    for (let b = 0; b < 64; b++) v[b] += (h[b >> 3] >> (b & 7)) & 1 ? 1 : -1;
  }
  return v.map((x) => (x > 0 ? "1" : "0")).join("");
}
export function hamming(a: string, b: string) { let d = 0; for (let i = 0; i < 64; i++) if (a[i] !== b[i]) d++; return d; }

/** A search or list page, not one job: no verdict can be honest about it. */
export function isListingPage(url: string): boolean {
  const u = url.trim();
  if (/linkedin\.com\/jobs\/(?:search|search-results|collections)/i.test(u) && !/currentJobId=\d{6,}/i.test(u)) return true;
  if (/indeed\.[a-z.]+\/(?:jobs|q-)/i.test(u) && !/jk=[0-9a-f]{10,}/i.test(u)) return true;
  if (/naukri\.com\//i.test(u) && !/\d{8,}/.test(u) && /-jobs(?:-in-|$|\?|\/)/i.test(u)) return true;
  if (/glassdoor\.[a-z.]+\/Job\/.*SRCH/i.test(u)) return true;
  return false;
}

/** A bare domain or site root ("https://cursor.com/") is never a job posting. */
export function isSiteRoot(url: string): boolean {
  try { const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`); return (u.pathname === "/" || u.pathname === "") && !u.search; } catch { return false; }
}
const JD_MARKERS = [
  /\bresponsibilit(?:y|ies)\b/i, /\brequirements?\b/i, /\bqualifications?\b/i, /\bwhat you.ll (?:do|be doing|bring)\b/i, /\bwhat we.re looking for\b/i,
  /\bapply (?:now|for this (?:job|role|position))\b/i, /\bjob (?:description|type|id|ref)\b/i, /\babout the (?:role|job|position|team)\b/i,
  /\byears? of experience\b/i, /\b(?:full|part)[- ]time\b/i, /\bemployment type\b/i, /\bwho you are\b/i, /\bnice to have\b/i, /\bpreferred (?:skills|qualifications)\b/i,
  /\bmust[- ]have\b/i, /\bkey skills\b/i, /\brole overview\b/i, /\bwork location\b/i, /\bctc\b/i, /\bnotice period\b/i,
];
/** Does the page we read look like one job posting? Boards and ATS pages are trusted by URL; anything else must either
 *  declare itself (schema.org JobPosting) or read like a JD: several of the usual sections present. A company homepage,
 *  a blog post or a product page fails this and is refused instead of being scored. */
export function looksLikeJob(raw: { text: string; job_ld?: boolean; title?: string | null; source: string }): boolean {
  if (raw.source !== "careers") return true;
  if (raw.job_ld) return true;
  const t = raw.text.slice(0, 30000);
  const hits = JD_MARKERS.reduce((n, re) => n + (re.test(t) ? 1 : 0), 0);
  return hits >= 3;
}

/** The one URL we fetch, cache and hash for a posting, whatever form the person pasted. LinkedIn search, collections and
 *  "search-results" links carry the job as currentJobId — those become the job's own page; tracking parameters go. */
export function canonicalPostingUrl(url: string): string {
  const u = /^https?:\/\//i.test(url) ? url.trim() : `https://${url.trim()}`;
  const li = u.match(/linkedin\.com\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/i) ?? u.match(/linkedin\.com\/jobs\/.*?[?&]currentJobId=(\d{6,})/i);
  if (li) return `https://www.linkedin.com/jobs/view/${li[1]}/`;
  const nk = u.match(/naukri\.com\/job-listings-[^?#]*?-(\d{8,})/i) ?? u.match(/naukri\.com\/[^?#]*?-(\d{8,})(?:[?#]|$)/i);
  if (nk) { try { const x = new URL(u); x.search = ""; x.hash = ""; return x.toString(); } catch { /* fall through */ } }
  return strip(u);
}
