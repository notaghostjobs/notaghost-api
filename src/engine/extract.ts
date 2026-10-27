import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { db } from "../lib/db.js";
import { jobKey, stripFurniture, CLEAN_SINCE } from "./ghost/canon.js";

/** Plain text out of a PDF or DOCX résumé. No AI here. */
export async function extractText(buf: Buffer, filename: string): Promise<{ text: string; pages: number }> {
  if (filename.toLowerCase().endsWith(".docx")) {
    const r = await mammoth.extractRawText({ buffer: buf });
    const text = clean(r.value);
    return { text, pages: Math.max(1, Math.round(text.length / 3000)) };
  }
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const r = await parser.getText();
    return { text: clean(r.text), pages: r.total };
  } finally { await parser.destroy(); }
}

function clean(s: string) {
  return s.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Fetch a posting URL and reduce it to readable text. Pasted text goes straight through. */
export async function fetchPosting(url: string): Promise<string> {
  // the user's own browser usually read this posting seconds ago (the card) and sent it to us; that copy beats any
  // server fetch — and job boards like Naukri refuse the server outright
  try {
    const { key } = jobKey(url);
    const { data: seen } = await db.from("postings").select("raw_text, source, scored_at").eq("job_key", key).not("raw_text", "is", null).order("last_seen_at", { ascending: false }).limit(1).maybeSingle();
    const trusted = !!seen?.raw_text && seen.raw_text.length >= 200 && !(seen.source === "linkedin" && (!seen.scored_at || seen.scored_at < CLEAN_SINCE));
    if (trusted) return stripFurniture(seen!.raw_text);
  } catch { /* fall through to a fetch */ }
  // LinkedIn: the guest endpoint returns the posting without a login wall and rarely rate-limits
  const li = url.match(/linkedin\.com\/jobs\/view\/(?:[^/?]*-)?(\d{6,})/i);
  if (li) {
    try {
      const g = await fetch(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${li[1]}`, {
        headers: { "user-agent": "GhostedReader/1.0 (+https://notaghost.jobs/reader/; hello@notaghost.jobs)", "accept-language": "en-IN,en;q=0.9" },
        signal: AbortSignal.timeout(15000),
      });
      if (g.ok) { const t = htmlToText(await g.text()); if (t.length > 200) return t; }
    } catch { /* fall through */ }
  }
  const r = await fetch(url, {
    headers: { "user-agent": "GhostedReader/1.0 (+https://notaghost.jobs/reader/; hello@notaghost.jobs)", "accept-language": "en-IN,en;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Object.assign(new Error(`Couldn't open that link (${r.status}). Paste the posting text instead.`), { status: 400 });
  const html = await r.text();
  return htmlToText(html);
}

export function htmlToText(html: string) {
  // prefer JSON-LD JobPosting when a site provides it
  const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of ld) {
    try {
      const j = JSON.parse(m[1]);
      const jp = [j].flat().find((x: any) => x?.["@type"] === "JobPosting");
      if (jp?.description) {
        return clean(
          `${jp.title ?? ""}\n${jp.hiringOrganization?.name ?? ""}\n${jp.jobLocation?.address?.addressLocality ?? ""}\n` +
          `Posted: ${jp.datePosted ?? ""}\n\n${strip(jp.description)}`
        );
      }
    } catch { /* ignore */ }
  }
  const body = html.replace(/<(script|style|nav|footer|header|svg)[\s\S]*?<\/\1>/gi, " ");
  return clean(strip(body)).slice(0, 20000);
}

const strip = (h: string) =>
  h.replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n")
   .replace(/<[^>]+>/g, " ")
   .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
   .replace(/[ \t]{2,}/g, " ");
