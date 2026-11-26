// Reproducibility manifest for the V3 evaluation: hashes of every file and setting that decides an outcome.
// Writes a PRE-FREEZE candidate (status "not frozen"). The freeze itself (fresh inventory snapshot, then this manifest
// with status "frozen") happens only after the founder approves the pilot. Hashes are of committed file contents.
//   SUPABASE_URL=https://offline.invalid SUPABASE_SERVICE_ROLE_KEY=offline npx tsx src/lab/v3/manifest.mts
import { readFileSync, writeFileSync, existsSync } from "node:fs"; import { createHash } from "node:crypto"; import { execSync } from "node:child_process";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const R = "/home/claude/wt-api", S = process.env.V3_DATA ?? "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad";
const files = ["src/lab/v3/scope.ts", "src/lab/v3/anchors.ts", "src/lab/v3/shortlist.ts", "src/lab/v3/gate.ts", "src/lab/v3/jobtext.ts", "src/lab/v3/api3.ts", "src/lab/v3/features.mts", "src/lab/v3/data.mts", "src/lab/v3/run-v3.mts",
  "src/lab/v2/pipeline.ts", "src/lab/v2/cjr.ts", "src/lab/v2/terms.ts", "src/lab/v2/cer.ts", "src/lab/provenance.ts", "src/lab/validity.ts", "src/lab/skills.ts", "lab/py/retrieve.py", "lab/py/embed.py", "src/lab/prep-cands.mts", "src/lab/run-req2.mts", "src/lab/req.ts", "src/lab/req2.ts",
  "lab/eval/v2/review-v2b.template.html", "lab/eval/v2/mk-review-v2b.mts", "lab/eval/v2/score-review-v2b.py"];
const { JUDGE_SYSTEM, JUDGE_VERSION } = await import("../v2/pipeline.js"); const { EXTRACT_SYSTEM, EXTRACTOR_VERSION } = await import("../v2/cjr.js");
const { SHORTLIST3_VERSION, DEFAULT_SHORT } = await import("./shortlist.js"); const { GATE3_VERSION, DEFAULT_OPTS } = await import("./gate.js"); const { ANCHORS } = await import("./anchors.js"); const A = await import("./api3.js");
const { SIZE, MAXTOK } = { SIZE: 40, MAXTOK: { extract: 4000, judge: 10000 } };
const m = {
  status: "pre-freeze candidate (NOT frozen; no fresh-profile output exists)", made_at: new Date().toISOString(), branch: execSync("git branch --show-current", { cwd: R }).toString().trim(), commit: execSync("git rev-parse --short HEAD", { cwd: R }).toString().trim(),
  model: { id: A.MODEL, prices_usd_per_mtok: A.PRICE, inr_per_usd: A.INR_PER_USD, fx_buffer: A.FX_BUFFER, thinking: "between_tools", effort: { extract: "low", judge: "medium" }, max_tokens: MAXTOK, retries: 0 },
  versions: { extractor: EXTRACTOR_VERSION, judge_prompt: JUDGE_VERSION, shortlist: SHORTLIST3_VERSION, gate: GATE3_VERSION, anchors: `${ANCHORS.length} anchors / ${new Set(ANCHORS.map((a) => a.family)).size} families` },
  settings: { shortlist_size: SIZE, shortlist: DEFAULT_SHORT, gate: DEFAULT_OPTS, strong_max: 5, reserve_chars_per_token: A.CHARS_PER_TOKEN_RESERVE },
  prompt_sha256: { extract_system: sha(EXTRACT_SYSTEM), judge_system_template: sha(JUDGE_SYSTEM("{{CANDIDATE}}")) },
  files: Object.fromEntries(files.map((f) => [f, existsSync(`${R}/${f}`) ? sha(readFileSync(`${R}/${f}`)) : "MISSING"])),
  retrieval: { embedding_model: "bge-small (local ONNX int8)", pool: 200, fallback_channels: "fulltext + title, first 50 each", note: "parameters as in the V2 experiment; unchanged" },
  inventory_snapshot: { status: "to be taken at freeze", previous: { file: "bench/prod/inventory.jsonl", sha256: existsSync(`${S}/bench/prod/inventory.jsonl`) ? sha(readFileSync(`${S}/bench/prod/inventory.jsonl`)) : null, last_seen_max: "2026-11-24" } },
  v2_frozen_archive: Object.fromEntries(["Radar-v2-review.SUPPLIED.html", "review-v2-key.ORIGINAL.json", "frozen.json", "ledger.FINAL.jsonl"].map((f) => [f, existsSync(`${S}/v2/frozen-archive/${f}`) ? sha(readFileSync(`${S}/v2/frozen-archive/${f}`)).slice(0, 16) : null])),
};
writeFileSync(`${S}/v3/MANIFEST-v3-prefreeze.json`, JSON.stringify(m, null, 1)); console.log(JSON.stringify({ ...m, files: Object.fromEntries(Object.entries(m.files).map(([k, v]) => [k, String(v).slice(0, 16)])) }, null, 1));
