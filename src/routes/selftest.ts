// Sharpen self-test: the same synthetic résumé against the same stored posting, N times, with the v2 scorer forced on.
// Proves two things before anyone is charged under v2: the promise never moves, and every delivery meets it.
// Read-only to callers (AUDIT key): GET /admin/sharpen/selftest?runs=3 starts a run in the background and returns at once;
// GET /admin/sharpen/selftest/result reads the last run. Nothing here touches a user, a plan or a shot.
import { Hono } from "hono";
import { db } from "../lib/db.js";
import { parseResume, parsePosting, matchAndGrade, runSharpen } from "../engine/sharpen.js";
import { fit, target, assess } from "../engine/fit.js";

export const selftest = new Hono();

// a synthetic candidate — no real person
const RESUME = `Arjun Venkatesan
Bengaluru · arjun.v@example.com

Director – Grocery & FMCG, Ninjacart (2022–present)
- Directly accountable for FMCG & grocery P&L (60% of company revenue); grew volume 5x in 100 days after relaunch
- Negotiated annual terms and pricing with 40 suppliers across FMCG and staples
- Ran selection for 1,200 SKUs across 14 brands; weekly category reporting built in SQL
- Led a team of 6 category associates; hired and trained 4
- Set up vendor scorecards (fill rate, lead time, margin) reviewed monthly with leadership

Category Manager, BigBasket (2018–2022)
- Owned staples and dry grocery category: pricing, promotions, assortment for Bengaluru and Hyderabad
- Launched private-label pulses line; reached 18% share of category in 9 months
- Managed inventory planning with supply chain; cut stock-outs from 11% to 4%
- Worked with marketing on monthly campaigns; ran A/B tests on PDP content

Associate, Category, Flipkart (2015–2018)
- Supported home & kitchen category: seller onboarding, catalogue quality, pricing checks
- Built Excel models for promotion ROI

Education: MBA, Christ University (2015); B.Com, Loyola College (2013)
Skills: P&L ownership, vendor negotiation, assortment planning, SQL, Excel, Tableau, pricing, promotions, team leadership`;

const KEY = "selftest:sharpen";
let running = false;

async function run(runs: number, postingUrlPart: string) {
  running = true;
  const started = new Date().toISOString();
  const log: unknown[] = [];
  const save = (extra: Record<string, unknown>) => db.from("reader_control").upsert({ key: KEY, value: { started, runs, posting: postingUrlPart, log, ...extra }, updated_at: new Date().toISOString() });
  try {
    const { data: p } = await db.from("postings").select("raw_text, url").ilike("url", `%${postingUrlPart}%`).not("raw_text", "is", null).limit(1).maybeSingle();
    if (!p?.raw_text) throw new Error(`no stored posting matching ${postingUrlPart}`);
    await save({ status: "preview" });
    const resume = await parseResume(RESUME, 1);
    const posting = await parsePosting(p.raw_text);
    const { matches } = await matchAndGrade(resume, posting);
    const a = assess(matches, true);
    const preview = { current: a.current, promised: a.promised, reachable: a.reachable, band: a.band, can_lift: a.can_lift,
      said: matches.filter((m) => m.bucket === "said").length, unsaid: matches.filter((m) => m.bucket === "have_not_said").length,
      sayable: matches.filter((m) => m.bucket === "have_not_said" && m.sayable).length, missing: matches.filter((m) => m.bucket === "missing").length, total: matches.length,
      unsaid_lines: matches.filter((m) => m.bucket === "have_not_said").map((m) => ({ requirement: m.requirement.slice(0, 80), evidence: m.evidence.slice(0, 100), line: (m.line ?? "").slice(0, 160), kind: m.evidence_kind, sayable: !!m.sayable, why: m.vet_reason })) };
    await save({ status: "running", preview });
    const results: unknown[] = [];
    for (let i = 1; i <= runs; i++) {
      const t0 = Date.now();
      const out = await runSharpen(resume, p.raw_text, undefined, { posting, matches }, true);
      const after = fit(out.after_matches);
      results.push({ run: i, delivered: after, promised: a.promised, held: after >= a.promised, needs_review: out.needs_review, seconds: Math.round((Date.now() - t0) / 1000),
        converted: out.after_matches.filter((m) => m.bucket === "said").length - preview.said });
      await save({ status: "running", preview, results });
    }
    const delivered = results.map((r: any) => r.delivered);
    await save({ status: "done", preview, results, verdict: { identical: new Set(delivered).size === 1, all_held: results.every((r: any) => r.held), delivered }, finished: new Date().toISOString() });
  } catch (e) {
    await save({ status: "error", error: (e as Error).message });
  } finally { running = false; }
}

selftest.get("/", (c) => {
  const runs = Math.min(5, Math.max(1, Number(c.req.query("runs") ?? 3)));
  const posting = c.req.query("posting") ?? "4478516313";
  if (running) return c.json({ ok: false, error: "a self-test is already running" }, 409);
  void run(runs, posting);
  return c.json({ ok: true, started: true, runs, posting });
});
selftest.get("/result", async (c) => {
  const { data } = await db.from("reader_control").select("value, updated_at").eq("key", KEY).maybeSingle();
  return c.json(data ?? { status: "never run" });
});
