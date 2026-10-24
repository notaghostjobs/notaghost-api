import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { extractText } from "../../src/engine/extract.js";
import { parseResume, runSharpen, type ResumeProfile } from "../../src/engine/sharpen.js";
import { resumePdf } from "../../src/engine/pdf.js";
import { scores } from "../../src/routes/preview.js";

// Batch runner v2: parses each résumé once (cached), then runs pairs WORKERS at a time.
const WORKERS = Number(process.env.WORKERS ?? 3);
const pairs: [string, string][] = JSON.parse(readFileSync("samples/batch/pairs.json", "utf8"));
mkdirSync("samples/batch/out", { recursive: true });
const rows: any[] = existsSync("samples/batch/results.json") ? JSON.parse(readFileSync("samples/batch/results.json", "utf8")) : [];
const done = new Set(rows.map((r) => r.id));
const PROF = "samples/batch/profiles.json";
const profiles: Record<string, ResumeProfile> = existsSync(PROF) ? JSON.parse(readFileSync(PROF, "utf8")) : {};

async function profile(file: string) {
  if (profiles[file]) return profiles[file];
  const { text, pages } = await extractText(readFileSync(`samples/batch/${file}`), file);
  profiles[file] = await parseResume(text, pages);
  writeFileSync(PROF, JSON.stringify(profiles, null, 1));
  return profiles[file];
}

// the app's gate: "This one isn't your profile"
const gated = (mustRate: number, before: number) => mustRate > 0.6 || (mustRate > 0.5 && before < 30);

const queue = pairs.filter(([f, jd]) => !done.has(`${f.replace(/\.pdf$/, "")}__${jd}`));
let n = rows.length;
async function worker() {
  for (;;) {
    const next = queue.shift(); if (!next) return;
    const [file, jd] = next; const id = `${file.replace(/\.pdf$/, "")}__${jd}`; const t0 = Date.now();
    try {
      const p = await profile(file);
      const out = await runSharpen(p, readFileSync(`samples/batch/jd/${jd}.txt`, "utf8"));
      const b = scores(out.matches), a = scores(out.after_matches);
      const musts = out.matches.filter((m) => m.kind === "must"); const mustMissing = musts.filter((m) => m.bucket === "missing").length;
      const mismatch = musts.length > 0 && gated(mustMissing / musts.length, b.before);
      const pdf = await resumePdf(out.rewrite, p);
      writeFileSync(`samples/batch/out/${id}.pdf`, pdf);
      writeFileSync(`samples/batch/out/${id}.json`, JSON.stringify({ profile: p, ...out }, null, 1));
      rows.push({ id, name: p.name, jd, pages_in: p.pages, reqs: out.matches.length, musts: musts.length, must_missing: mustMissing,
        said: out.matches.filter((m) => m.bucket === "said").length, hidden: out.matches.filter((m) => m.bucket === "have_not_said").length, missing: out.matches.filter((m) => m.bucket === "missing").length,
        before: b.before, promised: b.after, after: a.before, mismatch, verified: out.verification.ok, broken: out.broken.length, repair: !!out.timing.repair, regen: !!out.timing.regen, secs: Math.round((Date.now() - t0) / 1000), fit: out.rewrite.fit_line, headline: out.rewrite.headline });
      console.log(`${++n}. ${p.name} × ${jd}: ${b.before}→${b.after} promised, ${a.before} after ${mismatch ? "[MISMATCH]" : ""} ${out.verification.ok ? "✓" : "✗"} ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) { console.log(`FAIL ${id}: ${(e as Error).message}`); rows.push({ id, error: (e as Error).message }); }
    writeFileSync("samples/batch/results.json", JSON.stringify(rows, null, 1));
  }
}
await Promise.all(Array.from({ length: WORKERS }, worker));
console.log("BATCH DONE");
process.exit(0);
