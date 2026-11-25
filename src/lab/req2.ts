// Requirement evaluation, second version (match-req-2). The control (req.ts) is unchanged; this adds two switchable
// treatments and keeps everything else identical:
//   provenance: skill evidence comes from the layout-aware reading with per-line provenance (provenance.ts). A skill
//               only listed counts as "unknown" (0.35), a project as 0.7, work shown hands-on or led as 1, a summary
//               claim as 0.5 — instead of "anything in the experience text is demonstrated".
//   core:       the job's requirements are split into CORE (the primary stack or platform, the specialist domain
//               skill, mandatory qualifications, skills named in the title) and SUPPORTING (generic tools: SQL, cloud
//               exposure, Excel, Agile, Docker, CI/CD …). Coverage is 75% core, 25% supporting. And a CAP: when the
//               job explicitly requires a core skill the candidate shows no evidence for at all, and that is not an
//               either/or requirement ("Java or Go"), the score is multiplied by CORE_CAP. Intended effect: a role
//               whose required primary stack the candidate lacks cannot outrank, on shared generic words, a similar
//               role whose stack they have. It never removes a job.
import { cover, skillsIn } from "./skills.js";
import { evaluate as evaluate1, type Evidence, type Reqs, type Intent, type Weights, VALUE, W } from "./req.js";
import { transfer } from "../lib/ontology.js";
import { levelFit } from "../lib/career.js";

/** Generic skills that support fit but never establish it. */
export const SUPPORTING = new Set(["sql", "nosql", "aws", "azure", "gcp", "docker", "cicd", "linux", "excel", "agile", "project_mgmt", "rest", "microservices", "kafka", "html_css", "statistics", "crm_tools", "itil", "javascript_generic", "powerbi", "tableau", "looker"]);
export const CORE_CAP = 0.75;
const ANY_OF = /\b(or|any (one )?of|one of|either|such as|e\.g\.|like)\b|\//i;
const QUAL_REQ: [string, RegExp][] = [
  ["ca", /\b(ca|chartered accountant)\b[^.\n]{0,40}\b(required|mandatory|must|qualified)|\b(must be|should be) (a )?(qualified )?(ca|chartered accountant)\b|\bca\s*\/\s*cma\b/i],
  ["phd", /\bph\.?d\.?\b[^.\n]{0,60}\b(required|mandatory|must)|\b(requires|required:?|must have) (a )?ph\.?d/i],
  ["llb", /\b(qualified (lawyer|attorney)|enrolled (advocate|with the bar)|llb)\b[^.\n]{0,40}\b(required|mandatory|must)|post[- ]qualification (legal )?experience/i],
  ["cfa", /\bcfa\b[^.\n]{0,30}\b(required|mandatory|must)/i],
];

export type Ev2 = Evidence & { strength?: Map<string, number> };
export type Opts = { provenance: boolean; core: boolean };
const value = (ev: Ev2, need: string, useProv: boolean): { v: number; status: string; via: string } => {
  if (useProv && ev.strength) {
    let best = 0, via = ""; for (const [h, s] of ev.strength) { const c = cover(h, need) * s; if (c > best) { best = c; via = h; } }
    const status = best >= 0.9 ? "demonstrated" : best >= 0.5 ? "transferable" : best > 0 ? "unknown" : "unsupported";
    return { v: best >= 0.9 ? 1 : best >= 0.5 ? Math.max(0.6, best) : best > 0 ? Math.max(VALUE.unknown * 0.6, best) : 0, status, via };
  }
  let best = 0, via = ""; for (const h of ev.demonstrated) { const c = cover(h, need); if (c > best) { best = c; via = h; } }
  if (best === 1) return { v: 1, status: "demonstrated", via }; if (best >= 0.5) return { v: VALUE.transferable, status: "transferable", via };
  for (const h of ev.listed) if (cover(h, need) >= 0.5) return { v: VALUE.unknown, status: "unknown", via: h };
  return { v: 0, status: "unsupported", via: "" };
};

