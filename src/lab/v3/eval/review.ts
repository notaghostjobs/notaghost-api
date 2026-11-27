// Blinded human-review packages for a fresh evaluation root (generalises lab/eval/v2/mk-review-v2b.mts).
//  - every displayed V3 strong recommendation and every Arm A (control) top-5 job is a case; a job chosen by both
//    systems for the same person is ONE case with both arms in the hidden key;
//  - false-negative audit: per candidate 4 non-displayed jobs from fixed strata (seeded, before anyone sees grades):
//    A2 judged direct/adjacent but not shown, B1 judged stretch/unsuitable/cannot judge, C1 eligible high-retrieval job
//    not shortlisted. 25% of audit cases go to the double-review package P, the rest to the single-review package Q;
//  - job text: the complete description, third-party contacts removed; candidate: the allowlisted evidence record
//    through review-redact (the build fails on any audit hit); nothing says which system proposed a job;
//  - one feedback form per candidate listing only the jobs actually displayed to them (both arms, merged, shuffled).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EvalRoot, RootError, sha256 } from "./root.js";
import { REPO, SETTINGS } from "./freeze.js";
import { jobs } from "./pipeline.js";
import { cleanLines, nameTokens, audit, cleanJobText } from "../../v2/review-redact.js";
import { SPEC } from "../../../lib/ontology.js";

