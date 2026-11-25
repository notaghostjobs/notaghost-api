// Requirement-level suitability, offline lab code. After broad retrieval, each candidate–job pair is judged on the
// job's own requirements: each material requirement is "demonstrated", "transferable", "unknown", "unsupported" or
// "contradicted", with the words on both sides kept. The score is a transparent weighted sum; nothing here removes a job
// from consideration except the eligibility rules that already exist (explicit city, language, years far outside).
import { skillsIn, cover, SKILLS } from "./skills.js";
import { fieldsOf, transfer } from "../lib/ontology.js";
import { levelFit } from "../lib/career.js";
import type { Level } from "../lib/usmatch.js";

// ── the candidate's evidence ─────────────────────────────────────────────────────────────────────────────────────────
export type Evidence = { demonstrated: Set<string>; listed: Set<string>; scope: number; scopeWhy: string; owns: boolean; ownsWhy: string; domains: string[]; quals: Set<string> };
const SCOPE: [RegExp, number, string][] = [
  [/\b(head of|director|vice president|vp\b|business head|regional (business|credit) head|country manager|general manager)\b/i, 4, "heads a function or business"],
  [/\b(managed|manage|managing|led|leading|lead) (a )?(team|teams) of (\d{2,}|[2-9]\d*)|\bmanager of managers|team leads? reporting\b/i, 3, "manages a team"],
  [/\b(managed|managing|led|leading|mentored|supervised) (a )?(team|teams|\d+ (engineers|people|members|analysts|executives))\b|\bpeople manager\b|\bdirect reports\b/i, 2.5, "leads people"],
  [/\b(tech(nical)? lead|team lead|lead engineer|lead developer)\b/i, 2, "technical or team lead"],
];
const OWNS = /\b(own(ed|s|ing)? (the )?(p&l|revenue|business|portfolio|category|product)|p&l (ownership|responsibility)|revenue (target|responsibility) of|responsible for (revenue|p&l|gmv)|business head|category head)\b/i;
const QUALS: [string, RegExp][] = [["ca", /\bchartered accountant|\bca\b(?= ?(\(|final|qualified|inter))/i], ["cfa", /\bcfa\b/i], ["frm", /\bfrm\b/i], ["cpa", /\bcpa\b/i], ["acca", /\bacca\b/i], ["pmp", /\bpmp\b/i], ["mba", /\bmba\b|\bpgdm\b/i], ["llb", /\bllb\b|\bll\.b\b/i], ["mbbs", /\bmbbs\b/i], ["nursing", /\b(b\.?sc\.? nursing|gnm)\b/i], ["engineering_degree", /\bb\.?\s?tech|\bb\.?e\.?\b|bachelor of engineering|m\.?\s?tech/i]];
export function evidence(experience: string, skillsText: string, resume: string): Evidence {
  const demonstrated = skillsIn(experience); const listed = new Set([...skillsIn(skillsText)].filter((s) => !demonstrated.has(s)));
  let scope = 1, scopeWhy = "individual contributor"; for (const [re, r, why] of SCOPE) if (re.test(resume) && r > scope) { scope = r; scopeWhy = why; }
  const o = resume.match(OWNS); const quals = new Set(QUALS.filter(([, re]) => re.test(resume)).map(([q]) => q));
  return { demonstrated, listed, scope, scopeWhy, owns: !!o, ownsWhy: o?.[0] ?? "", domains: fieldsOf(resume).slice(0, 3).map((f) => f.id), quals };
}

// ── the job's requirements ───────────────────────────────────────────────────────────────────────────────────────────
export type Reqs = { mandatory: Map<string, string>; preferred: Map<string, string>; mentioned: Map<string, string>; level: Level; manages: boolean; owns: boolean; domainMandatory: string | null; quals: string[]; spec: string | null; source: "det" | "ai" };
const MUSTY = /\b(must|required|requirement|mandatory|essential|strong|proficien|hands[- ]on|expert|solid|deep|in[- ]depth|minimum|at least|\d+\+? ?(years|yrs)|experience (in|with)|expertise)\b/i;
const NICE = /\b(prefer|nice to have|a plus|plus\b|good to have|bonus|desirable|added advantage|familiarity|exposure to|optional)\b/i;
const SKILL_LINE = /(must[- ]have skills?|mandatory skills?|primary skills?|skill required|skills? required|key skills?)\s*[:\-–]\s*([^\n]{3,200})/i;
const DOMAIN_REQ: [string, RegExp][] = [
  ["bfsi", /\b(experience|background|exposure) (in|with|from) (the )?(banking|bfsi|financial services|lending|nbfc|capital markets|insurance|payments|fintech)[^.\n]{0,40}\b(required|must|mandatory|essential|preferred)?/i],
  ["health", /\b(experience|background) (in|with|from) (the )?(healthcare|pharma|clinical|life sciences|hospital)/i],
  ["retail", /\b(experience|background) (in|with|from) (the )?(retail|e-?commerce|fmcg|cpg|quick commerce)/i],
  ["semi", /\b(experience|background) (in|with|from) (the )?(semiconductor|silicon|vlsi|asic)/i],
  ["auto", /\b(experience|background) (in|with|from) (the )?(automotive|ev\b|vehicles)/i],
];
const firstMatch = (sent: string, id: string) => sent.slice(0, 160);
function addAll(m: Map<string, string>, text: string) { for (const id of skillsIn(text)) if (!m.has(id)) m.set(id, firstMatch(text, id)); }
export function reqsFromDet(j: any): Reqs {
  const mandatory = new Map<string, string>(), preferred = new Map<string, string>(), mentioned = new Map<string, string>();
  const req = (j.text.requirements as string).split("\n").filter(Boolean), duties = (j.text.duties as string).split("\n").filter(Boolean);
  const all = [...req, ...duties].join("\n"); const line = all.match(SKILL_LINE)?.[2]; if (line) addAll(mandatory, line);
  for (const s of req) { if (NICE.test(s)) addAll(preferred, s); else if (MUSTY.test(s)) addAll(mandatory, s); else addAll(mentioned, s); }
  for (const s of duties) addAll(mentioned, s);
  for (const k of mandatory.keys()) { preferred.delete(k); mentioned.delete(k); } for (const k of preferred.keys()) mentioned.delete(k);
  const dm = DOMAIN_REQ.find(([, re]) => re.test(all)); const text = all;
  return { mandatory, preferred, mentioned, level: j.seniority.value ?? "mid", manages: !!j.manages_people.value, owns: OWNS.test(text), domainMandatory: dm && /required|must|mandatory|essential/i.test(text.match(dm[1])?.[0] ?? "") ? dm[0] : null, quals: (j.qualifications.value ?? []).map(String), spec: j.specialisation.value?.[0] ?? null, source: "det" };
}
export function reqsFromAI(r: any, det: any): Reqs {
  const mandatory = new Map<string, string>(), preferred = new Map<string, string>(), mentioned = new Map<string, string>();
  for (const e of r.essential ?? []) addAll(mandatory, `${e.skill} ${e.quote ?? ""}`);
  for (const e of r.preferred ?? []) addAll(preferred, `${e.skill} ${e.quote ?? ""}`);
  for (const e of r.responsibilities ?? []) addAll(mentioned, `${e.text} ${e.quote ?? ""}`);
  for (const k of mandatory.keys()) { preferred.delete(k); mentioned.delete(k); } for (const k of preferred.keys()) mentioned.delete(k);
  const constraints = [...(r.mandatory_constraints ?? []), ...(r.qualifications ?? [])].map((x: any) => `${x.text} ${x.quote ?? ""}`).join(" ");
  const dm = DOMAIN_REQ.find(([, re]) => re.test(constraints));
  const lv = ["intern", "entry", "mid", "senior", "leader"].includes(r.seniority?.value) ? r.seniority.value : det.seniority.value ?? "mid";
  return { mandatory, preferred, mentioned, level: lv, manages: r.manages_people?.value === true, owns: OWNS.test((r.responsibilities ?? []).map((x: any) => x.text + " " + (x.quote ?? "")).join(" ")), domainMandatory: dm ? dm[0] : null, quals: (r.qualifications ?? []).map((x: any) => x.text), spec: (r.specialisation ?? [])[0] ?? null, source: "ai" };
}

// ── the evaluation ───────────────────────────────────────────────────────────────────────────────────────────────────
export type Status = "demonstrated" | "transferable" | "unknown" | "unsupported" | "contradicted";
export type Check = { req: string; kind: "skill" | "level" | "scope" | "ownership" | "domain" | "intent"; status: Status; job: string; cand: string };
export const VALUE: Record<Status, number> = { demonstrated: 1, transferable: 0.6, unknown: 0.35, unsupported: 0, contradicted: 0 };
function skillStatus(need: string, ev: Evidence): { s: Status; via: string } {
  let best = 0, via = ""; for (const h of ev.demonstrated) { const c = cover(h, need); if (c > best) { best = c; via = h; } }
  if (best === 1) return { s: "demonstrated", via: `${via} in work history` };
  if (best >= 0.5) return { s: "transferable", via: `${via} in work history` };
  for (const h of ev.listed) if (cover(h, need) >= 0.5) return { s: "unknown", via: `${h} listed in skills only` };
  return { s: "unsupported", via: "not in résumé" };
}
export type Intent = { want: [string, number][]; level: Level; years: number; domain: string | null; stretch: boolean };
export type Weights = { rel: number; ess: number; pref: number; sen: number; scope: number; intent: number; domain: number };
export const W: Weights = { rel: 0.25, ess: 0.3, pref: 0.05, sen: 0.15, scope: 0.05, intent: 0.15, domain: 0.05 };   // set before any result was seen
export function evaluate(ev: Evidence, rq: Reqs, intent: Intent, rel: number, w: Weights = W) {
  const checks: Check[] = [];
  const val = (m: Map<string, string>) => { const xs: number[] = []; for (const [id, sent] of m) { const st = skillStatus(id, ev); xs.push(VALUE[st.s]); checks.push({ req: id, kind: "skill", status: st.s, job: sent.slice(0, 120), cand: st.via }); } return xs; };
  const mand = val(rq.mandatory); const pref = val(rq.preferred); const ment = val(rq.mentioned);
  // coverage of what the job asks, with the duties' skills at half weight, shrunk toward "unknown" when the posting
  // names few skills: one matched word is not evidence of fit (a posting that names nothing is neither)
  const K = 2, PRIOR = VALUE.unknown;
  const num = mand.reduce((a, b) => a + b, 0) + 0.5 * ment.reduce((a, b) => a + b, 0), den = mand.length + 0.5 * ment.length;
  const ess = (num + K * PRIOR) / (den + K), prf = (pref.reduce((a, b) => a + b, 0) + K * 0.5) / (pref.length + K);
  const sen = levelFit(intent.level, rq.level, intent.stretch); checks.push({ req: `level ${rq.level}`, kind: "level", status: sen >= 1 ? "demonstrated" : sen >= 0.7 ? "transferable" : sen > 0 ? "unsupported" : "contradicted", job: rq.level, cand: `targets ${intent.level}` });
  let scope = 1; if (rq.manages && ev.scope < 2) { scope = 0.5; checks.push({ req: "people management", kind: "scope", status: "unknown", job: "manages people", cand: ev.scopeWhy }); }
  else if (!rq.manages && ev.scope >= 4 && intent.level === "leader") { scope = 0.6; checks.push({ req: "hands-on role", kind: "scope", status: "transferable", job: "individual contributor", cand: ev.scopeWhy }); }
  if (rq.owns && !ev.owns) { scope = Math.min(scope, 0.6); checks.push({ req: "ownership of revenue or P&L", kind: "ownership", status: "unknown", job: "owns revenue/P&L", cand: "résumé shows no ownership" }); }
  let ag = 0; for (const [k, p] of intent.want) ag += p * transfer(k, rq.spec ?? ""); checks.push({ req: "direction", kind: "intent", status: ag >= 0.8 ? "demonstrated" : ag >= 0.5 ? "transferable" : "unsupported", job: rq.spec ?? "unclassified", cand: intent.want.map((x) => x[0]).join(", ") });
  let dom = 1; if (rq.domainMandatory) { dom = ev.domains.includes(rq.domainMandatory) ? 1 : 0.4; checks.push({ req: `domain ${rq.domainMandatory}`, kind: "domain", status: dom === 1 ? "demonstrated" : "unsupported", job: "domain experience required", cand: ev.domains.join(", ") || "none read" }); }
  const intentScore = rq.spec ? ag : 0.5;   // an unclassified posting is not penalised for its missing class
  const score = w.rel * rel + w.ess * ess + w.pref * prf + w.sen * sen + w.scope * scope + w.intent * intentScore + w.domain * dom;
  const unsupportedMand = checks.filter((c) => c.kind === "skill" && rq.mandatory.has(c.req) && c.status === "unsupported").length;
  const band = ess >= 0.75 && sen >= 1 && intentScore >= 0.8 && unsupportedMand === 0 ? "direct" : ess >= 0.5 && sen >= 0.7 && intentScore >= 0.5 ? "adjacent" : "stretch";
  return { score: Math.round(score * 1000) / 1000, band, parts: { rel, ess, prf, sen, scope, intent: intentScore, dom }, checks, unsupportedMand, nMand: mand.length };
}
/** A short explanation from the checks only: what aligns, what is unclear, the main gaps. */
export function explain(e: ReturnType<typeof evaluate>): string {
  const d = e.checks.filter((c) => c.kind === "skill" && c.status === "demonstrated").map((c) => c.req), t = e.checks.filter((c) => c.status === "transferable").map((c) => c.req);
  const u = e.checks.filter((c) => c.status === "unknown").map((c) => c.req), g = e.checks.filter((c) => c.status === "unsupported" || c.status === "contradicted").map((c) => c.req);
  return [`${e.band} fit`, d.length && `shown: ${d.slice(0, 5).join(", ")}`, t.length && `transferable: ${t.slice(0, 3).join(", ")}`, u.length && `unclear: ${u.slice(0, 3).join(", ")}`, g.length && `gaps: ${g.slice(0, 3).join(", ")}`].filter(Boolean).join("; ");
}
export { SKILLS };
