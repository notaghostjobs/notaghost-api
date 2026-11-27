// Candidate intake validation and preflight. Nothing is filled in: a missing or contradictory answer holds the
// candidate for clarification before any paid run; invalid consent, a duplicate person or an unreadable résumé
// rejects them. The output is a preflight report (accepted / held / rejected, with reasons) and, for accepted
// candidates only, the intent answers both arms receive.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { extname, join } from "node:path";
import { SPEC } from "../../../lib/ontology.js";
import { employment } from "../dates.js";
import { sha256 } from "./root.js";

export const INTAKE_SCHEMA = "ghosted-intake/1", CONSENT_VERSION = "consent-v1", TEST_ID = "ghosted-radar-v3-eval";
export const CONSENT_TEXT = "My résumé and answers may be used by Ghosted to test job-matching quality. They will be seen only by the Ghosted team and two named reviewers, never published, and deleted within 90 days. I may withdraw at any time.";
export const LEVELS4 = ["entry", "mid", "senior", "leader"] as const;   // the product's own level question, given to both arms
export const WORK_MODES = ["onsite", "hybrid", "remote"] as const;
export type Intake = {
  schema: string; candidate_id: string; population: "pilot" | "main" | "synthetic"; resume_file: string;
  current_function: string; target_functions: string[]; career_change: "yes" | "no"; target_level: (typeof LEVELS4)[number]; open_to_step_up: "yes" | "no";
  open_to_adjacent: "yes" | "maybe" | "no"; location: { city: string; work_modes: string[] }; preferred_industry: string;
  constraints: { pay_floor_lpa: number | null; notice_days: number | null; relocate: "yes" | "no" | null }; deal_breakers: string[]; years_experience: number;
  consent: { version: string; text_sha256: string; agreed: boolean; date: string; test: string; follow_up: boolean }; recruited: { channel: string; at: string };
};
export type Decision = { candidate: string; status: "accepted" | "held" | "rejected"; reasons: string[]; clarify: string[]; resume_sha256?: string; text_chars?: number; resume_years?: number | null };

