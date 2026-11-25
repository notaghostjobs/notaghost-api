// QA validation of WORKDAY_PAUSED (25 Nov 2026), behind the pilot token; closes with the pilot. It runs only when the
// switch is set in QA's own environment, sends no request to any outside host (the paths it calls stop before the network,
// and nothing here reads a non-Workday feed), and reports: requests that left QA for a Workday host (QA's own counter of
// outside requests), refusals made by the pause guard, and what each path returned. It writes nothing.
import { Hono } from "hono";
import { allowed } from "./bench.js";
import { outside } from "./net.js";
import { workdayPaused, refusedByPause, WorkdayPaused, isWorkdayUrl } from "../lib/workdayPause.js";
import { workday, workdayDiscover } from "../reader/systems/ats.js";
import { enrichOne, readPostingText } from "../reader/enrich.js";
import { readPosting } from "../engine/ghost/read.js";
import { fetchPosting } from "../engine/extract.js";

const JOB = "https://accenture.wd103.myworkdayjobs.com/AccentureCareers/job/Bengaluru/Analyst_R00000001";
const wdOutside = () => [...outside.entries()].filter(([h]) => isWorkdayUrl(`https://${h}/`)).reduce((n, [, c]) => n + c, 0);
const run = async (name: string, f: () => Promise<unknown>, pass: (r: { ok: boolean; v?: any; e?: any }) => boolean) => {
  let r: { ok: boolean; v?: any; e?: any };
  try { r = { ok: true, v: await f() }; } catch (e) { r = { ok: false, e }; }
  return { path: name, pass: pass(r), returned: r.ok ? (typeof r.v === "string" ? `text of ${r.v.length} chars` : r.v === null ? "null" : typeof r.v) : `${(r.e as Error)?.name}: ${(r.e as Error)?.message}`.slice(0, 160) };
};

export function wdPauseRoutes() {
  const r = new Hono();
  r.get("/workday-pause-check", async (c) => {
    if (!allowed(c.req.header("x-bench-token"))) return c.json({ error: "not available" }, 404);
    if (!workdayPaused()) return c.json({ error: "WORKDAY_PAUSED is not set in this environment; nothing was run" }, 409);
    const before = wdOutside(); refusedByPause.clear();
    const results = [
      await run("reader list read (workday.read)", () => workday.read("accenture/wd103/AccentureCareers"), (x) => !x.ok && x.e instanceof WorkdayPaused),
      await run("tenant discovery by name (workdayDiscover)", () => workdayDiscover("Accenture"), (x) => x.ok && x.v === null),
      await run("enrichment of a Workday row (enrichOne, no such row id)", () => enrichOne({ id: -1, url: JOB, posted_at: null, salary_text: null, raw: {} }), (x) => x.ok && x.v === false),
      await run("Radar live check (readPostingText)", () => readPostingText(JOB), (x) => x.ok && x.v === ""),
      await run("Ghost Meter link reader (readPosting)", () => readPosting(JOB), (x) => !x.ok && (x.e as any)?.status === 422),
      await run("Sharpen / free-check link fetch (fetchPosting)", () => fetchPosting(JOB, { bypassCache: true }), (x) => !x.ok && (x.e as any)?.status === 400),
      await run("any other fetch to a Workday host (guard)", () => fetch("https://accenture.wd103.myworkdayjobs.com/robots.txt"), (x) => !x.ok && x.e instanceof WorkdayPaused),
    ];
    const after = wdOutside();
    return c.json({ at: new Date().toISOString(), paused: true, workday_requests_sent_from_qa: after - before, refused_by_pause_guard: Object.fromEntries(refusedByPause), all_passed: results.every((x) => x.pass) && after === before, results });
  });
  return r;
}
