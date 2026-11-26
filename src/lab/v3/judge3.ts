// V3 judge input (approved 26 Nov 2026, Option A): identical to the frozen j3 judgeUser format in src/lab/v2/pipeline.ts
// except that the posting text is passed COMPLETE (up to the extraction limit) instead of its first 6,000 characters,
// so a requirement stated late in a posting, or a conflict between its opening and closing sections, is visible to the
// judge even when extraction misses it. The frozen V2 function is untouched. Batching keeps every request well inside
// the model's limits by reducing the batch size, never by cutting job text.
//   Sonnet 5.5 (platform.claude.com/docs/en/models/sonnet-5-5/overview, read 26 Nov 2026): context 1M tokens, max output 128K.
import type { CJR } from "../v2/cjr.js";
import { EXTRACT_CHAR_LIMIT } from "./jobtext.js";

export const JUDGE3_INPUT = "j3-fulltext";
export const MODEL_CONTEXT_TOKENS = 1_000_000, MODEL_MAX_OUTPUT_TOKENS = 128_000;
/** Our own per-request ceiling, far below the model's: input estimated at 2.5 characters per token (the guard's
 *  conservative rate), plus the batch's output allowance. */
export const JUDGE_INPUT_TOKEN_BUDGET = 150_000, JUDGE_OUTPUT_TOKENS_PER_JOB = 2_000, JUDGE_BATCH_MAX = 5, CHARS_PER_TOKEN_EST = 2.5;
export type JudgeJob = { id: string; title: string; company: string; text: string; cjr: CJR };
const block = (j: JudgeJob) => `JOB ${j.id}: ${j.title} — ${j.company}\nREQUIREMENTS (extracted, each with its source text):\n${JSON.stringify({ function: j.cjr.function, specialisation: j.cjr.specialisation, mandatory: j.cjr.mandatory, secondary: j.cjr.secondary, years: j.cjr.years, seniority: j.cjr.seniority, manages_people: j.cjr.manages_people, credentials: j.cjr.credentials })}\nJOB TEXT:\n${j.text}`;
/** The judge's user message: every job's complete text. A text longer than the extraction limit is refused here
 *  (it should never have been extracted): nothing is cut silently. */
export function judgeUserFull(jobs: JudgeJob[]): string {
  for (const j of jobs) if (j.text.length > EXTRACT_CHAR_LIMIT) throw new Error(`job ${j.id}: ${j.text.length} characters exceeds the ${EXTRACT_CHAR_LIMIT}-character limit; it must be flagged oversized, not cut`);
  return jobs.map(block).join("\n\n=====\n\n");
}
export const estTokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN_EST);
/** Batches of at most five jobs whose system prompt + user message stay within the input budget and whose output
 *  allowance stays within the model's limit. A job that alone exceeds the budget is returned in `tooLarge` (to be
 *  marked "cannot judge: judge request too large"), never truncated. */
export function batchJobs(jobs: JudgeJob[], systemChars: number, o: { max?: number; inputBudget?: number } = {}): { batches: JudgeJob[][]; tooLarge: JudgeJob[]; maxTokens: (b: JudgeJob[]) => number } {
  const max = o.max ?? JUDGE_BATCH_MAX, budget = o.inputBudget ?? JUDGE_INPUT_TOKEN_BUDGET; const batches: JudgeJob[][] = [], tooLarge: JudgeJob[] = []; let cur: JudgeJob[] = [];
  const size = (b: JudgeJob[]) => estTokens(systemChars + judgeUserFull(b).length);
  for (const j of jobs) {
    if (size([j]) > budget) { tooLarge.push(j); continue; }
    if (cur.length && (cur.length >= max || size([...cur, j]) > budget)) { batches.push(cur); cur = []; }
    cur.push(j);
  }
  if (cur.length) batches.push(cur);
  const maxTokens = (b: JudgeJob[]) => Math.min(MODEL_MAX_OUTPUT_TOKENS, Math.max(10_000, JUDGE_OUTPUT_TOKENS_PER_JOB * b.length));
  return { batches, tooLarge, maxTokens };
}
