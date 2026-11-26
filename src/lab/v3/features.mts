// V3 features for one person × job, from frozen inputs only (CER, CJR cache, deterministic job record, posting text).
const D = await import("./data.mjs"); const SC = await import("./scope.js"); const AN = await import("./anchors.js");
const scopeCache = new Map<string, any>(), anchorCache = new Map<string, any>();
export function personFeatures(p: string) {
  if (!scopeCache.has(p)) { const c = D.cer(p); scopeCache.set(p, { c, scope: SC.candidateScope(c, D.intent(p)?.level), anchors: AN.candidateAnchors(c) }); }
  return scopeCache.get(p);
}
export function jobInfo(id: string) { const v = D.views.get(id), det = D.det.get(id); return { id, title: v?.title ?? "", employer: v?.employer ?? "", text: D.fullText.get(id) ?? (v ? v.whole_raw.slice(v.title.length + 2) : ""), det, cjr: D.cjr.get(id) }; }
const { skillsIn } = await import("../skills.js"); const { GENERIC, TOOL_FAMILY_IDS } = await import("../v2/terms.js"); const SLm = await import("./shortlist.js"); const { descSha } = await import("./jobtext.js");
const CITY = /\b(bengaluru|bangalore|mumbai|pune|hyderabad|chennai|delhi|gurgaon|gurugram|noida|kolkata|remote)\b/i;
/** Requirement signature used to decide whether two same-title postings may share one judgement. */
export function signature(id: string) {
  const j = jobInfo(id); const js = SC.jobScope(j); const ja = AN.jobAnchors(j); const req = `${j.det?.text?.requirements ?? ""}\n${(j.det?.capabilities_essential?.value ?? []).join("\n")}\n${j.text}`;
  const city = (CITY.exec(String(j.det?.posting?.location ?? "")) ?? CITY.exec(j.text.slice(0, 1500)) ?? ["unstated"])[0].toLowerCase().replace("bangalore", "bengaluru");
  const tools = [...skillsIn(req)].filter((s: string) => TOOL_FAMILY_IDS.has(s) && !GENERIC.has(s)).sort();
  const unit = [...(j.det?.function?.value ?? []), ...(j.det?.domain?.value ?? [])].map(String).sort().join(",");
  return { sig: { yearsBand: SLm.yearsBand(js.yearsMin), city, employment: SLm.EMPLOYMENT(`${j.title}\n${j.text.slice(0, 3000)}`), manages: js.managesPeople, anchors: ja.defining.map((d: any) => d.id).sort().join(","), unit, tools }, reqHash: descSha(j.text) };
}
export function features(p: string, id: string) {
  const P = personFeatures(p); const j = jobInfo(id); const js = SC.jobScope(j); const compat = SC.compat(P.scope, js);
  if (!anchorCache.has(id)) anchorCache.set(id, AN.jobAnchors(j)); const ja = anchorCache.get(id); const anchors = AN.checkAnchors(ja, P.anchors);
  return { job: j, jobScope: js, compat, anchors, person: P };
}
