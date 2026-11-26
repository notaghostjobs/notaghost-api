// Executable freeze. Two steps, kept apart on purpose:
//  1. CONFIG FREEZE (before any fresh candidate result exists): hashes of every file, prompt, vocabulary, rule,
//     threshold and evaluation script that can change an outcome → lab/eval/v3/FROZEN-config.json (committed).
//  2. FINALISE (at pilot execution, before the first paid call): the root's inventory snapshot hash, the accepted
//     candidate set with intake hashes, the sampling manifest and the pricing check → <root>/manifest/FINAL.json.
// Every evaluation stage calls verifyConfig(); a paid stage also calls verifyFinal(). Any mismatch refuses to run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, fileSha, type EvalRoot } from "./root.js";

export const REPO = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
export const FREEZE_FILE = process.env.V3_FREEZE_FILE ?? join(REPO, "lab/eval/v3/FROZEN-config.json");
export const FREEZE_SCHEMA = "ghosted-v3-freeze/1";
/** Every file whose content can change a matching or evaluation outcome. */
export const FROZEN_FILES: Record<string, string> = {
  // matching
  "src/lab/v3/scope.ts": "seniority rules", "src/lab/v3/anchors.ts": "anchor vocabulary", "src/lab/v3/shortlist.ts": "shortlist and clustering", "src/lab/v3/gate.ts": "gate thresholds",
  "src/lab/v3/featcore.ts": "features", "src/lab/v3/jobtext.ts": "posting text", "src/lab/v3/judge3.ts": "judge input (full text) and batching", "src/lab/v2/pipeline.ts": "eligibility, judge prompt j3, validator", "src/lab/v2/cjr.ts": "extraction prompt x3, validator",
  "src/lab/v2/terms.ts": "terms", "src/lab/v2/cer.ts": "candidate evidence record", "src/lab/provenance.ts": "provenance", "src/lab/validity.ts": "job validity rules", "src/lab/skills.ts": "skills",
  "src/lab/cir.ts": "candidate record", "src/lib/ontology.ts": "function ontology", "src/lib/career.ts": "career reading", "src/lab/jir.ts": "job records", "src/lab/build-jir.mts": "job record build", "src/lab/prep-cands.mts": "candidate prep",
  // retrieval
  "lab/py/retrieve.py": "hybrid retrieval", "lab/py/retrieve_eval.py": "retrieval wrapper", "lab/py/embed.py": "embeddings", "lab/py/resume_layout.py": "PDF layout", "lab/py/text_layout.py": "text layout",
  // control arm
  "src/lab/run-req2.mts": "control matcher (Arm A)", "src/lab/req.ts": "control evidence", "src/lab/req2.ts": "control scoring",
  // evaluation
  "src/lab/v3/eval/pipeline.ts": "evaluation pipeline", "src/lab/v3/eval/intake.ts": "intake rules", "src/lab/v3/eval/cache.ts": "cache identity", "src/lab/v3/eval/review.ts": "review package builder", "src/lab/v3/eval/root.ts": "data root",
  "src/lab/v3/api3.ts": "budget enforcement", "src/lab/v2/review-redact.ts": "review privacy boundary", "lab/eval/v3/review-v3.template.html": "review rubric and form", "src/lab/v3/eval/freeze.ts": "freeze rules", "src/lab/v3/eval/cli.mts": "evaluation commands", "lab/eval/v3/feedback.template.html": "candidate feedback form",
  "lab/eval/v2/score-review-v2b.py": "evaluation scoring",
};
export const SETTINGS = { model: "claude-sonnet-5-5", extractor: "x3", judge: "j3", shortlist: "s3.3", gate: "g3v3.2", shortlist_size: 40, strong_max: 5, retrieval: { pool: 200, fallback_channels: ["fallback_fulltext", "fallback_title"], fallback_depth: 50, embedding: "bge-small 256 (Xenova ONNX int8)" },
  freshness_hours: 72, extract_char_limit: 60000, judge_text_chars: 60000, judge_input: "j3-fulltext", judge_batch_max: 5, judge_input_token_budget: 150000, max_tokens: { extract: 4000, judge: 10000 }, effort: { extract: "low", judge: "medium" }, thinking: "between_tools", retries: 0, audit_per_candidate: 4, audit_double_share: 0.25 };
export const EMBED_MODEL_FILE = "Xenova_bge-small-en-v1.5/model_quantized.onnx";

