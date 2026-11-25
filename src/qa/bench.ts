// A temporary pass-through for one approved pilot (25 Nov 2026: AI job reading, Haiku 5.5 vs Sonnet 5.5, ₹350 hard cap).
// Model requests made in the founder's workspace are forwarded to the model with QA's own key, so no key leaves this
// service. QA only. It keeps nothing: not the request, not the reply. It records what every QA model call records
// (model, tokens, cost) in the QA log, and is bound by its own cumulative pilot cap (₹350 at current list prices, kept
// across restarts, worst case set aside before each call, three calls at a time) instead of the QA testers' budget,
// whose ₹1,000 ceiling is a fixed safety rule and whose meter prices Haiku at ten times its list price. It closes by
// itself at CLOSES.
// It is to be deleted when the pilot is done.
import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../lib/env.js";
import { QA } from "./guard.js";
import { promptVersion } from "./budget.js";
import { store } from "./state.js";

const TOKEN_SHA256 = "ce211548b4faca7f8f08eab08967f00bdb512ab98c960166f0734952361f5ecd";                       // the token itself exists only in the workspace that runs the benchmark
const CLOSES = Date.parse("2026-11-29T00:00:00+05:30");
export const MAX_BODY = 200_000, MAX_OUT = 4_000, AT_ONCE = 3;
/** The only two models the pilot compares. */
export const PILOT_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"] as const;
/** The pilot's own hard cap, cumulative across restarts (kept in the QA store), in paise. */
export const PILOT_CAP_PAISE = 35_000;
/** Current list prices, USD per million tokens (platform.claude.com pricing, 25 Nov 2026), at ₹90 to the dollar: the
 *  pilot counts its spend at these, rounded up. Cache writes at 1.25× input. */
const PILOT_PRICE: Record<string, { in: number; out: number; cr: number; cw: number }> = {
  "claude-haiku-5-5": { in: 0.10, out: 0.50, cr: 0.01, cw: 0.125 },
  "claude-sonnet-5-5": { in: 2, out: 10, cr: 0.10, cw: 2.5 },
};
export const pilotPaise = (model: string, u: any) => { const p = PILOT_PRICE[model]; if (!p) return Infinity;
  const usd = ((u?.input_tokens ?? 0) * p.in + (u?.output_tokens ?? 0) * p.out + (u?.cache_read_input_tokens ?? 0) * p.cr + (u?.cache_creation_input_tokens ?? 0) * p.cw) / 1e6;
  return Math.ceil(usd * 90 * 100); };
export const allowed = (given: string | undefined, now = Date.now()) => { const got = createHash("sha256").update(String(given ?? "")).digest(); return QA && now < CLOSES && String(given ?? "").length === 64 && timingSafeEqual(got, Buffer.from(TOKEN_SHA256, "hex")); };

/** The one request the benchmark makes, and nothing else: exactly the fields the engine's own model call sends
 *  (engine/claude.ts json()). Returns why it is refused, or null. Any other field, block type or role is refused. */
const only = (o: any, keys: string[]) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).every((k) => keys.includes(k));
export function refuse(b: any): string | null {
  if (!only(b, ["model", "max_tokens", "system", "messages"])) return "unexpected field";
  if (!(PILOT_MODELS as readonly string[]).includes(b.model)) return "model not allowed";
  if (!Number.isInteger(b.max_tokens) || b.max_tokens < 1 || b.max_tokens > MAX_OUT) return "max_tokens not allowed";
  if (!Array.isArray(b.system) || b.system.length < 1 || b.system.length > 2) return "system must be one or two text blocks";
  for (const s of b.system) { if (!only(s, ["type", "text", "cache_control"]) || s.type !== "text" || typeof s.text !== "string" || !s.text) return "system block not allowed"; if (s.cache_control !== undefined && !(only(s.cache_control, ["type"]) && s.cache_control.type === "ephemeral")) return "cache_control not allowed"; }
  if (!Array.isArray(b.messages) || b.messages.length !== 1) return "exactly one message";
  const m = b.messages[0]; if (!only(m, ["role", "content"]) || m.role !== "user" || typeof m.content !== "string" || !m.content) return "the message must be one user message of plain text";
  return null;
}
/** The most this request could cost, in paise at the meter's prices: every character an input token written to cache at
 *  full price, and the whole reply allowance used. Always above the real cost. */
