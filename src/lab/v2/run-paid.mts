// Matching v2, paid stages (Sonnet only), under a checkpoint ceiling enforced by api.ts before every request.
//   extract: cached job requirements for the shortlisted jobs of one set (each posting version paid for once)
//   judge:   the evidence judge on each candidate's shortlist (5 jobs a call; candidate evidence cached), then the 0–5 gate
//   SUPABASE_URL=https://offline.invalid SUPABASE_SERVICE_ROLE_KEY=offline npx tsx src/lab/v2/run-paid.mts <extract|judge> <dev|heldout> <checkpoint 1|2|3> [limit]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
const { callSonnet, Ledger, firstJson, CHECKPOINTS, MODEL, TruncatedError } = await import("./api.js");
const { CJRCache, validateCJR, EXTRACT_SYSTEM, extractUser, EXTRACTOR_VERSION } = await import("./cjr.js");
const { JUDGE_SYSTEM, JUDGE_VERSION, candidateBlock, judgeUser, validateVerdict, display, SHORTLIST_VERSION } = await import("./pipeline.js");
const S = process.env.V2_DATA ?? "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad", OUT = `${S}/v2`;
const [step, set, cp, limitArg] = process.argv.slice(2); const ceiling = (CHECKPOINTS as any)[cp]; if (!ceiling) throw new Error("checkpoint must be 1, 2 or 3");
if (set === "heldout") { const f = JSON.parse(readFileSync(`${OUT}/frozen.json`, "utf8")); if (!f.config_sha) throw new Error("held-out is locked until the configuration is frozen"); }
const ledger = new Ledger(`${OUT}/ledger.jsonl`); const cache = new CJRCache(`${OUT}/cjr`);
const stage = JSON.parse(readFileSync(`${OUT}/stage-${set}.json`, "utf8"));
const views = new Map(readFileSync(`${S}/arch/views-det.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => { const v = JSON.parse(l); return [v.id, v]; }));
const job = (id: string) => { const v: any = views.get(id); return { id, title: v.title, company: v.employer ?? "", text: v.whole_raw.slice(v.title.length + 2) }; };
const limit = limitArg ? Number(limitArg) : Infinity;
/** Run up to n tasks at once; the first error stops new tasks and is rethrown. */
async function pool<T>(items: T[], n: number, f: (x: T) => Promise<void>) { let i = 0, err: unknown = null; await Promise.all(Array.from({ length: n }, async () => { while (!err && i < items.length) { const x = items[i++]; try { await f(x); } catch (e) { err = e; } } })); if (err) throw err; } mkdirSync(`${OUT}/verdicts`, { recursive: true });

if (step === "extract") {
  const ids = [...new Set(Object.values<any>(stage).flatMap((o) => o.shortlist.map((x: any) => x.id)))].slice(0, limit);
  let done = 0, cached = 0, rejected = 0, dropped = 0;
  await pool(ids, 4, async (id) => {
    const j = job(id); if (cache.get(id, j.text)) { cached++; return; }
    let r: any;
    try { r = await callSonnet({ ledger, ceiling, purpose: `extract ${EXTRACTOR_VERSION} ${id}`, system: EXTRACT_SYSTEM, user: extractUser(j.title, j.company, j.text.slice(0, 16000)), maxTokens: 4000, cacheSystem: true, thinking: "between_tools", effort: "low" }); }
    catch (err) { if (err instanceof TruncatedError) { rejected++; writeFileSync(`${OUT}/cjr/${id}.rejected.json`, JSON.stringify({ errors: ["truncated"] })); return; } throw err; }
    const v = validateCJR(firstJson(r.text), j, MODEL);
    if (!v.ok) { rejected++; writeFileSync(`${OUT}/cjr/${id}.${EXTRACTOR_VERSION}.rejected.json`, JSON.stringify({ errors: v.errors, reply: r.text })); return; }
    cache.put(v.cjr, j.text); dropped += v.dropped; done++;
  });
  console.log(JSON.stringify({ jobs: ids.length, extracted: done, cached, rejected, unquoted_requirements_dropped: dropped, spent_inr: +ledger.spent().toFixed(2) }));
}

if (step === "judge") {
  const res: any = {};
  await pool(Object.keys(stage).slice(0, limit), 3, async (p) => {
    const c = JSON.parse(readFileSync(`${OUT}/cer/${p}.json`, "utf8")); const block = candidateBlock(c); const evidenceText = block;
    const items = stage[p].shortlist.map((x: any) => x.id).map((id: string) => ({ ...job(id), cjr: cache.get(id, job(id).text) }));
    const verdicts: any[] = []; const t0 = Date.now();
    for (const it of items.filter((x: any) => !x.cjr || !x.cjr.usable)) verdicts.push({ job_id: it.id, fit: "cannot_judge", failed: it.cjr ? `posting not usable: ${it.cjr.usable_reason}` : "no extracted requirements" });
    const ok = items.filter((x: any) => x.cjr && x.cjr.usable);
    for (let i = 0; i < ok.length; i += 5) {
      const batch = ok.slice(i, i + 5);
      let r: any = { text: "" };
      try { r = await callSonnet({ ledger, ceiling, purpose: `judge ${JUDGE_VERSION} ${p}`, system: JUDGE_SYSTEM(block), user: judgeUser(batch), maxTokens: 10000, cacheSystem: true, thinking: "between_tools", effort: "medium" }); }
      catch (err) { if (!(err instanceof TruncatedError)) throw err; }   // truncated: every job in the batch fails closed below
      const parsed: any = firstJson(r.text); const list: any[] = Array.isArray(parsed?.verdicts) ? parsed.verdicts : [];
      for (const b of batch) verdicts.push(validateVerdict(list.find((v) => String(v?.job_id) === b.id), b, evidenceText));
    }
    const jobs = new Map(items.map((x: any) => [x.id, { title: x.title, employer: x.company, eligible: true }]));
    const shown = display(verdicts.filter((v) => v.core), c, jobs as any);
    res[p] = { verdicts, shown, ms: Date.now() - t0 }; writeFileSync(`${OUT}/verdicts/${set}-${p}.json`, JSON.stringify(res[p]));
  });
  console.log(JSON.stringify({ candidates: Object.keys(res).length, shown: Object.fromEntries(Object.entries<any>(res).map(([p, r]) => [p, r.shown.strong.length])), spent_inr: +ledger.spent().toFixed(2), versions: { extractor: EXTRACTOR_VERSION, judge: JUDGE_VERSION, shortlist: SHORTLIST_VERSION } }));
}
