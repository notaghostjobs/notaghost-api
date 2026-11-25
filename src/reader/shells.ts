// Pages that load and carry text but hold no job: the page around the posting, not the posting. Seen in the 24 Nov 2026
// snapshot and confirmed in the live table on 25 Nov:
//   1. careers.ibm.com/careers/JobDetail — every live IBM row with text (865) is the page's metadata block (Job ID,
//      City / Township / Village, Work arrangement, Shift …), 739–936 characters, with no duties. The posting body is
//      drawn by script. Being over 200 characters, it passed the "no readable text" gate, so the render fallback that
//      exists for this host was never tried and the shell was stored as the description.
//   2. job-boards.greenhouse.io/hackerrank — 16 rows store the application form ("Apply for this job * indicates a
//      required field", name, phone, résumé, screening questions) and no job text.
// A shell is never stored as a description. Where the system offers the posting another way, that way is used.

const IBM_META = /\b(job id|city \/ township \/ village|state \/ province|work arrangement|area of work|employment type|position type|travel required|shift|back to search results|recruitment scams|privacy statement|apply now|is this role a commissionable)\b/gi;
const DUTIES = /\b(responsibilit|your role|what you('|’)ll do|required (technical|skills|qualifications)|preferred (technical|qualifications)|qualifications|requirements|you will|about the (role|job))\w*/i;

export type Shell = "metadata only" | "application form only";

/** "metadata only" / "application form only" when the text is a page shell, else null. Looks only at what the text is. */
export function shellKind(text: string): Shell | null {
  const t = text.replace(/\s+/g, " ").trim();
  // Greenhouse's hosted form: the page title, then the form. A real posting there carries its text before the form.
  const form = t.match(/^(job application for [^]{0,200}?)?apply for this job \* indicates a required field/i);
  if (form && !DUTIES.test(t.slice(0, 4000).replace(/how many years[^?]*\?/gi, ""))) return "application form only";
  const meta = new Set((t.match(IBM_META) ?? []).map((m) => m.toLowerCase())).size;   // distinct fields: a page repeating "Apply now" is not a metadata block
  const words = t.replace(IBM_META, " ").split(/\s+/).filter((w) => /[a-z]{3,}/i.test(w)).length;
  if (meta >= 6 && words < 150 && !DUTIES.test(t)) return "metadata only";
  return null;
}

/** IBM's careers search already returns a `description` for each job (the adapter asks for it and, until now, dropped
 *  it). Kept only when it is real posting text: long enough, not itself a shell. Otherwise undefined, and enrichment
 *  runs as before. */
export function ibmDescription(raw: unknown, toText: (html: string) => string): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const t = toText(raw).trim();
  if (t.length < 400 || shellKind(t)) return undefined;
  return t.slice(0, 20000);
}

/** Board and job id from a Greenhouse hosted-job URL, for the public Job Board API (one job, with its content). */
export function greenhouseJob(url: string): { board: string; id: string } | null {
  const m = url.match(/^https?:\/\/(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/([a-z0-9_-]+)\/jobs\/(\d+)/i);
  return m ? { board: m[1].toLowerCase(), id: m[2] } : null;
}

/** The Job Board API returns `content` HTML-escaped (&lt;p&gt;…). Undo the escaping so htmlToText can read it. */
export function unescapeHtml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
