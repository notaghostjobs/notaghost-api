// The meter. Every model call records its tokens and an estimated cost in paise, tagged with what it was for and, when
// known, which account it was for. Totals flush to reader_control every 30 seconds: meter:day:<date>:<proc> for the
// day, meter:acct:<user> for the account's lifetime. The Radar cap (₹600 per account per plan) reads the account total.
// Estimates use list prices; the number to believe is the Anthropic invoice — this is the per-run breakdown of it.
import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "../lib/db.js";

export type MeterCtx = { tag: string; user?: string; acc?: { paise: number } };
const als = new AsyncLocalStorage<MeterCtx>();
export const withMeter = <T>(ctx: MeterCtx, fn: () => Promise<T>) => als.run(ctx, fn);
export const meterCtx = () => als.getStore();

// list prices, USD per million tokens; INR at 84. Unknown models fall back to the Sonnet row.
const PRICE: Record<string, { in: number; out: number; cr: number; cw: number }> = {
  sonnet: { in: 3, out: 15, cr: 0.3, cw: 3.75 },
  haiku: { in: 1, out: 5, cr: 0.1, cw: 1.25 },
  opus: { in: 15, out: 75, cr: 1.5, cw: 18.75 },
};
const INR = 84;
export function paiseOf(model: string, u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number {
  const p = PRICE[/haiku/.test(model) ? "haiku" : /opus/.test(model) ? "opus" : "sonnet"];
  const usd = ((u.input_tokens ?? 0) * p.in + (u.output_tokens ?? 0) * p.out + (u.cache_read_input_tokens ?? 0) * p.cr + (u.cache_creation_input_tokens ?? 0) * p.cw) / 1e6;
  return Math.round(usd * INR * 100);
}

type Line = { calls: number; in: number; out: number; cache_read: number; cache_write: number; paise: number };
const line = (): Line => ({ calls: 0, in: 0, out: 0, cache_read: 0, cache_write: 0, paise: 0 });
const add = (a: Line, b: Line) => { a.calls += b.calls; a.in += b.in; a.out += b.out; a.cache_read += b.cache_read; a.cache_write += b.cache_write; a.paise += b.paise; };

const pending = { day: new Map<string, Line>(), acct: new Map<string, Map<string, Line>>() };
const PROC = process.env.RENDER_SERVICE_NAME ?? process.env.METER_PROC ?? "api";
const istDay = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);

export function record(model: string, u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }) {
  const ctx = als.getStore();
  const tag = ctx?.tag ?? "untagged";
  const l: Line = { calls: 1, in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0, paise: paiseOf(model, u) };
  if (ctx?.acc) ctx.acc.paise += l.paise;
  const d = pending.day.get(tag) ?? line(); add(d, l); pending.day.set(tag, d);
  if (ctx?.user) { const m = pending.acct.get(ctx.user) ?? new Map<string, Line>(); const a = m.get(tag) ?? line(); add(a, l); m.set(tag, a); pending.acct.set(ctx.user, m); }
  if (!timer) timer = setTimeout(() => { timer = null; flush().catch((e) => console.error("[meter] flush", (e as Error).message)); }, 30e3);
}
let timer: NodeJS.Timeout | null = null;

type DayDoc = { by_tag: Record<string, Line> };
type AcctDoc = { paise: number; by_tag: Record<string, Line>; since: string; updated: string };

export async function flush() {
  if (pending.day.size) {
    const key = `meter:day:${istDay()}:${PROC}`;
    const day = new Map(pending.day); pending.day.clear();
    const { data } = await db.from("reader_control").select("value").eq("key", key).maybeSingle();
    const doc: DayDoc = (data?.value as DayDoc) ?? { by_tag: {} };
    for (const [tag, l] of day) { const cur = doc.by_tag[tag] ?? line(); add(cur, l); doc.by_tag[tag] = cur; }
    await db.from("reader_control").upsert({ key, value: doc, updated_at: new Date().toISOString() }, { onConflict: "key" });
  }
  if (pending.acct.size) {
    const accts = new Map(pending.acct); pending.acct.clear();
    for (const [user, m] of accts) {
      const key = `meter:acct:${user}`;
      const { data } = await db.from("reader_control").select("value").eq("key", key).maybeSingle();
      const doc: AcctDoc = (data?.value as AcctDoc) ?? { paise: 0, by_tag: {}, since: new Date().toISOString(), updated: "" };
      for (const [tag, l] of m) { const cur = doc.by_tag[tag] ?? line(); add(cur, l); doc.by_tag[tag] = cur; doc.paise += l.paise; }
      doc.updated = new Date().toISOString();
      await db.from("reader_control").upsert({ key, value: doc, updated_at: doc.updated }, { onConflict: "key" });
    }
  }
}

/** What an account's plan has cost so far (paise), as charged through `charge`. */
export async function spentSince(user: string, since: string): Promise<number> {
  const key = `meter:plan:${user}:${since.slice(0, 10)}`;
  const { data } = await db.from("reader_control").select("value").eq("key", key).maybeSingle();
  return Number((data?.value as any)?.paise ?? 0);
}
/** Run `fn` under an account tag and add what it cost to that account's plan counter. Returns fn's result and the paise. */
export async function charge<T>(user: string, planSince: string, tag: string, fn: () => Promise<T>): Promise<{ result: T; paise: number }> {
  const acc = { paise: 0 };
  const result = await withMeter({ tag, user, acc }, fn);
  if (acc.paise > 0) {
    const key = `meter:plan:${user}:${planSince.slice(0, 10)}`;
    const { data } = await db.from("reader_control").select("value").eq("key", key).maybeSingle();
    const doc = (data?.value as any) ?? { paise: 0, since: planSince, by_tag: {} };
    doc.paise = Number(doc.paise ?? 0) + acc.paise; doc.by_tag[tag] = Number(doc.by_tag[tag] ?? 0) + acc.paise; doc.updated = new Date().toISOString();
    await db.from("reader_control").upsert({ key, value: doc, updated_at: doc.updated }, { onConflict: "key" });
  }
  return { result, paise: acc.paise };
}

/** The last `days` days, every process, by tag — for the admin page. */
export async function meterDays(days = 7) {
  const since = new Date(Date.now() - days * 86400e3);
  const { data } = await db.from("reader_control").select("key, value").like("key", "meter:day:%").gte("updated_at", since.toISOString());
  const out: Record<string, Record<string, Line>> = {};
  for (const r of data ?? []) {
    const day = r.key.split(":")[2]; const doc = r.value as DayDoc;
    out[day] = out[day] ?? {};
    for (const [tag, l] of Object.entries(doc.by_tag)) { const cur = out[day][tag] ?? line(); add(cur, l); out[day][tag] = cur; }
  }
  const totals: Record<string, Line & { rupees: number }> = {};
  for (const day of Object.keys(out).sort()) { const t = line(); for (const l of Object.values(out[day])) add(t, l); totals[day] = { ...t, rupees: Math.round(t.paise / 100) }; }
  return { by_day: out, totals, proc: PROC, prices_usd_per_m: PRICE, inr: INR };
}
