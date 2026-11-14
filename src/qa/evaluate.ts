// The independent evaluation. Pure functions: ground truth in, what the product produced in, findings out.
// It uses none of the product's own scoring or verification, and makes no model call. A check is one of:
//   pass     — compared against the ground truth and it agrees
//   fail     — compared and it disagrees (the detail says exactly where)
//   review   — a judgement a rule cannot make; the evidence is attached for a person or an outside judge
//   not_run  — the product has not produced this yet, so nothing is claimed
// Nothing is "pass" because a step finished without an error.
import type { Truth } from "./truth.js";
import { figures, mentions, norm } from "./truth.js";

export type Status = "pass" | "fail" | "review" | "not_run";
export type Check = { check: string; status: Status; detail: string; evidence?: unknown };
export type Section = { verdict: "pass" | "fail" | "needs_review" | "incomplete" | "not_run"; counts: Record<Status, number>; checks: Check[] };
type Role = { company: string; title: string; start: string; end: string; bullets: string[] };
export type RecordIn = { name?: string; headline?: string; years_total?: number; roles?: Role[]; skills?: { name: string }[] | string[]; education?: { school: string; degree: string; year?: string }[]; extra_sections?: { title: string; items: string[] }[]; contact?: { email?: string; phone?: string; city?: string }; candidate_added_facts?: { requirement: string; fact: string }[] };
export type JobIn = { slug: string; url: string; title: string; employer: string; fn: string; level: string; location: string; state: string; text: string };
export type RadarIn = { status: string; error?: string | null; items: { url: string; title: string; company: string; location?: string; label?: string; why?: string; near?: string | null; band_text?: string | null }[]; targets?: { level?: string; years?: number; functions?: string[]; titles?: string[] } | null };
export type SharpenIn = { id: string; status: string; error?: string | null; job_url: string | null; before?: number; after?: number; rewrite?: { headline?: string; summary?: string; roles?: Role[]; skills?: string[]; education?: { school: string; degree: string }[]; relevant?: string[]; extra_sections?: { title: string; items: string[] }[] } | null; pdf?: { text: string; pages: number } | null; self_report?: unknown };

const section = (checks: Check[]): Section => { const counts = { pass: 0, fail: 0, review: 0, not_run: 0 } as Record<Status, number>; for (const c of checks) counts[c.status]++;
  return { verdict: !checks.length || counts.not_run === checks.length ? "not_run" : counts.fail ? "fail" : counts.not_run ? "incomplete" : counts.review ? "needs_review" : "pass", counts, checks }; };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** "Jul 2025", "07/2025", "2025-07", "2025", "Present" → { y, m } (m 0 when not given; y 9999 for the present) */
export function when(s: string | undefined | null): { y: number; m: number } | null {
  const t = String(s ?? "").toLowerCase().trim(); if (!t) return null; if (/present|current|now|till date|to date|ongoing/.test(t)) return { y: 9999, m: 0 };
  const y = t.match(/(19|20)\d{2}/)?.[0]; if (!y) return null; const rest = t.replace(y, " ");
  const mi = MONTHS.findIndex((m) => new RegExp(`\\b${m}`).test(rest)); const num = rest.match(/\b(0?[1-9]|1[0-2])\b/)?.[1];
  return { y: Number(y), m: mi >= 0 ? mi + 1 : num ? Number(num) : 0 };
}
export const sameWhen = (truth: string, got: string) => { const a = when(truth), b = when(got); if (!a || !b) return false; return a.y === b.y && (a.m === 0 || b.m === 0 || a.m === b.m); };
const STOP = new Set("a an and the of for in on at to with by from as is are was were be been it its this that or per into across over under via our their his her my we i".split(" "));
const words = (s: string) => norm(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w));
export const alike = (a: string, b: string) => { const x = norm(a), y = norm(b); if (!x || !y) return false; if (x === y || x.includes(y) || y.includes(x)) return true; const wa = new Set(words(a)), wb = words(b); const hit = wb.filter((w) => wa.has(w)).length; return wb.length > 0 && hit / Math.max(wa.size, wb.length) >= 0.75; };
const has = (hay: string, needle: string) => mentions(hay, needle);
/** is a statement still there? by its figures when it has any, otherwise by most of its distinctive words */
export function stated(hay: string, fact: string): boolean { const f = figures(fact); const got = new Set(figures(hay)); if (f.length) return f.every((n) => got.has(n)); const w = words(fact); const h = new Set(words(hay)); return w.length > 0 && w.filter((x) => h.has(x)).length / w.length >= 0.7; }
const flat = (r: { headline?: string; summary?: string; roles?: Role[]; skills?: any[]; relevant?: string[]; extra_sections?: { title: string; items: string[] }[]; education?: { school: string; degree: string }[] }) =>
  [r.headline, r.summary, ...(r.relevant ?? []), ...(r.roles ?? []).flatMap((x) => [x.title, x.company, ...(x.bullets ?? [])]), ...(r.skills ?? []).map((s: any) => (typeof s === "string" ? s : s?.name)), ...(r.extra_sections ?? []).flatMap((s) => [s.title, ...s.items]), ...(r.education ?? []).flatMap((e) => [e.school, e.degree])].filter(Boolean).join("\n");
