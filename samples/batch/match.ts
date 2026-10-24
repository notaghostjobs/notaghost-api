import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { parsePosting, matchAndGrade } from "../../src/engine/sharpen.js";
import { scores } from "../../src/routes/preview.js";
// usage: tsx match.ts <out-json-id> ...   (reuses parsed profile from a previous run's json)
for (const id of process.argv.slice(2)) {
  const dir = existsSync(`samples/batch/out/${id}.json`) ? "out" : "v1/out"; const prev = JSON.parse(readFileSync(`samples/batch/${dir}/${id}.json`, "utf8"));
  const jd = id.split("__")[1];
  const posting = prev.posting ?? await parsePosting(readFileSync(`samples/batch/jd/${jd}.txt`, "utf8"));
  const { matches } = await matchAndGrade(prev.profile, posting); writeFileSync(`samples/batch/out/${id}.match.json`, JSON.stringify(matches));
  const musts = matches.filter((m) => m.kind === "must"); const mm = musts.filter((m) => m.bucket === "missing").length;
  const s = scores(matches);
  console.log(`\n== ${prev.profile.name} × ${jd}: before ${s.before} → promised ${s.after}; musts missing ${mm}/${musts.length} (${Math.round(100*mm/musts.length)}%) ${mm/musts.length>0.6||(mm/musts.length>0.5&&s.before<30)?"[GATED]":""}`);
  for (const m of matches) console.log(`  ${m.bucket.padEnd(13)} ${(m.evidence_kind||"").padEnd(7)} ${m.kind.padEnd(4)} ${m.requirement.slice(0,60).padEnd(60)} | ${(m.evidence||"").slice(0,60)}`);
}
process.exit(0);
