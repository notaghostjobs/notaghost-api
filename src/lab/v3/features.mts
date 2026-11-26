// V3 features for one person × job on the frozen development data (the 19 seen profiles). Thin wrapper over featcore.
const D = await import("./data.mjs"); const FC = await import("./featcore.js");
const people = new Map<string, any>();
export function personFeatures(p: string) { if (!people.has(p)) people.set(p, FC.personFrom(D.cer(p), D.intent(p)?.level)); return people.get(p); }
export function jobInfo(id: string) { const v = D.views.get(id), det = D.det.get(id); return { id, title: v?.title ?? "", employer: v?.employer ?? "", text: D.fullText.get(id) ?? (v ? v.whole_raw.slice(v.title.length + 2) : ""), det, cjr: D.cjr.get(id) }; }
export const signature = (id: string) => FC.signatureOf(jobInfo(id));
export const features = (p: string, id: string) => FC.featuresOf(personFeatures(p), jobInfo(id));
