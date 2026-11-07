// Radar (test build, 7 Nov): from the résumé on file, the live Bengaluru openings this person has a real shot at — ranked,
// each with the fit engine's number now and if sharpened. Flow: profile → what they're a fit for (one model call) →
// five confirm-not-type questions → shortlist from the live sightings (title and level, ₹0) → the model picks the
// plausible sixty from titles alone (one call) → the fit engine on each (the same match + audited lines as the preview,
// posting checklist cached per sighting) → stored per user, filled progressively. No payment, no shot: /radar/test only.
import { Hono } from "hono";
import { z } from "zod";
import { db, type User } from "../lib/db.js";
import { requireUser } from "../lib/auth.js";
import { isTester } from "../lib/testers.js";
import { json, MODEL } from "../engine/claude.js";
import { parsePosting, matchAndGrade, type ResumeProfile, type PostingProfile, type Match } from "../engine/sharpen.js";
import { assess } from "../engine/fit.js";
import { gapsOf, fillOptions, assembleLine, shapeFree, acceptInto, withdrawFrom, recallAnswers, rememberAnswer, forgetAnswer, applyRemembered, sameRequirement, type Facts, type Gap } from "../engine/told.js";

export const radar = new Hono<{ Variables: { user: User } }>();
/** Public: the market's pulse — roles that came in and went quiet per day, across every employer we read. No sign-in. */
export const radarPublic = new Hono();
radar.use("*", requireUser);

type Targets = { titles: string[]; level: "ic" | "lead" | "manager" | "head"; functions: string[]; strengths: string[]; years: number; one_line: string };
type Answers = { titles: string[]; level: Targets["level"]; stretch: boolean; avoid: string[]; notes?: string };
type Item = { sighting_id: number; title: string; company: string; location: string; url: string; posted_at: string | null; first_seen: string; why: string;
  now?: number; promised?: number; band?: string; said?: number; unsaid?: number; missing?: number; top_said?: string[]; top_unsaid?: string[]; top_missing?: string[]; error?: string };
type Run = { status: "targets" | "shortlist" | "picking" | "scoring" | "questions" | "done" | "error"; started: string; finished?: string; answers: Answers; resume_id: string;
  pool: number; by_title: number; picked: number; scored: number; items: Item[]; error?: string; cost_calls: number;
  questions?: Gap[];            // the missing must-haves that repeat across the picked roles, asked once
  shots?: number; within_reach?: number; threshold: number };
/** A real shot: sharpened ≥ 75 (decided 7 Nov). Under 50 is never shown. */
const SHOT = 75, REACH = 50;