const work = (t: Truth) => t.roles.filter((r) => r.kind !== "career_break");
/** pair each ground-truth role with the produced role for the same job: employer first, then title, then dates */
function pair(t: Truth, got: Role[]) {
  const used = new Set<number>(); const pairs: { truth: Truth["roles"][number]; got: Role | null }[] = [];
  for (const r of work(t)) { let best = -1, score = 0;
    got.forEach((g, i) => { if (used.has(i) || !alike(r.employer, g.company)) return; const s = 1 + (alike(r.title, g.title) ? 2 : 0) + (sameWhen(r.start, g.start) ? 1 : 0); if (s > score) { score = s; best = i; } });
    if (best >= 0) used.add(best); pairs.push({ truth: r, got: best >= 0 ? got[best] : null }); }
  return { pairs, extra: got.filter((_, i) => !used.has(i)).filter((g) => !/career break|sabbatical|caregiv/i.test(`${g.title} ${g.company}`)) };
}
function roleFacts(pairs: ReturnType<typeof pair>, what: string): Check[] {
  const out: Check[] = [];
  const missing = pairs.pairs.filter((p) => !p.got).map((p) => `${p.truth.title} — ${p.truth.employer} (${p.truth.start} to ${p.truth.end})`);
  out.push({ check: `${what}: every role in the résumé is present`, status: missing.length ? "fail" : "pass", detail: missing.length ? `missing or merged: ${missing.join(" · ")}` : `${pairs.pairs.length} of ${pairs.pairs.length} roles found` });
  out.push({ check: `${what}: no role that is not in the résumé`, status: pairs.extra.length ? "fail" : "pass", detail: pairs.extra.length ? `not in the ground truth: ${pairs.extra.map((g) => `${g.title} — ${g.company} (${g.start}–${g.end})`).join(" · ")}` : "none" });
  const titles = pairs.pairs.filter((p) => p.got && !alike(p.truth.title, p.got.title)).map((p) => `${p.truth.employer}: résumé says "${p.truth.title}", this says "${p.got!.title}"`);
  out.push({ check: `${what}: job titles unchanged`, status: titles.length ? "fail" : "pass", detail: titles.length ? titles.join(" · ") : "all titles agree" });
  const dates = pairs.pairs.filter((p) => p.got && !(sameWhen(p.truth.start, p.got.start) && sameWhen(p.truth.end === "present" ? "present" : p.truth.end, p.got.end))).map((p) => `${p.truth.title} — ${p.truth.employer}: résumé ${p.truth.start} to ${p.truth.end}, this says ${p.got!.start} to ${p.got!.end}`);
  out.push({ check: `${what}: dates unchanged (including overlaps, promotions and gaps)`, status: dates.length ? "fail" : "pass", detail: dates.length ? dates.join(" · ") : "all dates agree" });
  return out;
}

