// Holdout: both models on exactly the postings Sonnet read (same 100), plus Haiku on all 250.
import { readFileSync, writeFileSync } from "node:fs";
const S = "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad";
const son = new Set(readFileSync(`${S}/pilot/ai-claude-sonnet-5-5-9275f7c166a5.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.partition === "holdout").map((x) => x.id));
for (const m of ["claude-haiku-5-5", "claude-sonnet-5-5"]) { const L = readFileSync(`${S}/pilot/ai-${m}-9275f7c166a5.jsonl`, "utf8").split("\n").filter(Boolean).filter((l) => son.has(JSON.parse(l).id)); writeFileSync(`${S}/pilot/sub100-${m}.jsonl`, L.join("\n") + "\n"); console.log(m, L.length); }
