// V3 features as pure functions of explicit inputs. Used by the development replay (features.mts, frozen dev data)
// and by the fresh evaluation (eval/), so both compute exactly the same thing from whatever data root they are given.
import * as SC from "./scope.js"; import * as AN from "./anchors.js"; import * as SL from "./shortlist.js";
import { descSha } from "./jobtext.js"; import { skillsIn } from "../skills.js"; import { GENERIC, TOOL_FAMILY_IDS } from "../v2/terms.js";
export type JobIn = { id: string; title: string; employer: string; text: string; det?: any; cjr?: any };
export const personFrom = (cer: any, statedLevel: string | null | undefined) => ({ c: cer, scope: SC.candidateScope(cer, statedLevel), anchors: AN.candidateAnchors(cer) });
const CITY = /\b(bengaluru|bangalore|mumbai|pune|hyderabad|chennai|delhi|gurgaon|gurugram|noida|kolkata|remote)\b/i;
/** Requirement signature used to decide whether two same-title postings may share one judgement. */
export function signatureOf(j: JobIn) {
  const js = SC.jobScope(j); const ja = AN.jobAnchors(j); const req = `${j.det?.text?.requirements ?? ""}\n${(j.det?.capabilities_essential?.value ?? []).join("\n")}\n${j.text}`;
  const city = (CITY.exec(String(j.det?.posting?.location ?? "")) ?? CITY.exec(j.text.slice(0, 1500)) ?? ["unstated"])[0].toLowerCase().replace("bangalore", "bengaluru");
  const tools = [...skillsIn(req)].filter((s: string) => TOOL_FAMILY_IDS.has(s) && !GENERIC.has(s)).sort();
  const unit = [...(j.det?.function?.value ?? []), ...(j.det?.domain?.value ?? [])].map(String).sort().join(",");
  return { sig: { yearsBand: SL.yearsBand(js.yearsMin), city, employment: SL.EMPLOYMENT(`${j.title}\n${j.text.slice(0, 3000)}`), manages: js.managesPeople, anchors: ja.defining.map((d) => d.id).sort().join(","), unit, tools }, reqHash: descSha(j.text) };
}
export function featuresOf(P: ReturnType<typeof personFrom>, j: JobIn) {
  const js = SC.jobScope(j); const compat = SC.compat(P.scope, js); const anchors = AN.checkAnchors(AN.jobAnchors(j), P.anchors);
  return { job: j, jobScope: js, compat, anchors, person: P };
}
/** Supporting-skill coverage for the shortlist score (generic terms weigh a quarter; listed skills 0.3). */
export function coverOf(cer: any, reqText: string) { const have = new Map(cer.skills.map((s: any) => [s.id, s.basis])); let num = 0, den = 0;
  for (const s of skillsIn(reqText)) { const w = GENERIC.has(s) ? 0.25 : 1; den += w; const b = have.get(s); num += w * (b === "work" || b === "achievement" ? 1 : b === "project" ? 0.7 : b ? 0.3 : 0); } return den ? num / den : 0.5; }