// ---------- 1 · the Record against the résumé ----------
export function evalRecord(t: Truth, rec: RecordIn | null): Section {
  if (!rec) return section([{ check: "The résumé was read into a Record", status: "not_run", detail: "no résumé has been uploaded for this candidate" }]);
  const c: Check[] = []; const p = pair(t, rec.roles ?? []); const all = flat(rec as any);
  c.push({ check: "Name", status: alike(t.person.name, rec.name ?? "") ? "pass" : "fail", detail: `résumé "${t.person.name}", Record "${rec.name ?? ""}"` });
  c.push(...roleFacts(p, "Record"));
  const promos = work(t).filter((r) => r.promoted_from); if (promos.length) { const lost = promos.filter((r) => !p.pairs.find((x) => x.truth === r)?.got || !(rec.roles ?? []).some((g) => alike(r.employer, g.company) && alike(r.promoted_from!, g.title))); c.push({ check: "Promotions kept as separate roles", status: lost.length ? "fail" : "pass", detail: lost.length ? `not kept apart: ${lost.map((r) => `${r.promoted_from} → ${r.title} at ${r.employer}`).join(" · ")}` : `${promos.length} promotion(s) kept apart` }); }
  const conc = work(t).filter((r) => r.concurrent); if (conc.length) { const lost = conc.filter((r) => !p.pairs.find((x) => x.truth === r)?.got); c.push({ check: "Overlapping roles both kept", status: lost.length ? "fail" : "pass", detail: lost.length ? `lost: ${lost.map((r) => `${r.title} — ${r.employer}`).join(" · ")}` : `${conc.length} concurrent role(s) present with their own dates` }); }
  const [lo, hi] = t.expected.record.years ?? [t.summary.total_years - 1, t.summary.total_years + 1];
  c.push({ check: "Total years of experience", status: rec.years_total == null ? "fail" : rec.years_total >= lo && rec.years_total <= hi ? "pass" : "fail", detail: `Record says ${rec.years_total ?? "nothing"}; ground truth ${t.summary.total_years} (accepted ${lo}–${hi})` });
  const lostA: string[] = [], soft: string[] = []; let n = 0;
  for (const x of p.pairs) for (const a of x.truth.achievements) { n++; const where = x.got ? x.got.bullets.join("\n") : ""; if (stated(where, a.numbers.length ? a.numbers.join(" ") : a.text)) continue; if (stated(all, a.numbers.length ? a.numbers.join(" ") : a.text)) soft.push(`${x.truth.employer}: "${a.text.slice(0, 70)}" is in the Record but under a different role`); else lostA.push(`${x.truth.employer}: "${a.text.slice(0, 90)}"${a.numbers.length ? ` [${a.numbers.join(", ")}]` : ""}`); }
  c.push({ check: "Achievements captured with their figures", status: lostA.length ? "fail" : soft.length ? "review" : n ? "pass" : "not_run", detail: lostA.length ? `${lostA.length} of ${n} not captured: ${lostA.slice(0, 12).join(" · ")}` : soft.length ? soft.slice(0, 8).join(" · ") : n ? `${n} of ${n} captured under the right role` : "the ground truth lists no achievements", evidence: lostA.length > 12 ? lostA : undefined });
  const pnl = work(t).filter((r) => r.pnl); if (pnl.length) { const lost = pnl.filter((r) => !stated(p.pairs.find((x) => x.truth === r)?.got?.bullets.join("\n") ?? "", r.pnl!)); c.push({ check: "P&L ownership captured", status: lost.length ? "fail" : "pass", detail: lost.length ? `not captured: ${lost.map((r) => `${r.employer}: ${r.pnl}`).join(" · ")}` : `${pnl.length} P&L statement(s) captured` }); }
  const xf = work(t).flatMap((r) => r.cross_functional.map((f) => ({ r, f }))); if (xf.length) { const lost = xf.filter((x) => !stated(all, x.f)); c.push({ check: "Cross-functional responsibilities captured", status: lost.length ? "review" : "pass", detail: lost.length ? `not found in these words: ${lost.map((x) => `${x.r.employer}: ${x.f}`).join(" · ")}` : `${xf.length} found` }); }
  const edu = t.education.filter((e) => !(rec.education ?? []).some((g) => alike(e.institution, g.school)));
  c.push({ check: "Education", status: edu.length ? "fail" : t.education.length ? "pass" : "not_run", detail: edu.length ? `missing: ${edu.map((e) => `${e.degree}, ${e.institution}`).join(" · ")}` : `${t.education.length} entries found` });
  const skills = t.skills.filter((s) => !has(all, s)); if (t.skills.length) c.push({ check: "Skills", status: skills.length === 0 ? "pass" : skills.length / t.skills.length > 0.4 ? "fail" : "review", detail: skills.length ? `${skills.length} of ${t.skills.length} not found: ${skills.join(", ")}` : `${t.skills.length} of ${t.skills.length} found` });
  const cert = t.certifications.filter((s) => !stated(all, s)); if (t.certifications.length) c.push({ check: "Certifications", status: cert.length ? "fail" : "pass", detail: cert.length ? `missing: ${cert.join(" · ")}` : `${t.certifications.length} found` });
  const abroad = t.summary.countries_worked.filter((x) => norm(x) !== norm(t.person.country)); if (abroad.length) { const lost = abroad.filter((x) => !has(all, x)); c.push({ check: "International experience", status: lost.length ? "review" : "pass", detail: lost.length ? `the Record does not mention ${lost.join(", ")} (it has no place for a role's country; check the bullets)` : `mentions ${abroad.join(", ")}` }); }
  const invented = figures(all).filter((x) => !new Set(figures(JSON.stringify(t))).has(x));
  c.push({ check: "No figure in the Record that is not in the résumé", status: "review", detail: invented.length ? `figures not in the ground truth (may be in the PDF but unlisted): ${invented.slice(0, 30).join(", ")}` : "every figure in the Record is in the ground truth" });
  return section(c);
}

