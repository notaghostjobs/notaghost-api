// Matching v2: cached job requirements (CJR). One model extraction per posting version, reused by every candidate.
// Key: job id + sha256 of the full description + schema version + extractor version. Output that is malformed, or
// whose quotes are not in the posting, is rejected (no requirement is manufactured).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

export const CJR_SCHEMA = "cjr/1", EXTRACTOR_VERSION = "x1";
export type Req = { text: string; quote: string; kind: "tool" | "credential" | "domain" | "responsibility" | "experience" | "other"; alternatives?: string[] };
export type CJR = {
  schema: typeof CJR_SCHEMA; extractor: string; job_id: string; desc_sha256: string; model: string;
  function: string; specialisation: string; responsibilities: string[];
  mandatory: Req[]; secondary: Req[]; preferred: Req[];
  years: { min: number | null; max: number | null; quote: string | null };
  seniority: "entry" | "junior" | "mid" | "senior" | "lead" | "head" | "executive" | "unknown"; manages_people: boolean | null;
  location: { city: string | null; work_mode: "onsite" | "hybrid" | "remote" | "unknown"; quote: string | null };
  credentials: Req[]; usable: boolean; usable_reason: string | null;
};
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const norm = (s: string) => s.normalize("NFKC").replace(/[•●▪◦‣∙·]/g, " ").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
/** A quote is verified when, normalised, it is a substring of the source (at least 8 characters). */
export function quoted(q: string | null | undefined, source: string): boolean { if (!q) return false; const n = norm(q); return n.length >= 8 && norm(source).includes(n); }

export const EXTRACT_SYSTEM = `You extract a job posting's requirements into JSON for a matching system. Rules:
- Read the WHOLE posting. Use only what it says. Never infer or add a requirement it does not state.
- Every requirement carries "quote": an exact, contiguous excerpt (8-200 characters) copied from the posting that states it. No paraphrase in "quote".
- mandatory = stated as required/must/minimum/essential, or the role's defining core work. secondary = important but not stated as required. preferred = "nice to have", "plus", "preferred".
- alternatives: only when the posting itself allows them ("CA or CMA", "Java/Kotlin").
- function: the actual day-to-day job function (e.g. "SAP ABAP development", "loan operations", "credit underwriting", "backend engineering"). specialisation: the narrower craft or stack.
- years: numbers only if stated, with the quote; otherwise null.
- seniority from the title and stated scope; "unknown" if not clear. manages_people: true only if the posting says the role manages people.
- If the text has no real job content (a careers shell, login text, a truncated page), set usable=false with a reason and leave lists empty.
Reply with JSON only, matching this shape:
{"function":"","specialisation":"","responsibilities":[""],"mandatory":[{"text":"","quote":"","kind":"tool|credential|domain|responsibility|experience|other","alternatives":[]}],"secondary":[],"preferred":[],"years":{"min":null,"max":null,"quote":null},"seniority":"unknown","manages_people":null,"location":{"city":null,"work_mode":"unknown","quote":null},"credentials":[],"usable":true,"usable_reason":null}`;
export const extractUser = (title: string, company: string, text: string) => `TITLE: ${title}\nCOMPANY: ${company}\nPOSTING:\n${text}`;

const SEN = new Set(["entry", "junior", "mid", "senior", "lead", "head", "executive", "unknown"]), KIND = new Set(["tool", "credential", "domain", "responsibility", "experience", "other"]);
/** Validate model output against the schema and the posting. Returns the record or the reasons it was rejected. */
export function validateCJR(raw: unknown, job: { id: string; text: string; title: string }, model: string): { ok: true; cjr: CJR; dropped: number } | { ok: false; errors: string[] } {
  const e: string[] = []; const o: any = raw;
  if (!o || typeof o !== "object") return { ok: false, errors: ["not an object"] };
  const src = `${job.title}\n${job.text}`;
  for (const k of ["function", "specialisation"]) if (typeof o[k] !== "string") e.push(`${k} missing`);
  if (typeof o.usable !== "boolean") e.push("usable missing");
  if (!SEN.has(o.seniority)) e.push("seniority invalid");
  let dropped = 0;
  const reqs = (name: string): Req[] => {
    if (!Array.isArray(o[name])) { e.push(`${name} not a list`); return []; }
    const out: Req[] = [];
    for (const r of o[name]) {
      if (!r || typeof r.text !== "string" || !KIND.has(r.kind)) { e.push(`${name}: malformed item`); continue; }
      if (!quoted(r.quote, src)) { dropped++; continue; }   // an unquoted requirement is not kept
      out.push({ text: r.text.slice(0, 200), quote: r.quote, kind: r.kind, alternatives: Array.isArray(r.alternatives) ? r.alternatives.map(String).slice(0, 6) : [] });
    }
    return out;
  };
  const mandatory = reqs("mandatory"), secondary = reqs("secondary"), preferred = reqs("preferred"), credentials = reqs("credentials");
  const y = o.years ?? {}; const years = { min: Number.isFinite(y.min) ? Number(y.min) : null, max: Number.isFinite(y.max) ? Number(y.max) : null, quote: quoted(y.quote, src) ? y.quote : null };
  if ((years.min !== null || years.max !== null) && !years.quote) { years.min = null; years.max = null; dropped++; }   // years without a quote are unknown
  const loc = o.location ?? {};
  if (e.length) return { ok: false, errors: e };
  if (o.usable && !mandatory.length && !secondary.length) return { ok: false, errors: ["usable but no quoted requirement"] };
  return { ok: true, dropped, cjr: {
    schema: CJR_SCHEMA, extractor: EXTRACTOR_VERSION, job_id: job.id, desc_sha256: sha(job.text), model,
    function: o.function.slice(0, 120), specialisation: o.specialisation.slice(0, 120), responsibilities: (Array.isArray(o.responsibilities) ? o.responsibilities : []).map(String).slice(0, 8),
    mandatory, secondary, preferred, years, seniority: o.seniority, manages_people: typeof o.manages_people === "boolean" ? o.manages_people : null,
    location: { city: typeof loc.city === "string" ? loc.city : null, work_mode: ["onsite", "hybrid", "remote"].includes(loc.work_mode) ? loc.work_mode : "unknown", quote: quoted(loc.quote, src) ? loc.quote : null },
    credentials, usable: !!o.usable, usable_reason: o.usable ? null : String(o.usable_reason ?? "not usable").slice(0, 160),
  } };
}

/** File cache in the private workspace (no database). */
export class CJRCache {
  constructor(private dir: string) { mkdirSync(dir, { recursive: true }); }
  key(id: string, text: string) { return `${id}.${sha(text).slice(0, 16)}.${CJR_SCHEMA.replace("/", "")}.${EXTRACTOR_VERSION}.json`; }
  get(id: string, text: string): CJR | null { const f = `${this.dir}/${this.key(id, text)}`; return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; }
  put(c: CJR, text: string) { writeFileSync(`${this.dir}/${this.key(c.job_id, text)}`, JSON.stringify(c)); }
}
