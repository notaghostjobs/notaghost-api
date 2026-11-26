// One approved read-only probe (25 Nov 2026): does IBM's careers search return each job's full description, a snippet,
// or another metadata shell? QA only, behind the pilot token, closes with the pilot. It makes AT MOST ONE outbound
// request, ever: the first call claims the probe in the QA store, makes the same search request the Reader makes
// (same headers, user agent and robots check, five jobs instead of fifty), stores the measurements and returns them.
// Every later call returns the stored result and sends nothing. It writes nothing but that one QA store key.
// It is to be deleted with the pilot pass-through.
import { Hono } from "hono";
import { getJson } from "../reader/http.js";
import { htmlToText } from "../engine/extract.js";
import { shellKind, ibmDescription } from "../reader/shells.js";
import { allowed } from "./bench.js";
import { store } from "./state.js";

export const PROBE_KEY = "qa:probe:ibm-search-description";
const RESP = /\b(responsibilit\w*|your role|what you('|’)ll do|you will)\b/i;
const REQS = /\b(required (technical|professional|skills)|preferred (technical|professional)|qualifications|requirements|must have|experience (in|with))\b/i;

export function measure(r: { ok: boolean; status: number; data: any }) {
  const hits: any[] = r.data?.hits?.hits ?? [];
  return {
    status: r.status, ok: r.ok, total: r.data?.hits?.total?.value ?? r.data?.hits?.total ?? null, returned: hits.length,
    jobs: hits.map((h) => {
      const s = h._source ?? {}; const raw = typeof s.description === "string" ? s.description : null; const text = raw ? htmlToText(raw).trim() : "";
      return {
        job_id: String(s.url ?? "").match(/jobId=(\d+)/)?.[1] ?? String(h._id ?? ""), title: String(s.title ?? ""), source_fields: Object.keys(s).sort(),
        description_type: raw === null ? typeof s.description : "string", raw_length: raw?.length ?? 0, text_length: text.length,
        has_responsibilities: RESP.test(text), has_requirements: REQS.test(text), shell: text ? shellKind(text) : null,
        kept_by_fix: ibmDescription(raw, htmlToText) !== undefined, ends_with_ellipsis: /(\.\.\.|…)\s*$/.test(text),
        head: text.slice(0, 400), tail: text.slice(-200),
      };
    }),
  };
}

type Deps = { search: () => Promise<{ ok: boolean; status: number; data: any }>; get: (k: string) => Promise<any>; set: (k: string, v: unknown) => Promise<void> };
const search = () => getJson<any>("https://www-api.ibm.com/search/api/v2", { method: "POST", gapMs: 600, timeoutMs: 20000, retries: 0,
  headers: { accept: "application/json", origin: "https://www.ibm.com", referer: "https://www.ibm.com/careers/search" },
  body: { appId: "careers", scopes: ["careers2"], size: 5, from: 0, _source: ["url", "title", "description", "field_keyword_19", "field_keyword_18", "field_keyword_08", "dcdate"], query: { bool: { filter: [{ term: { field_keyword_19: "Bangalore, IN" } }] } }, sort: [{ dcdate: "desc" }] } });

export function ibmProbeRoutes(d?: Partial<Deps>) {
  const deps: Deps = { search, get: (k) => store.get(k), set: (k, v) => store.set(k, v), ...d };
  const r = new Hono(); let running: Promise<any> | null = null;
  r.get("/ibm-probe", async (c) => {
    if (!allowed(c.req.header("x-bench-token"))) return c.json({ error: "not available" }, 404);
    const done = await deps.get(PROBE_KEY); if (done) return c.json({ ...done, repeat: true });
    running ??= (async () => {
      await deps.set(PROBE_KEY, { claimed_at: new Date().toISOString(), result: null });   // claimed before the request: a crash cannot lead to a second one
      const res = await deps.search(); const out = { claimed_at: new Date().toISOString(), result: measure(res) };
      await deps.set(PROBE_KEY, out); return out;
    })();
    return c.json(await running);
  });
  return r;
}