// ---------- 2 · Radar against the expected matches ----------
const RANK: Record<string, number> = { junior: 0, mid: 1, senior: 2, head: 3 };
export function evalRadar(t: Truth, run: RadarIn | null, jobs: JobIn[], source: string): Section {
  if (!run) return section([{ check: "Radar ran", status: "not_run", detail: "no Radar run for this candidate" }]);
  if (run.status !== "done") return section([{ check: "Radar finished", status: ["error"].includes(run.status) ? "fail" : "not_run", detail: `status ${run.status}${run.error ? `: ${run.error}` : ""}` }]);
  const c: Check[] = []; const by = new Map(jobs.map((j) => [j.url, j])); const ex = t.expected.radar; const slugOf = (u: string) => by.get(u)?.slug ?? u;
  const shown = run.items.filter((i) => i.label); const fy = shown.filter((i) => i.label === "for_you"); const fySlugs = fy.map((i) => slugOf(i.url)); const allSlugs = shown.map((i) => slugOf(i.url));
  if (run.targets) { const lv = t.expected.record.level ?? [t.summary.level]; c.push({ check: "Radar's reading of the person", status: "review", detail: `Radar: level "${run.targets.level}", ${run.targets.years} years, functions ${JSON.stringify(run.targets.functions ?? [])}, titles ${JSON.stringify(run.targets.titles ?? [])}. Ground truth: ${t.summary.function}, ${lv.join("/")}, ${t.summary.total_years} years. (Radar's level words differ from the catalogue's; a person decides whether they agree.)` }); }
  const missed = ex.for_you.filter((s) => !fySlugs.includes(s));
  c.push({ check: "Missed opportunities: every role that should be “for you” is", status: !ex.for_you.length ? "not_run" : missed.length ? "fail" : "pass", detail: !ex.for_you.length ? "the ground truth names none" : missed.length ? `missed ${missed.length} of ${ex.for_you.length}: ${missed.map((s) => `${s}${allSlugs.includes(s) ? ` (shown as ${shown.find((i) => slugOf(i.url) === s)?.label})` : " (not shown at all)"}`).join(" · ")}` : `all ${ex.for_you.length} shown as for you` });
  const banned = allSlugs.filter((s) => ex.never.includes(s));
  c.push({ check: "Exclusions: nothing shown that must never be", status: banned.length ? "fail" : "pass", detail: banned.length ? `shown but excluded: ${banned.map((s) => `${s} (${shown.find((i) => slugOf(i.url) === s)?.label})`).join(" · ")}` : `none of the ${ex.never.length} excluded roles is shown` });
  const okSet = new Set([...ex.for_you, ...ex.acceptable]); const good = fySlugs.filter((s) => okSet.has(s)); const unlisted = fy.filter((i) => !okSet.has(slugOf(i.url)) && !ex.never.includes(slugOf(i.url)));
  c.push({ check: "Matching precision of “for you”", status: !fy.length ? (ex.for_you.length ? "fail" : "review") : unlisted.length ? "review" : banned.some((s) => fySlugs.includes(s)) ? "fail" : "pass", detail: `${fy.length} shown as for you; ${good.length} are in the expected or acceptable list (${fy.length ? Math.round((100 * good.length) / fy.length) : 0}%); ${unlisted.length} are not listed either way${unlisted.length ? `: ${unlisted.map((i) => `${slugOf(i.url)} “${i.title}”`).join(" · ")}` : ""}` });
  const fns = [t.summary.function, ...t.summary.other_functions].map(norm); const lv = (t.expected.record.level ?? [t.summary.level]).map((x) => RANK[x]);
  const wrongFn = fy.filter((i) => { const j = by.get(i.url); return j && !okSet.has(j.slug) && !fns.some((f) => f === norm(j.fn) || norm(j.fn).includes(f) || f.includes(norm(j.fn))); });
  c.push({ check: "Function: “for you” roles are in the person's function", status: wrongFn.length ? "fail" : fy.length ? "pass" : "not_run", detail: wrongFn.length ? wrongFn.map((i) => `${slugOf(i.url)} is ${by.get(i.url)!.fn}; the person is ${t.summary.function}`).join(" · ") : "all in function (or explicitly listed as acceptable)" });
  const wrongLv = fy.filter((i) => { const j = by.get(i.url); return j && !okSet.has(j.slug) && j.level in RANK && !lv.includes(RANK[j.level]); }); const far = shown.filter((i) => { const j = by.get(i.url); return j && j.level in RANK && Math.min(...lv.map((x) => Math.abs(x - RANK[j.level]))) >= 2; });
  c.push({ check: "Seniority: “for you” roles are at the person's level; nothing two levels away is shown", status: wrongLv.length || far.length ? "fail" : fy.length ? "pass" : "not_run", detail: wrongLv.length || far.length ? [...wrongLv.map((i) => `for you: ${slugOf(i.url)} is a ${by.get(i.url)!.level} role`), ...far.map((i) => `${i.label}: ${slugOf(i.url)} is a ${by.get(i.url)!.level} role, two or more levels from ${t.summary.level}`)].join(" · ") : "levels agree" });
  const place = shown.filter((i) => { const loc = by.get(i.url)?.location ?? i.location ?? ""; return !ex.locations.some((l) => has(loc, l)); });
  c.push({ check: "Location", status: place.length ? "fail" : shown.length ? "pass" : "not_run", detail: place.length ? place.map((i) => `${slugOf(i.url)} is in ${by.get(i.url)?.location ?? i.location}`).join(" · ") : `every shown role is in ${ex.locations.join(" / ")}` });
  const emp = shown.filter((i) => ex.exclude_employers.some((e) => alike(e, i.company))); const gone = shown.filter((i) => by.get(i.url)?.state === "gone"); const unknown = shown.filter((i) => !by.has(i.url));
  c.push({ check: "No closed role, excluded employer or unknown listing is shown", status: emp.length || gone.length || unknown.length ? "fail" : "pass", detail: [...emp.map((i) => `excluded employer: ${i.company} (${slugOf(i.url)})`), ...gone.map((i) => `closed role shown: ${slugOf(i.url)}`), ...unknown.map((i) => `not a fixture: ${i.url}`)].join(" · ") || "none" });
  const empty = shown.filter((i) => !String(i.why ?? "").trim()); const src = new Set(figures(source));
  const loose = shown.flatMap((i) => { const jf = new Set(figures(by.get(i.url)?.text ?? "")); return figures(`${i.why ?? ""} ${i.near ?? ""}`).filter((n) => !src.has(n) && !jf.has(n)).map((n) => `${slugOf(i.url)}: figure ${n} in “${String(i.why).slice(0, 80)}”`); });
  c.push({ check: "Role explanations: present, and every figure in them comes from the résumé or the posting", status: empty.length || loose.length ? "fail" : shown.length ? "pass" : "not_run", detail: [...empty.map((i) => `no explanation: ${slugOf(i.url)}`), ...loose].join(" · ") || `${shown.length} explanations, no unsupported figure` });
  c.push({ check: "Role explanations: true and specific to this person", status: shown.length ? "review" : "not_run", detail: "read each explanation against the résumé", evidence: shown.map((i) => ({ role: slugOf(i.url), label: i.label, why: i.why, near: i.near ?? null, years_line: i.band_text ?? null })) });
  return section(c);
}

