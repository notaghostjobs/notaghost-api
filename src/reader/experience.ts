// The experience split of the live Bengaluru market, from the postings' own words. Zero model cost: a text search for
// "5+ years", "3-5 years", "minimum 2 years", "fresher" over every live Bengaluru description on file. Postings that
// state no years are bucketed from the title's level word and reported separately, so the stated and the inferred never
// mix. Computed once a night (and at boot if missing); stored in reader_control under stats:experience; read by admin.
import { db } from "../lib/db.js";

export type Bucket = "fresher" | "2-4" | "4-6" | "6-8" | "8-10" | "10+";
const BUCKETS: Bucket[] = ["fresher", "2-4", "4-6", "6-8", "8-10", "10+"];
const bucketOf = (min: number): Bucket => (min <= 1 ? "fresher" : min <= 3 ? "2-4" : min <= 5 ? "4-6" : min <= 7 ? "6-8" : min <= 9 ? "8-10" : "10+");

const YRS = String.raw`(?:years?|yrs?)`;
const RANGE = new RegExp(String.raw`\b(\d{1,2})\s*(?:\+\s*)?(?:-|–|—|to)\s*(\d{1,2})\s*\+?\s*${YRS}\b`, "i");
const PLUS = new RegExp(String.raw`\b(\d{1,2})\s*(?:\+|plus)\s*${YRS}\b`, "i");
const OFEXP = new RegExp(String.raw`\b(\d{1,2})\s*\+?\s*(?:(?:-|–|—|to)\s*(\d{1,2}))?\s*\+?\s*${YRS}(?:['’]s?)?\s*(?:of\s+)?(?:relevant\s+|professional\s+|industry\s+|hands[- ]on\s+|work(?:ing)?\s+|prior\s+|total\s+|overall\s+|proven\s+)*(?:experience|exp\b)`, "i");
const MIN = new RegExp(String.raw`\b(?:minimum|min\.?|at\s+least|over|more\s+than|above)\s+(?:of\s+)?(\d{1,2})\s*\+?\s*${YRS}\b`, "i");
const WORDS: [RegExp, number][] = [[/\b(one)\s+year/i, 1], [/\b(two)\s+years/i, 2], [/\b(three)\s+years/i, 3], [/\b(four)\s+years/i, 4], [/\b(five)\s+years/i, 5], [/\b(six)\s+years/i, 6], [/\b(seven)\s+years/i, 7], [/\b(eight)\s+years/i, 8], [/\b(ten)\s+years/i, 10]];
const FRESH = /\b(fresher|freshers|new\s+grad(?:uate)?s?|recent\s+graduates?|entry[- ]level|0\s*(?:-|–|to)\s*[12]\s*(?:years?|yrs?)|internship|\bintern\b|trainee|campus)\b/i;

const EXP_FIRST = new RegExp(String.raw`\b(?:experience|exp)\b[^.\n]{0,40}?(\d{1,2})\s*\+?\s*(?:(?:-|–|—|to)\s*(\d{1,2}))?\s*\+?\s*${YRS}\b`, "i");
const IN_FIELD = new RegExp(String.raw`\b(\d{1,2})\s*\+?\s*(?:(?:-|–|—|to)\s*(\d{1,2}))?\s*\+?\s*${YRS}\b\s+(?:of\s+)?(?:in|as|with|working|leading|managing|building|delivering|handling)\b`, "i");
const BOILER = /\b(history|heritage|legacy|industry leader|in business|established|founded|serving|track record|old|anniversary|company|organisation|organization|clients?|customers?|excellence|innovation|leadership in|presence|operations in|employees|offices)\b/i;
export const PARSER_VERSION = 2;
/** The minimum years a posting asks for, from its own text; null when it never says.
 *  Anchored statements first ("5+ years of experience", "minimum 3 years", "experience: 2-4 years", "4+ years in retail");
 *  a bare "10+ years" counts only when nothing anchored exists and it isn't company boilerplate ("over 25 years of history"). */
export function statedYears(text: string): number | null {
  const t = (text ?? "").slice(0, 12000);
  if (!t) return null;
  const anchored: { i: number; v: number }[] = [], bare: { i: number; v: number }[] = [];
  const boiler = (m: RegExpMatchArray) => BOILER.test(t.slice(m.index ?? 0, (m.index ?? 0) + 90));
  const push = (list: { i: number; v: number }[], re: RegExp, pick: (m: RegExpMatchArray) => number) => { const m = t.match(re); if (m && m.index !== undefined && !boiler(m)) { const v = pick(m); if (v >= 0 && v <= 18) list.push({ i: m.index, v }); } };
  const lo = (m: RegExpMatchArray) => (m[2] ? Math.min(Number(m[1]), Number(m[2])) : Number(m[1]));
  push(anchored, OFEXP, lo);
  push(anchored, MIN, (m) => Number(m[1]));
  push(anchored, EXP_FIRST, lo);
  push(anchored, IN_FIELD, lo);
  for (const [re, v] of WORDS) push(anchored, re, () => v);
  if (anchored.length) { anchored.sort((a, b) => a.i - b.i); return anchored[0].v; }
  push(bare, RANGE, (m) => Math.min(Number(m[1]), Number(m[2])));
  push(bare, PLUS, (m) => Number(m[1]));
  if (bare.length) { bare.sort((a, b) => a.i - b.i); return bare[0].v; }
  if (FRESH.test(t)) return 0;
  return null;
}

