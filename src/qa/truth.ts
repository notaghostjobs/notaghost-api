// The import format for QA candidates and job fixtures, and the screen every imported document passes.
// Pure: no database, no network. Format name: ghosted-qa-truth/1.
import { z } from "zod";
import { EMPLOYERS, GM, JOBS } from "./fixtures.js";

const ym = z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/, "use YYYY or YYYY-MM");
const text = (max = 600) => z.string().trim().min(1).max(max);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{2,59}$/, "lowercase letters, digits and hyphens");
export const LEVELS = ["junior", "mid", "senior", "head"] as const;

export const TruthRole = z.object({
  employer: text(120), title: text(160), start: ym, end: z.union([ym, z.literal("present")]),
  location: text(120).optional(), country: text(60).optional(),
  kind: z.enum(["full_time", "contract", "consulting", "internship", "founder", "board", "career_break"]).default("full_time"),
  promoted_from: text(160).optional(),          // the title held before this one at the same employer
  concurrent: z.boolean().default(false),       // true when this role deliberately overlaps another in time
  team_size: z.number().int().min(0).optional(), pnl: text(160).optional(),             // e.g. "₹900 crore revenue, 14% contribution margin"
  cross_functional: z.array(text(120)).max(20).default([]),
  responsibilities: z.array(text()).max(40).default([]),
  achievements: z.array(z.object({ text: text(), numbers: z.array(text(40)).max(12).default([]) })).max(40).default([]),
});
export const Truth = z.object({
  format: z.literal("ghosted-qa-truth/1"),
  id: z.string().regex(/^QA(0\d[1-9]|0[1-9]\d|100)$/, "QA001 to QA100"),
  synthetic: z.literal(true, { errorMap: () => ({ message: "must be true: only synthetic documents are imported" }) }),
  provenance: z.object({ basis: z.enum(["invented", "derived_from_real"]), fictionalised: z.boolean(), permission: z.enum(["not_required", "obtained"]), note: text(400).optional() }),
  person: z.object({ name: text(120), city: text(80), country: text(60).default("India"), email: z.string().optional(), phone: z.string().optional(), languages: z.array(text(40)).max(12).default([]) }),
  summary: z.object({ function: text(80), other_functions: z.array(text(80)).max(8).default([]), level: z.enum(LEVELS), total_years: z.number().min(0).max(50), countries_worked: z.array(text(60)).max(12).default([]), covers: text(400) }),
  roles: z.array(TruthRole).min(1).max(30),
  education: z.array(z.object({ degree: text(160), institution: text(160), start: ym.optional(), end: ym.optional() })).max(10).default([]),
  skills: z.array(text(80)).max(80).default([]), certifications: z.array(text(160)).max(20).default([]),
  layout: z.object({ pages: z.number().int().min(1).max(10), columns: z.number().int().min(1).max(3), tables: z.boolean().default(false), sidebar: z.boolean().default(false), graphics: z.boolean().default(false), image_only: z.boolean().default(false), notes: text(400).optional() }),
  must_keep: z.array(text(300)).max(40).default([]),          // facts every Sharpen output must still state (matched on their numbers and key words)
  must_not_claim: z.array(text(200)).max(40).default([]),     // things this person never did or has: any appearance is an unsupported claim
  expected: z.object({
    record: z.object({ level: z.array(z.enum(LEVELS)).min(1).optional(), years: z.tuple([z.number(), z.number()]).optional() }).default({}),
    radar: z.object({ for_you: z.array(slug).max(30), acceptable: z.array(slug).max(60).default([]), never: z.array(slug).max(120).default([]), locations: z.array(text(80)).max(10).default(["Bengaluru"]), exclude_employers: z.array(text(120)).max(20).default([]), notes: text(600).optional() }),
    sharpen: z.array(z.object({ job: slug, relevant_terms: z.array(text(60)).min(1).max(30), must_keep: z.array(text(300)).max(20).default([]), must_not_claim: z.array(text(200)).max(20).default([]), notes: text(600).optional() })).max(10).default([]),
  }),
});
export type Truth = z.infer<typeof Truth>;

export const JobImport = z.object({
  format: z.literal("ghosted-qa-jobs/1"),
  employers: z.array(z.object({ name: text(120), slug, hiring_system: z.enum(["followed", "none", "unknown"]), about: text(600) })).max(60).default([]),
  roles: z.array(z.object({
    slug, employer: text(120), title: text(160), function: text(80), level: z.union([z.enum(LEVELS), z.literal("adjacent")]), years: z.tuple([z.number().min(0), z.number().max(50)]),
    location: text(120).default("Bengaluru, Karnataka, India"), pay: text(60).nullable().default(null), posted_days: z.number().int().min(0).max(720), state: z.enum(["live", "gone"]).default("live"),
    text: z.string().trim().min(200, "a posting needs at least 200 characters").max(12000),
    page: z.object({ posted_text: text(80).optional(), closed_notice: z.boolean().default(false), http: z.number().int().min(200).max(599).optional() }).default({}),     // what the page says; may contradict the system on purpose
    system: z.object({ listed: z.boolean().default(true), first_seen_days: z.number().int().min(0).max(720).optional() }).default({}),                                 // what the employer's own hiring system shows
    ghost_meter: z.object({ verdicts: z.array(z.enum(["Real", "Caution", "Ghost", "error"])).min(1), fire: z.array(z.number().int().min(2).max(22)).default([]), never: z.array(z.number().int().min(2).max(22)).default([]), note: text(400).optional() }).optional(),
  })).min(1).max(400),
});
export type JobImport = z.infer<typeof JobImport>;
export const builtInSlugs = () => new Set([...JOBS.map((j) => j.slug), ...GM.map((g) => g.slug)]);