// ---------- 3 · one Sharpen output against the résumé and the posting ----------
export function evalSharpen(t: Truth, s: SharpenIn, job: JobIn | null, source: string, rec: RecordIn | null): Section {
  const c: Check[] = []; const target = t.expected.sharpen.find((x) => x.job === job?.slug) ?? null;
  if (s.status !== "done" || !s.rewrite) return section([{ check: "Sharpen finished and delivered a document", status: ["failed", "error"].includes(s.status) ? "fail" : "not_run", detail: `status ${s.status}${s.error ? `: ${s.error}` : ""}` }]);
  const rw = s.rewrite; const out = flat(rw); const told = (rec?.candidate_added_facts ?? []).map((f) => f.fact).join("\n"); const basis = `${source}\n${JSON.stringify(t)}\n${told}`;
  c.push(...roleFacts(pair(t, rw.roles ?? []), "Factual accuracy"));
  const newEdu = (rw.education ?? []).filter((e) => !t.education.some((x) => alike(x.institution, e.school))); const lostEdu = t.education.filter((x) => !(rw.education ?? []).some((e) => alike(x.institution, e.school)));
  c.push({ check: "Factual accuracy: education unchanged", status: newEdu.length || lostEdu.length ? "fail" : "pass", detail: [...newEdu.map((e) => `added: ${e.degree}, ${e.school}`), ...lostEdu.map((e) => `dropped: ${e.degree}, ${e.institution}`)].join(" · ") || "unchanged" });
  const keep = [...t.must_keep, ...(target?.must_keep ?? [])]; const lostKeep = keep.filter((k) => !stated(out, k));
  const ach = work(t).flatMap((r) => r.achievements.map((a) => ({ r, a }))); const lostAch = ach.filter((x) => !stated(out, x.a.numbers.length ? x.a.numbers.join(" ") : x.a.text));
  c.push({ check: "Achievement preservation: every must-keep fact is still stated", status: !keep.length ? "not_run" : lostKeep.length ? "fail" : "pass", detail: !keep.length ? "the ground truth lists no must-keep facts" : lostKeep.length ? `lost ${lostKeep.length} of ${keep.length}: ${lostKeep.join(" · ")}` : `${keep.length} of ${keep.length} kept` });
  c.push({ check: "Achievement preservation: other achievements", status: !ach.length ? "not_run" : lostAch.length ? "review" : "pass", detail: !ach.length ? "none listed" : `${ach.length - lostAch.length} of ${ach.length} achievements still stated${lostAch.length ? `; not found (tailoring may drop some — judge whether these mattered): ${lostAch.slice(0, 15).map((x) => `${x.r.employer}: "${x.a.text.slice(0, 70)}"`).join(" · ")}` : ""}` });
  const known = new Set(figures(basis)); const lines = out.split("\n"); const badNums = lines.flatMap((l) => figures(l).filter((n) => !known.has(n)).map((n) => `${n} in “${l.slice(0, 110)}”`));
  c.push({ check: "Numerical accuracy: every figure in the document is in the résumé", status: badNums.length ? "fail" : "pass", detail: badNums.length ? `${badNums.length} figure(s) with no source: ${badNums.slice(0, 15).join(" · ")}` : `${figures(out).length} figures, all traceable to the résumé` });
  const ban = [...t.must_not_claim, ...(target?.must_not_claim ?? [])]; const claimed = ban.filter((k) => has(out, k));
  c.push({ check: "Unsupported claims: nothing the person never did", status: claimed.length ? "fail" : ban.length ? "pass" : "not_run", detail: claimed.length ? `claimed: ${claimed.join(" · ")}` : ban.length ? `none of the ${ban.length} listed claims appears` : "the ground truth lists none" });
  const skillsNew = (rw.skills ?? []).filter((k) => !has(basis, k)); const stuffed = skillsNew.filter((k) => job && has(job.text, k));
  c.push({ check: "Unsupported claims: skills", status: stuffed.length ? "fail" : skillsNew.length ? "review" : "pass", detail: stuffed.length ? `taken from the posting, not in the résumé: ${stuffed.join(", ")}` : skillsNew.length ? `not in the résumé in these words (rewording, or new?): ${skillsNew.join(", ")}` : "every listed skill is in the résumé" });
  if (!job) c.push({ check: "JD relevance", status: "review", detail: `the target (${s.job_url}) is not a fixture, so relevance cannot be measured against a known posting` });
  else if (!target) c.push({ check: "JD relevance", status: "not_run", detail: `the ground truth has no expected outcome for ${job.slug}` });
  else { const terms = target.relevant_terms; const before = terms.filter((x) => has(source, x)), after = terms.filter((x) => has(out, x)); const gained = after.filter((x) => !before.includes(x)), dropped = before.filter((x) => !after.includes(x));
    c.push({ check: "JD relevance: the posting's terms the person can truthfully claim are brought forward", status: dropped.length ? "fail" : gained.length ? "fail" : after.length === before.length && before.length < terms.length ? "review" : "pass", detail: `${terms.length} relevant terms; in the résumé ${before.length}, in the document ${after.length}.${dropped.length ? ` Dropped: ${dropped.join(", ")}.` : ""}${gained.length ? ` Appear in the document but not in the résumé (unsupported unless the candidate added them): ${gained.join(", ")}.` : ""}${!dropped.length && !gained.length && before.length < terms.length ? ` Not in the résumé, correctly absent: ${terms.filter((x) => !before.includes(x)).join(", ")}.` : ""}` });
    c.push({ check: "JD relevance: emphasis and ordering suit this posting", status: "review", detail: `product's own score ${s.before ?? "?"} → ${s.after ?? "?"} (not used as evidence here)`, evidence: { summary: rw.summary, relevant: rw.relevant } }); }
  if (!s.pdf) c.push({ check: "ATS readability and formatting", status: "not_run", detail: "the delivered PDF could not be opened for this evaluation" });
  else { const pt = s.pdf.text; const ptn = norm(pt);
    c.push({ check: "ATS readability: the PDF's text can be extracted", status: ptn.length > 400 ? "pass" : "fail", detail: `${pt.length} characters extracted` });
    let at = 0; const order: string[] = []; for (const r of rw.roles ?? []) { const i = ptn.indexOf(norm(r.company), at); if (i < 0) order.push(`${r.title} — ${r.company}`); else at = i; }
    c.push({ check: "ATS readability: roles read in order, top to bottom", status: order.length ? "fail" : "pass", detail: order.length ? `not found in reading order: ${order.join(" · ")}` : `${(rw.roles ?? []).length} roles in order` });
    const spaced = pt.match(/\b(?:[A-Z] ){4,}[A-Z]\b/g) ?? []; const heads = ["experience", "education"].filter((h) => !ptn.includes(h));
    c.push({ check: "ATS readability: headings are plain words", status: spaced.length || heads.length ? "fail" : "pass", detail: [...spaced.slice(0, 3).map((x) => `letter-spaced heading “${x}”`), ...heads.map((h) => `no “${h}” heading`)].join(" · ") || "standard headings, no letter-spacing" });
    const contact = [t.person.name, ...(rec?.contact?.email ? [rec.contact.email] : []), ...(rec?.contact?.phone ? [rec.contact.phone.replace(/\D/g, "").slice(-10)] : [])].filter((x) => !(norm(pt).includes(norm(x)) || pt.replace(/\D/g, "").includes(x)));
    c.push({ check: "ATS readability: name and contact details are in the text", status: contact.length ? "fail" : "pass", detail: contact.length ? `missing: ${contact.join(", ")}` : "present" });
    const junk = pt.match(/[�□]|\(cid:\d+\)/g) ?? []; const longLines = pt.split("\n").filter((l) => l.length > 260).length; const emptyRoles = (rw.roles ?? []).filter((r) => !(r.bullets ?? []).length).map((r) => `${r.title} — ${r.company}`); const many = (rw.roles ?? []).filter((r) => (r.bullets ?? []).length > 8).map((r) => `${r.company}: ${(r.bullets ?? []).length} lines`);
    c.push({ check: "Formatting: clean characters, no empty role", status: junk.length || emptyRoles.length ? "fail" : "pass", detail: [junk.length ? `${junk.length} unreadable character(s)` : "", ...emptyRoles.map((x) => `no lines under ${x}`)].filter(Boolean).join(" · ") || "clean" });
    c.push({ check: "Formatting: length and density", status: s.pdf.pages > Math.max(2, t.layout.pages) || many.length || longLines ? "review" : "pass", detail: `${s.pdf.pages} page(s) (original ${t.layout.pages})${many.length ? `; long roles: ${many.join(", ")}` : ""}${longLines ? `; ${longLines} very long line(s)` : ""}` }); }
  c.push({ check: "Reads like this person; nothing overstated in tone", status: "review", detail: "a judgement for a person or an outside judge", evidence: { headline: rw.headline, summary: rw.summary } });
  return section(c);
}

