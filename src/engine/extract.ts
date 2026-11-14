import { QA } from "../qa/guard.js";
import { takeFault } from "../qa/state.js";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { db } from "../lib/db.js";
import { readingOrder, linkAnnotations, clean } from "./pdftext.js";
export { readingOrder, linkAnnotations };
import { jobKey, stripFurniture, CLEAN_SINCE, canonicalPostingUrl } from "./ghost/canon.js";

/** Plain text out of a PDF or DOCX résumé. No AI here. */
export async function extractText(buf: Buffer, filename: string): Promise<{ text: string; pages: number; ours?: boolean; links?: string[] }> {
  if (QA && takeFault("parse_fail")) throw Object.assign(new Error("We couldn’t read that file. Try a PDF exported from Word or Google Docs."), { status: 422, simulated: true });
  const lower = filename.toLowerCase();
  if (lower.endsWith(".doc")) {
    // Word 97–2003: still common on Indian campuses. word-extractor reads the binary format without Office installed.
    const { default: WordExtractor } = await import("word-extractor");
    const doc = await new WordExtractor().extract(buf);
    const text = clean(doc.getBody());
    if (text.length < 80) throw Object.assign(new Error("We couldn’t read text from that .doc file. Save it as PDF or .docx and upload again."), { status: 400 });
    return { text, pages: Math.max(1, Math.round(text.length / 3000)) };
  }
  if (!lower.endsWith(".pdf") && !lower.endsWith(".docx")) throw Object.assign(new Error("Upload a PDF, .docx or .doc résumé."), { status: 400 });
  if (lower.endsWith(".docx")) {
    const r = await mammoth.extractRawText({ buffer: buf });
    const text = clean(r.value);
    return { text, pages: Math.max(1, Math.round(text.length / 3000)) };
  }
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const r = await parser.getText();
    let ours = false;
    try { const info: any = await parser.getInfo(); const meta = JSON.stringify(info?.info ?? info ?? {}).toLowerCase(); ours = /ghosted|notaghost/.test(meta); } catch {}
    // the stream order of a PDF is not always the reading order (a Chromium-printed résumé put all five role headers first,
    // then all their bullets, 13 Nov): the page is re-read top to bottom, and that order is used when the page is one column
    let text = clean(r.text);
    try { const o = await readingOrder(buf); if (o) text = o; } catch { /* stream order it is */ }
    // the links behind the words ("LinkedIn Profile" is a link to a profile): the URLs ride along for the contact line
    let links: string[] = [];
    try { links = await linkAnnotations(buf); } catch { /* none */ }
    if (links.length) text += "\n\nLINKS (behind the text): " + links.join(" ");
    return { text, pages: r.total, ours, links };
  } finally { await parser.destroy(); }
}


/** Fetch a posting URL and reduce it to readable text. Pasted text goes straight through. */
export async function fetchPosting(url0: string, opts: { bypassCache?: boolean } = {}): Promise<string> {
  if (QA && takeFault("page_unavailable")) throw Object.assign(new Error("Couldn’t open that link right now. Paste the posting text instead."), { status: 502, simulated: true });
  const url = canonicalPostingUrl(url0);   // a LinkedIn search link with currentJobId is the job's own page
  // the user's own browser usually read this posting seconds ago (the card) and sent it to us; that copy beats any
  // server fetch — and job boards like Naukri refuse the server outright
  if (!opts.bypassCache) try {
    const { key } = jobKey(url);
    const { data: seen } = await db.from("postings").select("raw_text, source, scored_at").eq("job_key", key).not("raw_text", "is", null).order("last_seen_at", { ascending: false }).limit(1).maybeSingle();
    const trusted = !!seen?.raw_text && seen.raw_text.length >= 200 && !(seen.source === "linkedin" && (!seen.scored_at || seen.scored_at < CLEAN_SINCE)) && !authwall(seen.raw_text);
    if (trusted) return stripFurniture(seen!.raw_text);
  } catch { /* fall through to a fetch */ }
  // LinkedIn: the guest endpoint returns the posting without a login wall and rarely rate-limits
  const li = url.match(/linkedin\.com\/jobs\/view\/(?:[^/?]*-)?(\d{6,})/i);
  if (li) {
    const why: string[] = [];
    // guest endpoint, three tries with a pause: it answers 429 in bursts and recovers within a second or two
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const g = await fetch(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${li[1]}`, {
          headers: { "user-agent": "GhostedReader/1.0 (+https://notaghost.jobs/reader/; hello@notaghost.jobs)", "accept-language": "en-IN,en;q=0.9" },
          signal: AbortSignal.timeout(15000),
        });
        if (g.ok) { const t = htmlToText(await g.text()); if (t.length > 200 && !authwall(t)) return t; why.push(`guest ok but ${t.length} chars${authwall(t) ? " (authwall)" : ""}`); break; }
        why.push(`guest ${g.status}`);
        if (g.status !== 429 && g.status < 500) break;
      } catch (e) { why.push(`guest ${(e as Error).name}`); }
      await new Promise((r) => setTimeout(r, 1200 + attempt * 1300));
    }
    // the free check's reader has more ways in (the public page, cached sightings): use it before giving up
    try { const { readPosting } = await import("./ghost/read.js"); const r = await readPosting(url); const t = stripFurniture(r.text); if (t.length > 200 && !authwall(t)) return t; why.push(`reader ${t.length} chars`); } catch (e) { why.push(`reader: ${(e as Error).message.slice(0, 80)}`); }
    try { await db.from("reader_control").upsert({ key: `sharpen_fail:linkedin:${li[1]}`, value: { at: new Date().toISOString(), url, why }, updated_at: new Date().toISOString() }); } catch { /* fine */ }
    throw Object.assign(new Error("LinkedIn didn’t let us read that posting just now. Open the job in Chrome with the Ghosted extension, or paste the posting text."), { status: 400, why });
  }
  const r = await fetch(url, {
    headers: { "user-agent": "GhostedReader/1.0 (+https://notaghost.jobs/reader/; hello@notaghost.jobs)", "accept-language": "en-IN,en;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Object.assign(new Error(`Couldn't open that link (${r.status}). Paste the posting text instead.`), { status: 400 });
  const html = await r.text();
  const text = htmlToText(html);
  if (authwall(text)) throw Object.assign(new Error("That page asks for a login before it shows the job. Paste the posting text instead."), { status: 400 });
  return text;
}
/** A login wall or a search page came back instead of a job. */
function authwall(t: string): boolean {
  const head = t.slice(0, 1500).toLowerCase();
  return /sign in to (view|see)|join linkedin|authwall|sign in\s+to continue|jobs in (bengaluru|bangalore|india)\s*[-|·]/.test(head) && !/responsibilit|requirements|qualifications|about the (job|role)/i.test(t);
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
   .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))   // "15&#43; years" is "15+ years"
   .replace(/[ \t]{2,}/g, " ");
