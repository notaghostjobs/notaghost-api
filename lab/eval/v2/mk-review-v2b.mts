// Corrected blinded review package (v2b). Membership comes ONLY from the archived original key (122 cases, R001–R122,
// 19 candidates, 12 shared pairs); nothing is re-selected. Reviewer-facing text is identical for a pair whatever system
// chose it. Job: the full original description from the frozen inventory (HTML → text), third-party contacts removed,
// nothing else omitted. Candidate: an allowlisted professional-evidence record through src/lab/v2/review-redact.ts;
// the build fails if the serialized candidate data has any audit hit. Writes to the private workspace only.
//   SUPABASE_URL=https://offline.invalid SUPABASE_SERVICE_ROLE_KEY=offline npx tsx lab/eval/v2/mk-review-v2b.mts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
const { cleanLines, nameTokens, audit, cleanJobText, normalise } = await import("../../../src/lab/v2/review-redact.ts");
const S = "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad", A = `${S}/v2/frozen-archive`, OUT = `${S}/v2/review-v2b`;
mkdirSync(OUT, { recursive: true });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const VERSION = "ghosted-review-v2b.1";
const key: any[] = JSON.parse(readFileSync(`${A}/review-v2-key.ORIGINAL.json`, "utf8"));
if (key.length !== 122 || new Set(key.map((x) => x.profile)).size !== 19 || key.filter((x) => x.arms.length === 2).length !== 12) throw new Error("archived mapping is not the 122/19/12 original: stop");
const ids = new Set(key.map((x) => String(x.job_id)));
const inv = new Map<string, any>(); for (const l of readFileSync(`${S}/bench/prod/inventory.jsonl`, "utf8").split("\n")) { if (!l) continue; const r = JSON.parse(l); if (ids.has(String(r.id))) inv.set(String(r.id), r); }
const prof = new Map(JSON.parse(readFileSync(`${S}/bench/profiles-19-local.json`, "utf8")).map((p: any) => [p.id, p]));
const answers = JSON.parse(readFileSync(`${S}/sim2/answers.json`, "utf8")); const { SPEC } = await import("../../../src/lib/ontology.ts");

