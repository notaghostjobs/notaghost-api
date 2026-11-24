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
/** What the key of a kept reading is made of. Any difference in one of these is a different reading:
 *  the engine version and this module's reading version (a change of prompt or rules), the model that reads, the title
 *  and the employer as the reader is shown them (the same paragraph under "Analyst" and under "Senior Manager" is not the
 *  same job), and the posting's text. Spacing and capitals do not count. A posting whose text is edited gets a new key;
 *  the old reading is simply never asked for again. */
export const READ_VERSION = "r1";
const norm = (x: string) => x.replace(/\s+/g, " ").trim().toLowerCase();
export const postingKey = (p: { title: string; company: string; text: string }, model: string) =>
  createHash("sha256").update([ENGINE_VERSION, READ_VERSION, model, norm(p.title), norm(p.company), norm(p.text)].join("\n")).digest("hex").slice(0, 32);
/** What the reader is given: the title and employer first, so they are context for the text and part of what is kept. */
export const readerText = (p: { title: string; company: string; text: string }) => `${p.title} | ${p.company}\n\n${p.text}`;

export type Posting = { id: string; title: string; company: string; text: string };
/** Readings under way, per store: a second request for the same posting waits for the first instead of paying again. */
const underWay = new WeakMap<object, Map<string, Promise<PostingProfile | null>>>();
/** What each posting asks. The same posting is read once: what is kept is not read again, two postings with the same key
 *  in one request are read once, and two requests at the same moment share one reading. `read` is Sharpen's
 *  parsePosting. Returns the requirements by posting id, how many readings this call started, and what could not be read. */
export async function requirementsFor(postings: Posting[], store: Store<PostingProfile>, read: (text: string) => Promise<PostingProfile>, model: string, atOnce = 6): Promise<{ by: Map<string, PostingProfile>; readNow: number; failed: string[] }> {
  const keyOf = new Map(postings.map((p) => [p.id, postingKey(p, model)]));
  const have = await store.get([...new Set(keyOf.values())]);
  const first = new Map<string, Posting>(); for (const p of postings) { const k = keyOf.get(p.id)!; if (!have.has(k) && !first.has(k)) first.set(k, p); }
  let pending = underWay.get(store); if (!pending) underWay.set(store, (pending = new Map()));
  let readNow = 0; const need = [...first.keys()];
  const one = (k: string): Promise<PostingProfile | null> => {
    const running = pending!.get(k); if (running) return running;
    readNow++;
    const job = (async () => { try { const r = clean(await read(readerText(first.get(k)!))); if (!r.must_have.length) return null; await store.put(k, r); return r; } catch { return null; } finally { pending!.delete(k); } })();
    pending!.set(k, job); return job;
  };
  for (let i = 0; i < need.length; i += atOnce) await Promise.all(need.slice(i, i + atOnce).map(async (k) => { const r = await one(k); if (r) have.set(k, r); }));
  const by = new Map<string, PostingProfile>(), failed: string[] = [];
  for (const p of postings) { const r = have.get(keyOf.get(p.id)!); if (r) by.set(p.id, r); else failed.push(p.id); }
  return { by, readNow, failed };
}
const list = (x: unknown, max: number) => (Array.isArray(x) ? x : []).map((s) => String(s ?? "").trim()).filter((s) => s.length > 3).slice(0, max);
const clean = (r: PostingProfile): PostingProfile => ({ ...r, must_have: list(r?.must_have, 14), nice_to_have: list(r?.nice_to_have, 6), company_language: list(r?.company_language, 10), red_flags: list(r?.red_flags, 6), years_required: String(r?.years_required ?? "") });

// ── the résumé as numbered lines: what evidence points at ─────────────────────────────────────────────────────────────
export function resumeLines(resume: string, max = 260): string[] {
  return resume.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 1).slice(0, max);
}
export type Answer = { ask: string; answer: string };
/** What the judge is shown of the person: the résumé's lines, numbered; then, apart and labelled, what they told us in
 *  answer to our questions, numbered on from there. `answersFrom` is the number of the first answer line (0 if none):
 *  evidence at or after it is the person's own statement, not their résumé, and is always recorded as such. */
