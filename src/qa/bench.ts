// A temporary pass-through for one benchmark (approved 24 Nov 2026): model requests made in the founder's workspace are
// forwarded to the model with QA's own key, so no key leaves this service. QA only. It keeps nothing: not the request,
// not the reply. It records what every QA model call records (model, tokens, cost) and is bound by the QA budget.
// It closes by itself at CLOSES, and is to be deleted when the benchmark is done.
import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../lib/env.js";
import { MODEL } from "../engine/claude.js";
import { paiseOf } from "../engine/meter.js";
import { QA } from "./guard.js";
import { qaBefore, qaAfter, qaSpend } from "./budget.js";

const TOKEN_SHA256 = "3ba10b5abc8b60a698e0679e2f33f52dc5d61d86481bc8931afd4ceadc487c67";                       // the token itself exists only in the workspace that runs the benchmark
const CLOSES = Date.parse("2026-11-26T00:00:00+05:30");
export const MAX_BODY = 200_000, MAX_OUT = 12_000, AT_ONCE = 3;
export const allowed = (given: string | undefined, now = Date.now()) => { const got = createHash("sha256").update(String(given ?? "")).digest(); return QA && now < CLOSES && String(given ?? "").length === 64 && timingSafeEqual(got, Buffer.from(TOKEN_SHA256, "hex")); };

/** The one request the benchmark makes, and nothing else: exactly the fields the engine's own model call sends
 *  (engine/claude.ts json()). Returns why it is refused, or null. Any other field, block type or role is refused. */
const only = (o: any, keys: string[]) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).every((k) => keys.includes(k));
export function refuse(b: any): string | null {
  if (!only(b, ["model", "max_tokens", "system", "messages"])) return "unexpected field";
  if (b.model !== MODEL) return "model not allowed";
  if (!Number.isInteger(b.max_tokens) || b.max_tokens < 1 || b.max_tokens > MAX_OUT) return "max_tokens not allowed";
  if (!Array.isArray(b.system) || b.system.length < 1 || b.system.length > 2) return "system must be one or two text blocks";
  for (const s of b.system) { if (!only(s, ["type", "text", "cache_control"]) || s.type !== "text" || typeof s.text !== "string" || !s.text) return "system block not allowed"; if (s.cache_control !== undefined && !(only(s.cache_control, ["type"]) && s.cache_control.type === "ephemeral")) return "cache_control not allowed"; }
  if (!Array.isArray(b.messages) || b.messages.length !== 1) return "exactly one message";
  const m = b.messages[0]; if (!only(m, ["role", "content"]) || m.role !== "user" || typeof m.content !== "string" || !m.content) return "the message must be one user message of plain text";
  return null;
}
/** The most this request could cost, in paise at the meter's prices: every character an input token written to cache at
 *  full price, and the whole reply allowance used. Always above the real cost. */
export const worstCase = (b: any) => paiseOf(MODEL, { cache_creation_input_tokens: Math.ceil(JSON.stringify([b.system, b.messages]).length / 2), output_tokens: b.max_tokens });

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

type Deps = { create: (b: any) => Promise<any>; left: () => Promise<number>; before: () => Promise<void>; after: (model: string, system: string, usage: any | null, ms: number) => Promise<void> };
export function benchRoutes(d?: Partial<Deps>) {
  const r = new Hono(); let client: Anthropic | null = null;
  const deps: Deps = { create: (b) => (client ??= new Anthropic({ apiKey: env.anthropicKey })).messages.create(b), left: async () => (await qaSpend()).left_paise, before: qaBefore, after: qaAfter, ...d };
  const g = gate(deps.left);
  r.post("/messages", async (c) => {
    if (!allowed(c.req.header("x-bench-token"))) return c.json({ error: "not available" }, 404);
    const raw = await c.req.text(); if (raw.length > MAX_BODY) return c.json({ error: "request too large" }, 413);
    let b: any; try { b = JSON.parse(raw); } catch { return c.json({ error: "not JSON" }, 400); }
    const why = refuse(b); if (why) return c.json({ error: "request not allowed: " + why }, 400);
    const system = b.system.map((s: any) => s.text).join("\n"), cost = worstCase(b), t0 = Date.now();
    if (!(await g.enter(cost))) return c.json({ type: "error", error: { type: "qa_budget", message: "QA AI budget could not cover this call. Nothing was sent." } }, 503);
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
