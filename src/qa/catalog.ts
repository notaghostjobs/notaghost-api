// One catalogue of QA candidates and job fixtures: the ones imported through the QA tools first, the built-in ones after.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { db } from "../lib/db.js";
import { store, now } from "./state.js";
import { CANDIDATES, EMPLOYERS, FUNCTIONS, GM, JOBS } from "./fixtures.js";
import type { JobImport, Truth } from "./truth.js";
import type { JobIn, MeterCase } from "./evaluate.js";

const PUBLIC = () => (process.env.QA_PUBLIC_URL ?? "").replace(/\/$/, "");
export const jobUrl = (slug: string) => `${PUBLIC()}/qa/jobs/${slug}`;
export const qaId = (n: number) => `QA${String(n).padStart(3, "0")}`;
export type Stored = { truth: Truth; pdf_path: string; sha256: string; pages: number; chars: number; bytes: number; imported_at: string; warnings: string[] };
export type ImportedRole = JobImport["roles"][number];

export const candKey = (id: string) => `qa:cand:${id}`;
export const getImported = (id: string) => store.get<Stored>(candKey(id));
export const listImported = async () => (await store.list<Stored>("qa:cand:", 200)).sort((a, b) => a.truth.id.localeCompare(b.truth.id));
export async function saveImported(id: string, truth: Truth, pdf: Buffer, meta: { pages: number; chars: number; warnings: string[] }): Promise<Stored> {
  const pdf_path = `qa-fixtures/${id}.pdf`;
  const up = await db.storage.from("resumes").upload(pdf_path, pdf, { contentType: "application/pdf", upsert: true }); if (up.error) throw new Error(`the PDF could not be stored: ${up.error.message}`);
  const row: Stored = { truth, pdf_path, sha256: createHash("sha256").update(pdf).digest("hex"), pages: meta.pages, chars: meta.chars, bytes: pdf.length, imported_at: now(), warnings: meta.warnings };
  await store.set(candKey(id), row); return row;
}
export async function removeImported(id: string) { const s = await getImported(id); if (!s) return false; await db.storage.from("resumes").remove([s.pdf_path]).then(() => {}, () => {}); await db.from("reader_control").delete().eq("key", candKey(id)); return true; }
/** the résumé file for a QA identity: the imported one, else the built-in one */
export async function resumeBytes(id: string): Promise<{ buf: Buffer; source: "imported" | "built-in" } | null> {
  const s = await getImported(id);
  if (s) { const d = await db.storage.from("resumes").download(s.pdf_path); if (d.data) return { buf: Buffer.from(await d.data.arrayBuffer()), source: "imported" }; }
  try { return { buf: await readFile(join(process.cwd(), "seed", "qa", "resumes", `${id}.pdf`)), source: "built-in" }; } catch { return null; }
}
/** what Radar is expected to do for a candidate, whichever catalogue they come from */
export async function expectedFor(n: number): Promise<{ name: string | null; covers: string | null; level: string | null; years: number | null; fn: string | null; for_you: string[]; never: string[]; sharpen_target: string | null; source: "imported" | "built-in" | null }> {
  const s = await getImported(qaId(n)); if (s) { const t = s.truth; return { name: t.person.name, covers: t.summary.covers, level: t.summary.level, years: t.summary.total_years, fn: t.summary.function, for_you: t.expected.radar.for_you, never: t.expected.radar.never, sharpen_target: t.expected.sharpen[0]?.job ?? t.expected.radar.for_you[0] ?? null, source: "imported" }; }
  const c = CANDIDATES.find((x) => x.n === n); if (!c) return { name: null, covers: null, level: null, years: null, fn: null, for_you: [], never: [], sharpen_target: null, source: null };
  return { name: c.name, covers: c.covers, level: c.level, years: c.years, fn: FUNCTIONS.find((f) => f.key === c.fn)?.name ?? c.fn, for_you: c.expect.for_you, never: c.expect.never, sharpen_target: c.expect.for_you[0] ?? null, source: "built-in" };
}

export const getJobs = async (): Promise<JobImport> => (await store.get<JobImport>("qa:jobs")) ?? { format: "ghosted-qa-jobs/1", employers: [], roles: [] };
/** imports merge by slug: a role or employer sent again replaces the earlier one */
export async function saveJobs(j: JobImport) { const cur = await getJobs(); const roles = new Map(cur.roles.map((r) => [r.slug, r])); for (const r of j.roles) roles.set(r.slug, r); const emps = new Map(cur.employers.map((e) => [e.slug, e])); for (const e of j.employers) emps.set(e.slug, e);
  const next: JobImport = { format: "ghosted-qa-jobs/1", employers: [...emps.values()], roles: [...roles.values()] }; await store.set("qa:jobs", next); return next; }
export async function allJobs(): Promise<JobIn[]> {
  const imp = await getJobs();
  return [...JOBS.map((j) => ({ slug: j.slug, url: jobUrl(j.slug), title: j.title, employer: j.employer, fn: FUNCTIONS.find((f) => f.key === j.fn)?.name ?? j.fn, level: j.level, location: "Bengaluru, Karnataka, India", state: j.state, text: j.text })),
    ...imp.roles.map((r) => ({ slug: r.slug, url: jobUrl(r.slug), title: r.title, employer: r.employer, fn: r.function, level: r.level, location: r.location, state: r.state, text: r.text }))];
}
export const knownJobSlugs = async () => new Set((await allJobs()).map((j) => j.slug));
export async function meterCases(): Promise<MeterCase[]> {
  const imp = await getJobs();
  return [...GM.map((g) => ({ slug: g.slug, url: jobUrl(g.slug), what: g.what, expected: g.expect, verdicts: g.verdicts, fire: g.signals?.fire ?? [], never: g.signals?.never ?? [] })),
    ...imp.roles.filter((r) => r.ghost_meter).map((r) => ({ slug: r.slug, url: jobUrl(r.slug), what: `${r.title} — ${r.employer}`, expected: r.ghost_meter!.note ?? "", verdicts: r.ghost_meter!.verdicts, fire: r.ghost_meter!.fire, never: r.ghost_meter!.never }))];
}
export const importedEmployer = async (slug: string) => (await getJobs()).employers.find((e) => e.slug === slug) ?? null;
export const employerSlug = async (name: string) => EMPLOYERS.find((e) => e.name === name)?.slug ?? (await getJobs()).employers.find((e) => e.name === name)?.slug ?? null;