/** Résumé text exactly as a parser would see it. PDF via pdftotext, DOCX via python-docx, TXT as is. */
export function resumeText(file: string): string {
  const ext = extname(file).toLowerCase();
  if (ext === ".txt") return readFileSync(file, "utf8");
  if (ext === ".pdf") return execFileSync("pdftotext", ["-q", file, "-"], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (ext === ".docx") return execFileSync("python3", ["-I", "-c", "import sys,docx;d=docx.Document(sys.argv[1]);print('\\n'.join(p.text for p in d.paragraphs));[print(' | '.join(c.text for c in r.cells)) for t in d.tables for r in t.rows]", file], { encoding: "utf8", maxBuffer: 1 << 26 });
  throw new Error(`unsupported résumé format ${ext}`);
}
const norm = (t: string) => t.toLowerCase().normalize("NFKC").replace(/[^a-z0-9]+/g, " ").trim();
/** A non-reversible similarity sketch: 64 minimum hashes of five-word shingles. Shared between roots, never the text. */
export function sketch(text: string): number[] {
  const w = norm(text).split(" "); const sh = new Set<string>(); for (let i = 0; i + 5 <= w.length; i++) sh.add(w.slice(i, i + 5).join(" "));
  const mins = Array(64).fill(Infinity); for (const s of sh) for (let k = 0; k < 64; k++) { const h = parseInt(sha256(`${k}:${s}`).slice(0, 8), 16); if (h < mins[k]) mins[k] = h; }
  return mins;
}
export const similarity = (a: number[], b: number[]) => a.filter((x, i) => x === b[i] && x !== Infinity).length / 64;
export const DUPLICATE_AT = 0.5;

const LEADER_MIN_YEARS = 8, SENIOR_MIN_YEARS = 4;
export function validate(dir: string, intake: any, others: { id: string; sketch: number[] }[], devSketches: { id: string; sketch: number[] }[], now = new Date()): Decision & { sketch?: number[]; answers?: any } {
  const id = String(intake?.candidate_id ?? ""); const d: Decision & { sketch?: number[]; answers?: any } = { candidate: id || "(none)", status: "accepted", reasons: [], clarify: [] };
  const reject = (r: string) => { d.status = "rejected"; d.reasons.push(r); }, hold = (r: string, q: string) => { if (d.status !== "rejected") d.status = "held"; d.reasons.push(r); d.clarify.push(q); };
  if (!intake || intake.schema !== INTAKE_SCHEMA) { reject(`intake schema is not ${INTAKE_SCHEMA}`); return d; }
  if (!/^[A-Z]\d{2,3}$/.test(id) || /^B\d\d$/.test(id)) reject("candidate ID must be anonymous (letter + 2–3 digits) and not a development ID (Bnn)");
  if (others.some((o) => o.id === id)) reject("duplicate candidate ID");
  // consent: the exact text, agreed, for this test
  const c = intake.consent ?? {};
  if (c.agreed !== true || c.version !== CONSENT_VERSION || c.text_sha256 !== sha256(CONSENT_TEXT) || c.test !== TEST_ID || !c.date) reject("no valid consent for this test (agreed, version, exact text and test name required)");
  // résumé: format, readable text
  const f = intake.resume_file ? join(dir, intake.resume_file) : ""; let text = "";
  if (!f || !existsSync(f)) reject("résumé file missing");
  else if (![".pdf", ".docx", ".txt"].includes(extname(f).toLowerCase())) reject(`résumé format ${extname(f)} not accepted (PDF, DOCX or TXT)`);
  else { try { text = resumeText(f); } catch (e) { reject(`résumé could not be read: ${(e as Error).message.slice(0, 80)}`); }
    const words = text.split(/\s+/).filter((x) => /[a-z]{2,}/i.test(x)).length; d.text_chars = text.length; d.resume_sha256 = sha256(readFileSync(f));
    if (text && (text.length < 400 || words < 60)) reject(`résumé text unreadable or too short (${words} words): a scanned image or empty file`); }
  // duplicates: against the development profiles and within this population
  if (text) { const s = sketch(text); d.sketch = s;
    const dev = devSketches.find((x) => similarity(s, x.sketch) >= DUPLICATE_AT); if (dev) reject(`same person as development profile ${dev.id} (résumé similarity ≥ ${DUPLICATE_AT})`);
    const dup = others.find((x) => similarity(s, x.sketch) >= DUPLICATE_AT); if (dup) reject(`same résumé as candidate ${dup.id}`); }
  // mandatory answers: present and valid, never inferred
  const tf: string[] = Array.isArray(intake.target_functions) ? intake.target_functions : [];
  if (!String(intake.current_function ?? "").trim()) hold("current function missing", "What is your current professional function?");
  if (!tf.length || tf.length > 2) hold("one or two target functions required", "Which one or two kinds of work do you want next?");
  for (const t of tf) if (!SPEC.has(t)) hold(`target function "${t}" is not in the function list`, `Please choose your target function from the list (you wrote "${t}").`);
  if (!LEVELS4.includes(intake.target_level)) hold("target level missing or invalid", "Which level are you aiming for: entry, mid, senior or leader?");
  if (!["yes", "maybe", "no"].includes(intake.open_to_adjacent)) hold("adjacent-role preference missing", "Would you consider closely related roles?");
  if (!["yes", "no"].includes(intake.open_to_step_up)) hold("step-up preference missing", "Would you consider a role one level up?");
  if (!["yes", "no"].includes(intake.career_change)) hold("career-change answer missing", "Are you trying to change career?");
  const modes: string[] = intake.location?.work_modes ?? []; if (!String(intake.location?.city ?? "").trim() || !modes.length || modes.some((m) => !WORK_MODES.includes(m as any))) hold("work location or work mode missing or invalid", "Which city, and which of on-site, hybrid or remote would you accept?");
  if (!Array.isArray(intake.deal_breakers)) hold("deal-breakers not answered (an empty list is a valid answer)", "Is there anything that rules a job out for you?");
  if (typeof intake.years_experience !== "number" || !(intake.years_experience >= 0 && intake.years_experience <= 50)) hold("years of experience missing or invalid", "How many years have you worked full-time?");
  if (typeof intake.preferred_industry !== "string" || !intake.preferred_industry) hold("industry preference not answered (\"any\" is a valid answer)", "Do you prefer a particular industry?");
  // contradictions: hold and ask, never resolve ourselves
  if (text && typeof intake.years_experience === "number") { const e = employment(text, now); d.resume_years = e.total_years; (d as any).resume_years_basis = e.basis;
    if (e.total_years !== null && Math.abs(e.total_years - intake.years_experience) > 3) hold(`stated ${intake.years_experience} years; the résumé's ${e.basis === "dated_roles" ? "dated roles add up to" : "own statement says"} about ${e.total_years}`, "Your résumé and your answer differ on years of experience. Which is right?"); }
  if (intake.target_level === "leader" && intake.years_experience < LEADER_MIN_YEARS && intake.career_change === "no") hold(`leader roles with ${intake.years_experience} years`, "You chose leader roles with fewer than 8 years: is that intended?");
  if (intake.target_level === "senior" && intake.years_experience < 2) hold(`senior roles with ${intake.years_experience} years`, "You chose senior roles with under 2 years: is that intended?");
  if (intake.target_level === "entry" && intake.years_experience > SENIOR_MIN_YEARS * 2 && intake.career_change === "no") hold(`entry roles with ${intake.years_experience} years and no career change`, "You chose entry roles with many years of experience: is this a career change?");
  for (const b of (intake.deal_breakers ?? []) as string[]) for (const t of tf) { const lab = (SPEC.get(t) as any)?.label ?? t; if (b && lab.toLowerCase().split(/\W+/).filter((w: string) => w.length > 3).some((w: string) => b.toLowerCase().includes(w))) hold(`deal-breaker "${b}" conflicts with target "${lab}"`, `You want "${lab}" but also ruled out "${b}". Which applies?`); }
  if (intake.open_to_adjacent === "no" && tf.length === 2 && (SPEC.get(tf[0]) as any)?.fn !== (SPEC.get(tf[1]) as any)?.fn) hold("two unrelated target functions but not open to related roles", "You chose two different functions but no related roles: which matters more?");
  if (intake.location?.city && !/bengaluru|bangalore/i.test(intake.location.city) && !modes.includes("remote")) hold("city outside Bengaluru and remote not accepted: the inventory is Bengaluru only", "Our jobs are Bengaluru-based: would you work in Bengaluru or remotely?");
  if (d.status === "accepted") d.answers = answersFrom(intake);
  return d;
}
/** The intent both arms receive, in the matcher's own answer shape. Only answered fields; nothing guessed. */
export function answersFrom(x: Intake) {
  return { direction_primary: x.target_functions[0], direction_secondary: x.target_functions[1] ?? "none", open_to_adjacent: x.open_to_adjacent === "no" ? "no" : "yes", adjacent_answer: x.open_to_adjacent,
    transition: x.career_change, level: x.target_level, years: x.years_experience, domain: x.preferred_industry === "any" ? "any" : x.preferred_industry, stretch: x.open_to_step_up,
    must_have_qualification: "none", exclusions: x.deal_breakers, deal_breakers: x.deal_breakers, work_modes: x.location.work_modes, city: x.location.city, source: "candidate" };
}
/** Preflight for every candidate folder in a root's intake directory. */
export function preflight(intakeDir: string, devSketches: { id: string; sketch: number[] }[], now = new Date()) {
  const seen: { id: string; sketch: number[] }[] = []; const out: (Decision & { answers?: any })[] = [];
  for (const cdir of readdirSync(intakeDir).filter((x) => !x.endsWith(".json")).sort()) {
    const f = join(intakeDir, cdir, "intake.json"); let intake: any = null; try { intake = JSON.parse(readFileSync(f, "utf8")); } catch { out.push({ candidate: cdir, status: "rejected", reasons: ["intake.json missing or not valid JSON"], clarify: [] }); continue; }
    if (intake.candidate_id !== cdir) { out.push({ candidate: cdir, status: "rejected", reasons: [`folder ${cdir} holds intake for ${intake.candidate_id}`], clarify: [] }); continue; }
    const d = validate(join(intakeDir, cdir), intake, seen, devSketches, now); if (d.sketch) seen.push({ id: d.candidate, sketch: d.sketch }); delete d.sketch; out.push(d);
  }
  const count = (s: string) => out.filter((x) => x.status === s).length;
  return { made_at: new Date().toISOString(), accepted: count("accepted"), held: count("held"), rejected: count("rejected"), decisions: out };
}

/** Pilot / main selection, fixed before any V3 output exists. Accepted candidates are taken in order of arrival
 *  (recruited.at), the first per professional area (the target function's family), until `n` are chosen; if fewer
 *  areas than `n` exist, the next arrivals fill the rest. Levels are reported, not used to pick. Held or rejected
 *  candidates are never replaced by choice: the rule simply moves to the next arrival. */
export function selectByArrival(intakes: Intake[], accepted: string[], n: number, rule = "first accepted arrival per professional area, then next arrivals") {
  const ok = intakes.filter((x) => accepted.includes(x.candidate_id)).sort((a, b) => a.recruited.at.localeCompare(b.recruited.at) || a.candidate_id.localeCompare(b.candidate_id));
  const area = (x: Intake) => (SPEC.get(x.target_functions[0]) as any)?.fn ?? "unknown"; const chosen: Intake[] = []; const areas = new Set<string>();
  for (const x of ok) if (chosen.length < n && !areas.has(area(x))) { chosen.push(x); areas.add(area(x)); }
  for (const x of ok) if (chosen.length < n && !chosen.includes(x)) chosen.push(x);
  return { rule, n, selected: chosen.map((x) => ({ candidate: x.candidate_id, area: area(x), level: x.target_level, arrived: x.recruited.at, channel: x.recruited.channel })), not_selected: ok.filter((x) => !chosen.includes(x)).map((x) => x.candidate_id), made_at: new Date().toISOString() };
}
