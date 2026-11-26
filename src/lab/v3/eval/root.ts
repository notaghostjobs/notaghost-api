// Isolated, versioned data root for one V3 evaluation population (synthetic, pilot or main). Every stage reads and
// writes only inside its root; nothing falls back to production, to the development workspace or to another root.
// A missing root, a wrong schema, a population mismatch or a missing required file is a hard, named failure.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";

export const ROOT_SCHEMA = "ghosted-eval/1";
export type Population = "synthetic" | "pilot" | "main";
export const DIRS = {
  intake: "intake",            // intake/<candidate>/{resume.*, intake.json}; intake/preflight.json
  intent: "intent",            // answers.json derived from accepted intakes only (never filled in)
  inventory: "inventory",      // snapshot.jsonl + snapshot.meta.json (hash, rows, capture time)
  jobs: "jobs",                // jir-det.jsonl, views-det.jsonl, emb/, eligible.json (the inventory both arms see)
  candidates: "candidates",    // text/, layout/, cer/, cand/ (retrieval records), profiles.json
  pools: "pools",              // retrieval.json: the complete ranked pools and channel ranks
  cjr: "cjr",                  // requirement-extraction cache, this root only
  judge: "judge",              // requests/ and responses/ exactly as sent and received
  v3: "v3",                    // per-candidate trace + display
  control: "control",          // Arm A output (offline control matcher)
  review: "review",            // blinded packages, hidden key, manifests, candidate feedback forms
  exports: "exports",          // reviewer and candidate exports as received
  adjudicated: "adjudicated",  // adjudication file and lock
  ledger: "ledger",            // ledger.jsonl (every paid call, including failed and truncated)
  logs: "logs",                // execution log per run
  manifest: "manifest",        // FROZEN-config.json (copied at open), FINAL.json (pilot execution)
} as const;
export class RootError extends Error {}

export class EvalRoot {
  readonly dir: string; readonly meta: { schema: string; population: Population; id: string; created_at: string };
  private constructor(dir: string, meta: any) { this.dir = dir; this.meta = meta; }
  static create(dir: string, population: Population, id: string): EvalRoot {
    dir = resolve(dir); if (existsSync(join(dir, "ROOT.json"))) throw new RootError(`a root already exists at ${dir}`);
    if (!["synthetic", "pilot", "main"].includes(population)) throw new RootError(`unknown population ${population}`);
    mkdirSync(dir, { recursive: true }); for (const d of Object.values(DIRS)) mkdirSync(join(dir, d), { recursive: true });
    const meta = { schema: ROOT_SCHEMA, population, id, created_at: new Date().toISOString() }; writeFileSync(join(dir, "ROOT.json"), JSON.stringify(meta, null, 1));
    return new EvalRoot(dir, meta);
  }
  /** Open an existing root. `expect` must match its population: a pilot run can never read a main root by accident. */
  static open(dir: string | undefined, expect: Population): EvalRoot {
    if (!dir) throw new RootError("no data root given (set V3_EVAL_ROOT or pass --root)");
    dir = resolve(dir); const f = join(dir, "ROOT.json"); if (!existsSync(f)) throw new RootError(`not an evaluation root (no ROOT.json): ${dir}`);
    const meta = JSON.parse(readFileSync(f, "utf8"));
    if (meta.schema !== ROOT_SCHEMA) throw new RootError(`root schema ${meta.schema} is not ${ROOT_SCHEMA}`);
    if (meta.population !== expect) throw new RootError(`root population is ${meta.population}, expected ${expect}`);
    for (const d of Object.values(DIRS)) if (!existsSync(join(dir, d))) throw new RootError(`root is missing ${d}/`);
    return new EvalRoot(dir, meta);
  }
  /** A path inside the root; anything that would escape it is refused. */
  p(...parts: string[]): string { const q = resolve(this.dir, ...parts); const r = relative(this.dir, q); if (r.startsWith("..") || isAbsolute(r)) throw new RootError(`path escapes the root: ${parts.join("/")}`); return q; }
  need(...parts: string[]): string { const q = this.p(...parts); if (!existsSync(q)) throw new RootError(`required file missing: ${relative(this.dir, q)}`); return q; }
  read(...parts: string[]): any { return JSON.parse(readFileSync(this.need(...parts), "utf8")); }
  readLines(...parts: string[]): any[] { return readFileSync(this.need(...parts), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  write(rel: string, data: unknown) { const q = this.p(rel); mkdirSync(resolve(q, ".."), { recursive: true }); writeFileSync(q, typeof data === "string" ? data : JSON.stringify(data, null, 1)); return q; }
  log(event: string, data: any = {}) { const q = this.p(DIRS.logs, "run.log.jsonl"); writeFileSync(q, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + "\n", { flag: "a" }); }
  candidates(): string[] { return readdirSync(this.p(DIRS.intake)).filter((d) => statSync(this.p(DIRS.intake, d)).isDirectory()).sort(); }
}
export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
export const fileSha = (f: string) => sha256(readFileSync(f));