export function evaluate2(ev: Ev2, rq: Reqs & { title?: string; mandatoryText?: string; quals2?: string[] }, intent: Intent, rel: number, o: Opts, w: Weights = W) {
  if (!o.provenance && !o.core) return { ...evaluate1(ev, rq, intent, rel, w), capped: false, core: [] as string[] };
  const checks: any[] = [];
  const all = (m: Map<string, string>, kind: string) => [...m].map(([id, sent]) => { const x = value(ev, id, o.provenance); checks.push({ req: id, kind, status: x.status, job: sent.slice(0, 120), cand: x.via }); return { id, sent, ...x }; });
  const mand = all(rq.mandatory, "mandatory"), pref = all(rq.preferred, "preferred"), ment = all(rq.mentioned, "mentioned");
  const K = 2, PRIOR = VALUE.unknown, avg = (xs: { v: number }[], half = false) => xs.reduce((a, b) => a + b.v * (half ? 0.5 : 1), 0);
  let ess: number, capped = false; const coreIds: string[] = [];
  if (o.core) {
    const titleSkills = skillsIn(rq.title ?? "");
    const isCore = (id: string) => !SUPPORTING.has(id) || titleSkills.has(id);
    const core = [...mand.filter((x) => isCore(x.id)), ...ment.filter((x) => isCore(x.id) && titleSkills.has(x.id))];
    const sup = [...mand.filter((x) => !isCore(x.id)), ...ment.filter((x) => !(isCore(x.id) && titleSkills.has(x.id)))];
    coreIds.push(...core.map((x) => x.id));
    const coreCov = (avg(core) + K * PRIOR) / (core.length + K), supCov = (avg(sup.filter((x) => mand.includes(x))) + 0.5 * avg(sup.filter((x) => !mand.includes(x))) + K * PRIOR) / (sup.filter((x) => mand.includes(x)).length + 0.5 * sup.filter((x) => !mand.includes(x)).length + K);
    ess = 0.75 * coreCov + 0.25 * supCov;
    // the cap: an explicitly required core skill with no evidence at all, unless the requirement offers alternatives the candidate meets
    for (const x of core.filter((c) => mand.includes(c) && c.v === 0)) {
      const alts = ANY_OF.test(x.sent) ? [...skillsIn(x.sent)].filter((s) => s !== x.id) : [];
      if (alts.some((a) => value(ev, a, o.provenance).v >= 0.6)) continue;
      capped = true; checks.push({ req: `${x.id} (core, required)`, kind: "core", status: "unsupported", job: x.sent.slice(0, 120), cand: "no evidence" });
    }
    // mandatory qualification the posting states and the résumé does not show
    for (const [q, re] of QUAL_REQ) if (re.test(rq.mandatoryText ?? "") && !ev.quals.has(q === "phd" ? "phd" : q)) { capped = true; checks.push({ req: `${q} (mandatory qualification)`, kind: "qualification", status: "unknown", job: (rq.mandatoryText ?? "").match(re)?.[0] ?? q, cand: "not shown on résumé" }); }
  } else {
    const num = avg(mand) + 0.5 * avg(ment), den = mand.length + 0.5 * ment.length; ess = (num + K * PRIOR) / (den + K);
  }
  const prf = (avg(pref) + K * 0.5) / (pref.length + K);
  // the rest is the control's logic, unchanged
  const sen = levelFit(intent.level, rq.level, intent.stretch);
  let scope = 1; if (rq.manages && ev.scope < 2) scope = 0.5; else if (!rq.manages && ev.scope >= 4 && intent.level === "leader") scope = 0.6;
  if (rq.owns && !ev.owns) scope = Math.min(scope, 0.6);
  let ag = 0; for (const [k, p] of intent.want) ag += p * transfer(k, rq.spec ?? "");
  const dom = rq.domainMandatory ? (ev.domains.includes(rq.domainMandatory) ? 1 : 0.4) : 1;
  const intentScore = rq.spec ? ag : 0.5;
  let score = w.rel * rel + w.ess * ess + w.pref * prf + w.sen * sen + w.scope * scope + w.intent * intentScore + w.domain * dom;
  if (capped) score *= CORE_CAP;
  const unsupportedMand = mand.filter((x) => x.v === 0).length;
  const band = !capped && ess >= 0.75 && sen >= 1 && intentScore >= 0.8 && unsupportedMand === 0 ? "direct" : !capped && ess >= 0.5 && sen >= 0.7 && intentScore >= 0.5 ? "adjacent" : "stretch";
  return { score: Math.round(score * 1000) / 1000, band, parts: { rel, ess, prf, sen, scope, intent: intentScore, dom }, checks, unsupportedMand, nMand: mand.length, capped, core: coreIds };
}
