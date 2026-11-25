process.env.SUPABASE_URL ??= "https://offline.invalid"; process.env.SUPABASE_SERVICE_ROLE_KEY ??= "offline";
import { readFileSync } from "node:fs";
const { evidence, reqsFromDet, reqsFromAI } = await import("/home/claude/wt-api/src/lab/req.ts"); const { evaluate2 } = await import("/home/claude/wt-api/src/lab/req2.ts"); const { provenance } = await import("/home/claude/wt-api/src/lab/provenance.ts");
const S = "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad";
const AI = new Map(readFileSync(`${S}/pilot/ai-claude-haiku-5-5-9275f7c166a5.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.ok).map((x) => [String(x.id), x.rec]));
const L = JSON.parse(readFileSync(`${S}/req/labels-merged-all.json`, "utf8"));
const det = new Map(readFileSync(`${S}/arch/jir-det.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => { const j = JSON.parse(l); return [j.posting.id, j]; }));
const profiles = new Map(JSON.parse(readFileSync(`${S}/bench/profiles-19-local.json`, "utf8")).map((p: any) => [p.id, p]));
let suit = 0, capped = 0, capUns = 0, unsuitCapped = 0; const why: Record<string, number> = {}; const ex: string[] = [];
for (const [k, v] of Object.entries<any>(L)) { const [p, id] = k.split("|"); const j: any = det.get(id); if (!j || !profiles.has(p)) continue;
  const c = JSON.parse(readFileSync(`${S}/arch/cand/${p}.json`, "utf8")); const resume = readFileSync((profiles.get(p) as any).resume, "utf8");
  const ev: any = evidence(c.cir.views.experience, c.cir.views.skills, resume); const intent = { want: c.belief.want, level: c.belief.level, years: c.belief.years, domain: c.belief.field, stretch: c.belief.stretch };
  const r = AI.get(id); if (!r) continue; const rq: any = { ...reqsFromAI(r, j), title: j.posting.title, mandatoryText: [...(r.mandatory_constraints ?? []), ...(r.qualifications ?? [])].map((x: any) => x.text + " " + (x.quote ?? "")).join("\n") };
  const e = evaluate2(ev, rq, intent as any, 0.5, { provenance: false, core: true }); const s = v.grade === "direct" || v.grade === "adjacent";
  if (s) { suit++; if (e.capped) { capped++; for (const ch of e.checks.filter((x: any) => x.kind === "core" || x.kind === "qualification")) why[ch.req] = (why[ch.req] ?? 0) + 1; if (ex.length < 8) ex.push(`${p} ${j.posting.title.slice(0, 40)} | ${e.checks.filter((x: any) => x.kind === "core" || x.kind === "qualification").map((x: any) => x.req + ' ← "' + x.job.slice(0, 60) + '"').join("; ")}`); } }
  else if (v.grade === "unsuitable" || v.grade === "stretch") { capUns++; if (e.capped) unsuitCapped++; } }
console.log(`judged suitable pairs: ${suit}; capped by the core rule: ${capped} (${(100 * capped / suit).toFixed(0)}%)`); console.log(`judged stretch/unsuitable pairs: ${capUns}; capped: ${unsuitCapped} (${(100 * unsuitCapped / capUns).toFixed(0)}%)`);
console.log("what the suitable ones were capped for:", JSON.stringify(Object.entries(why).sort((a, b) => b[1] - a[1]).slice(0, 12))); ex.forEach((x) => console.log("  ", x));
