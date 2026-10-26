import { htmlToText } from "../extract.js";
import { json, FAST } from "../claude.js";
import { jobKey } from "./canon.js";
import type { PostingFacts } from "./types.js";

const UA = "GhostedReader/1.0 (+https://notaghost.jobs/reader/; hello@notaghost.jobs)";
const H = { "user-agent": UA, "accept-language": "en-IN,en;q=0.9", accept: "text/html,application/json;q=0.9,*/*;q=0.8" };
const get = (u: string, extra: Record<string, string> = {}) => fetch(u, { headers: { ...H, ...extra }, redirect: "follow", signal: AbortSignal.timeout(15000) });

export interface RawRead {
  text: string;
  html?: string;
  posted_text?: string | null;
  posted_days?: number | null;
  applicants?: number | null;
  apply_url?: string | null;
  company?: string | null;
  title?: string | null;
  location?: string | null;
  poster?: { name: string | null } | null;
  source: PostingFacts["source"];
}

/** Read a posting from wherever it lives. Returns text plus whatever structured fields the source exposes. */
export async function readPosting(url: string): Promise<RawRead> {
  const { key, source } = jobKey(url);

  if (source === "linkedin") {
    const id = key.split(":")[1];
    // 1. guest API: description + company + title, no date
    let guest: RawRead | null = null;
    try {
      const r = await get(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`);
      if (r.ok) {
        const html = await r.text();
        const text = htmlToText(html);
        if (text.length > 200) {
          guest = { text, html, source: "linkedin",
            title: pick(html, /<h2[^>]*top-card-layout__title[^>]*>([\s\S]*?)<\/h2>/i) ?? pick(html, /<title>([^<|]+)/i),
            company: pick(html, /topcard__org-name-link[^>]*>([\s\S]*?)<\/a>/i) ?? pick(html, /<title>[^<]*?\b(?:at|-)\s+([^|<]+?)\s*\|/i),
            location: pick(html, /topcard__flavor--bullet[^>]*>([\s\S]*?)<\/span>/i),
            posted_text: pick(html, /posted-time-ago__text[^>]*>([\s\S]*?)<\/span>/i),
            applicants: num(pick(html, /num-applicants__caption[^>]*>([\s\S]*?)<\/span>/i)),
            apply_url: pick(html, /applyUrl":"([^"]+)"/i) ?? pick(html, /<a[^>]+class="[^"]*apply-button[^"]*"[^>]+href="([^"]+)"/i),
          };
        }
      }
    } catch { /* fall through */ }
    // 2. normal page for date/applicants if the guest copy lacked them
    if (!guest?.posted_text || guest.applicants == null) {
      try {
        const r = await get(`https://www.linkedin.com/jobs/view/${id}/`);
        if (r.ok) {
          const html = await r.text();
          const pt = pick(html, /posted-time-ago__text[^>]*>([\s\S]*?)<\/span>/i) ?? pick(html, /"datePosted":"([^"]+)"/i);
          const ap = num(pick(html, /num-applicants__caption[^>]*>([\s\S]*?)<\/span>/i) ?? pick(html, /(\d[\d,]*\+?)\s+applicants/i));
          if (guest) { guest.posted_text = guest.posted_text ?? pt; guest.applicants = guest.applicants ?? ap; }
          else { const text = htmlToText(html); if (text.length > 200) guest = { text, html, source: "linkedin", posted_text: pt, applicants: ap }; }
        }
      } catch { /* fine */ }
    }
    if (guest) { guest.posted_days = guest.posted_days ?? daysFromText(guest.posted_text); return guest; }
    throw blocked("LinkedIn");
  }

  if (source === "naukri") {
    const id = key.split(":")[1];
    try {
      const r = await get(`https://www.naukri.com/jobapi/v4/job/${id}`, { appid: "121", systemid: "Naukri", "content-type": "application/json" });
      if (r.ok) {
        const j: any = await r.json();
        const d = j?.jobDetails;
        if (d?.description) {
          const text = htmlToText(`<h1>${d.title}</h1><p>${d.companyDetail?.name ?? ""}</p><p>${(d.locations ?? []).map((l: any) => l.label).join(", ")}</p>${d.description}`);
          const created = d.createdDate ? new Date(Number(d.createdDate)) : null;
          return { text, source: "naukri", title: d.title, company: d.companyDetail?.name, location: (d.locations ?? []).map((l: any) => l.label).join(", "),
            posted_text: created ? `Posted ${created.toDateString()}` : null, posted_days: created ? Math.floor((Date.now() - created.getTime()) / 86400e3) : null,
            applicants: d.applyCount ?? null, apply_url: d.applyRedirectUrl ?? null };
        }
      }
    } catch { /* fall through to browser */ }
    const html = await renderWithBrowser(url);
    const text = htmlToText(html);
    if (text.length < 200) throw blocked("Naukri");
    return { text, html, source: "naukri", posted_text: pick(html, /(\d+\s+days?\s+ago|today|just now|few hours ago|\d+\s+weeks?\s+ago)/i), applicants: num(pick(html, /(\d[\d,]*\+?)\s*Applicants/i)) };
  }

  // careers pages / ATS / other boards: plain fetch, JSON-LD when present, browser fallback for JS-only pages
  let html = "";
  try { const r = await get(url); if (r.ok) html = await r.text(); else if (r.status === 403 || r.status === 429) throw blocked(new URL(url).hostname); } catch (e) { if ((e as any).status) throw e; }
  let text = html ? htmlToText(html) : "";
  if (text.length < 300) { try { html = await renderWithBrowser(url); text = htmlToText(html); } catch { /* ignore */ } }
  if (text.length < 200) throw blocked(new URL(url).hostname);
  const ld = jsonLd(html);
  return { text, html, source, title: ld?.title ?? null, company: ld?.hiringOrganization?.name ?? null,
    location: ld?.jobLocation?.address?.addressLocality ?? null,
    posted_text: ld?.datePosted ? `Posted ${new Date(ld.datePosted).toDateString()}` : pick(html, /(\d+\s+days?\s+ago|\d+\s+weeks?\s+ago|\d+\s+months?\s+ago)/i),
    posted_days: ld?.datePosted ? Math.floor((Date.now() - new Date(ld.datePosted).getTime()) / 86400e3) : null,
    apply_url: ld?.applicationUrl ?? null, applicants: null };
}

