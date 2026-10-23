import Anthropic from "@anthropic-ai/sdk";
import { env } from "../lib/env.js";

const client = new Anthropic({ apiKey: env.anthropicKey });
export const MODEL = "claude-sonnet-5-5";

/** One structured call: system + user -> JSON of shape T. Retries once on bad JSON. */
export async function json<T>(system: string, user: string, maxTokens = 4000): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system: system + "\n\nRespond with a single JSON object and nothing else. No markdown fences.",
      messages: [{ role: "user", content: user }],
    });
    const text = r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    try {
      return JSON.parse(text.slice(a, b + 1)) as T;
    } catch {
      console.error("[claude] bad JSON, stop_reason=%s, len=%d, tail=%s", r.stop_reason, text.length, text.slice(-200));
      if (attempt === 1) throw new Error("Model returned non-JSON twice");
    }
  }
  throw new Error("unreachable");
}
