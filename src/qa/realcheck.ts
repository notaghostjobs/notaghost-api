// What can be checked about a real résumé's run without a ground truth: the Record against the résumé's own text, and
// Radar's list against the fixtures and its own stated reasons. Pure; no model call. Where only a person can decide, the
// finding is "review" with the evidence attached. Finishing without an error is never a pass.
import { figures, mentions, norm } from "./truth.js";
import { when, type Check, type JobIn, type RecordIn, type Section, type Status } from "./evaluate.js";

const section = (checks: Check[]): Section => { const counts = { pass: 0, fail: 0, review: 0, not_run: 0 } as Record<Status, number>; for (const c of checks) counts[c.status]++;
  return { verdict: !checks.length || counts.not_run === checks.length ? "not_run" : counts.fail ? "fail" : counts.not_run ? "incomplete" : counts.review ? "needs_review" : "pass", counts, checks }; };
const STOP = new Set("a an and the of for in on at to with by from as or senior junior lead head manager associate assistant executive specialist officer principal staff".split(" "));
const key = (s: string) => norm(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w));
type Item = { url: string; title: string; company: string; location?: string; label?: string; why?: string; near?: string | null; band_text?: string | null };
type Trail = { id: number; title: string; company: string; why?: string; chosen?: boolean; dropped?: string };
export type RunIn = { status: string; error?: string | null; pool?: number; by_title?: number; examined?: number; dropped_band?: number; items: Item[]; trail?: Trail[] } | null;
export type TargetsIn = { level?: string; years?: number; functions?: string[]; titles?: string[]; one_line?: string } | null;

/** the Record against the text of the résumé it was read from */
export function checkRecord(text: string, pages: number, rec: RecordIn | null, uploadError: string | null): Section {
  if (uploadError) return section([{ check: "The résumé was read into a Record", status: "fail", detail: `the product refused or failed: ${uploadError}` }]);
  if (!rec) return section([{ check: "The résumé was read into a Record", status: "not_run", detail: "not processed yet" }]);
  const c: Check[] = []; const roles = rec.roles ?? [];
  c.push({ check: "The file's text can be extracted", status: norm(text).length > 400 ? "pass" : "review", detail: `${text.length} characters on ${pages} page(s)${norm(text).length > 400 ? "" : " — likely a scanned or image résumé; compare the Record with the original by eye"}` });
  c.push({ check: "Name", status: rec.name && mentions(text, rec.name) ? "pass" : "fail", detail: rec.name ? `Record says “${rec.name}”${mentions(text, rec.name) ? "" : ", which is not in the résumé text"}` : "the Record has no name" });
  c.push({ check: "Roles were found", status: roles.length ? "pass" : "fail", detail: `${roles.length} role(s) in the Record` });
  const ghostCo = roles.filter((r) => r.company && !mentions(text, r.company) && !key(r.company).some((w) => mentions(text, w))); const ghostTi = roles.filter((r) => r.title && !mentions(text, r.title) && key(r.title).filter((w) => mentions(text, w)).length < Math.ceil(key(r.title).length * 0.6));
  c.push({ check: "Every employer in the Record is in the résumé", status: ghostCo.length ? "fail" : roles.length ? "pass" : "not_run", detail: ghostCo.length ? `not found in the résumé text: ${ghostCo.map((r) => r.company).join(" · ")}` : "all found" });
  c.push({ check: "Every job title in the Record is in the résumé", status: ghostTi.length ? "review" : roles.length ? "pass" : "not_run", detail: ghostTi.length ? `not found in these words (reworded, or misread?): ${ghostTi.map((r) => `${r.title} — ${r.company}`).join(" · ")}` : "all found" });
  const years = new Set(text.match(/(?:19|20)\d{2}/g) ?? []); const badDates = roles.filter((r) => [r.start, r.end].some((d) => { const w = when(d); return w && w.y !== 9999 && !years.has(String(w.y)); }) || !when(r.start));
  c.push({ check: "Every date in the Record is in the résumé", status: badDates.length ? "fail" : roles.length ? "pass" : "not_run", detail: badDates.length ? `a year that is not in the résumé, or no start date: ${badDates.map((r) => `${r.title} — ${r.company} (${r.start || "?"}–${r.end || "?"})`).join(" · ")}` : "all years appear in the résumé" });
  const have = new Set(figures(text)); const loose = roles.flatMap((r) => (r.bullets ?? []).flatMap((b) => figures(b).filter((n) => !have.has(n)).map((n) => `${n} in “${b.slice(0, 90)}” (${r.company})`)));
  c.push({ check: "Every figure in the Record is in the résumé", status: loose.length ? "fail" : "pass", detail: loose.length ? `${loose.length} figure(s) with no source: ${loose.slice(0, 12).join(" · ")}` : "all figures traceable" });
  // date ranges written in the résumé whose start year no Record role or education entry carries: a role may have been missed or merged
  const starts = new Set([...roles.map((r) => when(r.start)?.y), ...(rec.education ?? []).map((e) => when(e.year)?.y)].filter(Boolean).map(String)); const edu = new Set((rec.education ?? []).flatMap((e) => (e.year ?? "").match(/(?:19|20)\d{2}/g) ?? []));
  const ranges = [...new Set((text.match(/(?:[A-Za-z]{3,9}\.?,?\s+)?(?:19|20)\d{2}\s*(?:[-–—]|to)\s*(?:(?:[A-Za-z]{3,9}\.?,?\s+)?(?:19|20)\d{2}|present|current|now|till date)/gi) ?? []).map((x) => x.replace(/\s+/g, " ")))];
  const orphan = ranges.filter((x) => { const y = x.match(/(?:19|20)\d{2}/)![0]; return !starts.has(y) && !edu.has(y); });
  c.push({ check: "No role in the résumé is missing from the Record", status: orphan.length ? "review" : "pass", detail: orphan.length ? `date ranges in the résumé that start no role in the Record (a missed or merged role, or education/projects): ${orphan.slice(0, 12).join(" · ")}` : `${ranges.length} date range(s) in the résumé, each accounted for` });
  const thin = roles.filter((r) => !(r.bullets ?? []).length); if (roles.length) c.push({ check: "Each role carries its content", status: thin.length ? "review" : "pass", detail: thin.length ? `no lines under: ${thin.map((r) => `${r.title} — ${r.company}`).join(" · ")}` : "every role has lines" });
  const first = Math.min(...roles.map((r) => when(r.start)?.y ?? 9999)); const span = first < 9999 ? new Date().getFullYear() - first : null;
  c.push({ check: "Total years of experience", status: rec.years_total == null ? "fail" : "review", detail: `Record says ${rec.years_total ?? "nothing"} years; the earliest role starts in ${first < 9999 ? first : "?"}${span != null ? ` (${span} calendar years ago, before any gap or overlap)` : ""}` });
  c.push({ check: "Education and skills", status: "review", detail: `${(rec.education ?? []).length} education entr${(rec.education ?? []).length === 1 ? "y" : "ies"}, ${(rec.skills ?? []).length} skills — compare with the original`, evidence: { education: rec.education ?? [], skills: (rec.skills ?? []).map((s: any) => (typeof s === "string" ? s : s?.name)) } });
  return section(c);
}

