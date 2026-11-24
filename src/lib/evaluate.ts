// The careful reading of a person against the roles chosen for them: what each posting asks, whether the résumé answers
// it, and where. One standard for the free list, Radar and Sharpen:
//   - what a posting asks is read once per posting text (Sharpen's own parsePosting) and kept, shared by everyone;
//   - a person is judged against it requirement by requirement, each answer pointing at a numbered line of their résumé;
//   - code, not the model, checks that the line exists and says something, gives the score (engine/fit), applies the
//     years band, the seniority and same-work verdicts and the employer limit, and returns up to five. Fewer, or none,
//     when fewer are a real shot: nothing is added to make five.
// The model calls are passed in, so every rule here is tested without a model.
import { createHash } from "node:crypto";
import type { PostingProfile, Match } from "../engine/sharpen.js";
import { fit, ENGINE_VERSION } from "../engine/fit.js";

export const EVAL_VERSION = "e1";   // the judging prompt and the rules below; a change here starts a fresh set of stored judgements

// ── what a posting asks: read once, kept by the fingerprint of its text ───────────────────────────────────────────────
export type Store<T> = { get(keys: string[]): Promise<Map<string, T>>; put(key: string, value: T): Promise<void> };
/** Kept in this process only. The table that keeps it across restarts and between products is proposed separately. */
export function memoryStore<T>(max = 5000): Store<T> & { size(): number } {
  const m = new Map<string, T>();
  return { size: () => m.size, async get(keys) { const out = new Map<string, T>(); for (const k of keys) { const v = m.get(k); if (v !== undefined) out.set(k, v); } return out; },
    async put(k, v) { if (m.size >= max && !m.has(k)) m.delete(m.keys().next().value as string); m.set(k, v); } };
}
/** The same posting text gives the same key, whichever employer page or id it came from; a new engine version a new key. */
export const postingKey = (text: string) => createHash("sha256").update(`${ENGINE_VERSION}\n${text.replace(/\s+/g, " ").trim().toLowerCase()}`).digest("hex").slice(0, 32);

export type Posting = { id: string; title: string; company: string; text: string };
/** What each posting asks. Postings with the same text are read once; what is already kept is not read again.
 *  `read` is Sharpen's parsePosting. Returns the requirements by posting id, and how many had to be read now. */
export async function requirementsFor(postings: Posting[], store: Store<PostingProfile>, read: (text: string) => Promise<PostingProfile>, atOnce = 6): Promise<{ by: Map<string, PostingProfile>; readNow: number; failed: string[] }> {
  const keyOf = new Map(postings.map((p) => [p.id, postingKey(p.text)]));
  const have = await store.get([...new Set(keyOf.values())]);
  const need = [...new Set(postings.map((p) => keyOf.get(p.id)!).filter((k) => !have.has(k)))];
  const textOf = new Map(postings.map((p) => [keyOf.get(p.id)!, p.text])); const failed: string[] = [];
  for (let i = 0; i < need.length; i += atOnce) {
    await Promise.all(need.slice(i, i + atOnce).map(async (k) => {
      try { const r = clean(await read(textOf.get(k)!)); if (r.must_have.length) { have.set(k, r); await store.put(k, r); } else failed.push(k); } catch { failed.push(k); }
    }));
  }
  const by = new Map<string, PostingProfile>(); for (const p of postings) { const r = have.get(keyOf.get(p.id)!); if (r) by.set(p.id, r); }
  return { by, readNow: need.length - failed.length, failed: postings.filter((p) => failed.includes(keyOf.get(p.id)!)).map((p) => p.id) };
}
const list = (x: unknown, max: number) => (Array.isArray(x) ? x : []).map((s) => String(s ?? "").trim()).filter((s) => s.length > 3).slice(0, max);
const clean = (r: PostingProfile): PostingProfile => ({ ...r, must_have: list(r?.must_have, 14), nice_to_have: list(r?.nice_to_have, 6), company_language: list(r?.company_language, 10), red_flags: list(r?.red_flags, 6), years_required: String(r?.years_required ?? "") });

// ── the résumé as numbered lines: what evidence points at ─────────────────────────────────────────────────────────────
export function resumeLines(resume: string, max = 260): string[] {
  return resume.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 1).slice(0, max);
}
export const numbered = (lines: string[]) => lines.map((l, i) => `${i + 1}| ${l}`).join("\n");