// ---------- 4 · Ghost Meter against controlled pages ----------
export type MeterCase = { slug: string; url: string; what: string; expected: string; verdicts: string[]; fire: number[]; never: number[] };
export type MeterResult = { at: string; status: number; verdict: string | null; score?: number | null; signals: { n: number; kind: string; text?: string }[]; error?: string | null };
export function evalMeter(cases: MeterCase[], results: Map<string, MeterResult[]>): { verdict: Section["verdict"]; pages: ({ page: string; what: string; expected: string } & Section)[] } {
  const pages = cases.map((g) => { const rs = results.get(g.url) ?? []; const c: Check[] = [];
    if (!rs.length) c.push({ check: "Checked", status: "not_run", detail: "this page has not been checked yet" });
    else { const r = rs[0]; const got = r.status >= 400 || !r.verdict ? "error" : r.verdict; const bad = r.signals.filter((x) => x.kind === "bad").map((x) => x.n);
      c.push({ check: "Verdict", status: g.verdicts.map((v) => v.toLowerCase()).includes(got.toLowerCase()) ? "pass" : "fail", detail: `got ${got === "error" ? `no verdict (“${r.error ?? r.status}”)` : `${got}${r.score != null ? ` (${r.score})` : ""}`}; acceptable: ${g.verdicts.join(" or ")}` });
      if (got !== "error") {
        if (g.fire.length) { const miss = g.fire.filter((n) => !bad.includes(n)); c.push({ check: "Signals that must fire", status: miss.length ? "fail" : "pass", detail: miss.length ? `did not fire: ${miss.join(", ")} (fired: ${bad.join(", ") || "none"})` : `fired: ${g.fire.join(", ")}` }); }
        if (g.never.length) { const hit = g.never.filter((n) => bad.includes(n)); c.push({ check: "Signals that must not fire", status: hit.length ? "fail" : "pass", detail: hit.length ? `fired wrongly: ${hit.map((n) => `${n} “${r.signals.find((x) => x.n === n)?.text ?? ""}”`).join(" · ")}` : `none of ${g.never.join(", ")} fired` }); }
        c.push({ check: "Every applicable signal, as evidence", status: "review", detail: g.expected, evidence: r.signals.filter((x) => x.kind !== "na").map((x) => ({ n: x.n, kind: x.kind, text: x.text })) }); }
      if (rs.length > 1) { const vs = [...new Set(rs.map((x) => (x.status >= 400 || !x.verdict ? "error" : x.verdict)))]; c.push({ check: "Same answer every time", status: vs.length > 1 ? "fail" : "pass", detail: `${rs.length} checks: ${vs.join(", ")}` }); } }
    return { page: g.slug, what: g.what, expected: g.expected, ...section(c) }; });
  const all = section(pages.flatMap((p) => p.checks)); return { verdict: all.verdict, pages };
}

