// Matching v2: the candidate evidence record (CER), deterministic, no model call. Built from the layout-aware reading
// (lab/py/resume_layout.py → src/lab/provenance.ts, match-req-2 40e0b7b), so a sidebar or skills list stays "listed"
// and never becomes work. Each work line keeps the role it sits under. Missing information stays unknown. Nothing is
// invented: every quote is the résumé's own text. Names, contacts, links and PIN codes are removed before the record
// is used or sent anywhere.
import { provenance, type Item } from "../provenance.js";
import { TOOL_FAMILY_IDS } from "./terms.js";

export const CER_SCHEMA = "cer/1";
type Line = { page: number; column: string; section: string; text: string; is_heading?: boolean };
export type Quote = { text: string; basis: "work" | "project" | "achievement" | "summary_claim" | "listed" | "education" };
export type CER = {
  schema: typeof CER_SCHEMA; candidate_id: string; resume_sha256: string;
  years_total: { value: number | null; basis: "dated_roles" | "stated" | "unknown" };
  roles: { title: string; from: string | null; to: string | null; lines: string[] }[];
  work_lines: string[]; project_lines: string[]; achievement_lines: string[]; summary_lines: string[]; listed_lines: string[]; education_lines: string[];
  skills: { id: string; basis: Item["basis"]; ownership: Item["ownership"]; quote: string }[];
  primary_stack: string[]; led_lines: string[]; credentials: { id: string; quote: string }[];
  level_read: string | null; function_read: { id: string; p: number }[];
  target: { functions: [string, number][]; level: string; open_to_adjacent: string; transition: string; exclusions: string[]; source: "simulated" | "candidate" };
  parser: { two_column: boolean; unheaded_as_work: number; dated_roles: number; warnings: string[] };
};