// ---------- the screen: what an imported document may not contain ----------
const QA_PHONE_DIGITS = /^(91)?0{5}0?1\d{3}$|^0{5}0?1\d{3}$/;
const SAFE_MAIL = /@(example\.(com|org|net)|[a-z0-9.-]+\.(test|invalid|example))$/i;
const SAFE_URL = /^(https?:\/\/)?([a-z0-9-]+\.)*(example\.(com|org|net)|[a-z0-9-]+\.(test|invalid|example))(\/|$)/i;
/** contact details and identifiers that could belong to a real person. Returns one line per finding; empty means clean. */
export function screen(doc: string, what: string): string[] {
  const out: string[] = []; const t = doc.replace(/[   ]/g, " ");
  for (const m of t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []) if (!SAFE_MAIL.test(m)) out.push(`${what}: e-mail address "${m}" — use an @example.com address`);
  for (const m of t.match(/(?<![\d.,₹$€£])\+?\d[\d \-()]{8,16}\d(?![\d.,%])/g) ?? []) { const d = m.replace(/\D/g, ""); if (d.length >= 10 && d.length <= 13 && !/^(19|20)\d{2}(19|20)\d{2}/.test(d) && !QA_PHONE_DIGITS.test(d)) out.push(`${what}: phone number "${m.trim()}" — use the candidate's QA number (+91 00000 0xxxx) or none`); }
  for (const m of t.match(/\b(?:https?:\/\/|www\.)[^\s)>\]]+|\b(?:linkedin\.com|github\.com|behance\.net|medium\.com|twitter\.com|x\.com|instagram\.com|facebook\.com)\/[^\s)>\]]+/gi) ?? []) if (!SAFE_URL.test(m.replace(/^www\./i, ""))) out.push(`${what}: web address "${m.slice(0, 60)}" — remove it or use an example.com address`);
  for (const m of t.match(/\b[A-Z]{5}\d{4}[A-Z]\b/g) ?? []) out.push(`${what}: looks like a PAN "${m}"`);
  for (const m of t.match(/\b\d{4}[ -]\d{4}[ -]\d{4}\b/g) ?? []) out.push(`${what}: looks like an Aadhaar number "${m}"`);
  if (/\b(date of birth|d\.?o\.?b\.?|passport (no|number)|father'?s name|marital status)\b/i.test(t)) out.push(`${what}: personal particulars (date of birth, passport, family or marital details) — remove them`);
  return [...new Set(out)];
}

export const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9₹$€£%+.]+/g, " ").replace(/\s+/g, " ").trim();
/** does the text contain the phrase as whole words (a trailing plural is allowed)? "founder" is not found inside "co-founders’ meeting" by accident of spelling alone */
export function mentions(hay: string, needle: string): boolean { const n = norm(needle); if (!n) return false; return new RegExp(`(^| )${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(s|es)?( |$)`).test(norm(hay)); }
/** the figures in a line, in a form that survives reformatting: "₹900 crore" → "900", "2.1 points" → "2.1", "1,20,000" → "120000". Years are left out. */
export function figures(s: string): string[] { return [...new Set((s.replace(/(\d),(?=\d)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []).filter((n) => !/^(19|20)\d{2}$/.test(n)))]; }
const overlap = (a: { start: string; end: string }, b: { start: string; end: string }) => { const v = (x: string, end: boolean) => x === "present" ? 999912 : Number(x.slice(0, 4)) * 100 + (x.length > 4 ? Number(x.slice(5, 7)) : end ? 12 : 1); return v(a.start, false) < v(b.end, true) && v(b.start, false) < v(a.end, true); };

/** everything that can be checked about a package before it is stored. `errors` block the import; `warnings` do not. */
export function checkPackage(raw: unknown, pdf: { text: string; pages: number; bytes: number; isPdf: boolean }, id: string, knownJobs: Set<string>): { ok: boolean; errors: string[]; warnings: string[]; truth: Truth | null } {
  const errors: string[] = [], warnings: string[] = [];
  if (!pdf.isPdf) errors.push("the résumé must be a PDF file");
  if (pdf.bytes > 5 * 1024 * 1024) errors.push("the PDF is larger than 5 MB");
  const p = Truth.safeParse(raw);
  if (!p.success) { for (const i of p.error.issues.slice(0, 25)) errors.push(`ground truth · ${i.path.join(".") || "(root)"}: ${i.message}`); return { ok: false, errors, warnings, truth: null }; }
  const t = p.data;
  if (t.id !== id) errors.push(`the ground truth is for ${t.id} but it was submitted as ${id}`);
  if (t.provenance.basis === "derived_from_real" && !t.provenance.fictionalised) errors.push("a document derived from a real résumé must be fictionalised (provenance.fictionalised: true)");
  errors.push(...screen(pdf.text, "PDF"), ...screen(JSON.stringify(raw), "ground truth"));
  const body = norm(pdf.text);
  if (!t.layout.image_only && body.length < 400) errors.push("the PDF has almost no readable text. If that is deliberate (a scanned or image-only résumé), set layout.image_only: true");
  if (!t.layout.image_only) {
    if (!body.includes(norm(t.person.name))) errors.push(`the name "${t.person.name}" is not in the PDF: the ground truth and the résumé do not belong together`);
    for (const r of t.roles) if (r.kind !== "career_break") { if (!body.includes(norm(r.employer))) warnings.push(`employer "${r.employer}" is not found in the PDF text`); if (!body.includes(norm(r.title))) warnings.push(`title "${r.title}" (${r.employer}) is not found in the PDF text`); }
    const have = new Set(figures(pdf.text));
    for (const r of t.roles) for (const a of r.achievements) for (const n of a.numbers.flatMap(figures)) if (!have.has(n)) warnings.push(`figure ${n} from "${a.text.slice(0, 50)}…" is not in the PDF: the ground truth would fail an accurate rewrite`);
    for (const k of t.must_keep) for (const n of figures(k)) if (!have.has(n)) warnings.push(`must_keep figure ${n} ("${k.slice(0, 40)}…") is not in the PDF`);
    for (const k of t.must_not_claim) if (mentions(pdf.text, k)) warnings.push(`must_not_claim "${k}" appears in the PDF itself`);
  }
  if (pdf.pages && pdf.pages !== t.layout.pages) warnings.push(`the PDF has ${pdf.pages} page(s); layout.pages says ${t.layout.pages}`);
  const work = t.roles.filter((r) => r.kind !== "career_break");
  for (let i = 0; i < work.length; i++) for (let j = i + 1; j < work.length; j++) if (overlap(work[i], work[j]) && !work[i].concurrent && !work[j].concurrent && !(work[i].end !== "present" && work[i].end === work[j].start) && !(work[j].end !== "present" && work[j].end === work[i].start)) warnings.push(`"${work[i].title}" and "${work[j].title}" overlap in time but neither is marked concurrent`);
  const ex = t.expected; const named = [...ex.radar.for_you, ...ex.radar.acceptable, ...ex.radar.never, ...ex.sharpen.map((s) => s.job)];
  for (const s of new Set(named)) if (!knownJobs.has(s)) warnings.push(`expected outcome names job "${s}", which is not a fixture yet: import it, or that check cannot run`);
  for (const s of ex.radar.for_you) if (ex.radar.never.includes(s)) errors.push(`job "${s}" is in both for_you and never`);
  if (!ex.radar.for_you.length && !ex.radar.never.length) warnings.push("no expected Radar outcome: Radar precision cannot be evaluated for this candidate");
  if (!ex.sharpen.length) warnings.push("no expected Sharpen target: JD relevance cannot be evaluated for this candidate");
  return { ok: errors.length === 0, errors, warnings, truth: t };
}
export function checkJobs(raw: unknown): { ok: boolean; errors: string[]; warnings: string[]; jobs: JobImport | null } {
  const errors: string[] = [], warnings: string[] = []; const p = JobImport.safeParse(raw);
  if (!p.success) { for (const i of p.error.issues.slice(0, 25)) errors.push(`${i.path.join(".") || "(root)"}: ${i.message}`); return { ok: false, errors, warnings, jobs: null }; }
  const j = p.data; const taken = builtInSlugs(); const names = new Set([...EMPLOYERS.map((e) => e.name), ...j.employers.map((e) => e.name)]); const seen = new Set<string>();
  for (const e of j.employers) { if (EMPLOYERS.some((b) => b.slug === e.slug || b.name === e.name)) errors.push(`employer "${e.name}" (${e.slug}) is already a built-in fixture`); errors.push(...screen(e.about, `employer ${e.slug}`)); }
  for (const r of j.roles) { if (taken.has(r.slug)) errors.push(`role "${r.slug}" has the same name as a built-in fixture`); if (seen.has(r.slug)) errors.push(`role "${r.slug}" appears twice`); seen.add(r.slug);
    if (!names.has(r.employer)) errors.push(`role "${r.slug}": employer "${r.employer}" is not a fixture — add it under employers`); if (r.years[0] > r.years[1]) errors.push(`role "${r.slug}": years must be [min, max]`);
    errors.push(...screen(r.text, `role ${r.slug}`).filter((x) => !/registration fee/.test(x)));
    if (r.ghost_meter) for (const n of r.ghost_meter.fire) if (r.ghost_meter.never.includes(n)) errors.push(`role "${r.slug}": signal ${n} is in both fire and never`); }
  return { ok: errors.length === 0, errors, warnings, jobs: j };
}
