// SmartRecruiters job pages answer the Reader with the posting's own JSON record (seen 25 Nov 2026: all 1,316 live
// SmartRecruiters rows store that record as their "description", and none has a posting date although every record
// carries "postedDate"). This reads the record: the posting's sections as clean text, the employer's own date, the
// title and location. Recruiter details ("postedBy") are never kept. Nothing here changes how pages are requested.
//
// It reads both what the page sends (valid JSON, HTML inside the section texts) and what the table already holds (the
// same record after htmlToText: tags gone, but real line breaks and, rarely, bare quotes inside strings), so stored
// rows can be repaired from their own text without fetching anything again.
import { htmlToText } from "../engine/extract.js";

export type SrRecord = { text: string; postedAt: string | null; title: string | null; location: string | null; how: "json" | "tolerant" | "fields" };
const ORDER = ["jobDescription", "qualifications", "additionalInformation", "companyDescription"] as const;   // the employer's blurb last
const iso = (v: unknown) => { if (typeof v !== "string") return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); };
const clean = (s: string) => htmlToText(/<[a-z][^>]*>/i.test(s) ? s : s.replace(/&/g, "&amp;").replace(/</g, "&lt;")).replace(/\n{3,}/g, "\n\n").trim();

/** Control characters inside JSON strings escaped, so a record that lost its escapes still parses. */
function escapeInStrings(t: string): string {
  let out = "", inStr = false, esc = false;
  for (const ch of t) {
    if (inStr) {
      if (esc) { esc = false; out += ch; continue; }
      if (ch === "\\") { esc = true; out += ch; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      const c = ch.charCodeAt(0); out += c < 0x20 ? (ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${c.toString(16).padStart(4, "0")}`) : ch; continue;
    }
    if (ch === '"') inStr = true; out += ch;
  }
  return out;
}

function fromObject(j: any, how: SrRecord["how"]): SrRecord | null {
  const sec = j?.content?.sections ?? j?.jobAd?.sections; if (!sec || typeof sec !== "object") return null;
  const parts: string[] = [];
  for (const k of ORDER) { const s = sec[k]; const body = typeof s?.text === "string" ? clean(s.text) : ""; if (body) parts.push(`${s.title ? String(s.title).trim() + "\n" : ""}${body}`); }
  const text = parts.join("\n\n").trim(); if (text.length < 200) return null;
  return { text: text.slice(0, 20000), postedAt: iso(j.postedDate ?? j.releasedDate), title: typeof j.jobTitle === "string" ? j.jobTitle : typeof j.name === "string" ? j.name : null, location: typeof j.jobAdLocation === "string" ? j.jobAdLocation.trim() : null, how };
}

/** Last resort for a record whose quotes were lost: each section's text between its own key and the next. */
function fromFields(t: string): SrRecord | null {
  const parts: string[] = [];
  for (const k of ORDER) {
    const m = t.match(new RegExp(`"${k}":\\{"title":"([^"]*)","text":"([\\s\\S]*?)"\\}(?=,"(?:${ORDER.join("|")})"|\\}\\})`));
    if (m && m[2].trim()) parts.push(`${m[1].trim()}\n${clean(m[2].replace(/\\n/g, "\n").replace(/\\"/g, '"'))}`);
  }
  const text = parts.join("\n\n").trim(); if (text.length < 200) return null;
  return { text: text.slice(0, 20000), postedAt: iso(t.match(/"postedDate":"([^"]+)"/)?.[1]), title: t.match(/"jobTitle":"([^"]+)"/)?.[1] ?? null, location: t.match(/"jobAdLocation":"([^"]+)"/)?.[1]?.trim() ?? null, how: "fields" };
}

/** The record read from a page answer or a stored description; null when the text is not a SmartRecruiters record. */
export function srRecord(raw: string): SrRecord | null {
  const t = raw.trim(); if (!t.startsWith("{") || !/"(content|jobAd)"\s*:\s*\{\s*"sections"/.test(t)) return null;
  try { return fromObject(JSON.parse(t), "json"); } catch { /* next */ }
  try { return fromObject(JSON.parse(escapeInStrings(t)), "tolerant"); } catch { /* next */ }
  return fromFields(t);
}
