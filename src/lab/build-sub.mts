// The isolation experiment's sub-inventory: postings that have an AI job record. Two versions of the same postings,
// identical except for the job intelligence: deterministic (det-v2) and AI (Haiku). Each gets its own retrieval views
// and per-candidate structured signals, so that retrieval can be run 2×2: {det, ai} × {without, with embeddings}.
//   npx tsx src/lab/build-sub.mts <ai.jsonl> <outdir>
process.env.SUPABASE_URL ??= "https://offline.invalid"; process.env.SUPABASE_SERVICE_ROLE_KEY ??= "offline";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const S = "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad";
const { SPEC } = await import("../lib/ontology.js"); const { agreement, levelFit } = await import("../lib/career.js");
const [aiF, out] = process.argv.slice(2); mkdirSync(out, { recursive: true });
const ai = new Map(readFileSync(aiF, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.ok && x.rec?.valid_posting !== false).map((x) => [String(x.id), x.rec]));
const views = new Map(readFileSync(`${S}/arch/views-det.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((v: any) => ai.has(v.id)).map((v: any) => [v.id, v]));
const jir = new Map(readFileSync(`${S}/arch/jir-det.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((j: any) => ai.has(j.posting.id)).map((j: any) => [j.posting.id, j]));
const ids = [...views.keys()];
const aiViews = ids.map((id) => { const r = ai.get(id), v: any = views.get(id);
  const resp = [r.archetype, ...(r.responsibilities ?? []).map((x: any) => `${x.text}${x.quote ? ` (${x.quote})` : ""}`)].filter(Boolean).join(". ");
  const skills = [...(r.essential ?? []).map((x: any) => x.skill), ...(r.preferred ?? []).map((x: any) => x.skill), ...(r.qualifications ?? []).map((x: any) => x.text)].join(". ");
  return { ...v, resp: resp || v.title, skills: skills || v.title, whole: `${v.title}. ${resp}. ${skills}` }; });
writeFileSync(`${out}/views-detsub.jsonl`, ids.map((id) => JSON.stringify(views.get(id))).join("\n") + "\n");
writeFileSync(`${out}/views-aisub.jsonl`, aiViews.map((v) => JSON.stringify(v)).join("\n") + "\n");
// per candidate: the same frozen belief, structured signals from each job intelligence (eligibility and text fit reused from the full run)
const fullIds = JSON.parse(readFileSync(`${S}/arch/cand/job-ids.json`, "utf8")); const pos = new Map(fullIds.map((id: string, i: number) => [id, i]));
for (const kind of ["detsub", "aisub"]) mkdirSync(`${out}/cand-${kind}`, { recursive: true });
for (const f of Array.from({ length: 19 }, (_, i) => `B${String(i + 1).padStart(2, "0")}`)) {
  const c = JSON.parse(readFileSync(`${S}/arch/cand/${f}.json`, "utf8")); const b = { want: new Map(c.belief.want), level: c.belief.level, years: c.belief.years, field: c.belief.field, stretch: c.belief.stretch };
  for (const kind of ["detsub", "aisub"]) {
    const sig = ids.map((id) => { const full = c.sig[pos.get(id) as number]; let spec: string | null, level: any, dom: string[];
      if (kind === "detsub") { const j: any = jir.get(id); spec = j.specialisation.value?.[0] ?? null; level = j.seniority.value; dom = j.domain.value ?? []; }
      else { const r = ai.get(id); spec = (r.specialisation ?? []).find((s: string) => SPEC.has(s)) ?? null; level = r.seniority?.value ?? "mid"; dom = r.domain?.value ?? []; }
      return [full[0], Math.round(agreement(b as any, spec) * 100) / 100, levelFit(b.level, level, b.stretch), full[3], dom.includes(b.field ?? "~") ? 1 : 0]; });
    writeFileSync(`${out}/cand-${kind}/${f}.json`, JSON.stringify({ cir: c.cir, belief: c.belief, sig_fields: c.sig_fields, sig })); }
}
console.log(ids.length, "postings in the sub-inventory");
