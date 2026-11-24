// The free pass of the US short list: no model, only words. Given what a résumé is aiming at (a few target titles and a
// level), it orders the open roles by how close their titles are and keeps a few dozen worth reading closely.
export const FUNCS = ["engineering", "product", "design", "data", "marketing", "sales", "operations", "finance", "people", "support", "legal", "healthcare", "other"] as const;
export const LEVELS = ["intern", "entry", "mid", "senior", "leader"] as const;
export type Level = (typeof LEVELS)[number];
export type Row = { system: string; ref: string; job_id: string; title: string; location: string | null; remote: boolean; url: string; posted_at: string | null; level: string | null; func: string | null };

const RANK = /^(senior|sr|staff|principal|lead|junior|jr|associate|head|director|vp|chief|manager|intern|i|ii|iii|iv|v|of|the|and|for|to|in|a)$/;
export const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9+#. ]+/g, " ").split(/\s+/).filter((w) => w.length > 1 || /[a-z]/.test(w)).filter(Boolean);
const core = (s: string) => words(s).filter((w) => !RANK.test(w));

/** The levels worth looking at for someone at `l`: their own and one either side, except that interns stay near the door. */
export function near(l: Level): Level[] {
  const i = LEVELS.indexOf(l);
  if (i <= 0) return ["intern", "entry"];
  return LEVELS.slice(Math.max(1, i - 1), i + 2) as Level[];
}

/** The distinct title words to search by, longest first, so a query can ask for any role naming one of them. */
export function keywords(titles: string[], max = 8): string[] {
  const seen = new Set<string>();
  for (const t of titles) for (const w of core(t)) if (w.length >= 3 && /^[a-z0-9+#.]+$/.test(w)) seen.add(w);
  return [...seen].sort((a, b) => b.length - a.length).slice(0, max);
}

/** 0..1: how much of the closest target title this role's title shares, with a little for the right level and for being recent. */
export function titleScore(row: Row, targets: string[], level: Level, now = Date.now()): number {
  const have = new Set(core(row.title));
  let best = 0;
  for (const t of targets) {
    const want = core(t); if (!want.length) continue;
    const hit = want.filter((w) => have.has(w)).length;
    best = Math.max(best, hit / want.length - Math.max(0, have.size - want.length) * 0.04);
  }
  const lv = row.level === level ? 0.12 : 0;
  const age = row.posted_at ? Math.max(0, (now - Date.parse(row.posted_at)) / 864e5) : 60;
  return Math.max(0, best) * 0.8 + lv + Math.max(0, 0.08 - age * 0.0013);
}

/** The few dozen to read closely: best title match first, no more than two from one employer. */
export function closest(rows: Row[], targets: string[], level: Level, keep = 40, now = Date.now()): Row[] {
  const per = new Map<string, number>(), out: Row[] = [];
  const scored = rows.map((r) => ({ r, s: titleScore(r, targets, level, now) })).filter((x) => x.s > 0.2).sort((a, b) => b.s - a.s);
  for (const { r } of scored) {
    const k = `${r.system}/${r.ref}`.toLowerCase(), n = per.get(k) ?? 0;
    if (n >= 2) continue;
    per.set(k, n + 1); out.push(r);
    if (out.length >= keep) break;
  }
  return out;
}

/** An employer's board name as a readable word, for when the posting itself does not give one. */
export const pretty = (ref: string) => ref.replace(/[-_.]+/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase()).trim();
/** One short place for a card: remote roles say so; otherwise the first place named. */
export const place = (location: string | null, remote: boolean) => (remote && !/[A-Z]{2}\b|,/.test(location ?? "") ? "Remote (US)" : (location ?? "United States").split(/;|\|/)[0].trim().slice(0, 40) || "United States");

const STATES = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "));
/** The city to offer on the "where" card, or null. It is offered only when we are sure: the model read it from the contact
 *  block, it is in the United States, and the same city name is really written in the first lines of the résumé (before any
 *  job is listed). Anything less and no city is shown, so nobody is told they live where they once worked. */
export function homeCity(h: { city?: string | null; state?: string | null; country?: string | null } | null | undefined, resume: string): string | null {
  const city = (h?.city ?? "").trim(); const state = (h?.state ?? "").trim().toUpperCase();
  if (!city || city.length < 3 || city.length > 40 || !/^[A-Za-z .'-]+$/.test(city)) return null;
  if (!STATES.has(state) || (h?.country && !/^(US|USA)$/i.test(h.country))) return null;
  // the contact block is whatever comes before the first section heading; with no heading in sight, only the first few lines count
  const top = resume.slice(0, 600), first = top.search(/^\s*(work\s+)?(experience|employment|work history|professional (summary|experience)|summary|profile|objective|education|skills|projects)\b/im);
  const head = first >= 0 ? top.slice(0, first) : top.split(/\n/).slice(0, 4).join("\n").slice(0, 240);
  // the city must be written there with its state right beside it, as a contact line writes it ("Austin, TX")
  if (!new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s,]+${state}\\b`, "i").test(head)) return null;
  return city.replace(/\s+/g, " ");
}

/** A title's level, by its own words (the same rule the US reader uses when it stores a role). */
export function levelOf(title: string): Level {
  if (/\b(intern|internship|co-?op|apprentice|trainee)\b/i.test(title)) return "intern";
  if (/\b(new grad|graduate|entry[- ]level|fresher|junior|jr\.?|associate|early career|i\b(?!i))\b/i.test(title) && !/\b(senior|sr\.?|director|manager|lead|principal|staff)\b/i.test(title)) return "entry";
  if (/\b(chief|vp|vice president|head of|director|principal|distinguished|fellow)\b/i.test(title)) return "leader";
  if (/\b(senior|sr\.?|staff|lead|manager|iii|iv)\b/i.test(title)) return "senior";
  return "mid";
}