const PII = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|https?:\/\/|www\.|linkedin|github\.com|(?:\+?91[\s-]*)?[6-9]\d{4}[\s-]?\d{5}\b|\b\d{6}\b/i;
const CRED: [string, RegExp][] = [["ca", /\bchartered accountant\b|\bca\b(?= ?(\(|final|qualified|inter))|\bicai\b/i], ["cfa", /\bcfa\b/i], ["frm", /\bfrm\b/i], ["cpa", /\bcpa\b/i],
  ["acca", /\bacca\b/i], ["cma", /\b(cma|icwa)\b/i], ["pmp", /\bpmp\b/i], ["mba", /\bmba\b|\bpgdm\b/i], ["llb", /\bllb\b|\bll\.b\b/i], ["mbbs", /\bmbbs\b/i], ["phd", /\bph\.?\s?d\b|doctorate/i],
  ["btech", /\bb\.?\s?tech\b|\bb\.?e\.?\b(?= |\()|bachelor of engineering/i], ["mtech", /\bm\.?\s?tech\b|\bm\.?s\.? in\b|master of (science|technology)/i], ["bcom", /\bb\.?\s?com\b/i], ["mcom", /\bm\.?\s?com\b/i], ["nism", /\bnism\b/i]];
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

export function buildCER(id: string, resumeSha: string, layout: { lines: Line[]; layout: { two_column: boolean }[] }, done: any, answers: any, specLabel = (x: string) => x): CER {
  const pv = provenance(layout as any);
  // the name line: the first non-empty line, only when it looks like a name (no digits, no separators, ≤5 words, not under a section)
  const firstLine = layout.lines.find((l) => l.text.trim());
  const first = firstLine?.text.trim() ?? "";
  const isName = !!firstLine && !/\d|[|@:,]/.test(first) && first.split(/\s+/).length <= 5 && !["experience", "skills", "education", "projects", "summary", "achievements"].includes(firstLine.section);
  const nameToks = isName ? first.split(/\s+/).filter((t) => /^[A-Za-z.'-]{3,}$/.test(t)) : [];
  const scrub = (t: string) => { let s = t; for (const n of nameToks) s = s.replace(new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "[name]"); return clean(s); };
  const keep = (l: Line, i: number) => !l.is_heading && l.text.trim().length > 2 && !PII.test(l.text) && !(isName && l === firstLine) && l.section !== "personal" && l.section !== "interests";
  const byCol = new Map<string, number>(); for (const l of layout.lines) byCol.set(l.column, (byCol.get(l.column) ?? 0) + l.text.length);
  const mainCol = [...byCol.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "main";
  const hasExp = layout.lines.some((l) => l.section === "experience" && l.column === mainCol);
  const out = { work: [] as string[], project: [] as string[], achievement: [] as string[], summary: [] as string[], listed: [] as string[], education: [] as string[] };
  layout.lines.forEach((l, i) => {
    if (!keep(l, i)) return; const t = scrub(l.text);
    switch (l.section) {
      case "experience": out.work.push(t); break; case "projects": out.project.push(t); break; case "achievements": out.achievement.push(t); break;
      case "summary": out.summary.push(t); break; case "skills": case "certifications": case "languages": out.listed.push(t); break; case "education": out.education.push(t); break;
      default: if (l.column === mainCol && !hasExp && i > 2) out.work.push(t); else if (l.column !== mainCol) out.listed.push(t); else out.summary.push(t);
    }
  });
  // role-by-role lines: provenance tags each work item with the dated role line it sits under
  const roles = (done?.jobs ?? []).map((j: any) => ({ title: scrub(String(j.title ?? "")), from: j.from ?? null, to: j.to ?? null, lines: [] as string[] }));
  for (const it of pv.items) if (it.basis === "work" && it.role) { const r = roles.find((x: any) => x.title && it.role!.toLowerCase().includes(x.title.toLowerCase().slice(0, 18))); if (r && !r.lines.includes(scrub(it.text))) r.lines.push(scrub(it.text)); }
  const skills = [...pv.best.values()].map((b) => ({ id: b.skill, basis: b.basis, ownership: b.ownership, quote: scrub(b.text) }));
  const workCount = new Map<string, number>(); for (const it of pv.items) if (it.basis === "work" || it.basis === "project") workCount.set(it.skill, (workCount.get(it.skill) ?? 0) + 1);
  const primary_stack = [...workCount.entries()].filter(([s]) => TOOL_FAMILY_IDS.has(s)).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([s]) => s);
  const all = [...out.work, ...out.project, ...out.achievement, ...out.summary, ...out.listed, ...out.education];
  const credentials = CRED.flatMap(([cid, re]) => { const q = all.find((t) => re.test(t)); return q ? [{ id: cid, quote: q.slice(0, 200) }] : []; });
  const dated = roles.filter((r: any) => r.from).length;
  const warnings: string[] = [];
  if (!dated) warnings.push("no dated roles found: role-by-role dates unknown");
  if (pv.unheadedAsWork) warnings.push(`${pv.unheadedAsWork} unheaded main-column lines treated as work`);
  if (!hasExp) warnings.push("no experience heading in the main column");
  const a = answers ?? {};
  return {
    schema: CER_SCHEMA, candidate_id: id, resume_sha256: resumeSha,
    years_total: { value: Number.isFinite(done?.years_read) ? done.years_read : null, basis: done?.years_basis === "dated" ? "dated_roles" : done?.years_basis === "stated" ? "stated" : "unknown" },
    roles, work_lines: out.work, project_lines: out.project, achievement_lines: out.achievement, summary_lines: out.summary, listed_lines: out.listed, education_lines: out.education,
    skills, primary_stack, led_lines: pv.items.filter((x) => x.ownership === "led_or_owned").map((x) => scrub(x.text)).filter((v, i, s) => s.indexOf(v) === i).slice(0, 8), credentials,
    level_read: done?.level_read ?? null, function_read: (done?.specs_shown ?? []).slice(0, 3).map((s: any) => ({ id: s.id, p: s.p })),
    target: { functions: [[a.direction_primary, 0.7], ...(a.direction_secondary && a.direction_secondary !== "none" ? [[a.direction_secondary, 0.3]] : [])].filter((x) => x[0]).map(([k, w]) => [specLabel(String(k)), Number(w)]) as [string, number][],
      level: String(a.level ?? "unknown"), open_to_adjacent: String(a.open_to_adjacent ?? "unknown"), transition: String(a.transition ?? "unknown"), exclusions: Array.isArray(a.exclusions) ? a.exclusions : [], source: "simulated" },
    parser: { two_column: pv.twoColumn, unheaded_as_work: pv.unheadedAsWork, dated_roles: dated, warnings },
  };
}

/** Every quote in the record must be the résumé's own text (whitespace-normalised, names removed). */
export function verifyCER(c: CER, resumeText: string): string[] {
  const hay = clean(resumeText).toLowerCase(); const bad: string[] = [];
  const check = (q: string) => { const s = q.replace(/\[name\]/g, "").split(/\s{2,}|\|/).map((x) => clean(x).toLowerCase()).filter((x) => x.length > 12); if (s.length && !s.some((x) => hay.includes(x.slice(0, 40)))) bad.push(q.slice(0, 80)); };
  [...c.work_lines, ...c.listed_lines, ...c.skills.map((s) => s.quote)].forEach(check);
  return bad;
}