/** Radar's list for this person: what it recommended and why, what it turned down and why, and what it never looked at */
export function checkRadar(text: string, run: RunIn, targets: TargetsIn, jobs: JobIn[], startError: string | null) {
  if (startError) return { ...section([{ check: "Radar ran", status: "fail", detail: startError }]), recommended: [], rejected: [], not_considered: [] };
  if (!run) return { ...section([{ check: "Radar ran", status: "not_run", detail: "not run yet" }]), recommended: [], rejected: [], not_considered: [] };
  if (run.status !== "done") return { ...section([{ check: "Radar finished", status: run.status === "error" ? "fail" : "not_run", detail: `status ${run.status}${run.error ? `: ${run.error}` : ""}` }]), recommended: [], rejected: [], not_considered: [] };
  const by = new Map(jobs.map((j) => [j.url, j])); const c: Check[] = []; const shown = run.items.filter((i) => i.label);
  const recommended = shown.map((i) => { const j = by.get(i.url); return { slug: j?.slug ?? null, url: i.url, label: i.label, title: i.title, employer: i.company, fixture: j ? { function: j.fn, level: j.level, location: j.location, state: j.state } : null, why: i.why ?? "", near_miss: i.near ?? null, years_line: i.band_text ?? null }; });
  const shownTitles = new Set(shown.map((i) => `${norm(i.title)}|${norm(i.company)}`));
  const rejected = (run.trail ?? []).filter((t) => !t.chosen && !shownTitles.has(`${norm(t.title)}|${norm(t.company)}`)).map((t) => ({ title: t.title, employer: t.company, reason: t.dropped ?? "not chosen", radar_said: t.why ?? null, slug: jobs.find((j) => norm(j.title) === norm(t.title) && norm(j.employer) === norm(t.company))?.slug ?? null }));
  const touched = new Set([...shown.map((i) => i.url), ...rejected.map((r) => jobs.find((j) => j.slug === r.slug)?.url).filter(Boolean) as string[]]);
  const want = (targets?.titles ?? []).flatMap(key); const fnWords = (targets?.functions ?? []).flatMap(key);
  const not_considered = jobs.filter((j) => j.state === "live" && !touched.has(j.url)).map((j) => { const hit = key(j.title).filter((w) => want.includes(w)); const fn = key(j.fn).some((w) => fnWords.includes(w)); return { slug: j.slug, title: j.title, employer: j.employer, function: j.fn, level: j.level, location: j.location, possibly_missed: hit.length > 0 || fn, shares: hit.length ? `title words: ${hit.join(", ")}` : fn ? "same function as Radar's own reading of the person" : null }; });
  const missed = not_considered.filter((x) => x.possibly_missed);
  c.push({ check: "Radar's reading of the person", status: "review", detail: targets ? `level “${targets.level}”, ${targets.years} years, functions ${JSON.stringify(targets.functions ?? [])}, looking for ${JSON.stringify(targets.titles ?? [])}${targets.one_line ? ` — “${targets.one_line}”` : ""}` : "not available" });
  c.push({ check: "Recommendations made", status: shown.length ? "review" : "review", detail: `${run.pool ?? "?"} live roles in QA; ${run.by_title ?? 0} matched by title; ${run.examined ?? "?"} examined; ${run.dropped_band ?? 0} ruled out on years; ${shown.filter((i) => i.label === "for_you").length} for you, ${shown.filter((i) => i.label === "adjacent").length} adjacent, ${shown.filter((i) => i.label === "stretch").length} stretch${shown.length ? "" : ". Nothing was recommended: decide whether the fixtures hold anything for this person"}` });
  const closed = shown.filter((i) => by.get(i.url)?.state === "gone"), unknown = shown.filter((i) => !by.has(i.url)), away = shown.filter((i) => !/bengaluru|bangalore/i.test(by.get(i.url)?.location ?? i.location ?? ""));
  c.push({ check: "No closed role, unknown listing or role outside Bengaluru is recommended", status: closed.length || unknown.length || away.length ? "fail" : shown.length ? "pass" : "not_run", detail: [...closed.map((i) => `closed: ${i.title} — ${i.company}`), ...unknown.map((i) => `not a fixture: ${i.url}`), ...away.map((i) => `outside Bengaluru: ${i.title} — ${i.company} (${by.get(i.url)?.location ?? i.location})`)].join(" · ") || "none" });
  const own = shown.filter((i) => mentions(text, i.company)); c.push({ check: "No recommendation at an employer already on the résumé", status: own.length ? "review" : shown.length ? "pass" : "not_run", detail: own.length ? `on the résumé: ${own.map((i) => i.company).join(", ")} (a current employer should be left out; a past one may be fine)` : "none" });
  const src = new Set(figures(text)); const empty = shown.filter((i) => !String(i.why ?? "").trim());
  const loose = shown.flatMap((i) => { const jf = new Set(figures(by.get(i.url)?.text ?? "")); return figures(`${i.why ?? ""} ${i.near ?? ""}`).filter((n) => !src.has(n) && !jf.has(n)).map((n) => `${i.title} — ${i.company}: figure ${n} in “${String(i.why).slice(0, 90)}”`); });
  c.push({ check: "Relevance explanations: present, and every figure in them is in the résumé or the posting", status: empty.length || loose.length ? "fail" : shown.length ? "pass" : "not_run", detail: [...empty.map((i) => `no explanation: ${i.title} — ${i.company}`), ...loose].join(" · ") || `${shown.length} explanations, no unsupported figure` });
  c.push({ check: "Relevance explanations: true of this person, and the match is right", status: shown.length ? "review" : "not_run", detail: "read each recommendation against the original résumé (listed under recommended)" });
  c.push({ check: "Rejected roles: each rejection is right", status: rejected.length ? "review" : "not_run", detail: `${rejected.length} role(s) examined and turned down (listed under rejected, with Radar's reason)` });
  c.push({ check: "Missed roles: nothing relevant was left unexamined", status: missed.length ? "review" : "pass", detail: missed.length ? `${missed.length} live role(s) share a title word or function with Radar's own reading and were never examined: ${missed.slice(0, 15).map((m) => `${m.title} — ${m.employer}`).join(" · ")}` : `every live role sharing a title word or function with Radar's reading was examined (${not_considered.length} unrelated roles were not)` });
  return { ...section(c), recommended, rejected, not_considered };
}
