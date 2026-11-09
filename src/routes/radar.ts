// Radar: from the résumé on file, the live Bengaluru openings this person has a real shot at — ranked, each with the fit
// engine's number now and if sharpened. Flow: profile → what they're a fit for (one call) → title match over the live
// sightings (₹0) → stage 1b: the posting's own text against the résumé's words (₹0) → stage 2: ten postings per call,
// résumé pinned, a rough band each (~₹0.25 a role) → stage 3: the expert match + audit only for roles in reach (the same
// engine as the preview; posting checklist cached per sighting, shared by every user) → stored per user, filled as it
// lands. Every call is metered and charged to the account; ₹600 per 30 days is the cap (the economics rule, 7 Nov).
import { Hono } from "hono";
import { z } from "zod";
import { db, type User } from "../lib/db.js";
import { requireUser } from "../lib/auth.js";
import { isRadarTester as isTester } from "../lib/testers.js";
import { json, MODEL } from "../engine/claude.js";
import { parsePosting, matchAndGrade, type ResumeProfile, type PostingProfile, type Match } from "../engine/sharpen.js";
import { assess } from "../engine/fit.js";
import { charge, withMeter } from "../engine/meter.js";
import { statedBand } from "../reader/experience.js";
import { gapsOf, fillOptions, assembleLine, shapeFree, acceptInto, withdrawFrom, recallAnswers, rememberAnswer, forgetAnswer, applyRemembered, sameRequirement, type Facts, type Gap } from "../engine/told.js";

export const radar = new Hono<{ Variables: { user: User } }>();
/** Public: the market's pulse — roles that came in and went quiet per day, across every employer we read. No sign-in. */
export const radarPublic = new Hono();
radar.use("*", requireUser);

type Targets = { titles: string[]; level: "ic" | "lead" | "manager" | "head"; functions: string[]; strengths: string[]; years: number; one_line: string };
type Answers = { titles: string[]; level: Targets["level"]; stretch: boolean; avoid: string[]; notes?: string };
type Item = { sighting_id: number; title: string; company: string; location: string; url: string; posted_at: string | null; first_seen: string; why: string; new_at?: string; tri?: number;
  now?: number; promised?: number; band?: string; said?: number; unsaid?: number; missing?: number; top_said?: string[]; top_unsaid?: string[]; top_missing?: string[]; error?: string };
type Run = { status: "targets" | "shortlist" | "picking" | "scoring" | "questions" | "done" | "error"; started: string; finished?: string; answers: Answers; resume_id: string;
  pool: number; by_title: number; picked: number; scored: number; items: Item[]; error?: string; cost_calls: number;
  questions?: Gap[];            // (legacy) the missing must-haves that repeat across the picked roles
  pq?: ProfileQ[];              // the Radar questions: career-level facts, asked once
  shots?: number; within_reach?: number; almost?: number; gap?: number; threshold: number;
  refreshed?: string;           // the last morning re-run
  seen?: number[];              // sightings already put to the model (picked or passed over), so a morning never re-asks
  gone?: { sighting_id: number; title: string; company: string; gone_at: string; promised?: number }[];   // roles that went quiet after they were on the list
  today?: { new: number; gone: number; at: string };
  spend?: { run_paise: number; total_paise: number; capped?: boolean };
  triaged?: number;             // how far down the free ranking the cheap pass went before it stopped finding anything
  dropped_band?: number;        // roles whose years band ruled the person out before any model saw them
  trail?: { id: number; title: string; company: string; rank: number; fit: number; band?: number; why?: string; chosen?: boolean; dropped?: string }[];   // the audit trail of the last pass
  examined?: number };   // what this account has cost us, from the meter
/** A real shot: sharpened ≥ 75 (decided 7 Nov). Under 50 is never shown. */
const SHOT = 75, ALMOST = 60, REACH = 50;   // the three tiers (9 Nov): apply right now · almost there · let's close the gap

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
/** Words that say how senior a role is, or nothing at all — never what the job is. They never decide a title match (9 Nov:
 *  with them counted, "Director, Project Management" beat "Category Manager" for a category person every time). */
const GENERIC = new Set("management manager mgr mgmt head director lead leader senior sr jr junior associate assistant specialist executive officer analyst coordinator principal staff chief vp president vice avp gm general group global regional national team role roles ind karnataka hybrid level l1 l2 l3 new founder founders cofounder co ex".split(" "));
const fstem = (w: string) => { let x = w.replace(/(ies)$/, "y"); if (x.endsWith("ment") && x.length > 7) x = x.replace(/e?ment$/, ""); return x.replace(/(ing|ers?|s)$/, ""); };
/** The function words of a title: what the job is, stemmed, level words and filler gone. */
const fwords = (t: string) => words(t).filter((w) => !GENERIC.has(w) && !/^\d+$/.test(w)).map(fstem);
let idfCache: { at: number; n: number; df: Map<string, number> } | null = null;
/** How rare each function word is across the city's live titles — "category" is heavy, "business" is light. Refreshed hourly. */
function titleIdf(pool: Sighting[]) {
  if (idfCache && Date.now() - idfCache.at < 3600e3) return idfCache;
  const df = new Map<string, number>();
  for (const s of pool) for (const w of new Set(fwords(s.title ?? ""))) df.set(w, (df.get(w) ?? 0) + 1);
  idfCache = { at: Date.now(), n: pool.length, df };
  return idfCache;
}
const idfOf = (w: string) => { const c = idfCache; if (!c) return 1; return Math.log((c.n + 1) / ((c.df.get(w) ?? 0) + 1)) + 0.2; };

const currentResume = async (userId: string) => {
  const { data } = await db.from("resumes").select("id, parsed").eq("user_id", userId).eq("is_current", true).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (data?.parsed) return { id: data.id as string, parsed: data.parsed as ResumeProfile };
  const { data: any } = await db.from("resumes").select("id, parsed").eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  return any?.parsed ? { id: any.id as string, parsed: any.parsed as ResumeProfile } : null;
};
/** An active Radar plan, shots used or not: the list stays open for the 30 days even after the ten Sharpens are spent. */
async function hasRadar(userId: string): Promise<boolean> {
  const { data } = await db.from("plans").select("id").eq("user_id", userId).eq("product", "radar").gt("expires_at", new Date().toISOString()).limit(1);
  return !!(data && data.length);
}
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
  const [live, gone] = await Promise.all([livePool(), gonePool()]); titleIdf(live);
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
let checkedTotal: { at: number; n: number } | null = null;
/** The companies whose own hiring systems we check every day (745 on 7 Nov): employers with a feed. Cached an hour. */
async function companiesChecked(): Promise<number> {
  if (checkedTotal && Date.now() - checkedTotal.at < 3600e3) return checkedTotal.n;
  const { count } = await db.from("employers").select("*", { count: "exact", head: true }).neq("ats", "none");
  checkedTotal = { at: Date.now(), n: count ?? 0 }; return checkedTotal.n;
}