// ── the judgement ────────────────────────────────────────────────────────────────────────────────────────────────────
export const JUDGE = `You compare one person's résumé with several job postings, requirement by requirement, the way a fair and careful recruiter would. The résumé is given as numbered lines. Each posting is given as its title and a numbered list of requirements (M = must-have, N = nice-to-have).

For every requirement of every posting give one verdict and the number of the ONE résumé line that best supports it:
- "s" (said): a line states it with specifics: the same activity on the same kind of thing. A plain equivalent counts ("lead a team through 1:1s" answers "mentor engineers").
- "l" (a line that could say it): a line shows the same work but in other words, or a little short of the requirement's scale.
- "k" (keyword only): the thing is only named, in a skills list or in passing, or the line is merely adjacent.
- "x" (missing): nothing in the résumé points to this specific requirement. Use line 0.
Generic words are not evidence of a specific requirement: "Leadership" is not "built a team of 5"; "Communication" is not "writes PRDs". Do not stretch across kinds of work: SAP delivery is not product management; customer support is not application support engineering; marketing campaigns are not marketing operations. A missing must-have is useful information, not a failure. Never cite a line that does not show the thing.

For every posting also give:
- "same_work": true only if this is the same kind of work the person has actually done (same function and a field they have worked in or one right beside it). An adjacent function that shares vocabulary is false.
- "seniority": "junior" (clearly below where they are: they would be stepping back), "right", "stretch" (one step up, plausible), or "out_of_reach" (two or more steps above, or it needs years or scope they do not have).
- "why": one sentence, at most 28 words, naming the strongest specific evidence for this posting from the résumé, or the main reason it is not a fit. No praise.

Also give "years": the person's total years of work after education, from the dates in the résumé, as a number (0 if it cannot be told).

Return JSON only: {"years": number, "jobs": [{"n": posting number, "same_work": true|false, "seniority": "...", "why": "...", "r": [["s"|"l"|"k"|"x", line number], ... one pair per requirement, in the order given]}]}`;

export type Verdict = { n: number; same_work: boolean; seniority: "junior" | "right" | "stretch" | "out_of_reach"; why: string; r: [string, number][] };
export type Judged = { years: number; jobs: Verdict[] };
export type Evaluation = {
  id: string; score: number; shown: boolean; reason: string | null;       // reason: why it is not shown, in plain words
  same_work: boolean; seniority: Verdict["seniority"]; why: string; gap: string;
  matches: Match[]; said: number; musts: number; unsupported: number;      // unsupported: verdicts whose cited line did not hold up
};

/** The postings as the judge sees them. */
export function ask(postings: Posting[], req: Map<string, PostingProfile>): string {
  return postings.map((p, i) => { const r = req.get(p.id)!; return `POSTING ${i + 1}: ${p.title} | ${p.company}${r.years_required ? ` | asks: ${r.years_required}` : ""}\n` + [...r.must_have.map((m, j) => `${j + 1}. M ${m}`), ...r.nice_to_have.map((m, j) => `${r.must_have.length + j + 1}. N ${m}`)].join("\n"); }).join("\n\n");
}

