// Matching v3 end-to-end runner for one candidate set: shortlist s3.3 → requirement extraction → judge j3 → gate g3v3.
// Modes:
//   --dry    no network: builds every request V3 would send and prints counts and worst-case reservations;
//   --mock   no network: a stub provider returns unusable replies, exercising the guard, ledger and fail-closed paths;
//   --paid   refuses unless the stage is in AUTHORISED (empty until the founder approves a stage) and a frozen
//            manifest with matching hashes exists. Nothing in this commit can make a paid call.
//   SUPABASE_URL=https://offline.invalid SUPABASE_SERVICE_ROLE_KEY=offline npx tsx src/lab/v3/run-v3.mts --dry|--mock [profiles,comma,separated]
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs"; import { createHash } from "node:crypto";
const D = await import("./data.mjs"); const F = await import("./features.mjs"); const SL = await import("./shortlist.js"); const G = await import("./gate.js"); const A = await import("./api3.js");
const { EXTRACT_SYSTEM, extractUser, validateCJR } = await import("../v2/cjr.js"); const { JUDGE_SYSTEM, candidateBlock, judgeUser, validateVerdict } = await import("../v2/pipeline.js");
const { firstJson } = await import("../v2/api.js"); const { EXTRACT_CHAR_LIMIT, forModel } = await import("./jobtext.js");
const { skillsIn } = await import("../skills.js"); const { GENERIC } = await import("../v2/terms.js");
/** Stage ceilings in rupees. Empty: no stage is authorised. Filled only by an approved commit. */
export const AUTHORISED: Record<string, number> = {};
export const SIZE = 40, MAXTOK = { extract: 4000, judge: 10000 };
const mode = process.argv.find((a) => a.startsWith("--")) ?? "--dry"; const only = process.argv.slice(2).find((a) => !a.startsWith("--"));
const ps = only ? only.split(",") : [...D.split.development, ...D.split.heldout];
if (mode === "--paid") { const st = process.env.V3_STAGE ?? ""; if (!(st in AUTHORISED)) throw new A.BudgetError(`stage "${st}" is not authorised; no paid call made`);
  const fz = `${D.S}/v3/FROZEN-v3.json`; if (!existsSync(fz)) throw new A.BudgetError("no frozen manifest; no paid call made"); }
const OUT = `${D.S}/v3/run-${mode.slice(2)}`; mkdirSync(OUT, { recursive: true });
const ledger = new A.Ledger3(`${OUT}/ledger.jsonl`, mode.slice(2)); const guard = new A.Guard(ledger, mode === "--paid" ? AUTHORISED[process.env.V3_STAGE!] : 1e9);
const stub = (async () => new Response(JSON.stringify({ model: "claude-sonnet-5-5", stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 100 }, content: [{ type: "text", text: "not json" }] }), { status: 200 })) as any;
const plan: any = { mode, size: SIZE, candidates: 0, extract_requests: 0, judge_requests: 0, worst_case_inr: 0, per_candidate: {} };
const extracted = new Map<string, any>();
async function send(purpose: string, system: string, user: string, maxTokens: number, effort: "low" | "medium") {
  const w = A.worstCase3(system.length, user.length, maxTokens); plan.worst_case_inr += w;
  if (mode === "--dry") return null;
  const r = await A.call3(guard, { purpose, system, user, maxTokens, cacheSystem: true, effort, key: mode === "--mock" ? "mock" : (process.env.GHOSTED_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || ""), fetchImpl: mode === "--mock" ? stub : undefined });
  return r.ok ? r.text : null;
}
for (const p of ps) {
  const { c, cands } = D.candidates(p); const r = D.pools.get(p); const have = new Map(c.skills.map((s: any) => [s.id, s.basis]));
  const sc = cands.map((x: any) => { const f = F.features(p, x.id); const need = [...skillsIn(x.reqText)]; let num = 0, den = 0; for (const s of need) { const w = GENERIC.has(s) ? 0.25 : 1; den += w; const b = have.get(s); num += w * (b === "work" || b === "achievement" ? 1 : b === "project" ? 0.7 : b ? 0.3 : 0); }
    const sg = F.signature(x.id); return { id: x.id, title: x.title, employer: x.employer, channels: Object.fromEntries(Object.entries<any>(r.channels).map(([k, l]) => [k, l.indexOf(x.id) + 1 || null])), agree: x.agree, compat: f.compat, anchors: f.anchors, cover: den ? num / den : 0.5, sig: sg.sig, reqHash: sg.reqHash }; });
  const sl = SL.shortlist3(sc, { size: SIZE, ...SL.DEFAULT_SHORT }); const reps = sl.chosen.map((cl) => cl.rep.id);
  const job = (id: string) => { const j = F.jobInfo(id); return { id, title: j.title, company: j.employer, text: j.text }; };
  for (const id of reps) { if (extracted.has(id)) continue; const j = job(id); const t = forModel(j.text, EXTRACT_CHAR_LIMIT);
    plan.extract_requests++; const reply = await send(`extract x3 ${id}`, EXTRACT_SYSTEM, extractUser(j.title, j.company, t.text), MAXTOK.extract, "low");
    const v = reply ? validateCJR(firstJson(reply), j, A.MODEL) : null; extracted.set(id, v && v.ok ? v.cjr : null); }
  const block = candidateBlock(c); const usable = reps.filter((id) => extracted.get(id)?.usable || mode === "--dry"); const verdicts: any[] = [];
  for (const id of reps.filter((id) => !usable.includes(id))) verdicts.push({ job_id: id, fit: "cannot_judge", failed: "no extracted requirements", core: [] });
  for (let i = 0; i < usable.length; i += 5) { const b = usable.slice(i, i + 5).map((id) => ({ ...job(id), cjr: extracted.get(id) ?? {} }));
    plan.judge_requests++; const reply = await send(`judge j3 ${p}`, JUDGE_SYSTEM(block), judgeUser(b), MAXTOK.judge, "medium");
    const list: any[] = (firstJson(reply ?? "") as any)?.verdicts ?? []; for (const x of b) verdicts.push(mode === "--dry" ? { job_id: x.id, fit: "cannot_judge", failed: "dry run", core: [] } : validateVerdict(list.find((v) => String(v?.job_id) === x.id), x, block, block)); }
  const ctx = (id: string) => { const f = F.features(p, id); return { compat: f.compat, anchors: f.anchors, eligible: true, employer: f.job.employer, title: f.job.title }; };
  const shown = G.present(verdicts, ctx, 5);
  plan.per_candidate[p] = { reps: reps.length, cluster_members: sl.chosen.reduce((a, cl) => a + cl.members.length, 0), judged: usable.length, strong: shown.strong.length, none_reason: shown.none_reason };
  plan.candidates++;
  writeFileSync(`${OUT}/${p}.json`, JSON.stringify({ shortlist: sl.chosen.map((cl) => ({ rep: cl.rep.id, members: cl.members, reqHash: cl.rep.reqHash })), verdicts, shown: { strong: shown.strong, stretch: shown.stretch, none_reason: shown.none_reason } }));
}
plan.worst_case_inr = +plan.worst_case_inr.toFixed(2); plan.ledger_spent_inr = +ledger.spent().toFixed(2); plan.ledger_entries = ledger.entries().length;
writeFileSync(`${OUT}/plan.json`, JSON.stringify(plan, null, 1)); console.log(JSON.stringify({ ...plan, per_candidate: undefined, strong_shown: Object.values<any>(plan.per_candidate).reduce((a, x) => a + x.strong, 0) }));
