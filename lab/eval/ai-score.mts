// Score AI job records (and v2 deterministic, for the same postings) against the blind labels of a partition.
//   npx tsx ai-score.mts <labels dir> <ai jsonl>[,<ai jsonl>] [show]
process.env.SUPABASE_URL ??= "https://offline.invalid"; process.env.SUPABASE_SERVICE_ROLE_KEY ??= "offline";
import { readFileSync } from "node:fs";
const { SPEC, transfer } = await import("/home/claude/wt-api/src/lib/ontology.ts");
const [D, files, show] = process.argv.slice(2); const J = (f: string) => JSON.parse(readFileSync(`${D}/${f}`, "utf8"));
const ids = J("ids.json"), A = new Map(J("labeller-A.json").map((x: any) => [x.n, x])), B = new Map(J("labeller-B.json").map((x: any) => [x.n, x]));
const v2 = new Map(JSON.parse(readFileSync("/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad/bench/prod/tags-v2.json", "utf8")).map((t: any) => [String(t.id), t]));
const fnOf = (s: string) => (!s || s === "none" || s === "unclear" ? s : s.startsWith("research") ? "data" : s.startsWith("presales") ? "sales" : s.startsWith("biz") ? "ops" : s.split(".")[0]);
const R = ["intern", "entry", "mid", "senior", "leader"];
for (const f of files.split(",")) {
  const ai = new Map(readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.ok).map((x) => [String(x.id), x]));
  for (const who of ["ai", "v2"]) {
    const st = { n: 0, tagged: 0, okBoth: 0, fnWrong: 0, near: 0, nearN: 0, lev: 0, levN: 0, lev2: 0, mgr: 0, mgrN: 0, dom: 0, domN: 0, badId: 0, invalidSaid: 0 };
    for (const { n, id } of ids) { const x: any = ai.get(String(id)); if (!x) continue; st.n++; const a: any = A.get(n), b: any = B.get(n);
      const rec = x.rec; let spec: string | null, level: string | null, mgr: any, dom: string[];
      if (who === "ai") { spec = (rec.specialisation ?? []).find((s: string) => SPEC.has(s)) ?? null; if ((rec.specialisation ?? []).some((s: string) => !SPEC.has(s))) st.badId++; level = rec.seniority?.value ?? null; mgr = rec.manages_people?.value; dom = rec.domain?.value ?? []; if (rec.valid_posting === false) st.invalidSaid++; }
      else { const t: any = v2.get(String(id)); spec = t?.spec ?? null; level = t?.level ?? null; mgr = t?.manages; dom = t?.fields ?? []; }
      const okOf = (l: any) => !!spec && (spec === l.spec || (l.ok || []).includes(spec));
      if (spec) { st.tagged++; if (okOf(a) && okOf(b)) st.okBoth++; if (fnOf(spec) !== fnOf(a.spec) && fnOf(spec) !== fnOf(b.spec) && a.spec !== "unclear" && b.spec !== "unclear") st.fnWrong++; }
      if (a.spec === b.spec && SPEC.has(a.spec)) { st.nearN++; if (spec && transfer(spec, a.spec) >= 0.5) st.near++; }
      if (a.level === b.level && a.level !== "unclear") { st.levN++; if (level === a.level) st.lev++; if (level && Math.abs(R.indexOf(level) - R.indexOf(a.level)) >= 2) st.lev2++; }
      if (a.manages === b.manages && a.manages !== "unclear") { st.mgrN++; if ((mgr === true ? "yes" : mgr === false ? "no" : "?") === a.manages) st.mgr++; }
      if (a.domain === b.domain && !["none", "other"].includes(a.domain)) { st.domN++; if (dom.includes(a.domain)) st.dom++; }
      if (show && who === "ai" && !(okOf(a) && okOf(b))) console.log(`  #${n} ${x.rec?.archetype} | ai ${spec} | A ${a.spec} B ${b.spec}`);
    }
    const pct = (x: number, y: number) => (y ? `${(100 * x / y).toFixed(0)}%` : "-");
    console.log(`${who === "ai" ? f.split("/").pop() : "deterministic v2 (same postings)"}: n ${st.n}; tagged ${pct(st.tagged, st.n)}; spec acceptable ${pct(st.okBoth, st.tagged)}; wrong function ${pct(st.fnWrong, st.tagged)} (${st.fnWrong}); close for matching ${pct(st.near, st.nearN)}; seniority exact ${pct(st.lev, st.levN)}, 2+ off ${st.lev2}; manages people ${pct(st.mgr, st.mgrN)}; domain ${pct(st.dom, st.domN)}${who === "ai" ? `; ids outside the list ${st.badId}; said not a posting ${st.invalidSaid}` : ""}`);
  }
}
