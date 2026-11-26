// Requirement-extraction cache for one evaluation root, with exact identity checks. An entry is reused only when the
// job id, the sha256 of the complete description text, the schema, the extractor version and the model all match.
// Every lookup is classified so that realised savings are counted, never assumed.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CJR_SCHEMA, EXTRACTOR_VERSION } from "../../v2/cjr.js";
import { descSha } from "../jobtext.js";

export type Lookup = "hit" | "hit_unusable" | "reused" | "reused_unusable" | "stale" | "missing";
export class ExtractionCache {
  readonly stats = { hit: 0, hit_unusable: 0, stale: 0, missing: 0, reused_in_run: 0, written: 0 };
  private memo = new Map<string, any>();
  constructor(readonly dir: string, readonly model: string) {}
  private file(id: string, sha: string) { return join(this.dir, `${id}.${sha}.${CJR_SCHEMA.replace("/", "")}.${EXTRACTOR_VERSION}.json`); }
  /** Classify and return a cached record; `stale` = an entry for this job exists but for other text, schema, version or model. */
  lookup(id: string, fullText: string): { status: Lookup; cjr: any | null } {
    const sha = descSha(fullText); const k = `${id}|${sha}`;
    if (this.memo.has(k)) { this.stats.reused_in_run++; const c = this.memo.get(k); return { status: c?.usable ? "reused" : "reused_unusable", cjr: c }; }   // extracted earlier in this run: shared, not a saving from an earlier run
    const f = this.file(id, sha);
    if (existsSync(f)) { const c = JSON.parse(readFileSync(f, "utf8"));
      const exact = c.job_id === id && c.desc_sha256 === sha && c.schema === CJR_SCHEMA && c.extractor === EXTRACTOR_VERSION && c.model === this.model;
      if (exact) { this.memo.set(k, c); if (c.usable) { this.stats.hit++; return { status: "hit", cjr: c }; } this.stats.hit_unusable++; return { status: "hit_unusable", cjr: c }; } }
    const any = existsSync(this.dir) && readdirSync(this.dir).some((x) => x.startsWith(`${id}.`));
    if (any) { this.stats.stale++; return { status: "stale", cjr: null }; }
    this.stats.missing++; return { status: "missing", cjr: null };
  }
  put(c: any, fullText: string) { if (c.desc_sha256 !== descSha(fullText)) throw new Error(`cache write for ${c.job_id}: record hash does not match the full text`); writeFileSync(this.file(c.job_id, c.desc_sha256), JSON.stringify(c)); this.memo.set(`${c.job_id}|${c.desc_sha256}`, c); this.stats.written++; }
}
