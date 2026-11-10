// Radar v2 (10 Nov): discovery on facts. Title match → the screen-out gates → one question to the model per posting —
// "is this the same function as the candidate's work: yes, adjacent, or no" — → three labels built from facts.
// No score is produced, promised or shown. Every line on a list is a fact from the posting or the one-line answer
// to that question, and the whole list is re-verified by `verify()` before it is stored, shown or sent.
import { json, MODEL } from "../engine/claude.js";
import type { ResumeProfile } from "../engine/sharpen.js";
import { statedBand, titleBucket } from "../reader/experience.js";
import { isBlr } from "../reader/blr.js";
import { bandGate, titleGate, pedigreeGate, languageGate, cityGate, resumeBlob, wantRung } from "./gates.js";

export type Label = "for_you" | "adjacent" | "stretch";
export type Same = "yes" | "adjacent" | "no";
export type Verdict = { same: Same; why: string };

/** The one judgement the rules cannot make: is this posting the candidate's function? Twelve postings a call, the
 *  candidate pinned once. The answer must quote the posting; it never scores. Cached per posting × function profile. */
export async function functionCheck(cand: { one_line: string; functions: string[]; years: number; level: string }, batch: { id: number; title: string; company: string; text: string }[]): Promise<Map<number, Verdict>> {
  const r = await json<{ verdicts: { id: number; same: string; why: string }[] }>(
    `You are a fair Bengaluru recruiter doing the first screen, and you answer ONE question per posting: is this posting the same FUNCTION as the candidate's work?
"yes" — the day-to-day work of this posting is what the candidate has done for most of their recent years (same craft: e.g. category management for a category manager; program management for a program manager; data engineering for a data engineer). Industry may differ; the craft must not.
"adjacent" — a neighbouring craft a recruiter would still consider (program ↔ business operations; category ↔ key-account/vendor management in commerce; data engineering ↔ data platform/analytics engineering).
"no" — a different craft, however similar the title words: a "Key Account Manager" in field sales is not category management; a "PMO" in pharma clinical operations is not consumer-tech program management; a procurement "Category Manager" is not e-commerce category management; "Program Manager" in engineering services delivery is not product program management.
Judge the posting's actual requirements, not its title. Years and level are already checked; do not judge them. "why": at most 15 words, quoting or paraphrasing the posting's own requirement that decided it. Never invent a requirement.`,
    `CANDIDATE: ${cand.one_line}\nFunctions: ${cand.functions.join("; ")}. Years: ${cand.years}. Level: ${cand.level}.\n\nPOSTINGS:\n${batch.map((b, i) => `#${i + 1} (id ${b.id}) ${b.title} — ${b.company}\n${b.text.replace(/\s+/g, " ").slice(0, 1800)}`).join("\n\n")}\n\nReturn: {verdicts:[{id, same: "yes"|"adjacent"|"no", why}]} — one per posting, by id.`,
    1400, MODEL
  );
  const out = new Map<number, Verdict>();
  for (const v of r.verdicts ?? []) {
    const id = Number(v.id); if (!batch.some((b) => b.id === id)) continue;
    const same = (v.same === "yes" || v.same === "adjacent") ? v.same : "no";
    out.set(id, { same, why: String(v.why ?? "").replace(/\s+/g, " ").slice(0, 140) });
  }
  return out;
}

/** Worlds a title plainly belongs to. Only the pairs a recruiter would never confuse are excluded before the model is
 *  asked — field sales for a desk function, clinical for anyone not clinical, engineering for a non-engineer — so the
 *  model question runs on a quarter of the postings. Conservative by design: when in doubt, ask. */
