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
  if ((m = u.match(/boards\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/i))) return { key: `greenhouse:${m[1]}:${m[2]}`, source: "ats" };
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