/** The years band a posting asks for — {min, max} with max null when it says "5+" — or null when it never says.
 *  Same anchoring and boilerplate rules as statedYears. */
export function statedBand(text: string): { min: number; max: number | null } | null {
  // stored descriptions may still carry numeric entities ("15&#43; years"); read them as the characters they are
  const t = (text ?? "").slice(0, 12000).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  if (!t) return null;
  const boiler = (i: number) => BOILER.test(t.slice(i, i + 90).split(/[.\n]/)[0]);   // the statement's own sentence, not the one after it
  // A posting often states two numbers: the total ("12+ years of experience") and a part of it ("at least 3 years in a
  // leadership role", "5 years managing teams"). The band is the total. Each candidate is tagged from its context.
  const SUB = /^[^.\n]{0,70}?\b(in\s+(a\s+|an\s+)?(senior|leadership|management|managerial|people[- ]management|similar|lead|supervisory|executive)\b|leading\b|managing\s+(teams|people|managers|a team)|as\s+(an?\s+)?(analyst|manager|lead|head|director)|of\s+which|including)/i;
  const PRE_SUB = /\b(at\s+least|including|of\s+which|with|and)\s*$/i;
  const TOTAL = /^[^.\n]{0,40}?\b(overall|total|of\s+(relevant\s+|professional\s+|work(?:ing)?\s+|prior\s+|industry\s+)?experience)\b/i;
  const PRE_TOTAL = /\b(overall|total|typically|minimum|at least)\s*,?\s*$/i;
  type C = { i: number; min: number; max: number | null; total: boolean; sub: boolean; bare: boolean };
  const cands: C[] = [];
  const take = (re: RegExp, bare: boolean) => {
    for (const m of t.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))) {
      const i = m.index ?? 0; if (boiler(i)) continue;
      const a = Number(m[1]), b = m[2] ? Number(m[2]) : null; if (a > 30 || (b !== null && b < a)) continue;
      const after = t.slice(i + m[0].length, i + m[0].length + 90), before = t.slice(Math.max(0, i - 40), i);
      cands.push({ i, min: a, max: b, total: TOTAL.test(after) || PRE_TOTAL.test(before), sub: SUB.test(after) || PRE_SUB.test(before), bare });
    }
  };
  take(OFEXP, false); take(EXP_FIRST, false); take(IN_FIELD, false); take(RANGE, true); take(PLUS, true);
  for (const m of t.matchAll(new RegExp(MIN.source, "gi"))) { const i = m.index ?? 0; if (boiler(i) || Number(m[1]) > 30) continue; const after = t.slice(i + m[0].length, i + m[0].length + 90); cands.push({ i, min: Number(m[1]), max: null, total: TOTAL.test(after), sub: SUB.test(after), bare: false }); }
  if (!cands.length) return FRESH_BAND.test(t) ? { min: 0, max: 1 } : null;
  const pick = (list: C[]) => list.sort((x, y) => x.i - y.i)[0];
  const chosen = pick(cands.filter((c) => c.total && !c.sub)) ?? pick(cands.filter((c) => !c.sub && !c.bare)) ?? pick(cands.filter((c) => !c.sub)) ?? pick(cands);
  return { min: chosen.min, max: chosen.max };
}
/** Only the plain words for an entry-level posting decide a 0–1 band; a company's "internship programme" paragraph does not. */
const FRESH_BAND = /\b(fresher|freshers|new\s+grad(?:uate)?s?|recent\s+graduates?|entry[- ]level|0\s*(?:-|–|to)\s*[12]\s*(?:years?|yrs?))\b/i;