export function personText(resume: string, answers: Answer[] = []): { lines: string[]; answersFrom: number; text: string } {
  const r = resumeLines(resume), a = answers.filter((x) => String(x?.answer ?? "").trim().length > 1).slice(0, 12).map((x) => `Asked: ${String(x.ask).replace(/\s+/g, " ").trim()} Answered: ${String(x.answer).replace(/\s+/g, " ").trim().slice(0, 300)}`);
  const lines = [...r, ...a]; const num = (l: string, i: number) => `${i + 1}| ${l}`;
  const text = "RÉSUMÉ\n" + r.map(num).join("\n") + (a.length ? "\n\nANSWERS THE PERSON GAVE US (their own statements; NOT on the résumé)\n" + a.map((l, i) => num(l, r.length + i)).join("\n") : "");
  return { lines, answersFrom: a.length ? r.length + 1 : 0, text };
}

// ── the judgement ────────────────────────────────────────────────────────────────────────────────────────────────────
export const JUDGE = `You compare one person's résumé with several job postings, requirement by requirement, the way a fair and careful recruiter would. The résumé is given as numbered lines. Each posting is given as its title and a numbered list of requirements (M = must-have, N = nice-to-have).

For every requirement of every posting give one verdict and the number of the ONE line that best supports it:
- "s" (said): a résumé line states it with specifics: the same activity on the same kind of thing. A plain equivalent counts ("lead a team through 1:1s" answers "mentor engineers").
- "l" (a line that could say it): a line shows the same work but in other words, or a little short of the requirement's scale.
- "k" (keyword only): the thing is only named, in a skills list or in passing, or the line is merely adjacent.
- "x" (missing): nothing points to this specific requirement. Use line 0.
The line you cite must itself show the thing: someone reading only that line and the requirement must agree. Generic words are not evidence of a specific requirement: "Leadership" is not "built a team of 5"; "Communication" is not "writes PRDs". Do not stretch across kinds of work: SAP delivery is not product management; customer support is not application support engineering; marketing campaigns are not marketing operations. A missing must-have is useful information, not a failure.
Lines under ANSWERS are what the person told us; they are NOT on the résumé. A requirement supported only by an answer is "l" at most, never "s", and you cite the answer's line number.

For every posting also give:
- "same_work": true only if this is the same kind of work the person has actually done (same function and a field they have worked in or one right beside it). An adjacent function that shares vocabulary is false.
- "seniority": "junior" (clearly below where they are: they would be stepping back), "right", "stretch" (one step up, plausible), or "out_of_reach" (two or more steps above, or it needs years or scope they do not have).
- "why": one sentence, at most 28 words, naming the strongest specific evidence for this posting, or the main reason it is not a fit. No praise. If it rests on an answer, say "you told us".

Also give "years": the person's total years of work after education, from the dates in the résumé, as a number (0 if it cannot be told).

Return JSON only: {"years": number, "jobs": [{"n": posting number, "same_work": true|false, "seniority": "...", "why": "...", "r": [["s"|"l"|"k"|"x", line number], ... one pair per requirement, in the order given]}]}`;

/** A second reader, shown only pairs of (requirement, cited line) and nothing else: not the posting, not the first verdict. */
export const AUDIT = `You check evidence. Each item is a job REQUIREMENT and one LINE quoted from a person's résumé (or from an answer they gave). Judging ONLY what the line itself says, does the line support the requirement?
- "yes": the line shows the same activity on the same kind of thing. A plain equivalent counts.
- "partial": related but weaker: adjacent work, a smaller scale, or the thing is only named.
- "no": the line does not show it. A heading, a job title alone, a generic trait, or a different kind of work is "no".
Do not assume anything the line does not say. Return JSON only: {"a": [[item id, "yes"|"partial"|"no"], ...]} with every item id exactly once.`;

