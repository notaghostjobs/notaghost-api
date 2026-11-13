// The private regression run: real résumés, kept OUTSIDE the repository, read by the same extraction the product uses.
//   npx tsx scripts/private-regress.ts <folder> [--update]
// <folder>/files holds the résumés (PDF); <folder>/golden holds, per file, the reading-order text a person has looked at
// and accepted. A run fails when a file's text changes from its golden, reads back shorter than the PDF's own stream text,
// carries a character no font can draw, or shows role headings back to back (the 13 Nov fault). --update accepts the
// current output as the new golden — only after reading the differences.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PDFParse } from "pdf-parse";
import { readingOrder } from "../src/engine/pdftext.js";

const dir = process.argv[2]; const update = process.argv.includes("--update");
if (!dir) { console.error("usage: private-regress.ts <folder> [--update]"); process.exit(2); }
const files = join(dir, "files"), golden = join(dir, "golden"); if (!existsSync(golden)) mkdirSync(golden, { recursive: true });
const dated = (l: string) => /(?:(?:19|20)\d\d|['’ʼ′`]\d\d)\s*(?:[–—-]|to)\s*(?:[A-Za-z]{3,9}\.?\s*)?['’ʼ′`]?(?:(?:19|20)\d\d|\d\d\b|present|now|current|till date)/i.test(l);
const vocab = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 3));
/** dated lines (role or education headings) that follow one another with almost nothing between them */
function backToBack(text: string): number {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const body = lines.slice(0, (() => { const i = lines.findIndex((l) => /^e\s*d\s*u\s*c\s*a\s*t\s*i\s*o\s*n\b|^academic|^-- sidebar --/i.test(l)); return i < 0 ? lines.length : i; })());
  // a company line and a title line, each with its dates, are one heading: only the last line of such a run counts
  const idx = body.map((l, i) => (dated(l) && !(i + 1 < body.length && dated(body[i + 1])) ? i : -1)).filter((i) => i >= 0);
  let n = 0; for (let k = 1; k < idx.length; k++) { const between = body.slice(idx[k - 1] + 1, idx[k]).filter((l) => !dated(l)).join(" ").split(/\s+/).filter(Boolean).length; if (between < 8) n++; }
  return n;
}

let failed = 0, changed = 0, fresh = 0; const rows: string[] = [];
for (const f of readdirSync(files).filter((f) => /\.pdf$/i.test(f)).sort()) {
  const buf = readFileSync(join(files, f)); const notes: string[] = [];
  const p = new PDFParse({ data: new Uint8Array(buf) }); const stream = (await p.getText().catch(() => ({ text: "" }))).text; await p.destroy().catch(() => {});
  let ordered = ""; try { ordered = (await readingOrder(buf)) ?? ""; } catch (e) { notes.push("FAIL reading order threw: " + (e instanceof Error ? e.message : e)); }
  if (stream.length < 300) { rows.push(`  –  ${f}: no text layer (read from the page in production)`); continue; }
  const sv = vocab(stream), ov = vocab(ordered); const kept = [...sv].filter((w) => ov.has(w)).length / Math.max(1, sv.size);
  if (kept < 0.97) notes.push(`FAIL words lost: ${(kept * 100).toFixed(1)}% of the PDF's words survive`);
  if (/[-�]/.test(ordered)) notes.push("FAIL a private-use character survived");
  const b2b = backToBack(ordered), was = backToBack(stream);
  if (b2b >= 2) notes.push(`FAIL ${b2b} headings back to back in reading order`);
  const g = join(golden, f + ".txt");
  if (!existsSync(g)) { writeFileSync(g, ordered); fresh++; notes.push("new golden written"); }
  else if (readFileSync(g, "utf8") !== ordered) { if (update) { writeFileSync(g, ordered); notes.push("golden updated"); } else { changed++; notes.push("FAIL text differs from its golden"); } }
  const bad = notes.some((n) => n.startsWith("FAIL")); if (bad) failed++;
  rows.push(`  ${bad ? "✗" : "✓"}  ${f}: ${ordered.includes("-- sidebar --") ? "two columns" : "one column"}${was >= 2 ? ` · stream order had ${was} headings back to back` : ""}${notes.length ? " · " + notes.join(" · ") : ""}`);
}
console.log(rows.join("\n"));
console.log(`\n${rows.length} résumés · ${failed} failed · ${changed} changed from golden · ${fresh} new`);
process.exit(failed ? 1 : 0);
