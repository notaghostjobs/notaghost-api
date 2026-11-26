// V3 features for one person × job, from frozen inputs only (CER, CJR cache, deterministic job record, posting text).
const D = await import("./data.mjs"); const SC = await import("./scope.js"); const AN = await import("./anchors.js");
const scopeCache = new Map<string, any>(), anchorCache = new Map<string, any>();
export function personFeatures(p: string) {
  if (!scopeCache.has(p)) { const c = D.cer(p); scopeCache.set(p, { c, scope: SC.candidateScope(c, D.intent(p)?.level), anchors: AN.candidateAnchors(c) }); }
  return scopeCache.get(p);
}
export function jobInfo(id: string) { const v = D.views.get(id), det = D.det.get(id); return { id, title: v?.title ?? "", employer: v?.employer ?? "", text: v ? v.whole_raw.slice(v.title.length + 2) : "", det, cjr: D.cjr.get(id) }; }
export function features(p: string, id: string) {
  const P = personFeatures(p); const j = jobInfo(id); const js = SC.jobScope(j); const compat = SC.compat(P.scope, js);
  if (!anchorCache.has(id)) anchorCache.set(id, AN.jobAnchors(j)); const ja = anchorCache.get(id); const anchors = AN.checkAnchors(ja, P.anchors);
  return { job: j, jobScope: js, compat, anchors, person: P };
}
