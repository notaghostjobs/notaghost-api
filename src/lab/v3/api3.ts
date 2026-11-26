// Matching v3 paid-call guard (prepared, not used yet: no paid call is authorised). Differs from v2/api.ts in three
// places, all found while costing the evaluation:
//  1. Reservation reads every 2.5 characters as a token. V2 assumed 3.2, but its own ledger shows 2.86–2.97
//     characters per token on these prompts, so V2's "worst case" could undercount input by about 10–12%.
//  2. The ceiling is the authorised stage ceiling (pilot or main), not a constant; a stage cannot raise it.
//  3. No automatic retries: a failed, truncated or invalid reply fails closed (the job is "cannot judge") and is counted.
// Everything else (Sonnet only, served-model check, ledger after every call, reservation before sending) is unchanged.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
export const MODEL = "claude-sonnet-5-5";
export const PRICE = { in: 2, out: 10, cw: 2.5, cr: 0.1 };   // USD per million tokens; re-check on the pricing page on the day of the run
export const INR_PER_USD = 84, FX_BUFFER = 1.03;             // ₹84 = the production meter's rate; reservations add 3% for rate movement
export const CHARS_PER_TOKEN_RESERVE = 2.5;
export type Usage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
export const rupees = (u: Usage) => ((u.input_tokens * PRICE.in + u.output_tokens * PRICE.out + (u.cache_creation_input_tokens ?? 0) * PRICE.cw + (u.cache_read_input_tokens ?? 0) * PRICE.cr) / 1e6) * INR_PER_USD;
/** Worst case for one request: every input character at 2.5 per token, all of max_tokens, the system prompt written to cache, +3% FX. */
export function worstCase3(systemChars: number, userChars: number, maxTokens: number): number {
  const inTok = Math.ceil((systemChars + userChars) / CHARS_PER_TOKEN_RESERVE) + 50, sysTok = Math.ceil(systemChars / CHARS_PER_TOKEN_RESERVE);
  return ((inTok * PRICE.in + maxTokens * PRICE.out + sysTok * PRICE.cw) / 1e6) * INR_PER_USD * FX_BUFFER;
}
export class Ledger3 {
  constructor(public file: string, public stage: string) {}
  entries(): any[] { return existsSync(this.file) ? readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; }
  spent(): number { return this.entries().reduce((a, e) => a + (e.inr ?? 0), 0); }
  add(e: any) { appendFileSync(this.file, JSON.stringify({ stage: this.stage, ...e }) + "\n"); }
}
export class BudgetError extends Error {}
export class Guard {
  reserved = 0;
  constructor(public ledger: Ledger3, public ceiling: number) { if (!(ceiling > 0)) throw new BudgetError("no authorised ceiling"); }
  /** Reserve before sending; refuse when spent + everything in flight + this request's worst case could pass the ceiling. */
  reserve(worst: number) { const spent = this.ledger.spent(); if (spent + this.reserved + worst > this.ceiling) throw new BudgetError(`refused: spent ₹${spent.toFixed(2)} + in flight ₹${this.reserved.toFixed(2)} + worst ₹${worst.toFixed(2)} > ceiling ₹${this.ceiling}`); this.reserved += worst; return () => { this.reserved -= worst; }; }
}
export async function call3(g: Guard, o: { purpose: string; system: string; user: string; maxTokens: number; cacheSystem?: boolean; effort?: "low" | "medium"; key: string; fetchImpl?: typeof fetch }) {
  if (!o.key) throw new BudgetError("no API key: no paid call is possible");
  const release = g.reserve(worstCase3(o.system.length, o.user.length, o.maxTokens)); const t0 = Date.now();
  try {
    const res = await (o.fetchImpl ?? fetch)("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": o.key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: o.maxTokens, thinking: { type: "between_tools" }, output_config: { effort: o.effort ?? "low" }, system: [{ type: "text", text: o.system, ...(o.cacheSystem ? { cache_control: { type: "ephemeral" } } : {}) }], messages: [{ role: "user", content: o.user }] }) });
    const ms = Date.now() - t0; const body: any = await res.json().catch(() => ({}));
    if (!res.ok) { g.ledger.add({ at: new Date().toISOString(), purpose: o.purpose, ok: false, status: res.status, inr: 0, ms }); return { ok: false as const, reason: `API ${res.status}`, ms }; }
    const inr = rupees(body.usage); g.ledger.add({ at: new Date().toISOString(), purpose: o.purpose, ok: true, model: body.model, usage: body.usage, inr, ms, stop: body.stop_reason });   // paid either way: record first
    if (body.model && !String(body.model).startsWith(MODEL)) throw new BudgetError(`provider served ${body.model}, not ${MODEL}`);
    const text = (body.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    if (body.stop_reason === "max_tokens") return { ok: false as const, reason: "truncated", ms, inr };
    return { ok: true as const, text, usage: body.usage as Usage, inr, ms };
  } finally { release(); }
}