/** When the posting states nothing: the title's level word, as a rough guess, reported apart from the stated ones. */
export function titleBucket(title: string): Bucket | "unknown" {
  const t = (title ?? "").toLowerCase();
  if (/\b(intern|internship|trainee|graduate|fresher|apprentice|campus|entry)\b/.test(t)) return "fresher";
  if (/\bchief of staff\b/.test(t)) return "unknown";   // a Chief of Staff is whatever the posting's years say, not a chief
  if (/\b(chief|ceo|cfo|cto|coo|president|vice president|vp|svp|evp|avp|director|head)\b/.test(t)) return "10+";
  if (/\b(principal|distinguished|fellow|staff|senior manager|sr\.? manager|general manager|gm|dgm|agm|architect|group manager)\b/.test(t)) return "8-10";
  if (/\b(senior|sr\.?)\b[^,|(–-]{0,30}\bmanager\b/.test(t) && !/\b(assistant|associate|deputy) manager\b/.test(t)) return "8-10";   // "Senior Category Manager", "Sr. Product Manager": the senior-manager rung
  if (/\b(assistant manager|associate manager|deputy manager|asst\.? manager)\b/.test(t)) return "4-6";   // India's first management rung, three to six years in
  if (/\b(lead|senior|sr\.?|principal|staff) associate\b|\bassociate (ii|iii|2|3)\b/.test(t)) return "4-6";   // "Lead Associate", "Principal Associate": an associate's seat with a prefix, not a lead's
  if (/\b(manager|lead|leader|supervisor)\b/.test(t)) return "6-8";
  if (/\b(senior|sr\.?|iii|expert|consultant)\b/.test(t)) return "4-6";
  if (/\b(junior|jr\.?|associate|assistant|analyst|executive|coordinator|representative|specialist|planner|officer|intermediate|mid[- ]?level|ii|i)\b/.test(t)) return "2-4";
  return "unknown";
}

type Tally = { n: number; titles: Record<string, number>; employers: Record<string, number> };
const tally = (): Tally => ({ n: 0, titles: {}, employers: {} });
const top = (o: Record<string, number>, k = 12) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, k).map(([name, n]) => ({ name, n }));
const normTitle = (t: string) => (t ?? "").replace(/\s*[-–—(|,].*$/, "").replace(/\b(sr\.?|senior)\b/gi, "Senior").trim().slice(0, 60);

export async function computeExperienceSplit() {
  const t0 = Date.now();
  const stated: Record<Bucket, Tally> = Object.fromEntries(BUCKETS.map((b) => [b, tally()])) as any;
  const inferred: Record<string, Tally> = Object.fromEntries([...BUCKETS, "unknown"].map((b) => [b, tally()]));
  let total = 0, withDesc = 0, statedN = 0;
  const samples: Record<Bucket, string[]> = Object.fromEntries(BUCKETS.map((b) => [b, []])) as any;
  for (let from = 0; from < 80000; from += 500) {
    const { data, error } = await db.from("sightings").select("id, title, company_name, description").eq("blr", true).is("gone_at", null).order("id", { ascending: true }).range(from, from + 499);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as any[]) {
      total++;
      const emp = r.company_name ?? "?", title = normTitle(r.title ?? "");
      const yrs = r.description ? (withDesc++, statedYears(r.description)) : null;
      if (yrs !== null) {
        statedN++;
        const b = bucketOf(yrs), s = stated[b]; s.n++; s.titles[title] = (s.titles[title] ?? 0) + 1; s.employers[emp] = (s.employers[emp] ?? 0) + 1;
        if (samples[b].length < 6) samples[b].push(`${r.title} — ${emp}`);
      } else {
        const b = titleBucket(r.title ?? ""), s = inferred[b]; s.n++; s.titles[title] = (s.titles[title] ?? 0) + 1; s.employers[emp] = (s.employers[emp] ?? 0) + 1;
      }
    }
    if (!data || data.length < 500) break;
  }
  const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : 0);
  // the market view: stated where stated, the title's level where not — every live role lands in one bucket
  const combined: Record<string, number> = {};
  for (const b of BUCKETS) combined[b] = stated[b].n + inferred[b].n;
  combined.unknown = inferred.unknown.n;
  const out = {
    at: new Date().toISOString(), ms: Date.now() - t0, parser: PARSER_VERSION,
    total, with_description: withDesc, years_stated: statedN, years_stated_share_of_described: pct(statedN, withDesc),
    buckets: BUCKETS.map((b) => ({ bucket: b, stated: stated[b].n, stated_share: pct(stated[b].n, statedN), inferred_from_title: inferred[b].n, all: combined[b], all_share: pct(combined[b], total),
      top_titles: top(stated[b].titles), top_employers: top(stated[b].employers), samples: samples[b] })),
    unknown_from_title: inferred.unknown.n,
    note: "stated = the posting's own words (first year statement in reading order; ranges take the lower end). inferred_from_title = postings that state no years, bucketed by the title's level word. all = stated + inferred. fresher = 0-1 years or fresher/intern/trainee wording.",
  };
  await db.from("reader_control").upsert({ key: "stats:experience", value: out, updated_at: new Date().toISOString() }, { onConflict: "key" });
  return out;
}

export async function experienceSplit(): Promise<any | null> {
  const { data } = await db.from("reader_control").select("value").eq("key", "stats:experience").maybeSingle();
  return data?.value ?? null;
}

/** Nightly at 3am IST, and at boot when there is no split yet. */
export async function experienceTick(): Promise<boolean> {
  const have = await experienceSplit();
  const ist = new Date(Date.now() + 5.5 * 3600e3);
  const stale = !have || Date.now() - Date.parse(have.at) > 20 * 3600e3;
  const old = have && have.parser !== PARSER_VERSION;   // a better parser recomputes at the next boot
  if (!have || old || (ist.getUTCHours() === 3 && stale)) { await computeExperienceSplit(); return true; }
  return false;
}
