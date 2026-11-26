// Matching v2: the only way this prototype calls a model. Sonnet only. Before every request the worst-case cost
// (input estimate + full max_tokens output + cache write) is checked against the current checkpoint ceiling; a
// request that could cross it is refused. Provider-reported usage is written to a ledger after every call.
// Prices: platform.claude.com pricing page, read 26 Nov 2026 (Sonnet 5.5: $2 in, $10 out, $2.50 5-min cache write,
// $0.10 cache hit, per million tokens). INR assumption: ₹84 per $1 (the production meter's rate); stated in reports.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export const MODEL = "claude-sonnet-5-5";
/** The key: GHOSTED_ANTHROPIC_KEY (cloud sessions may withhold a variable named ANTHROPIC_API_KEY), else ANTHROPIC_API_KEY. */
export const apiKey = () => process.env.GHOSTED_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || "";
export const PRICE = { in: 2, out: 10, cw: 2.5, cr: 0.1 }, INR = 84, TOTAL_CAP = 3000;
export const CHECKPOINTS = { 1: 300, 2: 1500, 3: 3000 } as const;
export type Usage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
export const rupees = (u: Usage) => ((u.input_tokens * PRICE.in + u.output_tokens * PRICE.out + (u.cache_creation_input_tokens ?? 0) * PRICE.cw + (u.cache_read_input_tokens ?? 0) * PRICE.cr) / 1e6) * INR;

export class Ledger {
  constructor(public file: string) {}
  entries(): any[] { return existsSync(this.file) ? readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; }
  spent(): number { return this.entries().reduce((a, e) => a + (e.inr ?? 0), 0); }
  add(e: any) { appendFileSync(this.file, JSON.stringify(e) + "\n"); }
}
/** Worst case for one request: every input character as a token/3.2, all of max_tokens, system written to cache. */
export function worstCase(systemChars: number, userChars: number, maxTokens: number): number {
  const inTok = Math.ceil((systemChars + userChars) / 3.2) + 50, sysTok = Math.ceil(systemChars / 3.2);
  return ((inTok * PRICE.in + maxTokens * PRICE.out + sysTok * PRICE.cw) / 1e6) * INR;
}
export class BudgetError extends Error {}

export async function callSonnet(o: { ledger: Ledger; ceiling: number; purpose: string; system: string; user: string; maxTokens: number; cacheSystem?: boolean; fetchImpl?: typeof fetch }): Promise<{ text: string; usage: Usage; inr: number; ms: number }> {
  if (!apiKey()) throw new BudgetError("no API key (GHOSTED_ANTHROPIC_KEY or ANTHROPIC_API_KEY): no paid call is possible");
  if (o.ceiling > TOTAL_CAP) throw new BudgetError("ceiling above the approved ₹3,000");
  const spent = o.ledger.spent(), worst = worstCase(o.system.length, o.user.length, o.maxTokens);
  if (spent + worst > o.ceiling) throw new BudgetError(`refused: spent ₹${spent.toFixed(2)} + worst case ₹${worst.toFixed(2)} > ceiling ₹${o.ceiling}`);
  const t0 = Date.now();
  const res = await (o.fetchImpl ?? fetch)("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": apiKey(), "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: o.maxTokens, system: [{ type: "text", text: o.system, ...(o.cacheSystem ? { cache_control: { type: "ephemeral" } } : {}) }], messages: [{ role: "user", content: o.user }] }),
  });
  const ms = Date.now() - t0; const body: any = await res.json().catch(() => ({}));
  if (!res.ok) { o.ledger.add({ at: new Date().toISOString(), purpose: o.purpose, ok: false, status: res.status, error: String(body?.error?.message ?? "").slice(0, 200), inr: 0, ms }); throw new Error(`API ${res.status}: ${body?.error?.type ?? "error"}`); }
  if (body.model && !String(body.model).startsWith(MODEL)) throw new BudgetError(`provider served ${body.model}, not ${MODEL}`);
  const usage: Usage = body.usage; const inr = rupees(usage);
  o.ledger.add({ at: new Date().toISOString(), purpose: o.purpose, ok: true, model: body.model, usage, inr, ms, stop: body.stop_reason });
  return { text: (body.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(""), usage, inr, ms };
}
/** First JSON object in a reply; null when there is none or it does not parse (callers fail closed). */
export function firstJson(text: string): unknown { const s = text.indexOf("{"), e = text.lastIndexOf("}"); if (s < 0 || e <= s) return null; try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; } }