export const worstCase = (b: any) => pilotPaise((PILOT_MODELS as readonly string[]).includes(b?.model) ? b.model : "claude-sonnet-5-5", { cache_creation_input_tokens: Math.ceil(JSON.stringify([b.system, b.messages]).length / 2), output_tokens: b.max_tokens });

/** At most AT_ONCE calls at a time, and never a call the budget could not pay for in full: before a call starts, its
 *  worst-case cost is set aside together with that of every call still running, and it is refused if spent + set aside
 *  would pass the cap. Checked when the call is about to start, not when it joined the queue. */
export function gate(left: () => Promise<number>, atOnce = AT_ONCE) {
  let active = 0, held = 0; const waiting: (() => void)[] = [];
  return {
    state: () => ({ active, held, waiting: waiting.length }),
    async enter(cost: number): Promise<boolean> {
      if (active >= atOnce) await new Promise<void>((r) => waiting.push(r)); else active++;      // a woken call inherits the slot of the one that left
      if ((await left()) - held < cost) { this.leave(0); return false; }
      held += cost; return true;
    },
    leave(cost: number) { held = Math.max(0, held - cost); const next = waiting.shift(); if (next) next(); else active = Math.max(0, active - 1); },
  };
}

/** The pilot's own spend, kept across restarts: every finished call adds its cost at current list prices. */
let pilotSpent: number | null = null;
const PILOT_KEY = "qa:pilot:jobread:total";
export async function pilotLeft(): Promise<number> { if (pilotSpent === null) pilotSpent = (await store.get<{ paise: number }>(PILOT_KEY))?.paise ?? 0; return Math.max(0, PILOT_CAP_PAISE - pilotSpent); }
export async function pilotAdd(model: string, usage: any): Promise<void> { await pilotLeft(); pilotSpent = (pilotSpent ?? 0) + (usage ? pilotPaise(model, usage) : 0); await store.set(PILOT_KEY, { paise: pilotSpent, cap: PILOT_CAP_PAISE, at: new Date().toISOString() }); }
type Deps = { create: (b: any) => Promise<any>; left: () => Promise<number>; before: () => Promise<void>; after: (model: string, system: string, usage: any | null, ms: number) => Promise<void> };
export function benchRoutes(d?: Partial<Deps>) {
  const r = new Hono(); let client: Anthropic | null = null;
  const deps: Deps = { create: (b) => (client ??= new Anthropic({ apiKey: env.anthropicKey })).messages.create(b), left: pilotLeft, before: async () => {}, after: async (m, sys, u, ms) => { await store.log("ai", { real: true, model: m, prompt: promptVersion(sys), tag: "pilot:jobread", ok: !!u, ms, in: u?.input_tokens ?? 0, out: u?.output_tokens ?? 0, cache_read: u?.cache_read_input_tokens ?? 0, cache_write: u?.cache_creation_input_tokens ?? 0, paise: u ? pilotPaise(m, u) : 0 }); await pilotAdd(m, u); }, ...d };
  const g = gate(deps.left);
  r.post("/messages", async (c) => {
    if (!allowed(c.req.header("x-bench-token"))) return c.json({ error: "not available" }, 404);
    const raw = await c.req.text(); if (raw.length > MAX_BODY) return c.json({ error: "request too large" }, 413);
    let b: any; try { b = JSON.parse(raw); } catch { return c.json({ error: "not JSON" }, 400); }
    const why = refuse(b); if (why) return c.json({ error: "request not allowed: " + why }, 400);
    const system = b.system.map((s: any) => s.text).join("\n"), cost = worstCase(b), t0 = Date.now();
    if (!(await g.enter(cost))) return c.json({ type: "error", error: { type: "qa_budget", message: "The pilot cap could not cover this call. Nothing was sent." } }, 503);
    let counted = false;
    try {
      await deps.before();
      const msg = await deps.create({ model: b.model, max_tokens: b.max_tokens, system: b.system, messages: b.messages });
      await deps.after(b.model, system, msg?.usage ?? {}, Date.now() - t0); counted = true;
      return c.json(msg);
    } catch (e: any) {
      if (!counted && e?.code !== "qa_budget") await deps.after(b.model, system, null, Date.now() - t0).catch(() => {});
      return c.json({ type: "error", error: { type: e?.code ?? e?.error?.error?.type ?? "upstream_error", message: String(e?.message ?? e).slice(0, 300) } }, Number(e?.status) >= 400 ? e.status : 502);
    } finally { g.leave(cost); }
  });
  return r;
}