export const REVIEW_VERSION = "ghosted-review-r3.1", FEEDBACK_VERSION = "ghosted-feedback-r3.1";   // neutral names: nothing a reviewer sees names a system
/** Small seeded generator (mulberry32) so the audit sample is reproducible from the root id. */
export function rng(seed: string) { let a = parseInt(sha256(seed).slice(0, 8), 16); return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const shuffle = <T,>(xs: T[], r: () => number) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = <T,>(xs: T[], n: number, r: () => number) => shuffle(xs, r).slice(0, n);

export type KeyCase = { code: string; package: "P" | "Q"; profile: string; candidate: string; job_id: string; arms: string[]; strata: string[]; desc_sha256: string };
export function buildKey(root: EvalRoot) {
  const r = rng(`${root.meta.id}|audit`); const control = root.read("control", "control.json"); const profiles = root.read("candidates", "profiles.json");
  const labels = new Map<string, string>(profiles.map((p: any, i: number) => [p.id, `Candidate ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ""}`]));
  const pairs = new Map<string, { profile: string; job_id: string; arms: Set<string>; strata: Set<string>; pkg: "P" | "Q"; sha: string }>();
  const add = (p: string, j: string, arm: string | null, stratum: string | null, pkg: "P" | "Q", sha: string) => { const k = `${p}|${j}`; const x = pairs.get(k) ?? { profile: p, job_id: j, arms: new Set(), strata: new Set(), pkg, sha };
    if (arm) x.arms.add(arm); if (stratum) x.strata.add(stratum); if (pkg === "P") x.pkg = "P"; pairs.set(k, x); };
  const audit: any = {};
  for (const p of profiles.map((x: any) => x.id)) {
    const v = root.read("v3", `${p}.json`); const tr = new Map(v.trace.map((t: any) => [t.job_id, t]));
    for (const s of v.strong) add(p, s.job_id, "v3", null, "P", (tr.get(s.job_id) as any).desc_sha256);
    for (const j of control[p].top) add(p, j, "control", null, "P", (tr.get(j) as any)?.desc_sha256 ?? "");
    const shown = new Set([...v.strong.map((s: any) => s.job_id), ...control[p].top]);
    const A = v.trace.filter((t: any) => !shown.has(t.job_id) && t.judge?.valid && ["direct", "adjacent"].includes(t.judge.fit));
    const B = v.trace.filter((t: any) => !shown.has(t.job_id) && t.judge && (t.judge.valid ? ["stretch", "unsuitable", "cannot_judge"].includes(t.judge.fit) : true));
    const C = v.trace.filter((t: any) => !shown.has(t.job_id) && t.eligible && t.stage === "not shortlisted (ranked below the cut)").sort((a: any, b: any) => (a.retrieval_rank ?? 999) - (b.retrieval_rank ?? 999)).slice(0, 20);
    const chosen = [...pick(A, 2, r).map((t: any) => ["A", t]), ...pick(B, 1, r).map((t: any) => ["B", t]), ...pick(C, 1, r).map((t: any) => ["C", t])];
    audit[p] = { available: { A: A.length, B: B.length, C: C.length }, chosen: chosen.map(([s, t]: any) => ({ stratum: s, job_id: t.job_id })) };
    for (const [s, t] of chosen as any) add(p, t.job_id, null, `audit:${s}`, r() < SETTINGS.audit_double_share ? "P" : "Q", t.desc_sha256);
  }
  const list = shuffle([...pairs.values()], r); const key: KeyCase[] = []; let nP = 0, nQ = 0;
  for (const x of list) { const code = x.pkg === "P" ? `C${String(++nP).padStart(3, "0")}` : `Q${String(++nQ).padStart(3, "0")}`;
    key.push({ code, package: x.pkg, profile: x.profile, candidate: labels.get(x.profile)!, job_id: x.job_id, arms: [...x.arms].sort(), strata: [...x.strata].sort(), desc_sha256: x.sha }); }
  key.sort((a, b) => a.code.localeCompare(b.code)); return { key, audit, labels };
}

function personRecord(root: EvalRoot, p: string, answers: any) {
  const c = root.read("candidates", "cer", `${p}.json`); const resume = readFileSync(root.read("candidates", "profiles.json").find((x: any) => x.id === p).resume, "utf8");
  const names = nameTokens(resume); const uncertain: any[] = [];
  const f = (k: string) => { const r = cleanLines(c[k] ?? [], names, k); uncertain.push(...r.uncertain.map((u) => ({ candidate: p, ...u }))); return r.value; };
  const yr = (x: any) => (x === null || x === undefined ? "?" : /^\d{4}(\.\d+)?$/.test(String(x)) ? String(Math.floor(Number(x))) : String(x).slice(0, 12));
  const a = answers[p]; const lab = (k: string) => (SPEC.get(k) as any)?.label ?? k;
  const rec = { years: c.years_total.value, years_basis: c.years_total.basis, roles: c.roles.map((r: any) => ({ title: cleanLines([r.title || ""], names, "role").value[0] ?? "(title removed)", from: yr(r.from), to: yr(r.to) })),
    work: f("work_lines"), achievements: f("achievement_lines"), projects: f("project_lines"), summary: f("summary_lines"), skills_listed: f("listed_lines"), education: f("education_lines"),
    intent_candidate: `${lab(a.direction_primary)}${a.direction_secondary && a.direction_secondary !== "none" ? `; also ${lab(a.direction_secondary)}` : ""} · target level ${a.level} · related roles: ${a.adjacent_answer} · step up: ${a.stretch} · work mode: ${(a.work_modes ?? []).join("/")}${(a.deal_breakers ?? []).length ? ` · rules out: ${a.deal_breakers.join(", ")}` : ""}` };
  const au = audit(JSON.stringify(rec), names); if (au.hits.length) throw new RootError(`privacy audit failed for ${p}: ${au.hits.length} hit(s); package not issued`);
  return { rec, uncertain };
}
/** Build packages P (two reviewers) and Q (one reviewer), the hidden key, and one feedback form per candidate. */
export function reviewStage(root: EvalRoot) {
  const { key, audit: auditPlan, labels } = buildKey(root); const answers = root.read("intent", "answers.json"); const J = jobs(root);
  const people: any = {}; const uncertain: any[] = []; for (const [p, l] of labels) { const x = personRecord(root, p, answers); people[l] = x.rec; uncertain.push(...x.uncertain); }
  const caseOf = (k: KeyCase) => { const v: any = J.views.get(k.job_id), raw: any = J.raw.get(k.job_id); const text = cleanJobText(J.full(k.job_id));
    if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(text)) throw new RootError(`job ${k.job_id} still carries contact details`);
    return { code: k.code, cand: k.candidate, title: v?.title ?? raw?.title ?? "", employer: raw?.company_name ?? v?.employer ?? "", location: raw?.location ?? "", text }; };
  const tpl = readFileSync(join(REPO, "lab/eval/v3/review-v3.template.html"), "utf8"); const out: any = { version: REVIEW_VERSION, packages: {} };
  for (const pkg of ["P", "Q"] as const) {
    const ks = key.filter((k) => k.package === pkg); if (!ks.length) continue;
    const usedPeople = Object.fromEntries([...new Set(ks.map((k) => k.candidate))].map((l) => [l, people[l]]));
    const data = { version: `${REVIEW_VERSION}-${pkg}`, cases: ks.map(caseOf), people: usedPeople }; const dataJson = JSON.stringify(data); const dataSha = sha256(dataJson).slice(0, 16);
    for (const w of [/"arms"/, /"v3"/, /"control"/, /"strata"/, /audit:/, /"job_id"/, /"profile"/]) if (w.test(dataJson)) throw new RootError(`package ${pkg} leaks system information (${w.source})`);
    const page = tpl.replace("__DATA__", dataJson.replace(/</g, "\\u003c")).replace("__SHA__", dataSha).replace(/__VERSION__/g, data.version);
    const file = root.write(`review/Radar-review-${root.meta.population}-${pkg}.html`, page);
    out.packages[pkg] = { file: file.replace(root.dir + "/", ""), version: data.version, data_sha: dataSha, page_sha256: sha256(page), cases: ks.length, reviewers: pkg === "P" ? 2 : 1, codes: ks.map((k) => k.code) };
    root.write(`review/manifest-${pkg}.json`, { version: data.version, data_sha: dataSha, codes: ks.map((k) => k.code), cases: ks.length });
  }
  root.write("review/key.HIDDEN.json", key); root.write("review/audit-plan.json", auditPlan); root.write("review/uncertain-for-manual-review.json", uncertain);
  // feedback forms: the person's own displayed jobs, both arms merged and shuffled, same case codes
  const ftpl = readFileSync(join(REPO, "lab/eval/v3/feedback.template.html"), "utf8"); const r = rng(`${root.meta.id}|feedback`); out.feedback = {};
  for (const [p, l] of labels) { const ks = shuffle(key.filter((k) => k.profile === p && k.arms.length), r); const data = { candidate: p, jobs: ks.map((k) => { const c = caseOf(k); return { code: c.code, title: c.title, employer: c.employer, location: c.location, text: c.text }; }) };
    const dj = JSON.stringify(data); const ds = sha256(dj).slice(0, 16); if (/"arms"|"v3"|"control"/.test(dj)) throw new RootError("feedback form leaks system information");
    root.write(`review/feedback-${p}.html`, ftpl.replace("__DATA__", dj.replace(/</g, "\\u003c")).replace("__SHA__", ds).replace(/__VERSION__/g, FEEDBACK_VERSION)); out.feedback[p] = { data_sha: ds, jobs: ks.length, label: l }; }
  const counts = { cases_total: key.length, displayed_cases: key.filter((k) => k.arms.length).length, v3_only_cases: key.filter((k) => k.arms.length === 1 && k.arms[0] === "v3").length, control_only_cases: key.filter((k) => k.arms.length === 1 && k.arms[0] === "control").length,
    // shown-by totals count an overlap case in both arms: v3_shown + control_shown − overlap = displayed_cases
    v3_shown: key.filter((k) => k.arms.includes("v3")).length, control_shown: key.filter((k) => k.arms.includes("control")).length,
    overlap_cases: key.filter((k) => k.arms.length === 2).length, audit_cases: key.filter((k) => !k.arms.length).length, P: key.filter((k) => k.package === "P").length, Q: key.filter((k) => k.package === "Q").length,
    reviewer_judgements: 2 * key.filter((k) => k.package === "P").length + key.filter((k) => k.package === "Q").length };
  out.counts = counts; root.write("review/review-manifest.json", out); root.log("review", counts); return out;
}
export const keyCodes = (root: EvalRoot) => readdirSync(root.p("review")).filter((f) => f.startsWith("manifest-"));
