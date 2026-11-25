// Job Intelligence Record (JIR): one posting turned into a versioned, evidence-carrying record. Offline lab code: not
// wired to any route, never writes to the database. Two producers fill the same shape:
//   "det-v2": deterministic (tagger2 + the posting's own sections), made here, ₹0;
//   "ai-*":   a model reading the posting under a strict schema (the pilot), parsed by fromModel().
// Every field that matters says where it came from: "stated" (the posting says it, with the words), "inferred" (a
// reasonable reading, with the words it rests on), or "unknown".
import { createHash } from "node:crypto";
import { jobText, tagPosting2 } from "../lib/tagger2.js";
import { SPEC } from "../lib/ontology.js";
import type { Level } from "../lib/usmatch.js";

export const JIR_SCHEMA = "jir-1";
export type Basis = "stated" | "inferred" | "unknown";
export type Grounded<T> = { value: T | null; basis: Basis; evidence: string[] };
export type JIR = {
  schema: typeof JIR_SCHEMA; producer: string; made_at: string;
  posting: { id: string; source: string | null; employer: string; title: string; location: string | null; text_sha256: string };
  function: Grounded<string[]>;            // canonical function ids; more than one when genuinely warranted
  specialisation: Grounded<string[]>;      // ontology ids, best first
  archetype: Grounded<string>;             // a short plain name of the role ("retail loan operations executive")
  responsibilities: Grounded<string[]>;    // what the person will do, as written
  capabilities_essential: Grounded<string[]>;
  capabilities_preferred: Grounded<string[]>;
  years_min: Grounded<number>;
  seniority: Grounded<Level>;
  manages_people: Grounded<boolean>;
  domain: Grounded<string[]>;
  work_arrangement: Grounded<string>;      // onsite / hybrid / remote, when stated
  qualifications: Grounded<string[]>;      // degrees, certifications, licences
  mandatory_constraints: Grounded<string[]>; // e.g. "must be CA qualified", "Kannada required", "night shift"
  adjacent_backgrounds: Grounded<string[]>;  // only when the posting itself says so ("or similar experience in …")
  confidence: number;                       // 0–1, the producer's own
  unknowns: string[];
  text: { duties: string; requirements: string; other: string };   // the posting's own words, sorted, for retrieval
};

const g = <T>(value: T | null, basis: Basis, evidence: string[] = []): Grounded<T> => ({ value, basis: value === null ? "unknown" : basis, evidence: evidence.slice(0, 3).map((e) => e.slice(0, 200)) });
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ARR = /\b(remote|work from home|wfh|hybrid|on-?site|work from office|wfo)\b/i;
const QUAL = /\b(b\.?\s?tech|b\.?e\.?|bachelor'?s?|master'?s?|m\.?\s?tech|mba|pgdm|ca\b|chartered accountant|cfa|cpa|acca|frm|pmp|ccna|ccnp|cissp|aws certified|phd|diploma|b\.?com|m\.?com|llb|mbbs|bsc nursing)\b[^.\n]{0,80}/gi;
const MUSTC = /\b(must (be|have|hold|speak|know)|mandatory|required to|only (candidates|applicants)|night shift|rotational shift|willing(ness)? to (travel|relocate)|immediate joiner|notice period)\b[^.\n]{0,100}/gi;
const ADJ = /\b(or (similar|equivalent|related) (experience|background|field)|background in [^.\n]{3,60} (or|and) [^.\n]{3,60})/gi;

/** The deterministic record: ₹0, ~7 ms a posting. */
export function detJIR(p: { id: string | number; source?: string | null; employer: string; title: string; location?: string | null; text: string }): JIR {
  const t = tagPosting2(p.title, p.text), jt = jobText(p.text);
  const duties = jt.duties.split("\n").filter(Boolean), reqs = jt.reqs.split("\n").filter(Boolean);
  const quals = [...new Set([...p.text.matchAll(QUAL)].map((m) => m[0].trim()))].slice(0, 5), musts = [...new Set([...p.text.matchAll(MUSTC)].map((m) => m[0].trim()))].slice(0, 5);
  const adj = [...p.text.matchAll(ADJ)].map((m) => m[0].trim()).slice(0, 3), arr = p.text.match(ARR)?.[0] ?? null;
  const spec = t.spec ? [t.spec, ...t.alt.filter((a) => a.s >= 0.8 * (t.alt[0]?.s ?? 0) && a.s > 2).map((a) => a.spec)].slice(0, 2) : null;
  const unknowns = [!t.spec && "specialisation", t.yearsMin === null && "years_min", !arr && "work_arrangement"].filter(Boolean) as string[];
  return {
    schema: JIR_SCHEMA, producer: "det-v2", made_at: new Date().toISOString(),
    posting: { id: String(p.id), source: p.source ?? null, employer: p.employer, title: p.title, location: p.location ?? null, text_sha256: sha(p.text) },
    function: g(spec ? [...new Set(spec.map((s) => SPEC.get(s)!.fn))] : null, "inferred", [t.why]),
    specialisation: g(spec, "inferred", [t.why]),
    archetype: g(t.spec ? SPEC.get(t.spec)!.label : null, "inferred"),
    responsibilities: g(duties.length ? duties.slice(0, 12) : null, "stated", duties.slice(0, 2)),
    capabilities_essential: g(reqs.length ? reqs.slice(0, 12) : null, "stated", reqs.slice(0, 2)),
    capabilities_preferred: g<string[]>(null, "unknown"),
    years_min: g(t.yearsMin, "stated"),
    seniority: g(t.level, t.levelWhy.startsWith("nothing") ? "inferred" : "inferred", [t.levelWhy]),
    manages_people: g(t.manages, "inferred"),
    domain: g(t.fields.length ? t.fields : null, "inferred"),
    work_arrangement: g(arr, "stated", arr ? [arr] : []),
    qualifications: g(quals.length ? quals : null, "stated", quals),
    mandatory_constraints: g(musts.length ? musts : null, "stated", musts),
    adjacent_backgrounds: g(adj.length ? adj : null, "stated", adj),
    confidence: t.conf, unknowns,
    text: { duties: jt.duties.slice(0, 4000), requirements: jt.reqs.slice(0, 4000), other: jt.other.slice(0, 2000) },
  };
}

/** The views a retriever embeds or indexes, from any producer's record. Company introductions and HR text never enter. */
export function views(j: JIR): { whole: string; resp: string; skills: string; domain: string } {
  const resp = [j.archetype.value, ...(j.responsibilities.value ?? [])].filter(Boolean).join(". ");
  const skills = [...(j.capabilities_essential.value ?? []), ...(j.capabilities_preferred.value ?? []), ...(j.qualifications.value ?? [])].join(". ");
  const domain = [j.posting.employer, ...(j.domain.value ?? []), j.archetype.value].filter(Boolean).join(". ");
  return { whole: `${j.posting.title}. ${resp}. ${skills}`.slice(0, 3000), resp: resp.slice(0, 2000) || j.posting.title, skills: skills.slice(0, 2000) || j.posting.title, domain };
}
