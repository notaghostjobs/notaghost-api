// Matching v2, stages that cost nothing, for one candidate set at a time (development during tuning; held-out only
// after the configuration is frozen). No model call. Private outputs go to the workspace, never the repository.
//   step "cer":   build candidate evidence records + corrected retrieval views     → <out>/cer/<id>.json, <arch>/<candDir>/<id>.json
//   step "stage": eligibility + shortlist on the v2 retrieval pools                 → <out>/stage-<set>.json
//   SUPABASE_URL=https://offline.invalid SUPABASE_SERVICE_ROLE_KEY=offline npx tsx src/lab/v2/run-free.mts <step> <dev|heldout> [pools.json]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
const { buildCER, verifyCER } = await import("./cer.js"); const { eligibility, shortlist } = await import("./pipeline.js");
const { validity2 } = await import("../validity.js"); const { SPEC, transfer } = await import("../../lib/ontology.js");
const S = "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad", OUT = `${S}/v2`;
const [step, set, poolsF] = process.argv.slice(2);
const split = JSON.parse(readFileSync(`${S}/diag/split.json`, "utf8")); const ids: string[] = set === "dev" ? split.development : set === "heldout" ? split.heldout : [];
if (!ids.length) throw new Error("set must be dev or heldout");
const frozen = JSON.parse(readFileSync(`${OUT}/frozen.json`, "utf8").toString() || "{}");
if (set === "heldout" && !frozen.config_sha) throw new Error("held-out is locked until the configuration is frozen (v2/frozen.json)");
const profiles = new Map(JSON.parse(readFileSync(`${S}/bench/profiles-19-local.json`, "utf8")).map((p: any) => [p.id, p]));
const answers = JSON.parse(readFileSync(`${S}/sim2/answers.json`, "utf8"));
mkdirSync(`${OUT}/cer`, { recursive: true });
const label = (k: string) => (SPEC.get(k) as any)?.label ?? k;

if (step === "cer") {
  const candDir = `${S}/arch/cand-v2-${set}`; mkdirSync(candDir, { recursive: true }); const report: any = {};
  for (const p of ids) {
    const resume = readFileSync((profiles.get(p) as any).resume, "utf8"); const old = JSON.parse(readFileSync(`${S}/arch/cand/${p}.json`, "utf8"));
    const lay = JSON.parse(readFileSync(`${S}/req2/layout/${p}.json`, "utf8"));
    const c = buildCER(p, createHash("sha256").update(resume).digest("hex"), lay, old.cir.done, answers[p], label);
    const bad = verifyCER(c, resume);
    writeFileSync(`${OUT}/cer/${p}.json`, JSON.stringify(c, null, 1));
    // corrected retrieval views: work/project/achievement lines are experience; listed lines are only skills
    const v = { ...old.cir.views, experience: [...c.work_lines, ...c.achievement_lines, ...c.project_lines].join(". ").slice(0, 4000), skills: c.listed_lines.join(", ").slice(0, 1200) };
    writeFileSync(`${candDir}/${p}.json`, JSON.stringify({ ...old, cir: { ...old.cir, views: v } }));
    report[p] = { work: c.work_lines.length, listed: c.listed_lines.length, roles: c.roles.length, dated: c.parser.dated_roles, primary_stack: c.primary_stack, credentials: c.credentials.map((x) => x.id), unverified_quotes: bad.length, warnings: c.parser.warnings };
  }
  writeFileSync(`${OUT}/cer-report-${set}.json`, JSON.stringify(report, null, 1)); console.log(JSON.stringify(report, null, 1));
}

if (step === "stage") {
  const jl = (f: string) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const det = new Map(jl(`${S}/arch/jir-det.jsonl`).map((j: any) => [j.posting.id, j])), views = new Map(jl(`${S}/arch/views-det.jsonl`).map((v: any) => [v.id, v]));
  const closed = new Set(JSON.parse(readFileSync(`${S}/v2/closed-since-snapshot.json`, "utf8")));
  const runs = new Map(JSON.parse(readFileSync(poolsF, "utf8")).runs.map((r: any) => [r.p, r]));
  const out: any = {};
  for (const p of ids) {
    const r: any = runs.get(p); const c = JSON.parse(readFileSync(`${OUT}/cer/${p}.json`, "utf8")); const resume = readFileSync((profiles.get(p) as any).resume, "utf8");
    const want: [string, number][] = JSON.parse(readFileSync(`${S}/arch/cand/${p}.json`, "utf8")).belief.want;
    const pool: { id: string; channel: string; rank: number | null }[] = r.pool.map((id: string, i: number) => ({ id, channel: "hybrid", rank: i + 1 }));
    for (const ch of ["fallback_fulltext", "fallback_title"]) for (const id of (r.channels[ch] ?? []).slice(0, 50)) if (!pool.some((x) => x.id === id)) pool.push({ id, channel: ch, rank: null });
    const excluded: any[] = [], cands: any[] = [];
    for (const x of pool) {
      const v: any = views.get(x.id), j: any = det.get(x.id); if (!v || !j) { excluded.push({ id: x.id, reasons: ["no job record"] }); continue; }
      const text = v.whole_raw.slice(v.title.length + 2); const invalid = !!validity2(v.title, text);
      const e = eligibility({ id: x.id, title: v.title, location: String(j.posting?.location ?? v.location ?? ""), text, invalid, closed: closed.has(x.id) }, c, resume);
      if (e.excluded) { excluded.push({ id: x.id, reasons: e.reasons }); continue; }
      const specs: string[] = (j.specialisation?.value ?? []).map(String);
      const agree = specs.length ? Math.max(...specs.map((s) => want.reduce((a, [k, w]) => a + w * transfer(k, s), 0))) : null;
      cands.push({ id: x.id, title: v.title, employer: v.employer ?? "", text, reqText: `${j.text?.requirements ?? ""}\n${(j.capabilities_essential?.value ?? []).join("\n")}`, poolRank: x.rank, channel: x.channel, agree });
    }
    const sl = shortlist(cands, c);
    out[p] = { pooled: pool.length, excluded, eligible: cands.length, shortlist: sl.map((x) => ({ id: x.j.id, score: +x.score.toFixed(3), poolRank: x.j.poolRank, channel: x.j.channel, why: x.why })) };
  }
  writeFileSync(`${OUT}/stage-${set}.json`, JSON.stringify(out)); console.log(Object.entries<any>(out).map(([p, o]) => `${p}: pooled ${o.pooled}, excluded ${o.excluded.length}, eligible ${o.eligible}, shortlist ${o.shortlist.length}`).join("\n"));
}
