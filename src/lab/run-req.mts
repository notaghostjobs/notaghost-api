// Arms with requirement-level ranking on top of the unchanged hybrid retrieval. Writes arms in the same shape as
// arms-full.json plus per-candidate stage tracking and explanations.
//   npx tsx src/lab/run-req.mts <retrieval.json> <cand dir> <jobs: "det"|"ai"> <out.json> [prefix]
process.env.SUPABASE_URL ??= "https://offline.invalid"; process.env.SUPABASE_SERVICE_ROLE_KEY ??= "offline";
import { readFileSync, writeFileSync } from "node:fs";
const { evidence, reqsFromDet, reqsFromAI, evaluate, explain, W } = await import("./req.js");
const S = "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad";
const [retF, candDir, kind, out, prefix = ""] = process.argv.slice(2);
const ret = JSON.parse(readFileSync(retF, "utf8"));
const det = new Map(readFileSync(`${S}/arch/jir-det.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => { const j = JSON.parse(l); return [j.posting.id, j]; }));
const ai = kind === "ai" ? new Map(readFileSync(`${S}/pilot/ai-claude-haiku-5-5-9275f7c166a5.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.ok).map((x) => [String(x.id), x.rec])) : null;
const views = new Map(readFileSync(`${S}/arch/views-det.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => { const v = JSON.parse(l); return [v.id, v]; }));
const profiles = new Map(JSON.parse(readFileSync(`${S}/bench/profiles-19-local.json`, "utf8")).map((p: any) => [p.id, p]));
const zero = (k: string[]) => ({ ...W, ...Object.fromEntries(k.map((x) => [x, 0])) });
const VARIANTS: Record<string, any> = { req: W, req_no_skills: zero(["ess", "pref"]), req_no_seniority: zero(["sen"]), req_no_scope: zero(["scope"]), req_no_intent: zero(["intent"]), req_no_domain: zero(["domain"]), req_no_retrieval: zero(["rel"]) };
const arms: any = {}; const track: any = {}; const notes: any = {};
const t0 = performance.now(); let evals = 0;
for (const r of ret.runs) {
  const c = JSON.parse(readFileSync(`${candDir}/${r.p}.json`, "utf8")); const resume = readFileSync((profiles.get(r.p) as any).resume, "utf8");
  const ev = evidence(c.cir.views.experience, c.cir.views.skills, resume);
  const intent = { want: c.belief.want, level: c.belief.level, years: c.belief.years, domain: c.belief.field, stretch: c.belief.stretch };
  // broad candidate generation: the fused pool, plus the two fallback channels' first 50 (title and full text)
  const pool: string[] = [...r.pool]; for (const ch of ["fallback_fulltext", "fallback_title"]) for (const id of (r.channels[ch] ?? []).slice(0, 50)) if (!pool.includes(id)) pool.push(id);
  const n = r.pool.length; const rel = (id: string) => { const i = r.pool.indexOf(id); return i >= 0 ? 1 - i / n : 0.2; };
  const scored: Record<string, { id: string; s: number; band: string; why: string; e: any }[]> = {};
  for (const id of pool) { const j: any = det.get(id); if (!j) continue; const rq = ai && ai.has(id) ? reqsFromAI(ai.get(id), j) : reqsFromDet(j);
    for (const [name, w] of Object.entries(VARIANTS)) { const e = evaluate(ev, rq, intent as any, rel(id), w); (scored[name] ??= []).push({ id, s: e.score, band: e.band, why: explain(e), e }); evals++; } }
  for (const [name, list] of Object.entries(scored)) {
    list.sort((a, b) => b.s - a.s);
    const per = new Map<string, number>(), seen = new Set<string>(), keep: typeof list = [];
    for (const x of list) { const v: any = views.get(x.id); const emp = (v?.employer ?? "").toLowerCase(), k = emp + "|" + (v?.title ?? "").toLowerCase(); if (seen.has(k)) continue; seen.add(k); if (keep.length < 5 && (per.get(emp) ?? 0) >= 1) continue; per.set(emp, (per.get(emp) ?? 0) + 1); keep.push(x); if (keep.length >= 40) break; }
    (arms[prefix + name] ??= {})[r.p] = { top: keep.slice(0, 5).map((x) => x.id), next: keep.slice(5, 40).map((x) => x.id) };
    if (name === "req") notes[r.p] = keep.slice(0, 5).map((x) => ({ id: x.id, title: (views.get(x.id) as any)?.title, band: x.band, score: x.s, why: x.why, checks: x.e.checks }));
  }
  track[r.p] = { channels: Object.fromEntries(Object.entries(r.channels).map(([k, v]: any) => [k, v])), fused_pool: r.pool, evaluated: pool };
}
const ms = performance.now() - t0;
writeFileSync(out, JSON.stringify({ arms, track, notes, weights: W, evals, ms_total: Math.round(ms), ms_per_eval: +(ms / evals).toFixed(3) }));
console.log(`${Object.keys(arms).length} arms; ${evals} evaluations in ${Math.round(ms)} ms (${(ms / evals).toFixed(3)} ms each, all variants)`);