function htmlToText(h: string): string {
  return (h || "").replace(/<(br|\/p|\/li|\/h\d|\/div|\/tr)[^>]*>/gi, "\n").replace(/<li[^>]*>/gi, "\n• ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&(rsquo|lsquo);/g, "'").replace(/&(rdquo|ldquo);/g, '"').replace(/&(ndash|mdash);/g, "–").replace(/&hellip;/g, "…").replace(/&times;/g, "×").replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
}
// completeness signals (deterministic; the same rules for every job)
const SIG = {
  requirements: /(requirements?|qualifications?|what you('|’)ll need|you (have|bring|will need)|must[- ]have|skills (required|needed)|eligibility|who you are|what we('|’)re looking for|experience required|ideal candidate)/i,
  responsibilities: /(responsibilit|what you('|’)ll do|you will|key accountabilities|duties|the role|day[- ]to[- ]day|in this role)/i,
  experience: /\d+\s*\+?\s*(-|to|–)?\s*\d*\s*\+?\s*(years|yrs)|\b(fresher|entry[- ]level|graduate)\b/i,
  workmode: /\b(remote|hybrid|on-?site|in[- ]office|work from office|wfo)\b/i,
};
const people = new Map<string, any>(); const uncertain: any[] = []; const candComplete: any = {};
const cand = new Map(key.map((x) => [x.profile, x.candidate]));
for (const [p, label] of cand) {
  const c = JSON.parse(readFileSync(`${S}/v2/cer/${p}.json`, "utf8")); const names = nameTokens(readFileSync((prof.get(p) as any).resume, "utf8"));
  const f = (k: string) => { const r = cleanLines(c[k] ?? [], names, k); for (const u of r.uncertain) uncertain.push({ candidate: label, ...u }); return r.value; };
  const yr = (x: any) => (x === null || x === undefined ? "?" : /^\d{4}(\.\d+)?$/.test(String(x)) ? String(Math.floor(Number(x))) : String(x).slice(0, 12));
  const roles = c.roles.map((r: any) => ({ title: (cleanLines([r.title || ""], names, "role").value[0] ?? "(title removed)"), from: yr(r.from), to: yr(r.to) }));
  const a = answers[p] ?? {}; const lab = (k: string) => (SPEC.get(k) as any)?.label ?? k;
  const rec = { years: c.years_total.value, years_basis: c.years_total.basis, roles, work: f("work_lines"), achievements: f("achievement_lines"), projects: f("project_lines"), summary: f("summary_lines"), skills_listed: f("listed_lines"), education: f("education_lines"),
    intent_simulated: `${lab(a.direction_primary)}${a.direction_secondary && a.direction_secondary !== "none" ? `; also ${lab(a.direction_secondary)}` : ""} · target level ${a.level} · open to related work: ${a.open_to_adjacent}` };
  const blob = JSON.stringify(rec); const au = audit(blob, names);
  if (au.hits.length) throw new Error(`privacy audit failed for ${label}: ${au.hits.length} hit(s) (${[...new Set(au.hits.map((h) => h.kind))].join("; ")}): package not issued`);
  people.set(label, rec);
  candComplete[label] = { work_lines: rec.work.length, dated_roles: roles.filter((r: any) => r.from !== "?").length, parser_warnings: c.parser.warnings, thin: rec.work.length < 5 };
}
const cases = key.map((x) => { const r = inv.get(String(x.job_id)); if (!r) throw new Error(`job ${x.job_id} missing from the frozen inventory: stop`);
  const text = cleanJobText(htmlToText(r.description)); return { code: x.code, cand: x.candidate, title: r.title, employer: r.company_name ?? "", location: r.location ?? "", text }; });
const jobComplete = cases.map((c) => { const s = Object.fromEntries(Object.entries(SIG).map(([k, re]) => [k, re.test(c.text)])); const short = c.text.length < 600;
  const risk = short || (!s.requirements && c.text.length < 1500); return { code: c.code, chars: c.text.length, ...s, location: !!c.location, source_completeness: risk ? "unknown (thin or no requirements section)" : "ok", flag_unjudgeable_risk: risk }; });
const jobAudit = cases.reduce((n, c) => n + (/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}|(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/.test(c.text) ? 1 : 0), 0);
if (jobAudit) throw new Error(`${jobAudit} job texts still carry contact details: package not issued`);
const data = { version: VERSION, cases, people: Object.fromEntries(people) };
const dataJson = JSON.stringify(data); const dataSha = sha(dataJson).slice(0, 16);
writeFileSync(`${OUT}/review-v2b-manifest.json`, JSON.stringify({ version: VERSION, data_sha: dataSha, source_key_sha: sha(readFileSync(`${A}/review-v2-key.ORIGINAL.json`, "utf8")).slice(0, 16), cases: cases.length, candidates: people.size,
  codes: cases.map((c) => c.code), job_completeness: jobComplete, candidate_completeness: candComplete, uncertain_for_manual_review: uncertain }, null, 1));
const page = readFileSync(new URL("./review-v2b.template.html", import.meta.url), "utf8").replace("__DATA__", dataJson.replace(/</g, "\\u003c")).replace("__SHA__", dataSha).replace(/__VERSION__/g, VERSION);
writeFileSync(`${OUT}/Radar-v2-review-v2b.html`, page);
console.log(JSON.stringify({ version: VERSION, data_sha: dataSha, cases: cases.length, candidates: people.size, unjudgeable_risk: jobComplete.filter((j) => j.flag_unjudgeable_risk).length, thin_candidates: Object.values<any>(candComplete).filter((x) => x.thin).length, uncertain: uncertain.length, page_sha: sha(page).slice(0, 16) }));
