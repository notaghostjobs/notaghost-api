// Candidate evidence with provenance, offline lab code. Built from the layout-aware reading (lab/py/resume_layout.py):
// every skill keeps the line that shows it, its page, column and section, the job it sits under, and how the line uses
// it (led or owned, did it hands-on, supported or was exposed). A skill in a skills list or sidebar stays evidence, but
// weak evidence; it never becomes work experience. Nothing is invented: lines are the document's own words.
import { skillsIn } from "./skills.js";

export type Basis = "work" | "project" | "achievement" | "summary_claim" | "listed" | "education" | "unknown";
export type Ownership = "led_or_owned" | "hands_on" | "supported_or_exposed" | "unknown";
export type Item = { skill: string; basis: Basis; ownership: Ownership; text: string; page: number; column: string; section: string; role: string | null };
export type Provenance = { items: Item[]; strength: Map<string, number>; best: Map<string, Item>; twoColumn: boolean; unheadedAsWork: number };

const LED = /\b(owned|own|led|lead|leading|headed|managed|managing|drove|spearheaded|responsible for|accountable for|ran)\b/i;
const HANDS = /\b(built|build|developed|develop|designed|implemented|engineered|wrote|created|deployed|migrated|automated|configured|coded|optimi[sz]ed|architected|processed|handled|prepared|reconciled|underwrote|analy[sz]ed|resolved|delivered|executed|launched)\b/i;
const SOFT = /\b(supported|assisted|exposure|familiar|familiarity|knowledge of|basic|learning|worked with|coordinated|participated|involved in|helped)\b/i;
const DATE = /((19|20)\d{2}|present|current)\s*(-|–|—|to)\s*((19|20)\d{2}|present|current|now)|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*'?\d{2,4}\b/i;
/** How strong each kind of evidence is, 0–1. Work shown hands-on or led is full evidence; a list is a claim. */
export const STRENGTH: Record<Basis, number> = { work: 1, achievement: 1, project: 0.7, summary_claim: 0.5, listed: 0.35, education: 0.3, unknown: 0.3 };
const OWN_ADJ: Record<Ownership, number> = { led_or_owned: 1, hands_on: 1, unknown: 0.9, supported_or_exposed: 0.6 };

export function provenance(layout: { lines: { page: number; column: string; section: string; text: string; is_heading?: boolean }[]; layout: { two_column: boolean }[] }): Provenance {
  const items: Item[] = []; const lines = layout.lines;
  // the widest column's unheaded lines are work history in résumés that never say "Experience"; a sidebar's are a list
  const byCol = new Map<string, number>(); for (const l of lines) byCol.set(l.column, (byCol.get(l.column) ?? 0) + l.text.length);
  const mainCol = [...byCol.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "main";
  const hasExp = lines.some((l) => l.section === "experience" && l.column === mainCol);
  let role: string | null = null, unheaded = 0;
  lines.forEach((l, i) => {
    if (l.is_heading) return;
    let basis: Basis;
    switch (l.section) {
      case "experience": basis = "work"; break; case "achievements": basis = "achievement"; break; case "projects": basis = "project"; break;
      case "summary": basis = "summary_claim"; break; case "skills": case "certifications": case "languages": basis = "listed"; break;
      case "education": basis = "education"; break; case "interests": case "personal": return;
      default: if (l.column === mainCol && !hasExp && i > 2) { basis = "work"; unheaded++; } else if (l.column !== mainCol) basis = "listed"; else basis = "unknown";
    }
    if (basis === "work" && DATE.test(l.text)) role = [lines[i - 1]?.text, l.text].filter(Boolean).join(" | ").slice(0, 140);
    const own: Ownership = LED.test(l.text) ? "led_or_owned" : HANDS.test(l.text) ? "hands_on" : SOFT.test(l.text) ? "supported_or_exposed" : "unknown";
    for (const s of skillsIn(l.text)) items.push({ skill: s, basis, ownership: basis === "work" || basis === "achievement" || basis === "project" ? own : "unknown", text: l.text.slice(0, 200), page: l.page, column: l.column, section: l.section, role: basis === "work" ? role : null });
  });
  const strength = new Map<string, number>(), best = new Map<string, Item>();
  for (const it of items) { const v = STRENGTH[it.basis] * (it.basis === "work" || it.basis === "achievement" || it.basis === "project" ? OWN_ADJ[it.ownership] : 1); if (v > (strength.get(it.skill) ?? 0)) { strength.set(it.skill, v); best.set(it.skill, it); } }
  return { items, strength, best, twoColumn: layout.layout.some((p) => p.two_column), unheadedAsWork: unheaded };
}
