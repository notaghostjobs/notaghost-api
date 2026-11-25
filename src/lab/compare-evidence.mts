// Old evidence (column-blind text) versus provenance evidence (layout-aware), per benchmark profile.
process.env.SUPABASE_URL ??= "https://offline.invalid"; process.env.SUPABASE_SERVICE_ROLE_KEY ??= "offline";
import { readFileSync, writeFileSync } from "node:fs";
const { evidence } = await import("./req.js"); const { provenance } = await import("./provenance.js");
const S = "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad";
const profiles = JSON.parse(readFileSync(`${S}/bench/profiles-19-local.json`, "utf8")); const out: any = {}; let demoted = 0, promoted = 0;
for (const p of profiles) {
  const c = JSON.parse(readFileSync(`${S}/arch/cand/${p.id}.json`, "utf8")); const resume = readFileSync(p.resume, "utf8");
  const old = evidence(c.cir.views.experience, c.cir.views.skills, resume); const pv = provenance(JSON.parse(readFileSync(`${S}/req2/layout/${p.id}.json`, "utf8")));
  const newDemo = new Set([...pv.strength].filter(([, v]) => v >= 0.9).map(([k]) => k));
  const dem = [...old.demonstrated].filter((s) => !newDemo.has(s)), pro = [...newDemo].filter((s) => !old.demonstrated.has(s));
  demoted += dem.length; promoted += pro.length;
  out[p.id] = { two_column: pv.twoColumn, unheaded_lines_read_as_work: pv.unheadedAsWork, old_demonstrated: old.demonstrated.size, new_demonstrated: newDemo.size, demoted: dem.map((s) => ({ s, now: pv.best.get(s) ? `${pv.best.get(s)!.basis}/${pv.best.get(s)!.ownership}: "${pv.best.get(s)!.text.slice(0, 70)}"` : "not found" })), promoted: pro.map((s) => ({ s, from: `${pv.best.get(s)!.section}: "${pv.best.get(s)!.text.slice(0, 70)}"` })) };
  console.log(p.id, `2col ${pv.twoColumn ? "Y" : "n"} | demonstrated old ${old.demonstrated.size} → new ${newDemo.size} | demoted: ${dem.join(",") || "-"} | promoted: ${pro.join(",") || "-"}`);
}
writeFileSync(`${S}/req2/evidence-compare.json`, JSON.stringify(out, null, 1)); console.log("demoted", demoted, "promoted", promoted);
