// A temporary pass-through for one benchmark (approved 24 Nov 2026): model requests made in the founder's workspace are
// forwarded to the model with QA's own key, so no key leaves this service. QA only. It keeps nothing: not the request,
// not the reply. It records what every QA model call records (model, tokens, cost) and is bound by the QA budget.
// It closes by itself at CLOSES, and is to be deleted when the benchmark is done.
import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../lib/env.js";
import { MODEL } from "../engine/claude.js";
import { QA } from "./guard.js";
import { qaBefore, qaAfter } from "./budget.js";

const TOKEN_SHA256 = "3ba10b5abc8b60a698e0679e2f33f52dc5d61d86481bc8931afd4ceadc487c67";                       // the token itself exists only in the workspace that runs the benchmark
const CLOSES = Date.parse("2026-11-26T00:00:00+05:30");
const MAX_BODY = 200_000, MAX_OUT = 6000;
const allowed = (given: string | undefined) => { const got = createHash("sha256").update(String(given ?? "")).digest(); return QA && Date.now() < CLOSES && String(given ?? "").length === 64 && timingSafeEqual(got, Buffer.from(TOKEN_SHA256, "hex")); };

export function benchRoutes() {
  const r = new Hono(); const client = new Anthropic({ apiKey: env.anthropicKey });
  r.post("/messages", async (c) => {
    if (!allowed(c.req.header("x-bench-token"))) return c.json({ error: "not available" }, 404);
    const raw = await c.req.text(); if (raw.length > MAX_BODY) return c.json({ error: "request too large" }, 413);
    let b: any; try { b = JSON.parse(raw); } catch { return c.json({ error: "not JSON" }, 400); }
    // only what the benchmark needs: the main model, plain messages, a bounded reply. No tools, no files, no streaming.
    if (b?.model !== MODEL || !Array.isArray(b?.messages) || b.tools || b.stream || !(Number(b.max_tokens) > 0 && Number(b.max_tokens) <= MAX_OUT)) return c.json({ error: "request not allowed" }, 400);
    const system = typeof b.system === "string" ? b.system : JSON.stringify(b.system ?? ""); const t0 = Date.now();
    try { await qaBefore(); } catch (e: any) { return c.json({ type: "error", error: { type: e?.code ?? "qa_refused", message: String(e?.message ?? e) } }, e?.status ?? 503); }
    try {
      const msg = await client.messages.create({ model: b.model, max_tokens: b.max_tokens, system: b.system, messages: b.messages, ...(b.temperature !== undefined ? { temperature: b.temperature } : {}) });
      await qaAfter(b.model, system, (msg as any).usage, Date.now() - t0);
      return c.json(msg as any);
    } catch (e: any) {
      await qaAfter(b.model, system, null, Date.now() - t0);
      return c.json({ type: "error", error: { type: e?.error?.error?.type ?? "upstream_error", message: String(e?.message ?? e).slice(0, 300) } }, Number(e?.status) >= 400 ? e.status : 502);
    }
  });
  return r;
}
