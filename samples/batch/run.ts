import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { extractText } from "../../src/engine/extract.js";
import { parseResume, runSharpen, type ResumeProfile } from "../../src/engine/sharpen.js";
import { resumePdf } from "../../src/engine/pdf.js";
import { scores } from "../../src/routes/preview.js";
const pairs: [string, string][] = JSON.parse(readFileSync("samples/batch/pairs.json", "utf8"));
mkdirSync("samples/batch/out", { recursive: true });
const rows: any[] = existsSync("samples/batch/results.json") ? JSON.parse(readFileSync("samples/batch/results.json", "utf8")) : [];
const done = new Set(rows.map((r) => r.id));
const profiles: Record<string, ResumeProfile> = {};
for (const [file, jd] of pairs) {
  const id = `${file.replace(/\.pdf$/, "")}__${jd}`;
  if (done.has(id)) continue;
  const t0 = Date.now();
  try {
    if (!profiles[file]) {
      const { text, pages } = await extractText(readFileSync(`samples/batch/${file}`), file);
      profiles[file] = await parseResume(text, pages);
    }
    const p = profiles[file];
    const out = await runSharpen(p, readFileSync(`samples/batch/jd/${jd}.txt`, "utf8"));
    const b = scores(out.matches), a = scores(out.after_matches);
    const musts = out.matches.filter((m) => m.kind === "must"); const mustMissing = musts.filter((m) => m.bucket === "missing").length;
    const mismatch = out.matches.length >= 4 && ((musts.length && mustMissing / musts.length > 0.5) || out.matches.filter((m) => m.bucket === "missing").length / out.matches.length > 0.5);
    const pdf = await resumePdf(out.rewrite, p);
    writeFileSync(`samples/batch/out/${id}.pdf`, pdf);
    writeFileSync(`samples/batch/out/${id}.json`, JSON.stringify({ profile: p, ...out }, null, 1));
    rows.push({ id, name: p.name, jd, pages_in: p.pages, reqs: out.matches.length, said: out.matches.filter((m) => m.bucket === "said").length, hidden: out.matches.filter((m) => m.bucket === "have_not_said").length, missing: out.matches.filter((m) => m.bucket === "missing").length,
      before: b.before, promised: b.after, after: a.before, mismatch, verified: out.verification.ok, broken: out.broken.length, repair: !!out.timing.repair, regen: !!out.timing.regen, secs: Math.round((Date.now() - t0) / 1000), fit: out.rewrite.fit_line, headline: out.rewrite.headline });
    console.log(`${rows.length}. ${p.name} × ${jd}: ${b.before}→${b.after} promised, ${a.before} after ${mismatch ? "[MISMATCH]" : ""} ${out.verification.ok ? "✓" : "✗"} ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (e) { console.log(`FAIL ${id}: ${(e as Error).message}`); rows.push({ id, error: (e as Error).message }); }
  writeFileSync("samples/batch/results.json", JSON.stringify(rows, null, 1));
}
process.exit(0);
