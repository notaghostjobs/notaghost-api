// V3 diagnosis 1: trace every known-suitable job (AI labels, provisional) through V2's frozen stages, and every shown
// job the labels call not suitable back to the stage that let it through. Offline, no model call.
//   SUPABASE_URL=https://offline.invalid SUPABASE_SERVICE_ROLE_KEY=offline npx tsx src/lab/v3/funnel.mts
import { writeFileSync, mkdirSync } from "node:fs";
const D = await import("./data.mjs"); const { shortlist, personRung, display } = await import("../v2/pipeline.js"); const { rungOf } = await import("../v2/terms.js");
const OUT = `${D.S}/v3`; mkdirSync(OUT, { recursive: true });

/** Why V2's display gate refused a verdict (mirrors display() in pipeline.ts, frozen g3). */
export function gateReason(v: any, c: any, title: string): string | null {
  if (v.failed) return `failed closed: ${v.failed.split(":")[0]}`;
  const openAdj = !/^(no|false)/i.test(c.target.open_to_adjacent); const pr = personRung(c); const jr = rungOf(title).rung;
  if (jr !== null && pr - jr >= 2) return "title ≥2 rungs below the person";
  if (v.fit === "direct") { if (v.function !== "same") return "direct but function not same"; if (v.specialisation === "different") return "direct but specialisation different"; if (!(v.seniority === "right" || v.seniority === "one_up")) return `direct but seniority ${v.seniority}`; if (v.confidence === "low") return "direct at low confidence"; }
  else if (v.fit === "adjacent") { if (!openAdj) return "adjacent, candidate not open to adjacent"; if (v.function === "different") return "adjacent, function different"; if (v.seniority === "too_far") return "adjacent, too far"; if (v.confidence !== "high") return `adjacent at ${v.confidence} confidence`; }
  else return `judged ${v.fit}`;
  const core = v.core; if (!core.length) return "no core checks";
  const n = (s: string) => core.filter((k: any) => k.status === s).length; const dem = n("demonstrated"), tr = n("transferable"), un = n("unverified");
  if (core.some((k: any) => k.status === "confirmed_gap")) return "confirmed gap in a core check";
  if (dem < 1) return "no demonstrated core check";
  if ((dem + tr) / core.length < (v.fit === "direct" ? 0.6 : 0.5)) return "too few core checks met";
  if (un / core.length > 0.4) return "too many unverified core checks";
  return null;   // passed: then lost only to the cap of 5 or a duplicate
}

const rows: any[] = [], fps: any[] = [], fun: any = {}, repro: any = {};
for (const p of [...D.split.development, ...D.split.heldout]) {
  const set = D.setOf(p); const { c, cands, excluded } = D.candidates(p);
  const sl = shortlist(cands, c).map((x: any) => x.j.id); const frozenSl = D.stage.get(p).shortlist.map((x: any) => x.id);
  repro[p] = JSON.stringify(sl) === JSON.stringify(frozenSl);
  const full = shortlist(cands, c, 100000, 100000, 10).map((x: any) => x.j.id);   // order without the size or employer caps
  const V = D.verdicts.get(p); const vd = new Map(V.verdicts.map((x: any) => [String(x.job_id), x])); const shown = new Set(V.shown.strong.map((s: any) => String(s.job_id)));
  const title = (id: string) => D.views.get(id)?.title ?? ""; const r = D.pools.get(p);
  const chRank = (id: string) => Object.fromEntries(Object.entries<any>(r.channels).map(([k, l]) => [k, l.indexOf(id) + 1 || null]));
  const exr = new Map(excluded.map((x: any) => [x.id, x.reasons]));
  for (const [k, g] of D.labels) {
    const [q, j] = k.split("|"); if (q !== p) continue; const suitable = D.SU.has(g.grade);
    if (shown.has(j) && !suitable) { const v: any = vd.get(j); fps.push({ p, set, job: j, title: title(j), label: g.grade, wrong_fn: g.wrong_fn, levels: g.levels, v2: { fit: v.fit, function: v.function, specialisation: v.specialisation, seniority: v.seniority, confidence: v.confidence }, label_reasons: g.reasons }); }
    if (!suitable || D.closed.has(j)) continue;
    const poolRank = r.pool.indexOf(j) + 1 || null; const inCands = cands.some((x: any) => x.id === j); const inPool = inCands || exr.has(j);
    const row: any = { p, set, job: j, title: title(j), grade: g.grade, poolRank, channels: chRank(j), slRankUncapped: full.indexOf(j) + 1 || null };
    if (!inPool) row.stage = "lost: retrieval";
    else if (exr.has(j)) { row.stage = "lost: eligibility"; row.reason = exr.get(j).join("; "); }
    else if (!sl.includes(j)) { row.stage = "lost: shortlist"; const x = cands.find((y: any) => y.id === j); const emp = (x.employer || "").toLowerCase(); const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); const dupOf = sl.find((id) => id !== j && (cands.find((y: any) => y.id === id)?.employer || "").toLowerCase() === emp && norm(title(id)) === norm(x.title));
      const empCount = sl.filter((id) => (cands.find((y: any) => y.id === id)?.employer || "").toLowerCase() === emp).length;
      row.reason = dupOf ? "same employer + same title already shortlisted (dedupe)" : full.indexOf(j) < 0 ? "dropped as a title duplicate of a non-shortlisted posting" : empCount >= 5 && full.indexOf(j) < 30 + 30 ? "employer cap (5)" : `rank ${full.indexOf(j) + 1} > 30`; row.empInShortlist = empCount; }
    else if (shown.has(j)) row.stage = "shown";
    else { const v: any = vd.get(j); row.judge = v ? { fit: v.fit, seniority: v.seniority, specialisation: v.specialisation, confidence: v.confidence, failed: v.failed ?? null } : null; const gr = v ? gateReason(v, c, title(j)) : "not judged"; row.stage = gr ? (v && (v.fit === "direct" || v.fit === "adjacent") && !v.failed ? "lost: display gate" : v?.failed ? "lost: judge failed closed" : "lost: judge verdict") : "lost: cap of 5 / duplicate"; row.reason = gr; }
    rows.push(row); fun[set] ??= {}; fun[set][row.stage] = (fun[set][row.stage] ?? 0) + 1; fun[set].known = (fun[set].known ?? 0) + 1;
  }
}
const reasons: any = {}; for (const r of rows) if (r.reason) { const k = `${r.set} | ${r.stage} | ${String(r.reason).replace(/rank \d+ > 30/, "rank > 30")}`; reasons[k] = (reasons[k] ?? 0) + 1; }
writeFileSync(`${OUT}/funnel-v2.json`, JSON.stringify({ repro, funnel: fun, reasons, rows, false_positives: fps }, null, 1));
console.log("frozen shortlist reproduced:", Object.values(repro).every(Boolean), JSON.stringify(repro));
console.log(JSON.stringify(fun, null, 1)); console.log(JSON.stringify(reasons, null, 1)); console.log("false positives (shown, labelled not suitable):", fps.length);