export type Verdict = { n: number; same_work: boolean; seniority: "junior" | "right" | "stretch" | "out_of_reach"; why: string; r: [string, number][] };
export type Judged = { years: number; jobs: Verdict[] };
export type Support = "yes" | "partial" | "no";
export type Evaluation = {
  id: string; score: number; shown: boolean; reason: string | null;       // reason: why it is not shown, in plain words
  same_work: boolean; seniority: Verdict["seniority"]; why: string; gap: string;
  matches: Match[]; said: number; musts: number;
  unsupported: number;      // verdicts whose cited line did not hold up (in code or at the audit) and were counted as missing
  weakened: number;         // verdicts the audit found only partly supported, counted one step lower
  from_answers: number;     // requirements supported by something the person told us, not by the résumé (marked told on the match)
  audited: boolean;         // the second reader checked this role's evidence
};

/** The postings as the judge sees them. */
export function ask(postings: Posting[], req: Map<string, PostingProfile>): string {
  return postings.map((p, i) => { const r = req.get(p.id)!; return `POSTING ${i + 1}: ${p.title} | ${p.company}${r.years_required ? ` | asks: ${r.years_required}` : ""}\n` + [...r.must_have.map((m, j) => `${j + 1}. M ${m}`), ...r.nice_to_have.map((m, j) => `${r.must_have.length + j + 1}. N ${m}`)].join("\n"); }).join("\n\n");
}

