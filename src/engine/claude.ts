import Anthropic from "@anthropic-ai/sdk";
import { env } from "../lib/env.js";
import { record } from "./meter.js";

const client = new Anthropic({ apiKey: env.anthropicKey });
export const MODEL = "claude-sonnet-5-5";
/** Every step that reads or writes a person's résumé runs on the main model — the fast one is kept only for the reader's own
 *  housekeeping (sector tagging of employers), never for anything a candidate will be judged on. Decided 6 Nov: accuracy over time. */
export const FAST = MODEL;
export const HOUSEKEEPING = "claude-haiku-5-5";

/** One structured call: system + user -> JSON of shape T. Retries once on bad JSON. */
export async function json<T>(system: string, user: string, maxTokens = 4000, model = MODEL, pdf?: Buffer, pin?: string): Promise<T> {
  if (model === MODEL && process.env.MODEL_OVERRIDE) model = process.env.MODEL_OVERRIDE;
  for (let attempt = 0; attempt < 2; attempt++) {
    // a PDF goes in as the page itself (the model sees layout — columns, sidebars — the way a person does), ahead of the text
    const content: Anthropic.MessageParam["content"] = pdf
      ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } }, { type: "text", text: user }]
      : user;
    const r = await client.messages.create({
      model,
      max_tokens: maxTokens,
      // the instructions repeat call after call: cache them (billed at a tenth after the first call, and faster to start)
      // a pinned block (the résumé profile, say) sits after the instructions as its own cached prefix: the same résumé
      // across a Radar run's hundred calls is then read from cache at a tenth of the price
      system: [
        { type: "text", text: system + "\n\nRespond with a single JSON object and nothing else. No markdown fences.", cache_control: { type: "ephemeral" } },
        ...(pin ? [{ type: "text" as const, text: pin, cache_control: { type: "ephemeral" as const } }] : []),
      ],
      messages: [{ role: "user", content }],
    });
    if (r.usage) record(model, r.usage as any);
    const text = r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    try {
      return JSON.parse(text.slice(a, b + 1)) as T;
    } catch {
      console.error("[claude] bad JSON, model=%s stop_reason=%s, len=%d, tail=%s", model, r.stop_reason, text.length, text.slice(-200));
      if (r.stop_reason === "max_tokens") { maxTokens = Math.min(maxTokens * 2, 32000); }
      if (attempt === 1) throw Object.assign(new Error("We couldn't finish writing this one. Nothing was used — try again."), { status: 502 });
      if (model !== MODEL) model = MODEL;  // second try on the stronger model
    }
  }
  throw new Error("unreachable");
}
