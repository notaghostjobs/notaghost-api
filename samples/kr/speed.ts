import { readFileSync, writeFileSync } from "node:fs";
import { rewriteResume, verifyRewrite } from "../../src/engine/sharpen.js";
import * as C from "../../src/engine/claude.js";
const d = JSON.parse(readFileSync("samples/kr/out.json", "utf8"));
for (const model of ["claude-haiku-5-5", "claude-sonnet-5-5"]) {
  process.env.MODEL_OVERRIDE = model;
  const t0 = Date.now();
  const rw = await rewriteResume(d.profile, d.posting);
  const t1 = Date.now();
  const v = await verifyRewrite(d.profile, rw);
  console.log(model, "write", ((t1-t0)/1000).toFixed(0)+"s", "verify ok:", v.ok, v.problems.length, "bullets", rw.roles.map(r=>r.bullets.length).join(","), "relevant", rw.relevant?.length);
  writeFileSync(`samples/kr/rw-${model}.json`, JSON.stringify({rw, v}, null, 2));
}
process.exit(0);
