import Anthropic from "@anthropic-ai/sdk";
import { env } from "../lib/env.js";

const client = new Anthropic({ apiKey: env.anthropicKey });
export const MODEL = "claude-sonnet-5-5";
export const FAST = "claude-haiku-5-5";

/** One structured call: system + user -> JSON of shape T. Retries once on bad JSON. */
export async function json<T>(system: string, user: string, maxTokens = 4000, model = MODEL): Promise<T> {
  if (model === MODEL && process.env.MODEL_OVERRIDE) model = process.env.MODEL_OVERRIDE;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await client.messages.create({
      model,
      max_tokens: maxTokens,
      // the instructions repeat call after call: cache them (billed at a tenth after the first call, and faster to start)
      system: [{ type: "text", text: system + "\n\nRespond with a single JSON object and nothing else. No markdown fences.", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    });
    const text = r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    try {
      return JSON.parse(text.slice(a, b + 1)) as T;
    } catch {
      console.error("[claude] bad JSON, model=%s stop_reason=%s, len=%d, tail=%s", model, r.stop_reason, text.length, text.slice(-200));
      if (r.stop_reason === "max_tokens") { maxTokens = Math.min(maxTokens * 2, 32000); }
      if (attempt === 1) throw Object.assign(new Error("We couldn't finish writing this one. Your shot is back — try again."), { status: 502 });
      if (model !== MODEL) model = MODEL;  // second try on the stronger model
    }
  }
  throw new Error("unreachable");
}