/** Title match, ₹0: overlap between the sighting's title and any target title, with a level check. */
/** How well a live title matches one of the titles we search with: function words only, rarity-weighted — the share of the
 *  target's meaning the live title carries (70%) and how much of the live title that explains (30%). Level words then
 *  adjust: a head-level person may be shown manager roles (India's ladders differ); a non-head person sees head roles only
 *  as a stretch; nobody but an IC sees intern or trainee roles. `targets` are the search titles already split into words. */
function titleScore(title: string, targets: string[][], level: Targets["level"], stretch: boolean): number {
  const tw = new Set(fwords(title)); if (!tw.size) return 0;
  const twTot = [...tw].reduce((n, w) => n + idfOf(w), 0);
  let best = 0;
  for (const tg of targets) {
    const tf = [...new Set(tg.filter((w) => !GENERIC.has(w) && !/^\d+$/.test(w)).map(fstem))];
    if (!tf.length) continue;
    const tot = tf.reduce((n, w) => n + idfOf(w), 0);
    const hit = tf.filter((w) => tw.has(w)).reduce((n, w) => n + idfOf(w), 0);
    if (!hit) continue;
    const sc = (hit / tot) * 0.7 + (hit / twTot) * 0.3;
    if (sc > best) best = sc;
  }
  if (best === 0) return 0;
  const senior = /\b(head|director|vp|vice president|svp|chief|president)\b/i.test(title);
  const junior = /\b(intern|trainee|fresher|junior|apprentice)\b/i.test(title);
  if (level !== "head" && senior) best *= stretch ? 0.7 : 0.5;
  if (level !== "ic" && junior) best *= 0.2;
  return best;
}
const TITLE_IN = 0.35;   // a title enters the long list at or above this

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


/** ---------- the three stages (7 Nov, the economics rule: never pay full price to reject) ----------
 *  1. free: title words, then the posting's own text against the résumé's words — ranks hundreds, costs nothing.
 *  2. cheap: ten postings per call, résumé pinned once, a rough band each — decides who gets stage 3, never shown.
 *  3. expert: the match + audit (same as the preview) — only for roles stage 2 put in reach; everything shown went through it. */