const HEADING = /^[A-Z &/|:•\-–]{3,40}$/;   // "WORK EXPERIENCE", "SKILLS": a heading is not evidence
const BUCKET: Record<string, { bucket: Match["bucket"]; kind?: "line" | "keyword" }> = { s: { bucket: "said" }, l: { bucket: "have_not_said", kind: "line" }, k: { bucket: "have_not_said", kind: "keyword" }, x: { bucket: "missing" } };
const content = (s: string) => new Set((s.toLowerCase().match(/[a-z][a-z0-9+#.]{2,}/g) ?? []).filter((w) => !/^(and|the|for|with|from|that|this|have|has|years?|experience|strong|ability|skills?|knowledge|work(ing)?|using|across|including|within)$/.test(w)).map((w) => w.replace(/(ing|ed|s)$/, "")));

/** One posting's verdicts turned into checked matches and a score. The model's word is not taken for the evidence:
 *  a cited line must exist, must not be a heading, and must say something; a "keyword" verdict must share a word with the
 *  requirement. A verdict that fails is counted as missing and noted. */
export function settle(p: Posting, req: PostingProfile, v: Verdict | undefined, lines: string[], years: number): Evaluation {
  const reqs = [...req.must_have.map((t) => ({ t, kind: "must" as const })), ...req.nice_to_have.map((t) => ({ t, kind: "nice" as const }))];
  let unsupported = 0;
  const matches: Match[] = reqs.map((q, i) => {
    const pair = v?.r?.[i]; let b = BUCKET[String(pair?.[0] ?? "x")] ?? BUCKET.x; const n = Number(pair?.[1] ?? 0); const line = Number.isInteger(n) && n >= 1 ? lines[n - 1] : undefined;
    if (b.bucket !== "missing") {
      const ok = !!line && !HEADING.test(line) && line.split(" ").length >= 2 && (b.kind !== "keyword" || [...content(q.t)].some((w) => content(line).has(w)));
      if (!ok) { unsupported++; b = BUCKET.x; }
    }
    return { requirement: q.t, kind: q.kind, bucket: b.bucket, evidence: b.bucket === "missing" ? "" : line!, evidence_kind: b.kind, suggestion: "" };
  });
  const score = fit(matches); const musts = req.must_have.length, said = matches.filter((m) => m.kind === "must" && m.bucket === "said").length;
  const band = bandOf(req.years_required);
  const reason =
    !v ? "it could not be judged" :
    !v.same_work ? "it is a different kind of work" :
    v.seniority === "out_of_reach" ? "it is out of reach for now" :
    v.seniority === "junior" ? "it is a step back" :
    band && years > 0 && band.max !== null && years > band.max + 1 ? `it asks ${band.min}–${band.max} years` :
    band && years > 0 && years + 2 <= band.min ? `it asks ${band.min}+ years` :
    unsupported > Math.max(2, reqs.length * 0.25) ? "the evidence did not hold up" :
    score < SHOW_FROM ? "too many of its must-haves are not on the résumé" : null;
  const gap = matches.find((m) => m.kind === "must" && m.bucket === "missing")?.requirement ?? "";
  return { id: p.id, score, shown: reason === null, reason, same_work: !!v?.same_work, seniority: v?.seniority ?? "out_of_reach", why: String(v?.why ?? "").slice(0, 320), gap: gap.slice(0, 260), matches, said, musts, unsupported };
}
export const SHOW_FROM = 60;   // the score from which a role is offered: the free list's existing bar
/** "5-8 years", "8+ years", "minimum 3 yrs" as a band; null when the posting states none. */
export function bandOf(s: string): { min: number; max: number | null } | null {
  const t = String(s ?? ""); let m = t.match(/(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})/); if (m && Number(m[2]) >= Number(m[1]) && Number(m[2]) <= 40) return { min: Number(m[1]), max: Number(m[2]) };
  m = t.match(/(\d{1,2})\s*\+|(?:min(?:imum)?|at least|over)\s*(\d{1,2})|(\d{1,2})\s*(?:years|yrs)/i); const n = m ? Number(m[1] ?? m[2] ?? m[3]) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 40 ? { min: n, max: null } : null;
}

/** The whole reading: requirements (kept), judgement in batches with the résumé pinned, then the rules. `judge` is one
 *  model call: (the postings as text, the numbered résumé) → Judged. A batch that fails is judged "could not be judged",
 *  never guessed. */
export async function evaluate(resume: string, postings: Posting[], deps: { store: Store<PostingProfile>; read: (text: string) => Promise<PostingProfile>; judge: (postings: string, resume: string) => Promise<Judged> }, perCall = 8): Promise<{ evals: Evaluation[]; years: number; readNow: number; calls: number }> {
  const lines = resumeLines(resume), pinned = numbered(lines);
  const { by, readNow } = await requirementsFor(postings, deps.store, deps.read);
  const ready = postings.filter((p) => by.has(p.id)); const out = new Map<string, Evaluation>(); let years = 0, calls = 0;
  const batches: Posting[][] = []; for (let i = 0; i < ready.length; i += perCall) batches.push(ready.slice(i, i + perCall));
  const run = async (b: Posting[]) => {
    calls++; let got: Judged | null = null; try { got = await deps.judge(ask(b, by), pinned); } catch { got = null; }
    if (got && Number.isFinite(Number(got.years)) && Number(got.years) > 0 && !years) years = Math.min(50, Number(got.years));
    return { b, got };
  };
  // the first batch alone, so the pinned résumé is written to the cache once; the rest together, reading it
  const done = batches.length ? [await run(batches[0]), ...(await Promise.all(batches.slice(1).map(run)))] : [];
  for (const { b, got } of done) b.forEach((p, i) => out.set(p.id, settle(p, by.get(p.id)!, got?.jobs?.find((j) => Number(j.n) === i + 1), lines, years)));
  return { evals: postings.map((p) => out.get(p.id) ?? { id: p.id, score: 0, shown: false, reason: "its requirements could not be read", same_work: false, seniority: "out_of_reach", why: "", gap: "", matches: [], said: 0, musts: 0, unsupported: 0 }), years, readNow, calls };
}

/** Up to `keep`, best first, at most `perEmployer` from one employer, only roles that passed every rule. May be empty. */
export function shortlist(evals: Evaluation[], employerOf: (id: string) => string, keep = 5, perEmployer = 2): Evaluation[] {
  const per = new Map<string, number>(), out: Evaluation[] = [];
  for (const e of evals.filter((e) => e.shown).sort((a, b) => b.score - a.score || b.said - a.said)) {
    const k = employerOf(e.id).toLowerCase(), n = per.get(k) ?? 0; if (n >= perEmployer) continue;
    per.set(k, n + 1); out.push(e); if (out.length >= keep) break;
  }
  return out;
}