const HEADING = /^[A-Z &/|:•\-–]{3,40}$/;   // "WORK EXPERIENCE", "SKILLS": a heading is not evidence
type B = { bucket: Match["bucket"]; kind?: "line" | "keyword" };
const BUCKET: Record<string, B> = { s: { bucket: "said" }, l: { bucket: "have_not_said", kind: "line" }, k: { bucket: "have_not_said", kind: "keyword" }, x: { bucket: "missing" } };
const lower = (b: B): B => (b.bucket === "said" ? BUCKET.l : b.kind === "line" ? BUCKET.k : b);
const content = (s: string) => new Set((s.toLowerCase().match(/[a-z][a-z0-9+#.]{2,}/g) ?? []).filter((w) => !/^(and|the|for|with|from|that|this|have|has|years?|experience|strong|ability|skills?|knowledge|work(ing)?|using|across|including|within)$/.test(w)).map((w) => w.replace(/(ing|ed|s)$/, "")));

/** One posting's verdicts turned into checked matches and a score. The model's word is not taken for the evidence:
 *  - in code: a cited line must exist, must not be a heading, and must say something; a "keyword" verdict must share a
 *    word with the requirement. A verdict that fails is counted as missing.
 *  - at the audit (`support`, by requirement number): "no" is counted as missing, "partial" one step lower.
 *  - evidence from an answer (line number at or after `answersFrom`) is never "said": it is marked told, and counts as a
 *    line that could say it. The résumé itself is not credited with it. */
export function settle(p: Posting, req: PostingProfile, v: Verdict | undefined, lines: string[], years: number, o: { answersFrom?: number; support?: Map<number, Support>; auditFailed?: boolean } = {}): Evaluation {
  const reqs = [...req.must_have.map((t) => ({ t, kind: "must" as const })), ...req.nice_to_have.map((t) => ({ t, kind: "nice" as const }))];
  let unsupported = 0, weakened = 0, fromAnswers = 0;
  const matches: Match[] = reqs.map((q, i) => {
    const pair = v?.r?.[i]; let b = BUCKET[String(pair?.[0] ?? "x")] ?? BUCKET.x; const n = Number(pair?.[1] ?? 0); const line = Number.isInteger(n) && n >= 1 ? lines[n - 1] : undefined;
    const told = !!o.answersFrom && n >= o.answersFrom;
    if (b.bucket !== "missing") {
      const ok = !!line && !HEADING.test(line) && line.split(" ").length >= 2 && (b.kind !== "keyword" || [...content(q.t)].some((w) => content(line).has(w)));
      if (!ok) { unsupported++; b = BUCKET.x; }
    }
    if (b.bucket !== "missing" && told && b.bucket === "said") b = BUCKET.l;
    const s = o.support?.get(i + 1);
    if (b.bucket !== "missing" && s === "no") { unsupported++; b = BUCKET.x; }
    else if (b.bucket !== "missing" && s === "partial" && lower(b) !== b) { weakened++; b = lower(b); }
    if (b.bucket !== "missing" && told) fromAnswers++;
    return { requirement: q.t, kind: q.kind, bucket: b.bucket, evidence: b.bucket === "missing" ? "" : line!, evidence_kind: b.kind, suggestion: "", ...(b.bucket !== "missing" && told ? { told: true } : {}) };
  });
  // the score: the engine's own fit. An answer is credited as a line that could say it (the engine gives a told fact
  // nothing because Sharpen sells the difference; here the person has simply told us, and we say so).
  const score = fit(matches.map((m) => (m.told ? { ...m, told: undefined } : m))); const musts = req.must_have.length, said = matches.filter((m) => m.kind === "must" && m.bucket === "said").length;
  const band = bandOf(req.years_required);
  const reason =
    !v ? "it could not be judged" :
    !v.same_work ? "it is a different kind of work" :
    v.seniority === "out_of_reach" ? "it is out of reach for now" :
    v.seniority === "junior" ? "it is a step back" :
    band && years > 0 && band.max !== null && years > band.max + 1 ? `it asks ${band.min}–${band.max} years` :
    band && years > 0 && years + 2 <= band.min ? `it asks ${band.min}+ years` :
    o.auditFailed ? "its evidence could not be checked" :
    unsupported > Math.max(2, reqs.length * 0.25) ? "the evidence did not hold up" :
    score < SHOW_FROM ? "too many of its must-haves are not on the résumé" : null;
  const gap = matches.find((m) => m.kind === "must" && m.bucket === "missing")?.requirement ?? "";
  return { id: p.id, score, shown: reason === null, reason, same_work: !!v?.same_work, seniority: v?.seniority ?? "out_of_reach", why: String(v?.why ?? "").slice(0, 320), gap: gap.slice(0, 260), matches, said, musts, unsupported, weakened, from_answers: fromAnswers, audited: !!o.support };
}
export const SHOW_FROM = 60;   // the score from which a role is offered: the free list's existing bar
/** "5-8 years", "8+ years", "minimum 3 yrs" as a band; null when the posting states none. */
export function bandOf(s: string): { min: number; max: number | null } | null {
  const t = String(s ?? ""); let m = t.match(/(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})/); if (m && Number(m[2]) >= Number(m[1]) && Number(m[2]) <= 40) return { min: Number(m[1]), max: Number(m[2]) };
  m = t.match(/(\d{1,2})\s*\+|(?:min(?:imum)?|at least|over)\s*(\d{1,2})|(\d{1,2})\s*(?:years|yrs)/i); const n = m ? Number(m[1] ?? m[2] ?? m[3]) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 40 ? { min: n, max: null } : null;
}

export type Deps = {
  store: Store<PostingProfile>; read: (text: string) => Promise<PostingProfile>;
  /** the model that reads postings: part of the key of what is kept */
  model: string;
  judge: (postings: string, person: string) => Promise<Judged>;
  /** the second reader. Required: there is no way to run this evaluation without the audit. */
  audit: (items: string) => Promise<{ a: [string, string][] }>;
};
/** The whole reading: requirements (kept), judgement in batches with the person's text pinned, the audit of every role
 *  that would be shown, then the rules. A call that fails leaves its roles unshown ("could not be judged", "its evidence
 *  could not be checked"), never guessed. */
export async function evaluate(resume: string, postings: Posting[], deps: Deps, o: { answers?: Answer[]; perCall?: number } = {}): Promise<{ evals: Evaluation[]; years: number; readNow: number; calls: number; auditCalls: number; audited: number }> {
  const person = personText(resume, o.answers), lines = person.lines, perCall = o.perCall ?? 8;
  const { by, readNow } = await requirementsFor(postings, deps.store, deps.read, deps.model);
  const ready = postings.filter((p) => by.has(p.id)); const out = new Map<string, Evaluation>(); let years = 0, calls = 0, auditCalls = 0, audited = 0;
  const batches: Posting[][] = []; for (let i = 0; i < ready.length; i += perCall) batches.push(ready.slice(i, i + perCall));
  const verdictOf = new Map<string, Verdict | undefined>();
  const run = async (b: Posting[]) => {
    calls++; let got: Judged | null = null; try { got = await deps.judge(ask(b, by), person.text); } catch { got = null; }
    if (got && Number.isFinite(Number(got.years)) && Number(got.years) > 0 && !years) years = Math.min(50, Number(got.years));
    return { b, got };
  };
  // the first batch alone, so the pinned text is written to the cache once; the rest together, reading it
  const done = batches.length ? [await run(batches[0]), ...(await Promise.all(batches.slice(1).map(run)))] : [];
  for (const { b, got } of done) b.forEach((p, i) => { const v = got?.jobs?.find((j) => Number(j.n) === i + 1); verdictOf.set(p.id, v); out.set(p.id, settle(p, by.get(p.id)!, v, lines, years, { answersFrom: person.answersFrom })); });
  // the audit: every role that would be shown has each piece of its evidence read again, on its own
  {
    const cand = ready.filter((p) => out.get(p.id)?.shown); const items: string[] = [];
    cand.forEach((p, pi) => out.get(p.id)!.matches.forEach((m, ri) => { if (m.bucket !== "missing") items.push(`[${pi + 1}.${ri + 1}] REQUIREMENT: ${m.requirement}\nLINE: ${m.evidence}`); }));
    const got = new Map<string, Support>(); let failed = false;
    for (let i = 0; i < items.length && !failed; i += 90) { auditCalls++; try { if (typeof deps.audit !== "function") throw new Error("no auditor"); const r = await deps.audit(items.slice(i, i + 90).join("\n\n")); for (const [id, s] of r?.a ?? []) got.set(String(id).replace(/[\[\]]/g, ""), s === "yes" || s === "partial" ? s : "no"); } catch { failed = true; } }
    cand.forEach((p, pi) => {
      const support = new Map<number, Support>(); out.get(p.id)!.matches.forEach((m, ri) => { if (m.bucket !== "missing") support.set(ri + 1, got.get(`${pi + 1}.${ri + 1}`) ?? "no"); });   // an item the auditor skipped is not taken on trust
      out.set(p.id, settle(p, by.get(p.id)!, verdictOf.get(p.id), lines, years, { answersFrom: person.answersFrom, support, auditFailed: failed })); if (!failed) audited++;
    });
  }
  const none = (p: Posting): Evaluation => ({ id: p.id, score: 0, shown: false, reason: "its requirements could not be read", same_work: false, seniority: "out_of_reach", why: "", gap: "", matches: [], said: 0, musts: 0, unsupported: 0, weakened: 0, from_answers: 0, audited: false });
  return { evals: postings.map((p) => out.get(p.id) ?? none(p)), years, readNow, calls, auditCalls, audited };
}

/** Up to `keep`, best first, at most `perEmployer` from one employer, only roles that passed every rule. One or two is a
 *  list; none is an empty list. Nothing is added to make five. */
export function shortlist(evals: Evaluation[], employerOf: (id: string) => string, keep = 5, perEmployer = 2): Evaluation[] {
  const per = new Map<string, number>(), out: Evaluation[] = [];
  for (const e of evals.filter((e) => e.shown).sort((a, b) => b.score - a.score || b.said - a.said)) {
    const k = employerOf(e.id).toLowerCase(), n = per.get(k) ?? 0; if (n >= perEmployer) continue;
    per.set(k, n + 1); out.push(e); if (out.length >= keep) break;
  }
  return out;
}