const RWORDS_STOP = new Set([...STOP, "experience", "work", "team", "role", "years", "year", "skills", "strong", "ability", "including", "across", "within", "using", "based", "related", "will", "must", "should", "have", "good", "well", "high", "new", "end", "key", "etc"]);
const cwordsOf = (t: string) => norm(t).split(" ").filter((w) => w.length > 3 && !RWORDS_STOP.has(w)).map(stem);
function resumeWords(p: ResumeProfile): Set<string> {
  const parts: string[] = [p.headline ?? "", ...(p.skills ?? []).map((s: any) => (typeof s === "string" ? s : s?.name ?? "")), ...(p.roles ?? []).flatMap((r) => [r.title ?? "", ...(r.bullets ?? [])])];
  return new Set(cwordsOf(parts.join(" ")));
}
/** Stage 1b: how much of the posting's own vocabulary the résumé already carries. 0..1. */
function textFit(rw: Set<string>, description: string): number {
  const dw = cwordsOf(description.slice(0, 6000)); if (dw.length < 30) return 0;
  const uniq = [...new Set(dw)]; let hit = 0; for (const w of uniq) if (rw.has(w)) hit++;
  return hit / Math.sqrt(uniq.length);
}
async function descriptionsFor(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await db.from("sightings").select("id, description").in("id", ids.slice(i, i + 100));
    for (const r of (data ?? []) as any[]) if (r.description) out.set(r.id, r.description);
  }
  return out;
}
/** Stage 2: a calibrated guess per posting from the posting's text, résumé pinned. ~₹0.25 a role. */
async function triage(resume: ResumeProfile, t: Targets, a: Answers, batch: { s: Sighting; text: string }[]): Promise<Map<number, { band: number; why: string }>> {
  const r = await json<{ bands: { id: number; band: number; why: string }[] }>(
    `You are a fair Bengaluru recruiter doing a first screen. For EACH numbered posting, estimate the score (0-100) this candidate's CURRENT résumé would get from a fair screener reading it against the posting's requirements. Calibration — the score is the share of the posting's requirements the résumé evidences today, must-haves counting double: 75+ = nearly every must-have is evidenced on the résumé as written; 55-74 = most must-haves evidenced, a few named but not shown; 40-54 = the function fits but several must-haves are absent from the résumé; under 40 = different function, wrong level, or most must-haves absent. Be strict: a résumé that never mentions the posting's domain does not score above 40 however senior the person is. Judge function and level honestly, both ways: a category manager is not a software engineer; a 'head of' role is not for a 5-year IC; and a 2-5 year posting is not a shortlist for a 10-year leader — being far over the band is a mismatch, score it under 40. One short reason each (≤10 words).`,
    `Candidate in one line: ${t.one_line}\nYears: ${t.years}. Level: ${a.level}${a.stretch ? " (open to one step up)" : ""}. Functions: ${t.functions.join("; ")}.\n\nPOSTINGS:\n${batch.map((b, i) => `#${i + 1} (id ${b.s.id}) ${b.s.title} — ${b.s.company_name ?? ""}\n${b.text.replace(/\s+/g, " ").slice(0, 2200)}`).join("\n\n")}\n\nReturn: {bands:[{id, band, why}]} — one entry per posting, by id.`,
    1500, MODEL, undefined, `RÉSUMÉ PROFILE:\n${JSON.stringify(resume)}`
  );
  const out = new Map<number, { band: number; why: string }>();
  for (const b of r.bands ?? []) { const id = Number(b.id); if (batch.some((x) => x.s.id === id)) out.set(id, { band: Math.max(0, Math.min(100, Number(b.band) || 0)), why: String(b.why ?? "").slice(0, 120) }); }
  return out;
}
const TRIAGE_IN = 45;      // stage 3 only for bands at or above this (Sharpen lifts ~15-20; 75 is the bar)
/** Stages 1b → 2 → 3 over a candidate set. Returns the scored items (stage 3) and the triaged-out ones (band only). */
async function stagedScore(user: User, resume: { id: string; parsed: ResumeProfile }, t: Targets, a: Answers, cands: Sighting[], opt: { stage1Keep: number; stage3Cap: number; enough?: number; ceiling?: number; earlyQuestions?: boolean; bank: Awaited<ReturnType<typeof recallAnswers>>; onProgress?: (scored: number) => Promise<void> | void; onChosen?: (items: Item[]) => Promise<void> | void; mark?: string; run: Run }) {
  const { run } = opt;
  // 1b. free ranking on the posting's own words
  const rw = resumeWords(resume.parsed);
  const descs = await descriptionsFor(cands.map((c) => c.id));
  // the years gate (9 Nov): a posting's own band against the person's years, both ways. Four or more years over the band's
  // top is a level mismatch a recruiter screens out ("2-5 years" is not for a ten-year BU head); two or more under the
  // band's floor is not a shot either. Read from the posting's text with the experience parser; free.
  const years = Number(resume.parsed.years_total ?? t.years ?? 0);
  let droppedBand = 0;
  const bandOf = (text: string) => (years ? statedBand(text) : null);
  const trail: NonNullable<Run["trail"]> = [];
  const tws = [...new Set([...a.titles, ...(resume.parsed.roles ?? []).slice(0, 3).map((r) => (r.title ?? "").replace(/[|/,(].*$/, "").trim())])].map(words).filter((w) => w.length);
  // rank = the posting's shared vocabulary with the résumé, weighted by how well its title matches what we're searching for
  const all = cands.map((s) => { const text = descs.get(s.id) ?? ""; const ts = titleScore(s.title ?? "", tws, a.level, true); return { s, text, fit: textFit(rw, text) * (0.5 + ts) }; });
  const ranked = all.filter((x) => {
    if (x.text.length < 200) { trail.push({ id: x.s.id, title: x.s.title, company: x.s.company_name ?? "", rank: -1, fit: 0, dropped: "no text" }); return false; }
    const b = bandOf(x.text);
    if (b && b.max !== null && years >= b.max + 4) { droppedBand++; trail.push({ id: x.s.id, title: x.s.title, company: x.s.company_name ?? "", rank: -1, fit: x.fit, dropped: `band ${b.min}-${b.max}, you ${years}` }); return false; }
    if (b && years + 2 <= b.min) { droppedBand++; trail.push({ id: x.s.id, title: x.s.title, company: x.s.company_name ?? "", rank: -1, fit: x.fit, dropped: `band ${b.min}+, you ${years}` }); return false; }
    return true;
  }).sort((x, y) => y.fit - x.fit);
  run.dropped_band = (run.dropped_band ?? 0) + droppedBand;
  const perEmp: Record<string, number> = {}; const kept: typeof ranked = [];
  for (const x of ranked) { const k = x.s.employer_key ?? x.s.company_name ?? "?"; if ((perEmp[k] ?? 0) >= 30) { trail.push({ id: x.s.id, title: x.s.title, company: x.s.company_name ?? "", rank: -1, fit: x.fit, dropped: "employer cap" }); continue; } perEmp[k] = (perEmp[k] ?? 0) + 1; kept.push(x); if (kept.length >= opt.stage1Keep) break; }
  kept.forEach((x, i) => trail.push({ id: x.s.id, title: x.s.title, company: x.s.company_name ?? "", rank: i + 1, fit: Math.round(x.fit * 100) / 100 }));
  // 0. roles already fully checked for this résumé (a prior run, a prior morning) go straight through: no cheap pass, no dice.
  //    Lists only grow, or lose roles that went quiet; they never forget a role (9 Nov).
  const priorIds = new Set<number>();
  for (let i = 0; i < kept.length; i += 100) {
    const { data } = await db.from("reader_control").select("key, value").in("key", kept.slice(i, i + 100).map((x) => `radar:m:${user.id}:${x.s.id}`));
    for (const r of data ?? []) if ((r.value as any)?.resume_id === resume.id && (r.value as any)?.matches?.length) priorIds.add(Number(String(r.key).split(":")[3]));
  }
  // 2. cheap bands, in batches of twenty down the free ranking: keep going while batches still find roles in reach,
  //    stop after two empty batches in a row, or once thirty are in reach, or at the ceiling (140 on day one — seven batches; past that the profile, not the search, is the question). The spend follows the value.
  const bands = new Map<number, { band: number; why: string }>();
  const BATCH = 20, EMPTY_STOP = 2, ENOUGH = opt.enough ?? 30, CEIL = Math.min(kept.length, opt.ceiling ?? 200);
  let at = 0, emptyRun = 0, inReachN = 0; const examined: typeof kept = [];
  while (at < CEIL && emptyRun < EMPTY_STOP && inReachN < ENOUGH) {
    const batch = kept.slice(at, Math.min(CEIL, at + BATCH)); at += batch.length; examined.push(...batch);
    // bands already known for this résumé–posting pair are reused; prior fully-checked roles count as in reach without a call
    let found = 0; const need: typeof batch = [];
    for (const x of batch) {
      if (priorIds.has(x.s.id)) { bands.set(x.s.id, { band: 100, why: "checked before" }); found++; inReachN++; continue; }
      const cached = await kv.get<{ band: number; why: string; resume_id: string }>(`radar:tri:${x.s.id}:${resume.id}`);
      if (cached) { bands.set(x.s.id, cached); if (cached.band >= TRIAGE_IN) { found++; inReachN++; } continue; }
      need.push(x);
    }
    const halves = [need.slice(0, 10), need.slice(10)].filter((h) => h.length);
    const got = await Promise.all(halves.map((h) => triage(resume.parsed, t, a, h).catch((e) => { console.error("[radar] triage", (e as Error).message); return new Map<number, { band: number; why: string }>(); })));
    run.cost_calls += halves.length;
    for (const m of got) for (const [id, v] of m) { bands.set(id, v); void kv.set(`radar:tri:${id}:${resume.id}`, { ...v, resume_id: resume.id }); if (v.band >= TRIAGE_IN) { found++; inReachN++; } }
    emptyRun = found ? 0 : emptyRun + 1;
    run.triaged = at; await opt.onProgress?.(0);
  }
  const kept2 = examined;
  for (const tr of trail) { const b = bands.get(tr.id); if (b) { tr.band = b.band; tr.why = b.why; } }
  // 3. the expert check on the ones in reach, best first, capped; at most 4 per employer
  // prior roles anywhere in the free ranking (even past where the batches stopped) are in reach by right
  for (const x of kept) if (priorIds.has(x.s.id) && !bands.has(x.s.id)) bands.set(x.s.id, { band: 100, why: "checked before" });
  const inReachAll = kept.filter((x) => (bands.get(x.s.id)?.band ?? 0) >= TRIAGE_IN).sort((x, y) => (bands.get(y.s.id)!.band - bands.get(x.s.id)!.band));
  const inReach = inReachAll;
  const per3: Record<string, number> = {}; const chosen: typeof kept = [];
  // at most six per employer through the full check: Amazon alone is a quarter of the city, and for some profiles Amazon is the market
  for (const x of inReach) { const prior = priorIds.has(x.s.id); const k = x.s.company_name ?? "?"; if (!prior && (per3[k] ?? 0) >= 6) continue; if (!prior) per3[k] = (per3[k] ?? 0) + 1; chosen.push(x); if (!prior && chosen.filter((c) => !priorIds.has(c.s.id)).length >= opt.stage3Cap) break; }
  for (const x of chosen) { const tr = trail.find((t) => t.id === x.s.id); if (tr) tr.chosen = true; }
  run.trail = trail.sort((a, b) => (a.rank < 0 ? 1e6 : a.rank) - (b.rank < 0 ? 1e6 : b.rank));
  const items: Item[] = chosen.map(({ s }) => ({ sighting_id: s.id, title: s.title, company: s.company_name ?? "", location: s.location ?? "", url: s.url, posted_at: s.posted_at, first_seen: s.first_seen, why: bands.get(s.id)?.why ?? "", tri: bands.get(s.id)?.band, ...(opt.mark ? { new_at: opt.mark } : {}) }));
  if (opt.onChosen) await opt.onChosen(items);
  let i = 0, done = 0;
  const worker = async () => {
    while (i < items.length) {
      const it = items[i++];
      try {
        const mk = `radar:m:${user.id}:${it.sighting_id}`;
        const prior = await kv.get<{ matches: Match[]; resume_id?: string }>(mk);
        let matches: Match[];
        if (prior?.matches?.length && prior.resume_id === resume.id) { matches = prior.matches; }   // same résumé, same posting: the number holds
        else {
          const pp = await postingFor(it.sighting_id);
          if (!pp) { it.error = "unreadable"; continue; }
          matches = (await matchAndGrade(resume.parsed, pp.posting)).matches; run.cost_calls += 2;
        }
        matches = applyRemembered(matches, opt.bank).matches;
        await kv.set(mk, { matches, resume_id: resume.id });
        summarise(it, matches);
      } catch (e) { it.error = (e as Error).message.slice(0, 120); }
      done++;
      if (opt.earlyQuestions && !run.pq?.length && done >= 4 && !(run as any)._qTried) { (run as any)._qTried = true; try { run.pq = await profileQuestions(resume.parsed, await askable(user.id, items.filter((x) => typeof x.now === "number"))); run.cost_calls++; await opt.onProgress?.(done); } catch (e) { console.error("[radar] pq", (e as Error).message); } }
      if (opt.onProgress && done % 3 === 0) await opt.onProgress(done);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const passedOver = kept2.filter((x) => !chosen.includes(x)).map(({ s }) => ({ id: s.id, band: bands.get(s.id)?.band ?? 0 }));
  // the ones the batches never reached stay unseen, so a later morning may still meet them
  run.seen = [...kept2.map((x) => x.s.id), ...(run.seen ?? []).filter((id) => !kept.some((x) => x.s.id === id))].slice(0, 4000);
  return { items, passedOver, kept: kept.length, examined: kept2.length, inReach: inReach.length };
}
/** Sharpen asks: did Radar already score this résumé against this posting? Then that match is the match (same engine), and
 *  the Sharpen that follows pays only for the rewrite. Matched on the posting URL Radar handed out. */
export async function radarMatchesFor(userId: string, resumeId: string, url: string): Promise<Match[] | null> {
  if (!url) return null;
  const run = await kv.get<Run>(runKey(userId));
  if (!run || run.resume_id !== resumeId) return null;
  const want = norm(url.replace(/[?#].*$/, ""));
  const it = run.items.find((i) => typeof i.now === "number" && norm((i.url ?? "").replace(/[?#].*$/, "")) === want);
  if (!it) return null;
  const m = await kv.get<{ matches: Match[] }>(`radar:m:${userId}:${it.sighting_id}`);
  return m?.matches?.length ? m.matches : null;
}
const CAP_PAISE = 60000;   // ₹600 per account per 30 days — the rule
async function spent30(userId: string): Promise<number> {
  const since = new Date(Date.now() - 30 * 86400e3).toISOString();
  const { data } = await db.from("reader_control").select("key, value").like("key", `meter:plan:${userId}:%`);
  let p = 0; for (const r of data ?? []) { const day = r.key.split(":")[3]; if (day >= since.slice(0, 10)) p += Number((r.value as any)?.paise ?? 0); }
  return p;
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
  run.almost = run.items.filter((i) => (i.promised ?? 0) >= ALMOST && (i.promised ?? 0) < SHOT).length;
  run.gap = run.items.filter((i) => (i.promised ?? 0) >= REACH && (i.promised ?? 0) < ALMOST).length;
}
/** A Radar question (9 Nov): a career-level fact about the person — a tool, years in a function, the scale they ran, a
 *  domain, a credential — never one job at one company, never a soft skill, never something the résumé already states.
 *  Answered once, kept on the account, applied to every role that asks for it in any wording. */
export type ProfileQ = { id: string; kind: "tool" | "years" | "scale" | "domain" | "credential"; ask: string; covers: string[]; answers: [string, string, string]; hint: string; told?: { text: string; line: string; remembered?: boolean } };
async function profileQuestions(resume: ResumeProfile, reqs: { requirement: string; n: number }[]): Promise<ProfileQ[]> {
  if (!reqs.length) return [];
  const brief = { headline: resume.headline, years: resume.years_total, roles: (resume.roles ?? []).slice(0, 6).map((r) => ({ company: r.company, title: r.title, start: r.start, end: r.end })), skills: (resume.skills ?? []).slice(0, 20).map((x: any) => x?.name ?? x), education: resume.education ?? [], extras: (resume.extra_sections ?? []).map((e) => e.title) };
  const r = await json<{ questions: Omit<ProfileQ, "told">[] }>(
    `You turn job requirements into a short questionnaire about a CANDIDATE'S WHOLE CAREER, to be answered once and applied to many roles. Rules:
- Ask only about hard, checkable facts a person can state in one line: a tool or method (Excel, SQL, Tableau, SAP), years in a function, the scale they ran (team size, P&L, budget, SKUs, revenue), a domain they have worked in, a credential (degree, MBA, certification).
- NEVER ask about soft skills or qualities (communication, analytical, problem-solving, ownership, leadership style, 'voice'). Drop those requirements.
- NEVER ask what the résumé already states: if education lists a bachelor's, do not ask for a degree; if skills list SQL, do not ask about SQL.
- Group requirements that are the same fact in different words into ONE question (e.g. '3+ years of Excel', 'advanced Excel', 'Excel modelling' → one Excel question). 'covers' lists every requirement string the question answers, verbatim.
- Each question: 'ask' is one plain question about the person's career (not a job); 'answers' are three mutually exclusive choices from strongest to none, each a complete clause a résumé could carry (e.g. 'Advanced — pivots, lookups, models, most days for 8+ years' / 'Working use — reports and tracking' / 'Not really'); 'hint' is an example of the one optional line in their own words.
- At most 6 questions, most-asked requirements first. If nothing qualifies, return an empty list.`,
    `CANDIDATE:\n${JSON.stringify(brief)}\n\nREQUIREMENTS (with how many roles ask):\n${JSON.stringify(reqs.slice(0, 30))}\n\nReturn: {questions:[{id, kind, ask, covers[], answers[3], hint}]}`,
    2500
  );
  return (r.questions ?? []).filter((q) => q.ask && Array.isArray(q.covers) && q.covers.length && Array.isArray(q.answers) && q.answers.length === 3).slice(0, 6).map((q, i) => ({ ...q, id: q.id || `q${i + 1}`, answers: q.answers.slice(0, 3) as [string, string, string] }));
}
/** The requirements worth asking about across a set of scored roles: missing, or done but unproven, must-haves first. */
async function askable(userId: string, items: Item[]): Promise<{ requirement: string; n: number }[]> {
  const groups: { requirement: string; n: number; weight: number }[] = [];
  for (const it of items) {
    if (typeof it.now !== "number") continue;
    const m = await kv.get<{ matches: Match[] }>(`radar:m:${userId}:${it.sighting_id}`); if (!m) continue;
    for (const x of m.matches) {
      const ask = !x.told && (x.bucket === "missing" || (x.bucket === "have_not_said" && !x.sayable));
      if (!ask) continue;
      const g = groups.find((g) => sameRequirement(g.requirement, x.requirement));
      const w = (x.kind === "must" ? 2 : 1) + (x.bucket === "missing" ? 1 : 0);
      if (g) { g.n++; g.weight += w; } else groups.push({ requirement: x.requirement, n: 1, weight: w });
    }
  }
  return groups.sort((a, b) => b.weight - a.weight || b.n - a.n).map((g) => ({ requirement: g.requirement, n: g.n }));
}

/** The missing must-haves that come up again and again across the picked roles — the ten most common, with the three
 *  honest ways of having done each (the same cards as the Sharpen questionnaire). One answer lifts every role that asked. */
async function commonQuestions(userId: string, items: Item[]): Promise<Gap[]> {
  const groups: { requirement: string; kind: "must" | "nice"; n: number; weight: number }[] = [];
  for (const it of items) {
    if (typeof it.now !== "number") continue;
    const m = await kv.get<{ matches: Match[] }>(`radar:m:${userId}:${it.sighting_id}`); if (!m) continue;
    for (const x of m.matches) {
      // what to ask: a must-have the résumé lacks, or one the person has plainly done but the résumé can't prove
      // (for a strong profile almost nothing is missing and everything is unproven — those are the questions that lift)
      const ask = !x.told && (x.bucket === "missing" || (x.bucket === "have_not_said" && !x.sayable && x.kind === "must"));
      if (!ask) continue;
      const g = groups.find((g) => sameRequirement(g.requirement, x.requirement));
      const w = (x.kind === "must" ? 2 : 1) + (x.bucket === "missing" ? 1 : 0);
      if (g) { g.n++; g.weight += w; } else groups.push({ requirement: x.requirement, kind: x.kind, n: 1, weight: w });
    }
  }
  const top = groups.sort((a, b) => b.weight - a.weight || b.n - a.n).slice(0, 8);
  if (!top.length) return [];
  const asMatches: Match[] = top.map((g) => ({ requirement: g.requirement, kind: g.kind, bucket: "missing", evidence: "", suggestion: `Asked by ${g.n} of the roles on your list.` }));
  const filled = await fillOptions(asMatches);
  return gapsOf(filled).map((gap, i) => ({ ...gap, why: top[i].n > 1 ? `Asked by ${top[i].n} of the roles on your list.` : `Asked by a role on your list — the résumé doesn’t show it yet.` }));
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
    const pool = await livePool(); run.pool = pool.length; titleIdf(pool);
    // the titles we search with: what the recruiter named, plus the résumé's own recent titles verbatim — a BU head who was
    // a Senior Category Manager is searched as both; the market's plain "Category Manager" must never lose to "Director, Operations"
    const ownTitles = (resume.parsed.roles ?? []).slice(0, 3).map((r) => (r.title ?? "").replace(/[|/,(].*$/, "").trim()).filter((t) => t.length > 3);
    const titles = [...new Set([...answers.titles, ...ownTitles])];
    const targetWords = titles.map(words).filter((w) => w.length);
    const avoid = answers.avoid.map(norm).filter(Boolean);
    const eligible = pool.filter((s) => s.readable).filter((s) => !avoid.some((a) => norm(s.company_name ?? "").includes(a) || norm(s.title).includes(a)));
    // every title gets its own share of the long list: the best sixty live roles for each, then the union (9 Nov — one shared
    // list ranked by word overlap let "Director, Business Operations" crowd out every "Category Manager")
    const longList: Sighting[] = []; const seenIds = new Set<number>();
    for (const tw of targetWords) {
      const mine = eligible.map((s) => ({ s, sc: titleScore(s.title ?? "", [tw], answers.level, answers.stretch) })).filter((x) => x.sc >= TITLE_IN).sort((a, b) => b.sc - a.sc || Date.parse(b.s.first_seen) - Date.parse(a.s.first_seen));
      const perEmp: Record<string, number> = {}; let n = 0;
      for (const { s } of mine) { if (seenIds.has(s.id)) continue; const k = s.employer_key ?? s.company_name ?? "?"; if ((perEmp[k] ?? 0) >= 20) continue; perEmp[k] = (perEmp[k] ?? 0) + 1; seenIds.add(s.id); longList.push(s); if (++n >= 60) break; }
    }
    run.by_title = longList.length; run.status = "picking"; run.dropped_band = 0; await save();
    if (!longList.length) { run.status = "done"; run.finished = new Date().toISOString(); await save(); return; }
    run.status = "scoring"; run.picked = 0; await save();
    const planSince = run.started;
    const { paise } = await charge(user.id, planSince, "radar:run", async () => {
      const r = await stagedScore(user, resume, targets, answers, longList, { stage1Keep: 420, stage3Cap: 25, enough: 30, ceiling: 140, earlyQuestions: true, bank, run,
        onChosen: async (items) => { run.items = items; run.picked = items.length; await save(); },
        onProgress: async (n) => { run.scored = n; await save(); } });
      run.picked = r.items.length; run.items = r.items; run.scored = r.items.length; run.examined = r.examined;
      // answers given on the questions screen while this ran: applied now to every role that asks
      try {
        const bank2 = await recallAnswers(user.id);
        if (bank2.length) for (const it of run.items) {
          if (typeof it.now !== "number") continue;
          const mk = `radar:m:${user.id}:${it.sighting_id}`; const m = await kv.get<{ matches: Match[] }>(mk); if (!m) continue;
          const re = applyRemembered(m.matches, bank2); if (re.n) { await kv.set(mk, { matches: re.matches }); summarise(it, re.matches); }
        }
      } catch (e) { console.error("[radar] bank", (e as Error).message); }
      // the questions: missing must-haves that repeat across the picked roles, asked once, applied everywhere
      run.items.sort((x, y) => (y.promised ?? -1) - (x.promised ?? -1) || (y.now ?? -1) - (x.now ?? -1));
      run.status = "questions"; await save();
      try { if (!run.pq?.length) { run.pq = await profileQuestions(resume.parsed, await askable(user.id, run.items)); run.cost_calls++; } } catch (e) { console.error("[radar] questions", (e as Error).message); run.pq = run.pq ?? []; }
    });
    run.spend = { run_paise: paise, total_paise: await spent30(user.id) };
    tally(run);
    run.status = "done"; run.finished = new Date().toISOString(); await save();
  } catch (e) {
    run.status = "error"; run.error = (e as Error).message; await save();
  } finally { running.delete(user.id); }
}

/** The morning re-run for one account: roles that went quiet leave the list (kept under `gone`), the openings that came in
 *  since the last run go through the same picker and fit engine, and the list is re-ranked. Only new sightings cost model
 *  calls (one pick + two per scored role). A changed source résumé means a full run instead. */
export async function refreshRadar(userId: string): Promise<{ new_shots: number; new_scored: number; gone: number; shots: number } | null> {
  const key = runKey(userId);
  const run = await kv.get<Run>(key);
  if (!run || run.status !== "done") return null;
  if (running.has(userId)) return null;
  const { data: urow } = await db.from("users").select("*").eq("id", userId).maybeSingle();
  if (!urow) return null;
  const resume = await currentResume(userId);
  if (!resume) return null;
  if (resume.id !== run.resume_id) {
    const tkey = `radar:targets:${userId}:${resume.id}`;
    let t = await kv.get<Targets>(tkey); if (!t) { t = await deriveTargets(resume.parsed); await kv.set(tkey, t); }
    running.add(userId);
    await runRadar(urow as User, resume, t, run.answers);
    const fresh = await kv.get<Run>(key);
    return { new_shots: fresh?.shots ?? 0, new_scored: fresh?.scored ?? 0, gone: 0, shots: fresh?.shots ?? 0 };
  }
  running.add(userId);
  try {
    const now = new Date().toISOString();
    const pool = await livePool(); titleIdf(pool);
    const liveIds = new Set(pool.map((s) => s.id));
    // 1. roles that went quiet leave the list
    const gone = run.items.filter((i) => !liveIds.has(i.sighting_id));
    run.gone = [...gone.map((i) => ({ sighting_id: i.sighting_id, title: i.title, company: i.company, gone_at: now, promised: i.promised })), ...(run.gone ?? [])].slice(0, 60);
    run.items = run.items.filter((i) => liveIds.has(i.sighting_id));
    // 2. what came in since the last run (two hours of slack for the reader's own timing), never seen by the picker before
    const since = Date.parse(run.refreshed ?? run.finished ?? run.started) - 2 * 3600e3;
    const seen = new Set([...(run.seen ?? []), ...run.items.map((i) => i.sighting_id)]);
    const ownTitles = (resume.parsed.roles ?? []).slice(0, 3).map((r) => (r.title ?? "").replace(/[|/,(].*$/, "").trim()).filter((t) => t.length > 3);
    const targetWords = [...new Set([...run.answers.titles, ...ownTitles])].map(words).filter((w) => w.length);
    const avoid = run.answers.avoid.map(norm).filter(Boolean);
    const scored = pool
      .filter((s) => s.readable && !seen.has(s.id) && Date.parse(s.first_seen) >= since)
      .filter((s) => !avoid.some((a) => norm(s.company_name ?? "").includes(a) || norm(s.title).includes(a)))
      .map((s) => ({ s, sc: titleScore(s.title ?? "", targetWords, run.answers.level, run.answers.stretch) }))
      .filter((x) => x.sc >= TITLE_IN)
      .sort((a, b) => b.sc - a.sc);
    const perEmp: Record<string, number> = {}; const longList: Sighting[] = [];
    for (const { s } of scored) { const k = s.employer_key ?? s.company_name ?? "?"; if ((perEmp[k] ?? 0) >= 12) continue; perEmp[k] = (perEmp[k] ?? 0) + 1; longList.push(s); if (longList.length >= 240) break; }
    let added: Item[] = []; let morningPaise = 0;
    const total = await spent30(userId); const capped = total >= CAP_PAISE;
    if (longList.length) {
      const tkey = `radar:targets:${userId}:${resume.id}`;
      let t = await kv.get<Targets>(tkey); if (!t) { t = await deriveTargets(resume.parsed); await kv.set(tkey, t); }
      const bank = await recallAnswers(userId).catch(() => []);
      // the morning budget: batches of twenty through the cheap pass (stops at the first two empty, ceiling forty), at most two
      // through the expert check (≈ ₹5 a day, ₹16 worst);
      // an account past ₹600 in its 30 days gets the free and cheap stages only
      const { result, paise } = await charge(userId, run.started, "radar:morning", () => stagedScore(urow as User, resume, t!, run.answers, longList, { stage1Keep: 60, stage3Cap: capped ? 0 : 2, enough: 4, ceiling: 40, bank, run, mark: now }));
      morningPaise = paise;
      added = result.items;
      run.items.push(...added);
    }
    run.spend = { run_paise: morningPaise, total_paise: total + morningPaise, capped };
    // 3. re-rank, retally; yesterday's "new" badges fall away
    for (const it of run.items) if (it.new_at && it.new_at !== now && Date.now() - Date.parse(it.new_at) > 36 * 3600e3) delete it.new_at;
    run.items.sort((x, y) => (y.promised ?? -1) - (x.promised ?? -1) || (y.now ?? -1) - (x.now ?? -1));
    tally(run);
    const new_shots = added.filter((i) => (i.promised ?? 0) >= REACH).length;   // new in any tier (9 Nov: the list is three tiers now)
    run.refreshed = now; run.today = { new: new_shots, gone: gone.length, at: now };
    await kv.set(key, run);
    return { new_shots, new_scored: added.filter((i) => typeof i.now === "number").length, gone: gone.length, shots: run.shots ?? 0 };
  } finally { running.delete(userId); }
}

/** Every account with a live Radar plan, re-run once a morning (8am IST) and told on WhatsApp. Called every five minutes
 *  from index.ts; the day's lock in reader_control keeps it to once. */
export async function radarMorning(notify: (userId: string, r: { new_shots: number; gone: number; shots: number }) => Promise<void>): Promise<number> {
  const ist = new Date(Date.now() + 5.5 * 3600e3);
  if (ist.getUTCHours() !== 8) return 0;
  const day = ist.toISOString().slice(0, 10);
  const lockKey = `radar:morning:${day}`;
  if (await kv.get(lockKey)) return 0;
  await kv.set(lockKey, { started: new Date().toISOString() });
  const { data: plans } = await db.from("plans").select("user_id").eq("product", "radar").gt("expires_at", new Date().toISOString());
  // testers and favours (radar:unlock) get the morning too, so their list moves like a customer's
  const { data: unlocks } = await db.from("reader_control").select("key").like("key", "radar:unlock:%");
  const users = [...new Set([...(plans ?? []).map((p: any) => p.user_id as string), ...(unlocks ?? []).map((r: any) => String(r.key).slice("radar:unlock:".length))])];
  let n = 0;
  for (const userId of users) {
    try {
      const r = await refreshRadar(userId);
      if (r) { await notify(userId, r); n++; }
    } catch (e) { console.error("[radar] morning", userId, (e as Error).message); }
  }
  await kv.set(lockKey, { started: new Date().toISOString(), done: new Date().toISOString(), users: users.length, refreshed: n });
  return n;
}

/** Testers: wipe this account's Radar — run, matches, unlock, cached targets, remembered answers — to walk the flow from scratch. */
radar.post("/test/reset", async (c) => {
  const u = c.get("user");
  if (!isTester(u)) return c.json({ error: "Not available on this account." }, 403);
  if (running.has(u.id)) return c.json({ error: "A run is in progress; wait for it to finish." }, 409);
  for (const pat of [`radar:run:${u.id}`, `radar:unlock:${u.id}`, `told:${u.id}`]) await db.from("reader_control").delete().eq("key", pat);
  for (const pat of [`radar:m:${u.id}:%`, `radar:targets:${u.id}:%`]) await db.from("reader_control").delete().like("key", pat);
  // ?all=1: the résumé is set aside as well (not deleted — Sharpen's history keeps it), so the next visit uploads fresh
  if (c.req.query("all") === "1") await db.from("resumes").update({ is_current: false }).eq("user_id", u.id).eq("is_current", true);
  return c.json({ ok: true });
});

/** Testers: run this morning's refresh on your own account now. */
radar.post("/test/refresh", async (c) => {
  const u = c.get("user");
  if (!isTester(u)) return c.json({ error: "Not available on this account." }, 403);
  const r = await refreshRadar(u.id);
  return c.json(r ?? { error: "No finished Radar on this account." }, r ? 200 : 404);
});

radarPublic.get("/pulse", async (c) => {
  const p = await pulse();
  const [read, checked] = await Promise.all([postingsRead(), companiesChecked()]);
  return c.json({ ...p, read, checked, as_of: new Date().toISOString() });
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
  if (!t) { t = await withMeter({ tag: "radar:targets", user: u.id }, () => deriveTargets(resume.parsed)); await kv.set(key, t); }
  // live count and came-in-today per title, from the pool (₹0)
  const pool = await livePool(); titleIdf(pool); const since = Date.now() - 86400e3;
  const counts = t.titles.map((title) => { const tw = [words(title)]; let live = 0, today = 0; for (const s of pool) { if (titleScore(s.title ?? "", tw, t.level, true) >= 0.5) { live++; if (Date.parse(s.first_seen) >= since) today++; } } return { title, live, today }; });
  const my = (title: string) => titleScore(title, t.titles.map(words), t.level, true) >= 0.5;
  const mine = await pulse(my);
  // one role counted once, whatever number of titles it matches — the headline number on the conversion page
  let total_live = 0, total_today = 0;
  for (const s of pool) if (my(s.title ?? "")) { total_live++; if (Date.parse(s.first_seen) >= since) total_today++; }
  return c.json({ targets: t, counts, total_live, total_today, pulse: mine, resume_id: resume.id, name: resume.parsed.name, roles: (resume.parsed.roles ?? []).map((r) => ({ company: r.company, start: r.start, end: r.end })) });
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

/** The questions before the list exists: the must-haves employers hiring for these titles keep asking, from the posting
 *  checklists already on file (parsed once for everyone), turned into career-level questions. Cached a day per title set. */
async function preQuestions(userId: string, resume: ResumeProfile, resumeId: string, t: Targets): Promise<{ questions: ProfileQ[]; from: number }> {
  const key = `radar:pq2:${resumeId}:${[...t.titles].map(norm).sort().join("|").slice(0, 160)}`;
  const cached = await kv.get<{ questions: ProfileQ[]; from: number; at: string }>(key);
  if (cached && Date.now() - Date.parse(cached.at) < 24 * 3600e3 && cached.from >= 10) return cached;
  const pool = await livePool(); titleIdf(pool); const tw = t.titles.map(words).filter((w) => w.length);
  const ids = pool.filter((s) => s.readable && titleScore(s.title ?? "", tw, t.level, true) >= TITLE_IN).map((s) => s.id).slice(0, 600);
  const groups: { requirement: string; n: number; weight: number }[] = [];
  let from = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await db.from("reader_control").select("value").in("key", ids.slice(i, i + 100).map((id) => `radar:pp:${id}`));
    for (const r of data ?? []) {
      const pp = (r.value as any)?.posting as PostingProfile | undefined; if (!pp) continue; from++;
      for (const [list, w] of [[pp.must_have ?? [], 2], [pp.nice_to_have ?? [], 1]] as [string[], number][]) {
        for (const req of list) { const g = groups.find((g) => sameRequirement(g.requirement, req)); if (g) { g.n++; g.weight += w; } else groups.push({ requirement: req, n: 1, weight: w }); }
      }
    }
  }
  if (from < 10) return { questions: [], from };
  const top = groups.filter((g) => g.n >= 3).sort((a, b) => b.weight - a.weight || b.n - a.n).slice(0, 30).map((g) => ({ requirement: g.requirement, n: g.n }));
  if (!top.length) return { questions: [], from };
  const questions = await withMeter({ tag: "radar:prequestions", user: userId }, () => profileQuestions(resume, top));
  const out = { questions, from, at: new Date().toISOString() };
  await kv.set(key, out);
  return out;
}
/** The questions screen's data: career-level questions, with what this account already answered marked. */
radar.get("/test/prequestions", async (c) => {
  const u = c.get("user");
  const resume = await currentResume(u.id);
  if (!resume) return c.json({ error: "no_resume" }, 404);
  const tkey = `radar:targets:${u.id}:${resume.id}`;
  let t = await kv.get<Targets>(tkey); if (!t) { t = await withMeter({ tag: "radar:targets", user: u.id }, () => deriveTargets(resume.parsed)); await kv.set(tkey, t); }
  const runNow = await kv.get<Run>(runKey(u.id));
  let questions: ProfileQ[] = runNow?.pq ?? []; let from = -1;
  if (!questions.length) { const pre = await preQuestions(u.id, resume.parsed, resume.id, t); questions = pre.questions; from = pre.from; }
  const bank = await recallAnswers(u.id).catch(() => []);
  const marked = questions.map((q) => { const r = bank.find((x) => q.covers.some((cv) => sameRequirement(x.requirement, cv))); return r ? { ...q, told: { text: r.fact, line: r.line, remembered: true } } : q; });
  return c.json({ questions: marked, from, run_status: runNow?.status ?? "none" });
});
/** One answer, given before (or after) the list exists: remembered on the account, applied to every scored role that asks,
 *  now and every morning after. */
radar.post("/test/prime", async (c) => {
  const u = c.get("user");
  const body = z.object({
    covers: z.array(z.string().min(2).max(200)).min(1).max(12),
    choice: z.string().max(200).optional(),       // one of the three answers, in full
    free: z.string().max(400).optional(),         // their own line, optional
    withdraw: z.boolean().optional(),
  }).safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
  const run = await kv.get<Run>(runKey(u.id));
  if (body.data.withdraw) {
    for (const req of body.data.covers) { await forgetAnswer(u.id, req).catch(() => {}); if (run && run.items.length) await rescore(u.id, run, req, (m) => withdrawFrom(m, m.find((x) => sameRequirement(x.requirement, req))?.requirement ?? req)); }
    if (run) await kv.set(runKey(u.id), run);
    return c.json({ ok: true });
  }
  const choice = (body.data.choice ?? "").trim(), free = (body.data.free ?? "").trim();
  if (!choice && !free) return c.json({ error: "Pick one of the three, or say it your way." }, 400);
  if (/^(no|not really|none|never)\b/i.test(choice) && !free) return c.json({ ok: true, line: "" });   // a 'no' is remembered as nothing to add
  const line = free ? await withMeter({ tag: "radar:prime", user: u.id }, () => shapeFree(body.data.covers[0], free)) : choice.replace(/[.。]+$/, "") + ".";
  const facts = free || choice;
  for (const req of body.data.covers) {
    await rememberAnswer(u.id, { requirement: req, fact: facts, line }).catch(() => {});
    if (run && run.items.length) await rescore(u.id, run, req, (m) => acceptInto(m, m.find((x) => sameRequirement(x.requirement, req))?.requirement ?? req, facts, line));
  }
  if (run) await kv.set(runKey(u.id), run);
  return c.json({ ok: true, line });
});

radar.get("/test/result", async (c) => {
  const u = c.get("user");
  const run = await kv.get<Run>(runKey(u.id));
  if (!run) return c.json({ status: "none" });
  const unlocked = (await hasRadar(u.id)) || !!(await kv.get(`radar:unlock:${u.id}`));
  const scored = run.items.filter((i) => typeof i.now === "number");
  const shots = scored.filter((i) => (i.promised ?? 0) >= SHOT);
  const almost = scored.filter((i) => (i.promised ?? 0) >= ALMOST && (i.promised ?? 0) < SHOT);
  const gap = scored.filter((i) => (i.promised ?? 0) >= REACH && (i.promised ?? 0) < ALMOST);
  const chance = [...shots, ...almost, ...gap];
  const since = Date.now() - 86400e3;
  const oldest = chance.reduce((m, i) => Math.max(m, (Date.now() - Date.parse(i.first_seen)) / 86400e3), 0);
  const reveal = { by_title: run.by_title ?? 0, examined: run.examined ?? run.picked ?? 0, shots: shots.length, almost: almost.length, gap: gap.length, chance: chance.length,
    opened_today: chance.filter((i) => Date.parse(i.first_seen) >= since).length, within_reach: almost.length + gap.length, oldest_days: Math.round(oldest),
    // the taste: the employer and the two numbers, the role hidden — the best three across the tiers
    taste: chance.slice(0, 3).map((i) => ({ company: i.company, location: i.location, now: i.now, promised: i.promised, first_seen: i.first_seen, posted_at: i.posted_at })) };
  const my = (title: string) => titleScore(title, run.answers.titles.map(words), run.answers.level, true) >= 0.5;
  const mine = run.status === "done" ? await pulse(my).catch(() => null) : null;
  if (!isTester(u)) { delete (run as any).spend; delete (run as any).trail; }   // ours to see, not the customer's
  delete (run as any)._qTried;
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
