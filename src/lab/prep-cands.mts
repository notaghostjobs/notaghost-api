// For each benchmark candidate: the CIR, arm A's ranking (the deterministic engine on job tags, unchanged code), and
// per-job structured signals the hybrid arms use (eligible, kind-of-work agreement, level fit, existing text fit).
//   npx tsx src/lab/prep-cands.mts <profiles.json> <answers.json> <inventory.jsonl> <jir.jsonl> <outdir>
process.env.SUPABASE_URL ??= "https://offline.invalid"; process.env.SUPABASE_SERVICE_ROLE_KEY ??= "offline";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const { cleanTitle } = await import("../radar/v2.js"); const { postingProblem, corpus, resumeTerms, fitTo } = await import("../lib/textfit.js");
const { entryFor } = await import("../lib/discover.js"); const { rank, agreement, levelFit } = await import("../lib/career.js");
const { bandGate, cityGate, languageGate } = await import("../radar/gates.js"); const { cir, intentFrom } = await import("./cir.js");
const [prof, ans, inv, jirF, out] = process.argv.slice(2); mkdirSync(out, { recursive: true });
const raw = readFileSync(inv, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.description);
const texts: any[] = []; for (const r of raw) { const v = postingProblem(r.title ?? "", r.description); if (!v.problem) texts.push({ text: v.text, employer: String(r.employer_key ?? r.company_name) }); }
const idf = corpus(texts); const index = new Map<string, any>();
for (const r of raw) { const e = entryFor({ id: r.id, title: cleanTitle(r.title), employer: String(r.company_name), description: r.description }, idf); if (e.entry) index.set(e.entry.id, e.entry); }
const jirs = readFileSync(jirF, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); const ids = jirs.map((j: any) => j.posting.id);
const answers = JSON.parse(readFileSync(ans, "utf8"));
for (const p of JSON.parse(readFileSync(prof, "utf8"))) {
  const resume = readFileSync(p.resume, "utf8").slice(0, 14000); const intent = intentFrom(answers[p.id]); const c = cir(p.id, resume, intent);
  const want = new Map<string, number>(intent.secondary ? [[intent.primary, 0.7], [intent.secondary, 0.3]] : [[intent.primary, 1]]);
  const belief = { want, level: intent.level, years: intent.years, field: intent.domain, stretch: intent.stretch, move: intent.transition };
  const mine = resumeTerms(resume, idf); const pool: any[] = []; const sig: number[][] = [];
  const t0 = performance.now();
  for (const j of jirs) { const e = index.get(j.posting.id); const spec = j.specialisation.value?.[0] ?? null, level = j.seniority.value;
    const fit = e ? fitTo(mine, e.marked).fit : 0; const elig = e ? !cityGate(e.title) && !languageGate(e.text, resume) && !(intent.years && bandGate(intent.years, e.text, e.title)) : false;
    const ag = agreement(belief as any, spec), lf = levelFit(intent.level, level, intent.stretch);
    sig.push([elig ? 1 : 0, Math.round(ag * 100) / 100, lf, Math.round(fit * 1000) / 1000, j.domain.value?.includes(intent.domain ?? "~") ? 1 : 0]);
    if (spec) pool.push({ id: j.posting.id, title: j.posting.title, employer: j.posting.employer, spec, level, fields: j.domain.value ?? [], fit, eligible: () => elig }); }
  const titles = c.done.jobs.map((x) => x.title).filter(Boolean).slice(0, 3);
  const A = rank(belief as any, pool, titles, 40); const ms = Math.round(performance.now() - t0);
  writeFileSync(`${out}/${p.id}.json`, JSON.stringify({ cir: c, belief: { want: [...want], level: belief.level, years: belief.years, field: belief.field, stretch: belief.stretch }, A: { top: A.slice(0, 5), next: A.slice(5, 40) }, ms_A: ms, sig_fields: ["eligible", "agree", "levelFit", "textfit", "domain"], sig }));
  console.log(p.id, intent.primary, "A top:", A.slice(0, 5).map((x) => x.title.slice(0, 30)).join(" | "), ms + "ms");
}
writeFileSync(`${out}/job-ids.json`, JSON.stringify(ids));
