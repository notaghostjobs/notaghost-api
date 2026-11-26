// Cost plan for a V3 paid evaluation, without any model call. Builds the exact requests V3 would send at shortlist
// size 40 for each of the 19 seen profiles (as a proxy for the size of fresh candidates' requests), using full
// posting text, and prices them three ways:
//   expected — chars→tokens calibrated on V2's own requests vs its ledger; measured output tokens (mean); prompt cache as V2 saw it;
//   p90      — p90 output tokens (extraction ×1.4 for full text), +20% input, +10% for failed calls that are paid but unusable, no prompt-cache reads, no sharing;
//   worst    — api3.ts's per-request reservation (every 2.5 chars a token, all of max_tokens, system written); no retries (policy: fail closed).
// Extraction is priced per distinct posting, with a cache hit only when the exact description sha and extractor version match.
//   SUPABASE_URL=https://offline.invalid SUPABASE_SERVICE_ROLE_KEY=offline npx tsx src/lab/v3/cost-plan.mts
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const D = await import("./data.mjs"); const F = await import("./features.mjs"); const SL = await import("./shortlist.js");
const { PRICE, INR } = await import("../v2/api.js"); const { worstCase3: worstCase } = await import("./api3.js"); const { EXTRACT_SYSTEM, extractUser, EXTRACTOR_VERSION, CJR_SCHEMA } = await import("../v2/cjr.js");
const { JUDGE_SYSTEM, candidateBlock, judgeUser, shortlist } = await import("../v2/pipeline.js"); const { judgeUserFull } = await import("./judge3.js"); const { descSha, EXTRACT_CHAR_LIMIT } = await import("./jobtext.js");
const { skillsIn } = await import("../skills.js"); const { GENERIC } = await import("../v2/terms.js");
const SIZE = Number(process.env.SIZE ?? 40), MAXTOK = { extract: 4000, judge: 10000 };
const ledger = readFileSync(`${D.S}/v2/frozen-archive/ledger.FINAL.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.ok && r.usage);
const stat = (pre: string) => { const R = ledger.filter((r) => r.purpose.startsWith(pre)); const q = (k: string, p: number) => { const v = R.map((r) => r.usage[k] ?? 0).sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.floor(p * v.length))]; };
  const mean = (k: string) => R.reduce((a, r) => a + (r.usage[k] ?? 0), 0) / R.length; return { n: R.length, inMean: mean("input_tokens") + mean("cache_creation_input_tokens") + mean("cache_read_input_tokens"), outMean: mean("output_tokens"), outP90: q("output_tokens", 0.9), outMax: q("output_tokens", 1), crShare: mean("cache_read_input_tokens") / (mean("input_tokens") + mean("cache_creation_input_tokens") + mean("cache_read_input_tokens")), cwShare: mean("cache_creation_input_tokens") / (mean("input_tokens") + mean("cache_creation_input_tokens") + mean("cache_read_input_tokens")) }; };
const SJ = stat("judge j3"), SX = stat("extract x3");
// calibration: V2's own requests (truncated view text, frozen CJR) → characters per input token
const view = (id: string) => { const v: any = D.views.get(id); return v.whole_raw.slice(v.title.length + 2); };
let v2JudgeChars = 0, v2JudgeCalls = 0, v2XChars = 0, v2X = 0;
for (const p of [...D.split.development, ...D.split.heldout]) { const c = D.cer(p); const sys = JUDGE_SYSTEM(candidateBlock(c)).length; const ids = D.stage.get(p).shortlist.map((x: any) => x.id).filter((id: string) => D.cjr.get(id)?.usable);
  for (let i = 0; i < ids.length; i += 5) { const b = ids.slice(i, i + 5).map((id: string) => ({ id, title: D.views.get(id).title, company: D.views.get(id).employer ?? "", text: view(id), cjr: D.cjr.get(id) })); v2JudgeChars += sys + judgeUser(b).length; v2JudgeCalls++; }
  for (const id of ids) { v2XChars += EXTRACT_SYSTEM.length + extractUser(D.views.get(id).title, D.views.get(id).employer ?? "", view(id).slice(0, 16000)).length; v2X++; } }
const cpt = { judge: v2JudgeChars / v2JudgeCalls / SJ.inMean, extract: v2XChars / v2X / SX.inMean };
const cjrChars = [...D.cjr.values()].map((x) => JSON.stringify({ function: x.function, specialisation: x.specialisation, mandatory: x.mandatory, secondary: x.secondary, years: x.years, seniority: x.seniority, manages_people: x.manages_people, credentials: x.credentials }).length).sort((a, b) => a - b);
const cjrMean = cjrChars.reduce((a, b) => a + b, 0) / cjrChars.length, cjrP90 = cjrChars[Math.floor(cjrChars.length * 0.9)];
const inr = (inTok: number, outTok: number, crTok = 0, cwTok = 0) => ((inTok * PRICE.in + outTok * PRICE.out + crTok * PRICE.cr + cwTok * PRICE.cw) / 1e6) * INR;
const per: any[] = []; const distinct = new Set<string>(); let cacheHits = 0;
for (const p of [...D.split.development, ...D.split.heldout]) {
  const { c, cands } = D.candidates(p); const r = D.pools.get(p); const have = new Map(c.skills.map((s: any) => [s.id, s.basis]));
  const sc = cands.map((x: any) => { const f = F.features(p, x.id); const need = [...skillsIn(x.reqText)]; let num = 0, den = 0; for (const s of need) { const w = GENERIC.has(s) ? 0.25 : 1; den += w; const b = have.get(s); num += w * (b === "work" || b === "achievement" ? 1 : b === "project" ? 0.7 : b ? 0.3 : 0); }
    const sg = F.signature(x.id); return { id: x.id, title: x.title, employer: x.employer, channels: Object.fromEntries(Object.entries<any>(r.channels).map(([k, l]) => [k, l.indexOf(x.id) + 1 || null])), agree: x.agree, compat: f.compat, anchors: f.anchors, cover: den ? num / den : 0.5, sig: sg.sig }; });
  const reps = SL.shortlist3(sc, { size: SIZE, ...SL.DEFAULT_SHORT }).chosen.map((cl) => cl.rep.id);
  const sys = JUDGE_SYSTEM(candidateBlock(c)).length; const calls: any[] = [];
  for (let i = 0; i < reps.length; i += 5) { const b = reps.slice(i, i + 5).map((id) => ({ id, title: D.views.get(id).title, company: D.views.get(id).employer ?? "", text: D.fullText.get(id) ?? view(id), cjr: {} as any }));
    const u = judgeUserFull(b.map((x) => ({ ...x, cjr: {} as any }))).length; const userChars = u + b.length * (cjrMean - 2); calls.push({ sys, userChars, userCharsP90: u + b.length * (cjrP90 - 2) }); }   // V3 judge input j3-fulltext
  const xs = reps.map((id) => { const text = D.fullText.get(id) ?? view(id); const hit = existsSync(`${D.S}/ho/v2/cjr/${id}.${descSha(text).slice(0, 16)}.${CJR_SCHEMA.replace("/", "")}.${EXTRACTOR_VERSION}.json`) || ["cp1", "cp1b", "cp2"].some((d) => existsSync(`${D.S}/${d}/v2/cjr/${id}.${descSha(text).slice(0, 16)}.${CJR_SCHEMA.replace("/", "")}.${EXTRACTOR_VERSION}.json`)); if (hit) cacheHits++;
    return { id, hit, chars: EXTRACT_SYSTEM.length + extractUser(D.views.get(id).title, D.views.get(id).employer ?? "", text.slice(0, EXTRACT_CHAR_LIMIT)).length, sysChars: EXTRACT_SYSTEM.length, truncated: text.length > EXTRACT_CHAR_LIMIT }; });
  xs.forEach((x) => distinct.add(x.id));
  per.push({ p, reps: reps.length, calls, xs });
}
// price one candidate's judge calls and its own extractions (unshared), three ways
const scen = (k: "expected" | "p90" | "worst") => per.map((c) => {
  let j = 0; c.calls.forEach((q: any, i: number) => { const chars = q.sys + (k === "p90" ? q.userCharsP90 : q.userChars);
    if (k === "worst") { j += worstCase(q.sys, q.userCharsP90, MAXTOK.judge); return; }
    const tok = (chars / cpt.judge) * (k === "p90" ? 1.2 : 1), sysTok = q.sys / cpt.judge; const out = k === "p90" ? SJ.outP90 : SJ.outMean;
    const cost = k === "expected" ? (i === 0 ? inr(tok - sysTok, out, 0, sysTok) : inr(tok - sysTok, out, sysTok, 0)) : inr(tok, out, 0, sysTok); j += k === "p90" ? cost * 1.1 : cost; });
  let x = 0; for (const e of c.xs) { if (e.hit) continue; if (k === "worst") { x += worstCase(e.sysChars, e.chars - e.sysChars, MAXTOK.extract); continue; }
    const tok = (e.chars / cpt.extract) * (k === "p90" ? 1.2 : 1), sysTok = e.sysChars / cpt.extract; const out = (k === "p90" ? SX.outP90 * 1.4 : SX.outMean * 1.2);
    x += k === "expected" ? inr(tok - sysTok, out, sysTok, 0) : inr(tok, out, 0, 0) * 1.1; }
  return { judge: j, extract: x }; });
const sum = (a: any[], f: string) => a.reduce((s, x) => s + x[f], 0);
const res: any = { size: SIZE, calibration: { chars_per_token_judge: +cpt.judge.toFixed(2), chars_per_token_extract: +cpt.extract.toFixed(2), judge_out_mean: Math.round(SJ.outMean), judge_out_p90: SJ.outP90, judge_out_max: SJ.outMax, extract_out_mean: Math.round(SX.outMean), extract_out_p90: SX.outP90, v2_prompt_cache_read_share_judge: +SJ.crShare.toFixed(3) },
  requests_per_candidate: { judge_calls_mean: +(sum(per.map((c) => ({ n: c.calls.length })), "n") / per.length).toFixed(1), extractions_mean_unshared: +(sum(per.map((c) => ({ n: c.xs.length })), "n") / per.length).toFixed(1), distinct_postings_19: distinct.size, slots_19: sum(per.map((c) => ({ n: c.xs.length })), "n"), exact_cache_hits: cacheHits, postings_over_16000_chars: per.flatMap((c) => c.xs).filter((x: any) => x.truncated).length },
  scenarios: {} };
for (const k of ["expected", "p90", "worst"] as const) { const s = scen(k); const sharing = k === "expected" ? distinct.size / sum(per.map((c) => ({ n: c.xs.length })), "n") : 1;   // expected: postings shared across candidates are extracted once
  const j = sum(s, "judge") / s.length, x = (sum(s, "extract") / s.length) * sharing; res.scenarios[k] = { judge_per_candidate: +j.toFixed(2), extraction_per_candidate: +x.toFixed(2), total_per_candidate: +(j + x).toFixed(2), sharing_factor: +sharing.toFixed(2) }; }
writeFileSync(`${D.S}/v3/cost-plan-${SIZE}.json`, JSON.stringify(res, null, 1)); console.log(JSON.stringify(res, null, 1));