const LEVEL_WORDS: Record<Targets["level"], RegExp> = {
  ic: /\b(associate|analyst|executive|specialist|engineer|developer|designer|coordinator|consultant|officer|intern|trainee|junior|ii|iii)\b/i,
  lead: /\b(senior|sr\.?|lead|principal|staff|manager|supervisor)\b/i,
  manager: /\b(manager|head|lead|director|avp|dgm|agm|gm)\b/i,
  head: /\b(head|director|vp|vice president|avp|svp|chief|president|general manager|gm)\b/i,
};
const norm = (t: string) => (t ?? "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const STOP = new Set(["and", "the", "of", "for", "in", "to", "with", "a", "an", "at", "on", "or", "&", "ii", "iii", "i", "india", "bengaluru", "bangalore", "remote"]);
const words = (t: string) => norm(t).split(" ").filter((w) => w && !STOP.has(w) && w.length > 1);
const stem = (w: string) => w.replace(/(ies)$/, "y").replace(/(ing|ers?|s)$/, "");

const currentResume = async (userId: string) => {
  const { data } = await db.from("resumes").select("id, parsed").eq("user_id", userId).eq("is_current", true).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (data?.parsed) return { id: data.id as string, parsed: data.parsed as ResumeProfile };
  const { data: any } = await db.from("resumes").select("id, parsed").eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  return any?.parsed ? { id: any.id as string, parsed: any.parsed as ResumeProfile } : null;
};
const kv = {
  async get<T>(key: string): Promise<T | null> { const { data } = await db.from("reader_control").select("value").eq("key", key).maybeSingle(); return (data?.value as T) ?? null; },
  async set(key: string, value: unknown) { await db.from("reader_control").upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" }); },
};

/** What this person is a fit for, from the profile alone — the questionnaire is pre-filled from it. */
async function deriveTargets(p: ResumeProfile): Promise<Targets> {
  const brief = { headline: p.headline, years: p.years_total, roles: (p.roles ?? []).slice(0, 6).map((r) => ({ company: r.company, title: r.title, start: r.start, end: r.end, bullets: (r.bullets ?? []).slice(0, 4) })), skills: (p.skills ?? []).slice(0, 14).map((s: any) => s?.name ?? s) };
  return json<Targets>(
    `You read a candidate's profile and say what roles they are a realistic fit for in Bengaluru today — the titles a recruiter would shortlist them for, not aspirations. Be concrete and conventional in title wording (the words employers use on their own careers pages).`,
    `Profile:\n${JSON.stringify(brief)}\n\nReturn: {titles: 6 to 8 job titles they would be shortlisted for today, most likely first (mix the exact current title, its common variants, and one adjacent title); level: one of "ic" | "lead" | "manager" | "head" (where they sit now); functions: 3-4 functional areas; strengths: 3 short phrases of what their résumé proves best; years: total years as a number; one_line: one sentence a recruiter would use to describe them}`,
    1200
  );
}

type Sighting = { id: number; title: string; company_name: string | null; location: string | null; url: string; posted_at: string | null; first_seen: string; employer_key: string | null; readable?: boolean };
let poolCache: { at: number; rows: Sighting[] } | null = null;
/** Every live Bengaluru sighting (title, employer, location, url), marked readable when its description is on file.
 *  The pulse counts all of them; scoring uses the readable ones. Cached in memory for 30 minutes. */
async function livePool(): Promise<Sighting[]> {
  if (poolCache && Date.now() - poolCache.at < 30 * 60e3) return poolCache.rows;
  const rows: Sighting[] = [];
  for (let from = 0; from < 80000; from += 1000) {
    const { data, error } = await db.from("sightings").select("id, title, company_name, location, url, posted_at, first_seen, employer_key").eq("blr", true).is("gone_at", null).order("id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Sighting[]));
    if (!data || data.length < 1000) break;
  }
  const readable = new Set<number>();
  for (let from = 0; from < 80000; from += 1000) {
    const { data, error } = await db.from("sightings").select("id").eq("blr", true).is("gone_at", null).not("description", "is", null).order("id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) readable.add((r as any).id);
    if (!data || data.length < 1000) break;
  }
  for (const r of rows) r.readable = readable.has(r.id);
  poolCache = { at: Date.now(), rows };
  return rows;
}
/** The reader's first days (25–27 Oct) were seeding: thousands "came in" because we started reading, not because they opened.
 *  The pulse shows nothing for days before this. */
const PULSE_SINCE = "2026-10-28";

type Gone = { id: number; title: string; company_name: string | null; employer_key: string | null; gone_at: string };
let goneCache: { at: number; rows: Gone[] } | null = null;
/** Bengaluru sightings that went quiet in the last 15 days (title, employer, when). Cached 30 minutes. */
async function gonePool(): Promise<Gone[]> {
  if (goneCache && Date.now() - goneCache.at < 30 * 60e3) return goneCache.rows;
  const since = new Date(Date.now() - 15 * 86400e3).toISOString();
  const rows: Gone[] = [];
  for (let from = 0; from < 40000; from += 1000) {
    const { data, error } = await db.from("sightings").select("id, title, company_name, employer_key, gone_at").eq("blr", true).gte("gone_at", since).order("id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Gone[]));
    if (!data || data.length < 1000) break;
  }
  goneCache = { at: Date.now(), rows };
  return rows;
}
const dayKey = (iso: string) => new Date(new Date(iso).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);   // IST calendar day
/** Fourteen days of came-in / went-quiet, oldest first, today last. `keep` filters both pools (personal strips). */
export async function pulse(keep?: (title: string) => boolean) {
  const [live, gone] = await Promise.all([livePool(), gonePool()]);
  const days: { day: string; in: number; out: number }[] = [];
  for (let i = 13; i >= 0; i--) days.push({ day: dayKey(new Date(Date.now() - i * 86400e3).toISOString()), in: 0, out: 0 });
  const idx = new Map(days.map((d, i) => [d.day, i]));
  let liveN = 0; const employers = new Set<string>();
  for (const s of live) { if (keep && !keep(s.title ?? "")) continue; liveN++; employers.add(s.employer_key ?? s.company_name ?? ""); const i = idx.get(dayKey(s.first_seen)); if (i !== undefined) days[i].in++; }
  for (const g of gone) { if (keep && !keep(g.title ?? "")) continue; const i = idx.get(dayKey(g.gone_at)); if (i !== undefined) days[i].out++; }
  const today = days[days.length - 1];
  return { days: days.filter((d) => d.day >= PULSE_SINCE), today_in: today.in, today_out: today.out, live: liveN, employers: employers.size };
}
let readTotal: { at: number; n: number } | null = null;
async function postingsRead(): Promise<number> {
  if (readTotal && Date.now() - readTotal.at < 3600e3) return readTotal.n;
  const { count } = await db.from("sightings").select("*", { count: "exact", head: true });
  readTotal = { at: Date.now(), n: count ?? 0 }; return readTotal.n;
}

/** Title match, ₹0: overlap between the sighting's title and any target title, with a level check. */
function titleScore(title: string, targets: string[][], level: Targets["level"], stretch: boolean): number {
  const tw = words(title).map(stem); if (!tw.length) return 0;
  let best = 0;
  for (const tg of targets) {
    const set = new Set(tg.map(stem));
    const hit = tw.filter((w) => set.has(w)).length;
    const s = hit / Math.max(tg.length, 1) * 0.7 + hit / tw.length * 0.3;
    if (s > best) best = s;
  }
  if (best === 0) return 0;
  const lv = LEVEL_WORDS[level].test(title);
  const senior = /\b(head|director|vp|vice president|svp|chief|president)\b/i.test(title);
  const junior = /\b(intern|trainee|fresher|junior|apprentice)\b/i.test(title);
  if (level !== "head" && senior) best *= stretch ? 0.6 : 0.3;
  if (level !== "ic" && junior) best *= 0.2;
  if (!lv && !stretch) best *= 0.85;
  return best;
}

/** One model call reads titles only and picks the plausible sixty. */
async function pickSixty(p: ResumeProfile, t: Targets, a: Answers, cands: Sighting[]): Promise<{ id: number; why: string }[]> {
  const lines = cands.map((s) => `${s.id} | ${s.title} | ${s.company_name ?? ""} | ${(s.location ?? "").slice(0, 40)}`).join("\n");
  const r = await json<{ picks: { id: number; why: string }[] }>(
    `You are a Bengaluru recruiter choosing which live openings to put in front of ONE candidate. You see only titles, employers and locations. Pick the openings this candidate would realistically be shortlisted for: same function, same or one-step-adjacent level, employers where that profile is hired. Exclude roles clearly above or below their level, different functions that merely share a word, and anything on their avoid list. Up to 120 picks, best first; fewer if fewer fit. For each, one short reason (≤12 words) a recruiter would give.`,
    `Candidate: ${t.one_line}\nYears: ${t.years}. Level now: ${a.level}${a.stretch ? " (open to one step up)" : ""}.\nTitles they'd take: ${a.titles.join("; ")}\nFunctions: ${t.functions.join("; ")}\nStrengths: ${t.strengths.join("; ")}\nAvoid: ${a.avoid.join("; ") || "nothing"}\nNotes: ${a.notes ?? ""}\n\nOpenings (id | title | employer | location):\n${lines}\n\nReturn: {picks: [{id, why}]}`,
    8000, MODEL
  );
  const ok = new Set(cands.map((c) => c.id));
  return (r.picks ?? []).filter((x) => ok.has(Number(x.id))).map((x) => ({ id: Number(x.id), why: String(x.why ?? "").slice(0, 120) })).slice(0, 120);
}

/** The posting checklist for a sighting — parsed once, shared by every candidate. */
async function postingFor(sightingId: number): Promise<{ posting: PostingProfile; text: string } | null> {
  const key = `radar:pp:${sightingId}`;
  const cached = await kv.get<{ posting: PostingProfile }>(key);
  const { data } = await db.from("sightings").select("description").eq("id", sightingId).maybeSingle();
  const text = (data?.description as string) ?? "";
  if (text.length < 200) return null;
  if (cached?.posting) return { posting: cached.posting, text };
  const posting = await parsePosting(text);
  const thin = ((posting?.must_have?.length ?? 0) + (posting?.nice_to_have?.length ?? 0)) < 3;
  if (thin) return null;
  await kv.set(key, { posting, at: new Date().toISOString() });
  return { posting, text };
}

function summarise(it: Item, matches: Match[]) {
  const a = assess(matches);
  const said = matches.filter((m) => m.bucket === "said"), unsaid = matches.filter((m) => m.bucket === "have_not_said"), missing = matches.filter((m) => m.bucket === "missing");
  Object.assign(it, { now: a.current, promised: a.promised, band: a.band, said: said.length, unsaid: unsaid.length, missing: missing.length,
    top_said: said.filter((m) => m.kind === "must").slice(0, 3).map((m) => m.requirement), top_unsaid: unsaid.filter((m) => m.sayable).slice(0, 3).map((m) => m.requirement), top_missing: missing.filter((m) => m.kind === "must").slice(0, 3).map((m) => m.requirement) });
}
function tally(run: Run) {
  run.shots = run.items.filter((i) => (i.promised ?? 0) >= SHOT).length;
  run.within_reach = run.items.filter((i) => (i.promised ?? 0) >= REACH && (i.promised ?? 0) < SHOT).length;
}
/** The missing must-haves that come up again and again across the picked roles — the ten most common, with the three
 *  honest ways of having done each (the same cards as the Sharpen questionnaire). One answer lifts every role that asked. */
async function commonQuestions(userId: string, items: Item[]): Promise<Gap[]> {
  const groups: { requirement: string; kind: "must" | "nice"; n: number; weight: number }[] = [];
  for (const it of items) {
    if (typeof it.now !== "number") continue;
    const m = await kv.get<{ matches: Match[] }>(`radar:m:${userId}:${it.sighting_id}`); if (!m) continue;
    for (const x of m.matches) {
      if (x.bucket !== "missing" || x.told) continue;
      const g = groups.find((g) => sameRequirement(g.requirement, x.requirement));
      if (g) { g.n++; if (x.kind === "must") g.weight += 2; else g.weight += 1; } else groups.push({ requirement: x.requirement, kind: x.kind, n: 1, weight: x.kind === "must" ? 2 : 1 });
    }
  }
  const top = groups.filter((g) => g.n >= 2).sort((a, b) => b.weight - a.weight || b.n - a.n).slice(0, 10);
  if (!top.length) return [];
  const asMatches: Match[] = top.map((g) => ({ requirement: g.requirement, kind: g.kind, bucket: "missing", evidence: "", suggestion: `Asked by ${g.n} of the roles on your list.` }));
  const filled = await fillOptions(asMatches);
  return gapsOf(filled).map((gap, i) => ({ ...gap, why: `Asked by ${top[i].n} of the roles on your list.` }));
}
/** Re-score every item whose matches carry this requirement, after an answer or a withdrawal. */
async function rescore(userId: string, run: Run, requirement: string, apply: (m: Match[]) => Match[]) {
  for (const it of run.items) {
    if (typeof it.now !== "number") continue;
    const key = `radar:m:${userId}:${it.sighting_id}`;
    const m = await kv.get<{ matches: Match[] }>(key); if (!m) continue;
    const hit = m.matches.find((x) => sameRequirement(x.requirement, requirement) && (x.bucket === "missing" || x.told));
    if (!hit) continue;
    const next = apply(m.matches.map((x) => (x === hit ? { ...x, requirement: hit.requirement } : x)));
    await kv.set(key, { matches: next });
    summarise(it, next);
  }
  run.items.sort((x, y) => (y.promised ?? -1) - (x.promised ?? -1) || (y.now ?? -1) - (x.now ?? -1));
  tally(run);
}

const runKey = (userId: string) => `radar:run:${userId}`;
const running = new Set<string>();

async function runRadar(user: User, resume: { id: string; parsed: ResumeProfile }, targets: Targets, answers: Answers) {
  const key = runKey(user.id);
  const run: Run = { status: "shortlist", started: new Date().toISOString(), answers, resume_id: resume.id, pool: 0, by_title: 0, picked: 0, scored: 0, items: [], cost_calls: 0, threshold: SHOT };
  const bank = await recallAnswers(user.id).catch(() => []);
  const save = () => kv.set(key, run);
  try {
    await save();
    const pool = await livePool(); run.pool = pool.length;
    const targetWords = answers.titles.map(words).filter((w) => w.length);
    const avoid = answers.avoid.map(norm).filter(Boolean);
    const scored = pool
      .filter((s) => s.readable)
      .filter((s) => !avoid.some((a) => norm(s.company_name ?? "").includes(a) || norm(s.title).includes(a)))
      .map((s) => ({ s, sc: titleScore(s.title ?? "", targetWords, answers.level, answers.stretch) }))
      .filter((x) => x.sc > 0.3)
      .sort((a, b) => b.sc - a.sc);
    // at most 6 per employer in the long list, so one big feed does not crowd the rest out
    const perEmp: Record<string, number> = {}; const longList: Sighting[] = [];
    for (const { s } of scored) { const k = s.employer_key ?? s.company_name ?? "?"; if ((perEmp[k] ?? 0) >= 8) continue; perEmp[k] = (perEmp[k] ?? 0) + 1; longList.push(s); if (longList.length >= 420) break; }
    run.by_title = longList.length; run.status = "picking"; await save();
    if (!longList.length) { run.status = "done"; run.finished = new Date().toISOString(); await save(); return; }
    const picks = await pickSixty(resume.parsed, targets, answers, longList); run.cost_calls++;
    const byId = new Map(longList.map((s) => [s.id, s]));
    // at most 4 per employer in the scored set (up to 120: the ≥75 list needs depth)
    const per2: Record<string, number> = {};
    const chosen = picks.map((p) => ({ p, s: byId.get(p.id)! })).filter(({ s }) => { const k = s.employer_key ?? s.company_name ?? "?"; if ((per2[k] ?? 0) >= 4) return false; per2[k] = (per2[k] ?? 0) + 1; return true; }).slice(0, 120);
    run.picked = chosen.length; run.status = "scoring";
    run.items = chosen.map(({ p, s }) => ({ sighting_id: s.id, title: s.title, company: s.company_name ?? "", location: s.location ?? "", url: s.url, posted_at: s.posted_at, first_seen: s.first_seen, why: p.why }));
    await save();
    // the fit engine on each, six at a time; the page fills as they land
    let i = 0;
    const worker = async () => {
      while (i < run.items.length) {
        const it = run.items[i++];
        try {
          const pp = await postingFor(it.sighting_id);
          if (!pp) { it.error = "unreadable"; continue; }
          let { matches } = await matchAndGrade(resume.parsed, pp.posting); run.cost_calls += 2;
          // what they told us on any earlier posting answers the same requirement here
          matches = applyRemembered(matches, bank).matches;
          await kv.set(`radar:m:${user.id}:${it.sighting_id}`, { matches });
          summarise(it, matches);
        } catch (e) { it.error = (e as Error).message.slice(0, 120); }
        run.scored++; if (run.scored % 4 === 0) await save();
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    run.items.sort((x, y) => (y.promised ?? -1) - (x.promised ?? -1) || (y.now ?? -1) - (x.now ?? -1));
    // the questions: missing must-haves that repeat across the picked roles, asked once, applied everywhere
    run.status = "questions"; await save();
    try { run.questions = await commonQuestions(user.id, run.items); run.cost_calls++; } catch (e) { console.error("[radar] questions", (e as Error).message); run.questions = []; }
    tally(run);
    run.status = "done"; run.finished = new Date().toISOString(); await save();
  } catch (e) {
    run.status = "error"; run.error = (e as Error).message; await save();
  } finally { running.delete(user.id); }
}

radarPublic.get("/pulse", async (c) => {
  const p = await pulse();
  return c.json({ ...p, read: await postingsRead(), as_of: new Date().toISOString() });
});
/** Public: the roles that opened most recently on companies' own systems — title, company, when. The only company we ever
 *  name is one that is hiring. Up to 24, newest first; one per company so a big feed does not fill it. */
radarPublic.get("/latest", async (c) => {
  const pool = await livePool();
  const seen = new Set<string>(); const out: { title: string; company: string; location: string; first_seen: string }[] = [];
  for (const s of pool.slice().sort((a, b) => Date.parse(b.first_seen) - Date.parse(a.first_seen))) {
    const k = s.employer_key ?? s.company_name ?? ""; if (!s.title || !s.company_name || seen.has(k)) continue;
    seen.add(k); out.push({ title: s.title, company: s.company_name, location: (s.location ?? "").split(",")[0], first_seen: s.first_seen });
    if (out.length >= 24) break;
  }
  return c.json({ roles: out, as_of: new Date().toISOString() });
});

/** The questionnaire's pre-fill: what the résumé says they're a fit for. */
radar.get("/test/targets", async (c) => {
  const u = c.get("user");
  const resume = await currentResume(u.id);
  if (!resume) return c.json({ error: "no_resume" }, 404);
  const key = `radar:targets:${u.id}:${resume.id}`;
  let t = await kv.get<Targets>(key);
  if (!t) { t = await deriveTargets(resume.parsed); await kv.set(key, t); }
  // live count and came-in-today per title, from the pool (₹0)
  const pool = await livePool(); const since = Date.now() - 86400e3;
  const counts = t.titles.map((title) => { const tw = [words(title)]; let live = 0, today = 0; for (const s of pool) { if (titleScore(s.title ?? "", tw, t.level, true) >= 0.5) { live++; if (Date.parse(s.first_seen) >= since) today++; } } return { title, live, today }; });
  const my = (title: string) => titleScore(title, t.titles.map(words), t.level, true) >= 0.5;
  const mine = await pulse(my);
  return c.json({ targets: t, counts, pulse: mine, resume_id: resume.id, name: resume.parsed.name, roles: (resume.parsed.roles ?? []).map((r) => ({ company: r.company, start: r.start, end: r.end })) });
});

const answers = z.object({ titles: z.array(z.string().min(2).max(80)).min(1).max(10), level: z.enum(["ic", "lead", "manager", "head"]), stretch: z.boolean().default(false), avoid: z.array(z.string().max(60)).max(20).default([]), notes: z.string().max(300).optional() });

radar.post("/test/start", async (c) => {
  const u = c.get("user");
  const resume = await currentResume(u.id);
  if (!resume) return c.json({ error: "Upload a résumé first." }, 400);
  if (running.has(u.id)) return c.json({ ok: true, already: true });
  const tkey = `radar:targets:${u.id}:${resume.id}`;
  let t = await kv.get<Targets>(tkey); if (!t) { t = await deriveTargets(resume.parsed); await kv.set(tkey, t); }
  // no questionnaire (held, 7 Nov): the résumé alone decides. Answers are accepted when given; otherwise they come from the profile.
  const raw = await c.req.json().catch(() => ({}));
  const body = answers.safeParse(raw);
  const a: Answers = body.success ? body.data : { titles: t.titles, level: t.level, stretch: false, avoid: (resume.parsed.roles ?? []).filter((r) => /present|current|now/i.test(r.end ?? "")).map((r) => r.company.split(/[·,(]/)[0].trim()).filter(Boolean) };
  running.add(u.id);
  void runRadar(u, resume, t, a);
  return c.json({ ok: true, answers: a });
});

/** Test build only: stands in for the ₹2,499 payment. Testers and the founder's account. */
radar.post("/test/unlock", async (c) => {
  const u = c.get("user");
  if (!isTester(u)) return c.json({ error: "Not available on this account." }, 403);
  await kv.set(`radar:unlock:${u.id}`, { at: new Date().toISOString() });
  return c.json({ ok: true });
});

radar.get("/test/result", async (c) => {
  const u = c.get("user");
  const run = await kv.get<Run>(runKey(u.id));
  if (!run) return c.json({ status: "none" });
  const unlocked = !!(await kv.get(`radar:unlock:${u.id}`));
  const scored = run.items.filter((i) => typeof i.now === "number");
  const shots = scored.filter((i) => (i.promised ?? 0) >= SHOT);
  const since = Date.now() - 86400e3;
  const oldest = shots.reduce((m, i) => Math.max(m, (Date.now() - Date.parse(i.first_seen)) / 86400e3), 0);
  const reveal = { shots: shots.length, opened_today: shots.filter((i) => Date.parse(i.first_seen) >= since).length, within_reach: scored.filter((i) => (i.promised ?? 0) >= REACH && (i.promised ?? 0) < SHOT).length, oldest_days: Math.round(oldest),
    // the taste: the employer and the shot, the role hidden
    taste: shots.slice(0, 3).map((i) => ({ company: i.company, location: i.location, now: i.now, promised: i.promised, first_seen: i.first_seen, posted_at: i.posted_at })) };
  const my = (title: string) => titleScore(title, run.answers.titles.map(words), run.answers.level, true) >= 0.5;
  const mine = run.status === "done" ? await pulse(my).catch(() => null) : null;
  if (unlocked) return c.json({ ...run, unlocked: true, reveal, pulse: mine });
  // locked: counts and the taste, no titles, no links, no facts
  return c.json({ ...run, unlocked: false, reveal, pulse: mine, items: run.items.map((i) => ({ sighting_id: i.sighting_id, company: i.company, now: i.now, promised: i.promised, first_seen: i.first_seen, error: i.error })), questions: [] });
});

/** One answer, applied to every role on the list that asked for it; remembered on the account like any questionnaire answer. */
radar.post("/test/answer", async (c) => {
  const u = c.get("user");
  const body = z.object({
    requirement: z.string().min(2), withdraw: z.boolean().optional(),
    what: z.string().max(200).optional(), where: z.string().max(80).optional(), when: z.string().max(40).optional(), size: z.string().max(30).optional(), unit: z.string().max(30).optional(), free: z.string().max(600).optional(),
  }).safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
  const run = await kv.get<Run>(runKey(u.id));
  if (!run || run.status !== "done") return c.json({ error: "No finished Radar to answer for." }, 404);
  const q = (run.questions ?? []).find((g) => g.requirement === body.data.requirement);
  if (!q) return c.json({ error: "That isn’t one of the questions." }, 400);
  let line: string | null = null;
  if (body.data.withdraw) {
    await rescore(u.id, run, q.requirement, (m) => withdrawFrom(m, m.find((x) => sameRequirement(x.requirement, q.requirement))?.requirement ?? q.requirement));
    q.told = undefined;
    await forgetAnswer(u.id, q.requirement).catch(() => {});
  } else {
    const f = body.data as Facts;
    line = f.free?.trim() ? await shapeFree(q.requirement, f.free) : (f.what?.trim() ? assembleLine(f) : "");
    if (!line) return c.json({ error: "Pick one of the three, or say it your way." }, 400);
    const facts = f.free?.trim() ? f.free.trim() : [f.what, f.where && `at ${f.where}`, f.when, f.size && `${f.size} ${f.unit ?? ""}`.trim()].filter(Boolean).join(" · ");
    const L = line;
    await rescore(u.id, run, q.requirement, (m) => acceptInto(m, m.find((x) => sameRequirement(x.requirement, q.requirement))?.requirement ?? q.requirement, facts, L));
    q.told = { text: facts, line: L };
    await rememberAnswer(u.id, { requirement: q.requirement, fact: facts, line: L }).catch(() => {});
  }
  await kv.set(runKey(u.id), run);
  return c.json({ ok: true, line, shots: run.shots, within_reach: run.within_reach, items: run.items, questions: run.questions });
});
