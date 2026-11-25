// One approved QA test (25 Nov 2026): does Greenhouse's public Job Board API return the real posting for the HackerRank
// jobs whose hosted pages are bare application forms? Three affected jobs and one healthy control, fixed below. QA only,
// behind the pilot token, closes with the pilot. At most FOUR job requests ever (plus the Reader's usual robots.txt
// check of the API host), 800 ms apart; the first call claims the test, later calls return the stored result. It writes
// nothing but one QA store key. It is to be deleted with the pilot pass-through.
import { Hono } from "hono";
import { getJson } from "../reader/http.js";
import { htmlToText } from "../engine/extract.js";
import { shellKind, unescapeHtml } from "../reader/shells.js";
import { allowed } from "./bench.js";
import { store } from "./state.js";

export const GH_KEY = "qa:probe:greenhouse-fallback";
/** Chosen by a read-only query of the live table, 25 Nov: the three newest live HackerRank form-only rows, and a healthy
 *  Greenhouse job from another employer whose stored text has duties and requirements. */
export const GH_JOBS = [
  { role: "affected", sighting: 2183897, board: "hackerrank", id: "8245384", stored_title: "Senior Engineering Manager - Evaluation" },
  { role: "affected", sighting: 1167298, board: "hackerrank", id: "8358510", stored_title: "Senior Deep Learning Research Engineer" },
  { role: "affected", sighting: 664778, board: "hackerrank", id: "8146911", stored_title: "Product Analyst II" },
  { role: "control", sighting: 2205075, board: "project44", id: "8255555", stored_title: "Project Manager- Carrier Onboarding" },
] as const;
const RESP = /\b(responsibilit\w*|what you('|’)ll do|you will|your role|the role)\b/i;
const REQS = /\b(requirements?|qualifications?|what you('|’)ll bring|must have|you have|experience (in|with))\b/i;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function measureJob(j: (typeof GH_JOBS)[number], r: { ok: boolean; status: number; data: any }) {
  const raw = typeof r.data?.content === "string" ? r.data.content : null; const text = raw ? htmlToText(unescapeHtml(raw)).trim() : "";
  return { ...j, status: r.status, ok: r.ok, api_title: r.data?.title ?? null, title_matches: !!r.data?.title && norm(String(r.data.title)) === norm(j.stored_title),
    location: r.data?.location?.name ?? null, updated_at: r.data?.updated_at ?? null, raw_length: raw?.length ?? 0, text_length: text.length,
    has_responsibilities: RESP.test(text), has_requirements: REQS.test(text), shell: text ? shellKind(text) : null, text };
}

type Deps = { fetchJob: (board: string, id: string) => Promise<{ ok: boolean; status: number; data: any }>; get: (k: string) => Promise<any>; set: (k: string, v: unknown) => Promise<void> };
const fetchJob = (board: string, id: string) => getJson<any>(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`, { timeoutMs: 20000, gapMs: 800, retries: 0 });

export function ghProbeRoutes(d?: Partial<Deps>) {
  const deps: Deps = { fetchJob, get: (k) => store.get(k), set: (k, v) => store.set(k, v), ...d };
  const r = new Hono(); let running: Promise<any> | null = null;
  r.get("/greenhouse-probe", async (c) => {
    if (!allowed(c.req.header("x-bench-token"))) return c.json({ error: "not available" }, 404);
    const done = await deps.get(GH_KEY); if (done) return c.json({ ...done, repeat: true });
    running ??= (async () => {
      await deps.set(GH_KEY, { claimed_at: new Date().toISOString(), jobs: null });   // claimed first: never a second round
      const jobs = []; for (const j of GH_JOBS) jobs.push(measureJob(j, await deps.fetchJob(j.board, j.id)));
      const out = { claimed_at: new Date().toISOString(), requests: GH_JOBS.length, jobs }; await deps.set(GH_KEY, out); return out;
    })();
    return c.json(await running);
  });
  return r;
}