// ---------- the candidate's whole report ----------
export function evaluate(i: { truth: Truth; source: string; record: RecordIn | null; radar: RadarIn | null; jobs: JobIn[]; sharpens: SharpenIn[]; journeys: { at: string; what: string; detail: string; refusal?: boolean }[] }) {
  const by = new Map(i.jobs.map((j) => [j.url, j])); const record = evalRecord(i.truth, i.record); const radar = evalRadar(i.truth, i.radar, i.jobs, i.source);
  const done = i.sharpens.map((s) => ({ shot: s.id, job: by.get(s.job_url ?? "")?.slug ?? s.job_url, ...evalSharpen(i.truth, s, by.get(s.job_url ?? "") ?? null, i.source, i.record) }));
  const pending = i.truth.expected.sharpen.filter((x) => !done.some((d) => d.job === x.job)).map((x) => ({ shot: null, job: x.job, ...section([{ check: "Sharpen was run against this posting", status: "not_run" as Status, detail: "no Sharpen for this expected target yet" }]) }));
  const journeys = section(i.journeys.length ? i.journeys.map((j) => ({ check: `${j.refusal ? "The product refused a request" : "Failed step"}: ${j.what}`, status: (j.refusal ? "review" : "fail") as Status, detail: `${j.at} · ${j.detail}${j.refusal ? " — decide whether refusing was right" : ""}` })) : [{ check: "No failed step or error recorded for this candidate", status: (i.record ? "pass" : "not_run") as Status, detail: i.record ? "none recorded" : "nothing has been run yet" }]);
  const parts = [record, radar, ...done, ...pending, journeys]; const any = (v: string) => parts.some((p) => p.verdict === v);
  return { candidate: i.truth.id, name: i.truth.person.name, covers: i.truth.summary.covers, verdict: any("fail") ? "fail" : parts.every((p) => p.verdict === "not_run") ? "not_run" : any("incomplete") || any("not_run") ? "incomplete" : any("needs_review") ? "needs_review" : "pass",
    how_to_read: "pass = compared with the ground truth and agrees · fail = disagrees · review = needs a person or an outside judge · not_run = nothing produced yet. Finishing without an error is never a pass.",
    record, radar, sharpen: [...done, ...pending], journeys };
}