export function computeConfig(modelsDir: string) {
  const files = Object.fromEntries(Object.keys(FROZEN_FILES).map((f) => [f, existsSync(join(REPO, f)) ? fileSha(join(REPO, f)) : "MISSING"]));
  const emb = join(modelsDir, EMBED_MODEL_FILE);
  return { schema: FREEZE_SCHEMA, settings: SETTINGS, files, embedding_model_sha256: existsSync(emb) ? fileSha(emb) : "MISSING" };
}
export const configSha = (c: any) => sha256(JSON.stringify({ settings: c.settings, files: c.files, embedding_model_sha256: c.embedding_model_sha256 }));
export function writeConfigFreeze(modelsDir: string, note: string) {
  const c = computeConfig(modelsDir); const missing = Object.entries(c.files).filter(([, v]) => v === "MISSING").map(([k]) => k);
  if (missing.length || c.embedding_model_sha256 === "MISSING") throw new Error(`cannot freeze: missing ${[...missing, c.embedding_model_sha256 === "MISSING" ? "embedding model" : ""].filter(Boolean).join(", ")}`);
  const out = { ...c, config_sha256: configSha(c), frozen_at: new Date().toISOString(), note }; writeFileSync(FREEZE_FILE, JSON.stringify(out, null, 1)); return out;
}
/** Refuse to run when any frozen file, setting or the embedding model differs from the committed freeze. */
export function verifyConfig(modelsDir: string): { config_sha256: string } {
  if (!existsSync(FREEZE_FILE)) throw new Error(`no configuration freeze at ${FREEZE_FILE}: nothing may run`);
  const f = JSON.parse(readFileSync(FREEZE_FILE, "utf8")); if (f.schema !== FREEZE_SCHEMA) throw new Error("freeze schema mismatch");
  const now = computeConfig(modelsDir); const bad = Object.keys({ ...f.files, ...now.files }).filter((k) => f.files[k] !== now.files[k]);
  if (bad.length) throw new Error(`frozen configuration mismatch: ${bad.join(", ")} changed since the freeze`);
  if (JSON.stringify(f.settings) !== JSON.stringify(now.settings)) throw new Error("frozen configuration mismatch: settings changed since the freeze");
  if (f.embedding_model_sha256 !== now.embedding_model_sha256) throw new Error("frozen configuration mismatch: embedding model changed");
  if (configSha(now) !== f.config_sha256) throw new Error("frozen configuration mismatch: config hash");
  return { config_sha256: f.config_sha256 };
}
/** FINAL manifest for one root: written once at execution, before any paid call. */
export function finalise(root: EvalRoot, modelsDir: string, o: { stage: string; pricing: any }) {
  const { config_sha256 } = verifyConfig(modelsDir);
  if (existsSync(root.p("manifest", "FINAL.json"))) throw new Error("FINAL.json already exists: a finalised run is never re-finalised");
  const meta = root.read("inventory", "snapshot.meta.json"); if (fileSha(root.need("inventory", "snapshot.jsonl")) !== meta.sha256) throw new Error("snapshot changed after it was recorded");
  const pre = root.read("intake", "preflight.json"); const accepted = pre.decisions.filter((d: any) => d.status === "accepted").map((d: any) => d.candidate);
  if (!accepted.length) throw new Error("no accepted candidates");
  const intakes = Object.fromEntries(accepted.map((c: string) => [c, fileSha(root.need("intake", c, "intake.json"))]));
  const sampling = root.read("intake", "sampling-manifest.json");
  const fin = { schema: "ghosted-v3-final/1", root: root.meta, stage: o.stage, config_sha256, snapshot: meta, candidates: accepted, intake_sha256: intakes, preflight_sha256: fileSha(root.need("intake", "preflight.json")), sampling_manifest_sha256: fileSha(root.need("intake", "sampling-manifest.json")), sampling_rule: sampling.rule, pricing: o.pricing, finalised_at: new Date().toISOString() };
  root.write("manifest/FINAL.json", fin); return fin;
}
export function verifyFinal(root: EvalRoot, modelsDir: string) {
  const { config_sha256 } = verifyConfig(modelsDir); const fin = root.read("manifest", "FINAL.json");
  if (fin.config_sha256 !== config_sha256) throw new Error("FINAL.json was made under another configuration");
  if (fileSha(root.need("inventory", "snapshot.jsonl")) !== fin.snapshot.sha256) throw new Error("inventory snapshot differs from FINAL.json");
  for (const [c, h] of Object.entries<string>(fin.intake_sha256)) if (fileSha(root.need("intake", c, "intake.json")) !== h) throw new Error(`intake for ${c} changed after finalising`);
  if (fileSha(root.need("intake", "preflight.json")) !== fin.preflight_sha256) throw new Error("preflight changed after finalising");
  return fin;
}
