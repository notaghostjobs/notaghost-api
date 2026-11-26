// The shared eligibility gate on the frozen match-req-2 inputs (same hybrid pools, same job records, same offline
// validity check as the control arm). No model call. Writes the eligible list per candidate (no fixed count; at most
// 40 for display) and the verdict for every pooled job.
//   npx tsx src/lab/run-elig.mts <retrieval.json> <cand dir> <out.json>
process.env.SUPABASE_URL ??= "https://offline.invalid"; process.env.SUPABASE_SERVICE_ROLE_KEY ??= "offline";
import { readFileSync, writeFileSync } from "node:fs";
const { evidence, reqsFromDet, evaluate } = await import("./req.js"); const { validity2 } = await import("./validity.js");
const { gate, jobFromDet, rankScore } = await import("./elig.js");
const S = "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad";
const [retF, candDir, out] = process.argv.slice(2); const ret = JSON.parse(readFileSync(retF, "utf8"));
const det = new Map(readFileSync(`${S}/arch/jir-det.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => { const j = JSON.parse(l); return [j.posting.id, j]; }));
const views = new Map(readFileSync(`${S}/arch/views-det.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => { const v = JSON.parse(l); return [v.id, v]; }));
const profiles = new Map(JSON.parse(readFileSync(`${S}/bench/profiles-19-local.json`, "utf8")).map((p: any) => [p.id, p]));
const lists: any = {}, verdicts: any = {}, stats: any = {}; const times: number[] = [];
for (const r of ret.runs) {
  const t0 = performance.now();
  const c = JSON.parse(readFileSync(`${candDir}/${r.p}.json`, "utf8")); const resume = readFileSync((profiles.get(r.p) as any).resume, "utf8");
  const ev: any = evidence(c.cir.views.experience, c.cir.views.skills, resume); if (/\bph\.?\s?d\b/i.test(resume)) ev.quals.add("phd");
  const intent = { want: c.belief.want, level: c.belief.level, years: c.belief.years, domain: c.belief.field, stretch: c.belief.stretch };
  const person = { want: c.belief.want, level: c.belief.level, years: Number(c.belief.years) || 0, stretch: !!c.belief.stretch, resume, experience: String(c.cir.views.experience ?? "") };
  const pool: string[] = [...r.pool]; for (const ch of ["fallback_fulltext", "fallback_title"]) for (const id of (r.channels[ch] ?? []).slice(0, 50)) if (!pool.includes(id)) pool.push(id);
  const n = r.pool.length; const rel = (id: string) => { const i = r.pool.indexOf(id); return i >= 0 ? 1 - i / n : 0.2; };
  const st = { pooled: pool.length, invalid: 0, function: 0, experience: 0, specialist: 0, eligible: 0 };
  const scored: any[] = [];
  for (const id of pool) {
    const v: any = views.get(id); if (v && validity2(v.title, v.whole_raw.slice(v.title.length + 2))) { st.invalid++; (verdicts[r.p] ??= {})[id] = { eligible: false, why: ["invalid posting"] }; continue; }
    const j: any = det.get(id); if (!j) continue;
    const g = gate(jobFromDet(j), person);
    for (const w of g.why) { if (/function/.test(w)) st.function++; else if (/years|step back|seniority/.test(w)) st.experience++; else st.specialist++; }
    (verdicts[r.p] ??= {})[id] = { eligible: g.eligible, why: g.why, agree: g.agree, yearsFit: g.yearsFit, specialist: g.specialist };
    if (!g.eligible) continue; st.eligible++;
    const e = evaluate(ev, { ...reqsFromDet(j) } as any, intent as any, rel(id));
    scored.push({ id, score: rankScore(g, e.parts.ess, rel(id)) });
  }
  scored.sort((a, b) => b.score - a.score);
  // the same de-duplication as the control arm: one line per employer and title; at most one per employer in the top 5
  const per = new Map<string, number>(), seen = new Set<string>(), keep: any[] = [];
  for (const x of scored) { const v: any = views.get(x.id); const emp = (v?.employer ?? "").toLowerCase(), k = emp + "|" + (v?.title ?? "").toLowerCase(); if (seen.has(k)) continue; seen.add(k); if (keep.length < 5 && (per.get(emp) ?? 0) >= 1) continue; per.set(emp, (per.get(emp) ?? 0) + 1); keep.push(x); if (keep.length >= 40) break; }
  lists[r.p] = { top: keep.slice(0, 5).map((x) => x.id), next: keep.slice(5).map((x) => x.id), eligible: st.eligible };
  stats[r.p] = st; times.push(performance.now() - t0);
}
const sorted = [...times].sort((a, b) => a - b);
writeFileSync(out, JSON.stringify({ arms: { "E:gate": lists }, verdicts, stats, ms: { median: Math.round(sorted[Math.floor(sorted.length / 2)]), max: Math.round(sorted.at(-1)!) } }));
const tot = Object.values<any>(stats).reduce((a, s) => { for (const k in s) a[k] = (a[k] ?? 0) + s[k]; return a; }, {} as any);
console.log("pooled", tot.pooled, "| invalid", tot.invalid, "| excluded: function", tot.function, "experience", tot.experience, "specialist", tot.specialist, "(reasons can overlap) | eligible", tot.eligible,
  "| list sizes", JSON.stringify(Object.fromEntries(Object.entries<any>(lists).map(([p, l]) => [p, l.top.length + l.next.length]))), "| ms", JSON.stringify({ median: Math.round(sorted[Math.floor(sorted.length / 2)]) }));
