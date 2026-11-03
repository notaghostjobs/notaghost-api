import { Hono } from "hono";
import { db } from "../lib/db.js";
import { cleanTag, logEvent } from "../lib/src.js";

/** Public: the page reports a tagged arrival (one per landing). Nothing personal; the anonymous browser id only. */
export const events = new Hono();
events.post("/click", async (c) => {
  const b = await c.req.json().catch(() => ({})) as { src?: string; first?: string; anon?: string; path?: string; ref?: string };
  const last = cleanTag(b.src), first = cleanTag(b.first) ?? last;
  if (!last) return c.json({ ok: false }, 400);
  void logEvent("click", { src: { first, last }, anon: typeof b.anon === "string" ? b.anon.slice(0, 64) : null, meta: { path: String(b.path ?? "").slice(0, 200), ref: String(b.ref ?? "").slice(0, 200) } });
  return c.json({ ok: true });
});

/**
 * Admin, read-only: the funnel per channel. click → check → signin → preview → shot → order → paid, with people
 * (distinct browsers or users) and revenue, since a date. Attribution is by first source; "direct" is everyone untagged.
 *   GET /admin/funnel?since=2026-11-06&until=2026-11-09&by=src|day
 */
export const funnel = new Hono();
const STAGES = ["click", "wa_in", "check", "signin", "preview", "shot", "order", "paid"] as const;
type Stage = typeof STAGES[number];

funnel.get("/", async (c) => {
  const since = c.req.query("since") ? new Date(c.req.query("since")!) : new Date(Date.now() - 7 * 86400e3);
  const until = c.req.query("until") ? new Date(c.req.query("until")!) : new Date();
  const by = c.req.query("by") === "day" ? "day" : "src";
  const rows: any[] = [];
  for (let off = 0; off < 50000; off += 1000) {
    const { data, error } = await db.from("events").select("at, kind, src_first, src_last, anon, user_id, meta").gte("at", since.toISOString()).lte("at", until.toISOString()).order("at", { ascending: true }).range(off, off + 999);
    if (error) return c.json({ error: error.message }, 500);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const keyOf = (r: any) => by === "day" ? String(r.at).slice(0, 10) : (r.src_first ?? "direct");
  const groups = new Map<string, { events: Record<Stage, number>; people: Record<Stage, Set<string>>; revenue_paise: number; verdicts: Record<string, number> }>();
  const blank = () => ({ events: Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>, people: Object.fromEntries(STAGES.map((s) => [s, new Set<string>()])) as Record<Stage, Set<string>>, revenue_paise: 0, verdicts: {} as Record<string, number> });
  for (const r of rows) {
    const k = keyOf(r); if (!groups.has(k)) groups.set(k, blank());
    const g = groups.get(k)!; const kind = r.kind as Stage; if (!(kind in g.events)) continue;
    g.events[kind]++;
    const who = r.user_id ?? (r.anon ? `a:${r.anon}` : null); if (who) g.people[kind].add(who);
    if (kind === "paid") g.revenue_paise += Number(r.meta?.amount_paise ?? 0);
    if (kind === "check" && r.meta?.verdict) g.verdicts[r.meta.verdict] = (g.verdicts[r.meta.verdict] ?? 0) + 1;
  }
  const out = [...groups.entries()].map(([key, g]) => {
    const people = Object.fromEntries(STAGES.map((s) => [s, g.people[s].size])) as Record<Stage, number>;
    const top = people.click || people.wa_in || people.check || 1;
    return { key, events: g.events, people, paid: people.paid, revenue_inr: Math.round(g.revenue_paise / 100),
      rates: { click_to_check: people.click ? +(people.check / people.click).toFixed(3) : null, check_to_signin: people.check ? +(people.signin / people.check).toFixed(3) : null, signin_to_preview: people.signin ? +(people.preview / people.signin).toFixed(3) : null, preview_to_paid: people.preview ? +(people.paid / people.preview).toFixed(3) : null, top_to_paid: +(people.paid / top).toFixed(4) },
      verdicts: g.verdicts };
  }).sort((a, b) => b.paid - a.paid || b.people.check - a.people.check);
  return c.json({ since: since.toISOString(), until: until.toISOString(), by, stages: STAGES, channels: out, events_read: rows.length,
    note: "people = distinct browsers before sign-in and distinct users after; attribution is by the first source a person was seen with; 'direct' = untagged." });
});
