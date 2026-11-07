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
const OFEXP = new RegExp(String.raw`\b(\d{1,2})\s*${YRS}(?:['’]s?)?\s*(?:of\s+)?(?:relevant\s+|professional\s+|industry\s+|hands[- ]on\s+|work(?:ing)?\s+|prior\s+|total\s+|overall\s+|proven\s+)*(?:experience|exp\b)`, "i");
const MIN = new RegExp(String.raw`\b(?:minimum|min\.?|at\s+least|over|more\s+than|above)\s+(?:of\s+)?(\d{1,2})\s*\+?\s*${YRS}\b`, "i");
const WORDS: [RegExp, number][] = [[/\b(one)\s+year/i, 1], [/\b(two)\s+years/i, 2], [/\b(three)\s+years/i, 3], [/\b(four)\s+years/i, 4], [/\b(five)\s+years/i, 5], [/\b(six)\s+years/i, 6], [/\b(seven)\s+years/i, 7], [/\b(eight)\s+years/i, 8], [/\b(ten)\s+years/i, 10]];
const FRESH = /\b(fresher|freshers|new\s+grad(?:uate)?s?|recent\s+graduates?|entry[- ]level|0\s*(?:-|–|to)\s*[12]\s*(?:years?|yrs?)|internship|\bintern\b|trainee|campus)\b/i;

/** The minimum years a posting asks for, from its own text; null when it never says. */
export function statedYears(text: string): number | null {
  const t = (text ?? "").slice(0, 12000);
  if (!t) return null;
  // the first year statement in reading order wins (requirements come early and are about the role, not a bullet about a tool)
  const cands: { i: number; v: number }[] = [];
  const push = (re: RegExp, pick: (m: RegExpMatchArray) => number) => { const m = t.match(re); if (m && m.index !== undefined) { const v = pick(m); if (v >= 0 && v <= 30) cands.push({ i: m.index, v }); } };
  push(RANGE, (m) => Math.min(Number(m[1]), Number(m[2])));
  push(PLUS, (m) => Number(m[1]));
  push(OFEXP, (m) => Number(m[1]));
  push(MIN, (m) => Number(m[1]));
  for (const [re, v] of WORDS) push(re, () => v);
  if (!cands.length) { if (FRESH.test(t)) return 0; return null; }
  cands.sort((a, b) => a.i - b.i);
  return cands[0].v;
}

/** When the posting states nothing: the title's level word, as a rough guess, reported apart from the stated ones. */
export function titleBucket(title: string): Bucket | "unknown" {
  const t = (title ?? "").toLowerCase();
  if (/\b(intern|internship|trainee|graduate|fresher|apprentice|campus|entry)\b/.test(t)) return "fresher";
  if (/\b(chief|ceo|cfo|cto|coo|president|vice president|vp|svp|evp|avp|director|head)\b/.test(t)) return "10+";
  if (/\b(principal|distinguished|fellow|staff|senior manager|sr\.? manager|general manager|gm|dgm|agm|architect|group manager)\b/.test(t)) return "8-10";
  if (/\b(manager|lead|leader|supervisor)\b/.test(t)) return "6-8";
  if (/\b(senior|sr\.?|iii|expert|consultant)\b/.test(t)) return "4-6";
  if (/\b(junior|jr\.?|associate|assistant|analyst|executive|coordinator|representative|ii|i)\b/.test(t)) return "2-4";
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
    at: new Date().toISOString(), ms: Date.now() - t0,
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
  if (!have || (ist.getUTCHours() === 3 && stale)) { await computeExperienceSplit(); return true; }
  return false;
}