/** The model reads the text and reports ONLY what is literally there. Deterministic enough: temperature 0, facts not opinions. */
type Extracted = Omit<PostingFacts, "job_key" | "read_at" | "source" | "url" | "description">;

/** The ₹0 reading: every fact a rule can read from the text, no model. What a rule cannot see stays null/false
 *  and the score treats it as "not checked" rather than guessing. The free check runs on this; the model reading
 *  is reserved for paid flows. */
export function extractFactsRules(raw: RawRead, url: string): Extracted {
  const text = raw.text ?? ""; const low = text.toLowerCase();
  const title = (raw.title ?? "").trim(); const company = (raw.company ?? "").trim(); const location = (raw.location ?? "").trim();
  const posted_text = raw.posted_text ?? ((text.match(/\b(?:re-?posted\s+)?\d+\s+(?:minute|hour|day|week|month)s?\s+ago\b/i) || [])[0] ?? null);
  const posted_days = raw.posted_days ?? daysFromText(posted_text);
  const applicants = raw.applicants ?? (() => { const m = text.match(/(?:over\s+)?(\d[\d,]*)\+?\s*(?:applicants|people clicked apply)/i); return m ? Number(m[1].replace(/,/g, "")) : null; })();
  const locParts = location.split(/\s*(?:\/|\||·|;)\s*/).map((s) => s.trim()).filter(Boolean);
  const locations_count = Math.max(1, new Set(locParts.map((s) => s.toLowerCase())).size + (/\bremote\b/i.test(location) && !/remote/i.test(locParts.join()) ? 1 : 0));
  const pay_stated = /(?:₹|rs\.?|inr|\$|usd|eur|£)\s?\d[\d,.]*\s*(?:k|l|lpa|lakhs?|cr)?(?:\s*(?:-|–|to)\s*(?:₹|rs\.?|inr|\$)?\s?\d[\d,.]*\s*(?:k|l|lpa|lakhs?|cr)?)?|\b\d{1,3}(?:\.\d)?\s*(?:lpa|lakhs?\b|lacs?\b)|\bctc\s*[:\-]?\s*\d|per annum\s*[:\-]?\s*\d/i.test(text);
  const evergreen = /talent (?:community|pool|network)|future opportunit|always looking|multiple openings|across (?:all )?levels|open pipeline|ongoing requirement|evergreen/i.test(low);
  const specific = /\b(?:you will|you'll|responsib|our team|the team|this role|reporting to|manager|product|platform|customers?|stakeholders?|roadmap|own the|lead the)\b/i;
  const templated = text.length < 250 || !specific.test(text);
  const yrs = low.match(/(\d{1,2})\s*(?:\+|-|–|to)?\s*(?:\d{1,2})?\s*\+?\s*(?:years?|yrs?)/); const minYears = yrs ? Number(yrs[1]) : null;
  const senior = /\b(senior|sr\.?|lead|principal|staff|director|head|vp|manager)\b/i.test(title);
  const musts = (text.match(/\bmust\b|\brequired\b|\bmandatory\b/gi) || []).length;
  const kitchen_sink = (senior && minYears != null && minYears <= 2) || musts >= 15;
  const email = text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/); const form = text.match(/https?:\/\/(?:forms\.gle|docs\.google\.com\/forms|[\w.-]*typeform\.com|[\w.-]*jotform\.com)[^\s"')]*/i);
  const dm = /\b(?:whatsapp|telegram)\b[^.\n]{0,40}\b(?:\+?\d[\d\s-]{8,})/i.test(text) || /\b(?:dm|message) (?:me|us) (?:on|at|via)\b/i.test(low);
  const sendCv = /\b(?:send|share|mail|email|forward)\b[^.\n]{0,40}\b(?:cv|resume|résumé|profile)\b/i.test(text);
  const apply_route: PostingFacts["apply_route"] = raw.apply_url ? "system" : form ? "external_form" : dm ? "dm" : email && sendCv ? "email" : /\bapply\b/i.test(text) ? "system" : "unknown";
  const apply_domain = raw.apply_url ? safeHost(raw.apply_url) : form ? safeHost(form[0]) : email ? email[0].split("@")[1].toLowerCase() : null;
  const agency = /\b(?:our client|leading client|a leading (?:mnc|company|organisation|organization)|client of ours|hiring for (?:a|an|our) (?:client|reputed)|staffing|consultancy|recruitment (?:firm|agency))\b/i.test(low);
  const scam_tells: string[] = [];
  if (/\b(?:registration|processing|security|training|joining|document(?:ation)?)\s+(?:fee|charge|deposit|amount)\b|\bpay(?:ment)? (?:to|before) (?:apply|join)|\brefundable (?:deposit|amount)\b/i.test(low)) scam_tells.push("a fee or deposit is asked for");
  if (/\bguaranteed (?:job|placement|selection)\b|\bno interview\b|\bdirect joining\b/i.test(low)) scam_tells.push("guaranteed job / no interview");
  if (/\b(?:earn|income) (?:from|at) home\b|\bwork from home\b[^.\n]{0,60}\b(?:daily|weekly) (?:payout|payment)\b|\bpart[- ]time\b[^.\n]{0,40}\b(?:earn|per day)\b/i.test(low) && !company) scam_tells.push("earn-from-home pitch with no employer");
  if (/\b(?:bank|account) details\b|\botp\b|\baadhaar\b[^.\n]{0,30}\bupload\b|\bpan card\b[^.\n]{0,30}\bupload\b/i.test(low)) scam_tells.push("asks for bank/OTP/ID details");
  if (dm && !raw.apply_url) scam_tells.push("WhatsApp/Telegram-only contact");
  const poster = raw.poster ? { name: raw.poster.name, is_recruiter_account: /\b(talent acquisition|recruit|staffing|hiring)\b/i.test(raw.poster.name ?? "") ? true : null, account_age_months: null } : null;
  void url;
  return { title, company, location, locations_count, posted_text, posted_days, applicants, pay_stated, templated, evergreen, kitchen_sink, apply_route, apply_domain, contact_present: !!(email || dm), agency, scam_tells, poster };
}

export async function extractFacts(raw: RawRead, url: string): Promise<Extracted> {
  const r = await json<any>(
    `You read a job posting (text extracted from a page; may contain navigation noise) and report only what is literally present. Never guess. Answer every field.
- posted_days: convert "1 month ago"→30, "3 weeks ago"→21, "Reposted 2 days ago"→2, a date→days since; null if not stated.
- applicants: number if shown ("Over 100 applicants"→100), else null.
- locations_count: distinct cities/"Remote" this ONE posting is open in (e.g. "Bengaluru / Hyderabad / Chennai / Remote" → 4).
- pay_stated: true only if a salary/CTC figure or range appears.
- templated: true only if the description could be any company (no product, team, manager, or specific work named).
- evergreen: true if "talent community/pool", "future opportunities", "always looking", "multiple openings across levels".
- kitchen_sink: true if unrelated technologies lumped together, or 15+ must-haves, or senior title with ≤2 years asked.
- apply_route: "system" (apply button on the board/company site), "email" (send CV to an email), "dm" (DM/WhatsApp/Telegram), "external_form" (Google Form/Typeform etc.), "unknown".
- apply_domain: domain of any email or external form mentioned, else null.
- agency: true if posted by a consultancy/staffing firm for "a leading client" or the employer is not named.
- scam_tells: list any of: fee/deposit/registration charge asked, pay-to-apply, WhatsApp/Telegram-only contact, "earn from home" with no employer, guaranteed job, request for bank/OTP details. Empty list if none.
- poster: {name, is_recruiter_account (true if a staffing/recruiting firm or "Talent Acquisition at X"), account_age_months (null unless stated)} or null.
Keep strings short.`,
    `URL: ${url}\n\nKNOWN FIELDS: ${JSON.stringify({ title: raw.title, company: raw.company, location: raw.location, posted_text: raw.posted_text, applicants: raw.applicants, apply_url: raw.apply_url })}\n\nPAGE TEXT:\n${raw.text.slice(0, 14000)}\n\nReturn: {title, company, location, locations_count, posted_text, posted_days, applicants, pay_stated, templated, evergreen, kitchen_sink, apply_route, apply_domain, contact_present, agency, scam_tells[], poster}`,
    1400, FAST
  );
  // source-structured fields win over the model's reading
  return {
    title: raw.title ?? r.title ?? "", company: raw.company ?? r.company ?? "", location: raw.location ?? r.location ?? "",
    locations_count: Math.max(1, Number(r.locations_count) || 1),
    posted_text: raw.posted_text ?? r.posted_text ?? null,
    posted_days: raw.posted_days ?? (r.posted_days == null ? null : Number(r.posted_days)),
    applicants: raw.applicants ?? (r.applicants == null ? null : Number(r.applicants)),
    pay_stated: !!r.pay_stated, templated: !!r.templated, evergreen: !!r.evergreen, kitchen_sink: !!r.kitchen_sink,
    apply_route: r.apply_route ?? "unknown", apply_domain: r.apply_domain ?? (raw.apply_url ? safeHost(raw.apply_url) : null),
    contact_present: !!r.contact_present, agency: !!r.agency, scam_tells: Array.isArray(r.scam_tells) ? r.scam_tells : [],
    poster: r.poster ?? (raw.poster ? { name: raw.poster.name, is_recruiter_account: null, account_age_months: null } : null),
  };
}

// ---------- helpers ----------
let browserP: Promise<import("playwright-core").Browser> | null = null;
async function renderWithBrowser(url: string) {
  const { chromium } = await import("playwright-core");
  if (!browserP) browserP = chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const b = await browserP; const ctx = await b.newContext({ userAgent: UA, locale: "en-IN" }); const page = await ctx.newPage();
  try { await page.goto(url, { waitUntil: "networkidle", timeout: 25000 }); await page.waitForTimeout(800); return await page.content(); }
  finally { await ctx.close(); }
}
function blocked(site: string) { return Object.assign(new Error(`${site} blocked automated reading. Paste the posting text instead.`), { status: 422 }); }
function pick(html: string, re: RegExp) { const m = html.match(re); return m ? htmlToText(m[1]).trim() || null : null; }
function num(s: string | null) { if (!s) return null; const m = s.replace(/,/g, "").match(/\d+/); return m ? Number(m[0]) : null; }
function safeHost(u: string) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; } }
export function daysFromText(t: string | null | undefined): number | null {
  if (!t) return null; const s = t.toLowerCase();
  if (/just now|today|few hours|hours? ago|minutes? ago/.test(s)) return 0;
  const m = s.match(/(\d+)\s*(day|week|month|year)/); if (m) return Number(m[1]) * ({ day: 1, week: 7, month: 30, year: 365 } as any)[m[2]];
  const d = Date.parse(t); return isNaN(d) ? null : Math.floor((Date.now() - d) / 86400e3);
}
function jsonLd(html: string): any {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const j = JSON.parse(m[1]); const jp = [j].flat(3).find((x: any) => x?.["@type"] === "JobPosting" || (Array.isArray(x?.["@graph"]) && x["@graph"].find((g: any) => g["@type"] === "JobPosting"))); if (jp) return jp["@graph"] ? jp["@graph"].find((g: any) => g["@type"] === "JobPosting") : jp; } catch { /* next */ }
  }
  return null;
}
