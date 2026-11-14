// What QA keeps: its own records (outbox, AI calls, faults, spend), all under "qa:" keys in the QA database.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { db } from "../lib/db.js";

export const rid = () => randomBytes(6).toString("hex");
/** the request a piece of work belongs to: set per request, inherited by the background work it starts */
export const qaCtx = new AsyncLocalStorage<{ rid: string; user?: string }>();
export const now = () => new Date().toISOString();

export const store = {
  async get<T>(key: string): Promise<T | null> { const { data } = await db.from("reader_control").select("value").eq("key", key).maybeSingle(); return (data?.value as T) ?? null; },
  async set(key: string, value: unknown) { await db.from("reader_control").upsert({ key, value, updated_at: now() }, { onConflict: "key" }); },
  async del(prefix: string) { await db.from("reader_control").delete().like("key", `${prefix}%`); },
  async list<T>(prefix: string, limit = 200): Promise<T[]> { const { data } = await db.from("reader_control").select("value").like("key", `${prefix}%`).order("key", { ascending: false }).limit(limit); return (data ?? []).map((r: any) => r.value as T); },
  /** an append-only record: the key sorts by time */
  async log(kind: string, value: Record<string, unknown>) { const at = now(); const row = { at, rid: qaCtx.getStore()?.rid ?? null, ...value }; await db.from("reader_control").insert({ key: `qa:${kind}:${at}:${rid()}`, value: row, updated_at: at }).then(() => {}, () => {}); return row; },
};

// ---- faults a tester can switch on: each fires `times` times, then clears ----
export type FaultKind = "ai_timeout" | "ai_rate_limit" | "ai_malformed" | "parse_fail" | "page_unavailable" | "wa_fail";
const faults = new Map<FaultKind, number>();
export const setFault = (k: FaultKind, times: number) => { if (times > 0) faults.set(k, times); else faults.delete(k); };
export const takeFault = (k: FaultKind) => { const n = faults.get(k) ?? 0; if (n <= 0) return false; if (n === 1) faults.delete(k); else faults.set(k, n - 1); return true; };
export const faultState = () => Object.fromEntries(faults);
