import { Hono } from "hono";
import { db } from "../lib/db.js";
import { snapshotDue } from "../engine/ghost/index.js";
import { companyKey } from "../engine/ghost/canon.js";

export const admin = new Hono();
admin.use("*", async (c, next) => { if (c.req.header("x-admin") !== process.env.ADMIN_SECRET) return c.json({ error: "no" }, 403); await next(); });

admin.post("/snapshot", async (c) => c.json({ rechecked: await snapshotDue(Number(c.req.query("limit") ?? 200)) }));

/** Seed employers from "Name | hint" lines. Hint may be "greenhouse:slug", a careers URL, or nothing. */
admin.post("/reader/seed", async (c) => {
  const lines = (await c.req.text()).split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  const rows = lines.map((line) => {
    const [name, hint] = line.split("|").map((s) => s.trim());
    const m = hint?.match(/^([a-z]+):(.+)$/i);
    return { key: companyKey(name), name, source: "seed", ats: m ? m[1].toLowerCase() : null, ats_ref: m ? m[2] : null, careers_url: hint && /^https?:/i.test(hint) ? hint : null };
  }).filter((r) => r.key);
  const { error, data } = await db.from("employers").upsert(rows, { onConflict: "key", ignoreDuplicates: true }).select("key");
  return c.json(error ? { error: error.message } : { added: data?.length ?? 0, given: rows.length });
});

/** Ask the worker to run a step now: resolve | read | harvest | selftest, with n. */
admin.post("/reader/run", async (c) => {
  const step = c.req.query("step"); const n = Number(c.req.query("n") ?? 0) || undefined;
  if (!step) return c.json({ error: "step?" }, 400);
  await db.from("reader_control").upsert({ key: "command", value: { step, n }, updated_at: new Date().toISOString() });
  return c.json({ queued: { step, n } });
});

/** The truth, in numbers. */
admin.get("/reader/stats", async (c) => {
  const count = async (table: string, f: (q: any) => any) => { const { count } = await f(db.from(table).select("*", { count: "exact", head: true })); return count ?? 0; };
  const [employers, unresolved, none, sightings, live, blr, ctl] = await Promise.all([
    count("employers", (q) => q), count("employers", (q) => q.is("resolved_at", null)), count("employers", (q) => q.eq("ats", "none")),
    count("sightings", (q) => q), count("sightings", (q) => q.is("gone_at", null)), count("sightings", (q) => q.is("gone_at", null).eq("blr", true)),
    db.from("reader_control").select("key, value, updated_at"),
  ]);
  // PostgREST caps a select at 1000 rows, so count per known value instead of fetching rows
  const SYSTEMS = ["greenhouse", "lever", "ashby", "smartrecruiters", "workday", "keka", "darwinbox", "page", "none"];
  const SOURCES = ["greenhouse", "lever", "ashby", "smartrecruiters", "workday", "keka", "darwinbox", "page", "naukri", "linkedin"];
  const systems: Record<string, number> = {}, confidence: Record<string, number> = {}, sources: Record<string, { all: number; blr: number }> = {};
  await Promise.all([
    ...SYSTEMS.map(async (sys) => { const n = await count("employers", (q) => q.eq("ats", sys)); if (n) systems[sys] = n; }),
    ...["link", "page", "search", "guess"].map(async (cf) => { const n = await count("employers", (q) => q.eq("confidence", cf).neq("ats", "none")); if (n) confidence[cf] = n; }),
    ...SOURCES.map(async (src) => { const all = await count("sightings", (q) => q.eq("source", src).is("gone_at", null)); if (!all) return; const b = await count("sightings", (q) => q.eq("source", src).is("gone_at", null).eq("blr", true)); sources[src] = { all, blr: b }; }),
  ]);
  const control: Record<string, unknown> = {}; for (const r of ctl.data ?? []) control[r.key] = r.value;
  return c.json({ employers: { total: employers, unresolved, resolved: employers - unresolved, with_feed: employers - unresolved - none, none, systems, confidence }, sightings: { total: sightings, live, blr, by_source: sources }, worker: control });
});

/** Employers with what we decided and why; filter by system. */
admin.get("/reader/employers", async (c) => {
  let q = db.from("employers").select("name, ats, ats_ref, confidence, evidence, careers_url, openings, blr_openings, read_error, resolve_error, source").order("blr_openings", { ascending: false, nullsFirst: false }).limit(Number(c.req.query("limit") ?? 200));
  if (c.req.query("ats")) q = q.eq("ats", c.req.query("ats")!);
  const { data } = await q; return c.json(data ?? []);
});

/** A sample of live Bengaluru sightings, newest first; filter by source. */
admin.get("/reader/sightings", async (c) => {
  let q = db.from("sightings").select("source, company_name, title, location, url, posted_at, posted_text, first_seen").is("gone_at", null).eq("blr", true).order("first_seen", { ascending: false }).limit(Number(c.req.query("limit") ?? 100));
  if (c.req.query("source")) q = q.eq("source", c.req.query("source")!);
  const { data } = await q; return c.json(data ?? []);
});
