// Real AI, bounded. Every model call in QA is counted here before and after it runs: a call is refused once the QA budget
// is spent, calls are limited to a few at a time, and each one is recorded with its model, the fingerprint of the
// instructions it ran under (the "prompt version"), its tokens and its cost. In production these are no-ops.
import { createHash } from "node:crypto";
import { QA } from "./guard.js";
import { store, qaCtx, takeFault } from "./state.js";
import { paiseOf, meterCtx } from "../engine/meter.js";

const CAP_PAISE = () => Math.round(Number(process.env.QA_AI_BUDGET_INR ?? "1000") * 100);
const MAX_AT_ONCE = () => Math.max(1, Math.min(6, Number(process.env.QA_AI_CONCURRENCY ?? "3")));
let spent: number | null = null, calls = 0, active = 0; const waiting: (() => void)[] = [];
export const promptVersion = (system: string) => createHash("sha256").update(system).digest("hex").slice(0, 12);
async function load() { if (spent === null) { const t = await store.get<{ paise: number; calls: number }>("qa:ai:total"); spent = t?.paise ?? 0; calls = t?.calls ?? 0; } return spent!; }
export async function qaSpend() { return { paise: await load(), calls, cap_paise: CAP_PAISE(), left_paise: Math.max(0, CAP_PAISE() - (spent ?? 0)), concurrency: MAX_AT_ONCE(), active }; }
export const budgetError = () => Object.assign(new Error("QA AI budget reached. No further paid calls are made until the budget is raised."), { status: 503, code: "qa_budget" });

/** before a model call: the budget, the queue, and any fault a tester has switched on */
export async function qaBefore(): Promise<void> {
  if (!QA) return;
  if ((await load()) >= CAP_PAISE()) throw budgetError();
  if (takeFault("ai_timeout")) { await new Promise((r) => setTimeout(r, 1500)); throw Object.assign(new Error("QA simulated provider timeout"), { status: 504, simulated: true }); }
  if (takeFault("ai_rate_limit")) throw Object.assign(new Error("rate_limit_error: QA simulated rate limit"), { status: 429, simulated: true });
  if (active >= MAX_AT_ONCE()) await new Promise<void>((r) => waiting.push(r));
  active++;
}
/** after it: release the slot, add the cost, write the record. `usage` is null when the call failed. */
export async function qaAfter(model: string, system: string, usage: any | null, ms: number): Promise<void> {
  if (!QA) return;
  active = Math.max(0, active - 1); waiting.shift()?.();
  // token cost, plus the provider's fee for each web search the call made (USD 10 per 1,000, counted at ₹90 to the dollar)
  const paise = usage ? paiseOf(model, usage) + Math.round((usage.server_tool_use?.web_search_requests ?? 0) * 0.01 * 90 * 100) : 0;
  spent = (spent ?? 0) + paise; calls++;
  const m = meterCtx();
  await store.log("ai", { real: true, model, prompt: promptVersion(system), tag: m?.tag ?? "untagged", user: m?.user ?? qaCtx.getStore()?.user ?? null, ok: !!usage, ms, in: usage?.input_tokens ?? 0, out: usage?.output_tokens ?? 0, cache_read: usage?.cache_read_input_tokens ?? 0, cache_write: usage?.cache_creation_input_tokens ?? 0, paise });
  await store.set("qa:ai:total", { paise: spent, calls });
}
/** a tester's "malformed response" fault: the model's text is replaced with something that is not JSON */
export const qaMalformed = () => QA && takeFault("ai_malformed");
