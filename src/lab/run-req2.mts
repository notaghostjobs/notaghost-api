// match-req-2 arms on the unchanged hybrid pools: A control (req-1 logic), B provenance, C core-vs-supporting, D both.
// The offline validity check v2 is applied to every arm alike. Writes arms in the usual shape plus notes and timing.
//   npx tsx src/lab/run-req2.mts <retrieval.json> <cand dir> <out.json>
process.env.SUPABASE_URL ??= "https://offline.invalid"; process.env.SUPABASE_SERVICE_ROLE_KEY ??= "offline";
import { readFileSync, writeFileSync } from "node:fs";
const { evidence, reqsFromDet } = await import("./req.js"); const { evaluate2 } = await import("./req2.js");
const { provenance } = await import("./provenance.js"); const { validity2 } = await import("./validity.js");
const S = "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad";
const [retF, candDir, out] = process.argv.slice(2);
// Paths default to the development workspace (unchanged behaviour). An evaluation root passes all four explicitly;
// when REQ2_EVAL=1 a missing one is an error, never a fall back to the development data.
const P = (k: string, dev: string) => { const v = process.env[k]; if (process.env.REQ2_EVAL === "1" && !v) throw new Error(`${k} must be set for an evaluation root`); return v ?? dev; }; const ret = JSON.parse(readFileSync(retF, "utf8"));
const det = new Map(readFileSync(P("REQ2_JIR", `${S}/arch/jir-det.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => { const j = JSON.parse(l); return [j.posting.id, j]; }));
const views = new Map(readFileSync(P("REQ2_VIEWS", `${S}/arch/views-det.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => { const v = JSON.parse(l); return [v.id, v]; }));
const profiles = new Map(JSON.parse(readFileSync(P("REQ2_PROFILES", `${S}/bench/profiles-19-local.json`), "utf8")).map((p: any) => [p.id, p]));
const ARMS: Record<string, { provenance: boolean; core: boolean }> = { "R2:A_control": { provenance: false, core: false }, "R2:B_provenance": { provenance: true, core: false }, "R2:C_core": { provenance: false, core: true }, "R2:D_both": { provenance: true, core: true } };
const arms: any = {}, notes: any = {}, invalidDropped: any = {}; const times: number[] = [];
for (const r of ret.runs) {
  const t0 = performance.now();
  const c = JSON.parse(readFileSync(`${candDir}/${r.p}.json`, "utf8")); const resume = readFileSync((profiles.get(r.p) as any).resume, "utf8");
  const ev: any = evidence(c.cir.views.experience, c.cir.views.skills, resume); if (/\bph\.?\s?d\b/i.test(resume)) ev.quals.add("phd");
  const pv = provenance(JSON.parse(readFileSync(`${P("REQ2_LAYOUT", `${S}/req2/layout`)}/${r.p}.json`, "utf8")));
  const ev2 = { ...ev, strength: pv.strength };
  const intent = { want: c.belief.want, level: c.belief.level, years: c.belief.years, domain: c.belief.field, stretch: c.belief.stretch };
  const pool: string[] = [...r.pool]; for (const ch of ["fallback_fulltext", "fallback_title"]) for (const id of (r.channels[ch] ?? []).slice(0, 50)) if (!pool.includes(id)) pool.push(id);
  const n = r.pool.length; const rel = (id: string) => { const i = r.pool.indexOf(id); return i >= 0 ? 1 - i / n : 0.2; };
  const valid = pool.filter((id) => { const v: any = views.get(id); const bad = v && validity2(v.title, v.whole_raw.slice(v.title.length + 2)); if (bad) invalidDropped[r.p] = (invalidDropped[r.p] ?? 0) + 1; return !bad; });
  for (const [name, o] of Object.entries(ARMS)) {
    const list: any[] = [];
    for (const id of valid) { const j: any = det.get(id); if (!j) continue; const rq: any = { ...reqsFromDet(j), title: j.posting.title, mandatoryText: j.text.requirements + "\n" + j.text.duties };
      const e = evaluate2(o.provenance ? ev2 : ev, rq, intent as any, rel(id), o); list.push({ id, ...e }); }
    list.sort((a, b) => b.score - a.score);
    const per = new Map<string, number>(), seen = new Set<string>(), keep: any[] = [];
    for (const x of list) { const v: any = views.get(x.id); const emp = (v?.employer ?? "").toLowerCase(), k = emp + "|" + (v?.title ?? "").toLowerCase(); if (seen.has(k)) continue; seen.add(k); if (keep.length < 5 && (per.get(emp) ?? 0) >= 1) continue; per.set(emp, (per.get(emp) ?? 0) + 1); keep.push(x); if (keep.length >= 40) break; }
    (arms[name] ??= {})[r.p] = { top: keep.slice(0, 5).map((x) => x.id), next: keep.slice(5, 40).map((x) => x.id) };
    (notes[name] ??= {})[r.p] = keep.slice(0, 5).map((x) => ({ id: x.id, title: (views.get(x.id) as any)?.title, band: x.band, score: x.score, capped: x.capped, core: x.core, checks: x.checks.filter((k: any) => ["core", "qualification"].includes(k.kind) || k.status === "unsupported").slice(0, 6) }));
  }
  times.push(performance.now() - t0);
}
const sorted = [...times].sort((a, b) => a - b);
writeFileSync(out, JSON.stringify({ arms, notes, invalidDropped, ms: { median: Math.round(sorted[Math.floor(sorted.length / 2)]), p95: Math.round(sorted[Math.floor(0.95 * sorted.length)]), max: Math.round(sorted.at(-1)!) } }));
console.log("arms", Object.keys(arms).join(", "), "| per-candidate ms (4 arms, incl. evidence):", { median: Math.round(sorted[Math.floor(sorted.length / 2)]), p95: Math.round(sorted[Math.floor(0.95 * sorted.length)]) }, "| invalid dropped per candidate:", JSON.stringify(invalidDropped));
