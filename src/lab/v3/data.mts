// Matching v3 lab: loads the frozen V2 experiment exactly as run-free.mts built it (same pools, same job records, same
// eligibility), so V3 stages can be replayed against frozen outputs. Reads the private workspace only; writes nothing.
import { readFileSync, existsSync, readdirSync } from "node:fs";
const { eligibility } = await import("../v2/pipeline.js");
const { validity2 } = await import("../validity.js"); const { transfer } = await import("../../lib/ontology.js");
export const S = process.env.V3_DATA ?? "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad";   // a fresh evaluation runs the same layout under its own root
const jl = (f: string, keep: (id: string) => boolean, id: (o: any) => string) => { const m = new Map<string, any>(); for (const l of readFileSync(f, "utf8").split("\n")) { if (!l) continue; const o = JSON.parse(l); if (keep(id(o))) m.set(id(o), o); } return m; };
export const split: { development: string[]; heldout: string[] } = JSON.parse(readFileSync(`${S}/diag/split.json`, "utf8"));
export const setOf = (p: string) => (split.development.includes(p) ? "dev" : "heldout");
export const profiles = new Map<string, any>(JSON.parse(readFileSync(`${S}/bench/profiles-19-local.json`, "utf8")).map((p: any) => [p.id, p]));
export const closed = new Set<string>(JSON.parse(readFileSync(`${S}/v2/closed-since-snapshot.json`, "utf8")));
export const pools = new Map<string, any>(); for (const set of ["dev", "heldout"]) for (const r of JSON.parse(readFileSync(`${S}/v2/pools-${set}.json`, "utf8")).runs) pools.set(r.p, r);
export const stage = new Map<string, any>(); for (const set of ["dev", "heldout"]) for (const [p, o] of Object.entries(JSON.parse(readFileSync(`${S}/v2/frozen-archive/stage-${set}.json`, "utf8")))) stage.set(p, o);
export const verdicts = new Map<string, any>(); for (const set of ["dev", "heldout"]) { const d = `${S}/v2/frozen-archive/verdicts-${set}`; for (const f of readdirSync(d)) verdicts.set(f.slice(-8, -5), JSON.parse(readFileSync(`${d}/${f}`, "utf8"))); }
export const cer = (p: string) => JSON.parse(readFileSync(`${S}/v2/cer/${p}.json`, "utf8"));
export const resume = (p: string) => readFileSync(profiles.get(p).resume, "utf8");
const LF = JSON.parse(readFileSync(`${S}/req/labels-merged-all.json`, "utf8"));
/** Existing two-labeller AI labels (provisional, not human truth). "conflict" is dropped. */
export const labels = new Map<string, any>(Object.entries<any>(LF).filter(([, v]) => v.grade !== "conflict"));
export const SU = new Set(["direct", "adjacent"]);
/** Cached job-requirement extractions (CJR) from the paid runs, newest extractor per job. */
export const cjr = new Map<string, any>();
for (const d of ["cp1", "cp1b", "cp2", "ho"].map((x) => `${S}/${x}/v2/cjr`)) if (existsSync(d)) for (const f of readdirSync(d)) { const o = JSON.parse(readFileSync(`${d}/${f}`, "utf8")); if (!o.job_id) continue; const prev = cjr.get(o.job_id); if (!prev || o.extractor >= prev.extractor) cjr.set(o.job_id, o); }
// every job any pool mentions (hybrid pool + both fallback channels, first 50), as run-free built it
const ids = new Set<string>(); for (const r of pools.values()) { r.pool.forEach((x: string) => ids.add(x)); for (const ch of Object.values<any>(r.channels)) ch.slice(0, 200).forEach((x: string) => ids.add(x)); }
export const det = jl(`${S}/arch/jir-det.jsonl`, (i) => ids.has(i), (o) => o.posting.id);
export const views = jl(`${S}/arch/views-det.jsonl`, (i) => ids.has(i), (o) => o.id);
/** Full posting text from the frozen inventory (not the 3,000-character retrieval view). */
const { htmlToText } = await import("./jobtext.js");
export const fullText = new Map<string, string>(); for (const l of readFileSync(`${S}/bench/prod/inventory.jsonl`, "utf8").split("\n")) { if (!l) continue; const o = JSON.parse(l); if (ids.has(String(o.id))) fullText.set(String(o.id), htmlToText(o.description ?? "")); }
const answers = JSON.parse(readFileSync(`${S}/sim2/answers.json`, "utf8"));
export const intent = (p: string) => answers[p];

/** The candidate list run-free.mts built for the shortlist (frozen V2 definition), plus the excluded jobs. */
export function candidates(p: string, opts: { fallbackDepth?: number } = {}) {
  const r = pools.get(p), c = cer(p), res = resume(p); const depth = opts.fallbackDepth ?? 50;
  const want: [string, number][] = JSON.parse(readFileSync(`${S}/arch/cand/${p}.json`, "utf8")).belief.want;
  const pool: { id: string; channel: string; rank: number | null }[] = r.pool.map((id: string, i: number) => ({ id, channel: "hybrid", rank: i + 1 }));
  for (const ch of ["fallback_fulltext", "fallback_title"]) for (const id of (r.channels[ch] ?? []).slice(0, depth)) if (!pool.some((x) => x.id === id)) pool.push({ id, channel: ch, rank: null });
  const excluded: any[] = [], cands: any[] = [];
  for (const x of pool) {
    const v: any = views.get(x.id), j: any = det.get(x.id); if (!v || !j) { excluded.push({ id: x.id, reasons: ["no job record"] }); continue; }
    const text = v.whole_raw.slice(v.title.length + 2); const invalid = !!validity2(v.title, text);
    const e = eligibility({ id: x.id, title: v.title, location: String(j.posting?.location ?? v.location ?? ""), text, invalid, closed: closed.has(x.id) }, c, res);
    if (e.excluded) { excluded.push({ id: x.id, reasons: e.reasons }); continue; }
    const specs: string[] = (j.specialisation?.value ?? []).map(String);
    const agree = specs.length ? Math.max(...specs.map((s) => want.reduce((a, [k, w]) => a + w * transfer(k, s), 0))) : null;
    cands.push({ id: x.id, title: v.title, employer: v.employer ?? "", text, reqText: `${j.text?.requirements ?? ""}\n${(j.capabilities_essential?.value ?? []).join("\n")}`, poolRank: x.rank, channel: x.channel, agree, det: j });
  }
  return { c, cands, excluded, pool };
}
