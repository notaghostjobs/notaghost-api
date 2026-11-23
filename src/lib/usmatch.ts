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
