// The posting text V3 reads: the employer's full description, HTML to text, nothing cut. V2's retrieval views stop at
// 3,000 characters, and 95% of postings in the frozen snapshot are longer (median 4,917), so V2's extractor and judge
// often never saw the requirements section. Extraction keeps a hard ceiling only to bound cost (16,000 characters,
// the V2 extractor's own limit); anything longer is recorded as truncated, never silently cut.
import { createHash } from "node:crypto";
export const EXTRACT_CHAR_LIMIT = 16000, JUDGE_CHAR_LIMIT = 6000;   // the judge also receives the extracted requirements; 6,000 is the frozen j3 judgeUser limit
export function htmlToText(h: string): string {
  return (h || "").replace(/<(br|\/p|\/li|\/h\d|\/div|\/tr)[^>]*>/gi, "\n").replace(/<li[^>]*>/gi, "\n• ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16)))
    .replace(/&(rsquo|lsquo);/g, "'").replace(/&(rdquo|ldquo);/g, '"').replace(/&(ndash|mdash);/g, "–").replace(/&hellip;/g, "…").replace(/&times;/g, "×").replace(/ /g, " ")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
}
export const descSha = (text: string) => createHash("sha256").update(text).digest("hex");
export function forModel(text: string, limit: number): { text: string; truncated: boolean; chars: number } { return { text: text.slice(0, limit), truncated: text.length > limit, chars: text.length }; }