const WORLD: { key: string; re: RegExp }[] = [
  { key: "field_sales", re: /\b(area (business|sales) manager|territory|field (sales|officer)|medical representative|sales officer|business development executive|telecall|inside sales|channel sales|distribution sales|regional business manager)\b/i },
  { key: "clinical", re: /\b(clinical|pharmacovigilance|medical writ|regulatory affairs|nurse|physician|radiolog|patholog|dentist)\b/i },
  { key: "engineering", re: /\b(software|developer|sde\b|devops|sre\b|backend|frontend|full ?stack|embedded|firmware|qa engineer|test engineer|android|ios engineer|kernel|architect)\b/i },
  { key: "data_eng", re: /\b(data engineer|data platform|etl|databricks|data architect|analytics engineer)\b/i },
  { key: "data_sci", re: /\b(data scientist|machine learning|ml engineer|applied scientist|research scientist)\b/i },
  { key: "finance", re: /\b(accountant|accounting|controller|treasury|audit|tax|fp&a|financial analyst|fund (accounting|services)|valuation|billing)\b/i },
  { key: "hr", re: /\b(human resources|\bhr\b|talent acquisition|recruiter|recruitment|payroll|l&d|learning and development)\b/i },
  { key: "legal", re: /\b(legal counsel|lawyer|paralegal|compliance officer|company secretary)\b/i },
  { key: "procurement", re: /\b(procurement|sourcing manager|purchase|buyer\b|vendor development)\b/i },
  { key: "design", re: /\b(ux|ui designer|visual design|graphic|interior design|visual merchandis)\b/i },
  { key: "facilities", re: /\b(facilities|admin(istration)? manager|security guard|housekeeping|front office)\b/i },
];
const RESUME_WORLD: Record<string, RegExp> = {
  field_sales: /\b(sales|territory|business development|channel|distribution|account executive)\b/i,
  clinical: /\b(clinical|pharma|hospital|medical|nurse|doctor|physician)\b/i,
  engineering: /\b(software|engineer|developer|sde|devops|architect|programmer)\b/i,
  data_eng: /\b(data engineer|data platform|etl|spark|databricks|pipeline)\b/i,
  data_sci: /\b(data scien|machine learning|ml\b|model)\b/i,
  finance: /\b(finance|accounting|accountant|audit|tax|treasury|controller|fp&a)\b/i,
  hr: /\b(human resources|\bhr\b|talent|recruit|payroll)\b/i,
  legal: /\b(legal|counsel|law|compliance)\b/i,
  procurement: /\b(procurement|sourcing|purchase|buyer|vendor)\b/i,
  design: /\b(design|ux|ui|creative)\b/i,
  facilities: /\b(facilities|administration|admin)\b/i,
};
export function worldExclusion(title: string, resumeText: string): string | null {
  for (const w of WORLD) {
    if (!w.re.test(title)) continue;
    const r = RESUME_WORLD[w.key];
    if (r && r.test(resumeText)) return null;   // the candidate has lived in that world; let the model decide
    return `a ${w.key.replace("_", " ")} seat, not your function`;
  }
  return null;
}

/** Near-misses that do not screen out but do decide the label: a year short of the floor, or a title one rung away. */
export function nearMiss(years: number, level: string, title: string, text: string): string | null {
  const b = statedBand(text);
  if (b && years < b.min && years + 2 > b.min) return `asks ${b.min}+ years; you have ${years}`;
  const RUNG: Record<string, number> = { fresher: 0, "2-4": 1, "4-6": 2, "6-8": 3, "8-10": 4, "10+": 5 };
  const NAME: Record<string, string> = { fresher: "an entry-level", "2-4": "an associate-level", "4-6": "a senior-associate", "6-8": "a manager-level", "8-10": "a senior-manager", "10+": "a head-level" };
  const r = RUNG[titleBucket(title)], want = wantRung(level, years);
  const bandFits = !!(b && years >= b.min - 1 && (b.max === null || years <= b.max + 1));
  if (r !== undefined && r === want - 1 && !bandFits) return `${NAME[titleBucket(title)]} title, one rung below yours`;
  if (r !== undefined && r === want + 1 && !bandFits) return `${NAME[titleBucket(title)]} title, one rung above yours`;
  return null;
}

export function labelOf(same: Same, near: string | null): Label | null {
  if (same === "no") return null;
  if (same === "yes") return near ? "adjacent" : "for_you";
  return near ? "stretch" : "adjacent";
}

export const BAND_TEXT = (text: string): string | null => { const b = statedBand(text); if (!b || (b.min === 0 && b.max === null)) return null; return b.max === null ? `${b.min}+ years` : `${b.min}–${b.max} years`; };

/** The list's contract, checked by code before anything is stored, shown or sent. Each item is re-tested against its
 *  posting text and the candidate; a failure removes the item and says why. No human reads the list; this does. */
export type Checkable = { sighting_id: number; title: string; location: string; url: string; first_seen: string; label: Label; why: string; text?: string };
export function verify(items: Checkable[], resume: ResumeProfile, years: number, level: string, stretch: boolean, textOf: (id: number) => string | undefined): { ok: Checkable[]; violations: { sighting_id: number; title: string; rule: string }[] } {
  const ok: Checkable[] = [], violations: { sighting_id: number; title: string; rule: string }[] = [];
  const blob = resumeBlob(resume);
  for (const it of items) {
    const text = it.text ?? textOf(it.sighting_id) ?? "";
    const fail = (rule: string) => violations.push({ sighting_id: it.sighting_id, title: it.title, rule });
    if (!text || text.length < 200) { fail("no posting text on file"); continue; }
    const gate = bandGate(years, text) ?? titleGate(it.title, level, stretch, years, text) ?? pedigreeGate(text, blob) ?? languageGate(text, blob) ?? cityGate(it.title);
    if (gate) { fail(gate); continue; }
    if (!isBlr(it.location ?? "") && !/bengaluru|bangalore/i.test(text.slice(0, 400))) { fail("location is not Bengaluru"); continue; }
    if ((Date.now() - Date.parse(it.first_seen)) / 86400e3 > 45) { fail("first seen more than 45 days ago"); continue; }
    if (!it.why || it.why.length < 8) { fail("no reason on the line"); continue; }
    if (!/^https?:\/\//.test(it.url)) { fail("no employer page"); continue; }
    ok.push(it);
  }
  return { ok, violations };
}
