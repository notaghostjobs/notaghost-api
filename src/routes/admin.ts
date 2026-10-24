import { Hono } from "hono";
import { db } from "../lib/db.js";
import { seedCompanies, readCity, scoreUnscored, readAllInBackground, readerStatus } from "../jobs/reader.js";
import { snapshotDue } from "../engine/ghost/index.js";

export const admin = new Hono();
admin.use("*", async (c, next) => { if (c.req.header("x-admin") !== process.env.ADMIN_SECRET) return c.json({ error: "no" }, 403); await next(); });

admin.post("/seed", async (c) => { const body = await c.req.text(); return c.json({ added: await seedCompanies(body.split("\n")) }); });
admin.post("/read", async (c) => c.json(await readCity({ limit: Number(c.req.query("limit") ?? 60), onlyStale: c.req.query("all") !== "1" })));
admin.post("/score", async (c) => c.json({ scored: await scoreUnscored(Number(c.req.query("limit") ?? 40)) }));
admin.post("/read-all", (c) => c.json(readAllInBackground()));
admin.get("/status", (c) => c.json(readerStatus()));
admin.post("/snapshot", async (c) => c.json({ rechecked: await snapshotDue(Number(c.req.query("limit") ?? 200)) }));

/** City dashboard numbers. */
admin.get("/stats", async (c) => {
  const [{ count: companies }, { count: withAts }, { count: postings }, { count: scored }, { data: verdicts }] = await Promise.all([
    db.from("companies").select("key", { count: "exact", head: true }),
    db.from("companies").select("key", { count: "exact", head: true }).not("ats", "in", '("unknown","none")').not("ats", "is", null),
    db.from("postings").select("id", { count: "exact", head: true }),
    db.from("postings").select("id", { count: "exact", head: true }).not("scored_at", "is", null),
    db.from("postings").select("verdict").not("verdict", "is", null).limit(5000),
  ]);
  const dist: Record<string, number> = {}; for (const v of verdicts ?? []) dist[v.verdict] = (dist[v.verdict] ?? 0) + 1;
  const { data: byAts } = await db.from("companies").select("ats").limit(2000);
  const ats: Record<string, number> = {}; for (const r of byAts ?? []) ats[r.ats ?? "unread"] = (ats[r.ats ?? "unread"] ?? 0) + 1;
  return c.json({ companies, with_feed: withAts, postings, scored, verdicts: dist, feeds: ats, reader: readerStatus() });
});

/** One line per company with a feed: what we found and a sample job, so a bad match is visible. */
admin.get("/feeds", async (c) => {
  let q = db.from("companies").select("name, ats, ats_slug, careers_url, ats_jobs, ats_checked").not("ats", "is", null).order("name");
  if (c.req.query("system")) q = q.eq("ats", c.req.query("system")!);
  const { data } = await q.limit(500);
  return c.json((data ?? []).map((r: any) => ({ name: r.name, ats: r.ats, slug: r.ats_slug, jobs: (r.ats_jobs ?? []).length, sample: (r.ats_jobs ?? []).slice(0, 2).map((j: any) => `${j.title} — ${j.location} — ${j.url}`) })));
});

/** Forget a feed system's discoveries (bad probe), so the next read re-discovers. Deletes its postings and observations. */
admin.post("/reset-feed", async (c) => {
  const system = c.req.query("system"); if (!system) return c.json({ error: "system?" }, 400);
  const { data: ps } = await db.from("postings").select("id").like("job_key", `${system}:%`).limit(10000);
  const ids = (ps ?? []).map((p) => p.id);
  if (ids.length) { await db.from("observations").delete().in("posting_id", ids); await db.from("postings").delete().in("id", ids); }
  const { count } = await db.from("companies").update({ ats: null, ats_jobs: [], ats_checked: null, openings: null }, { count: "exact" }).eq("ats", system);
  return c.json({ companies_reset: count, postings_deleted: ids.length });
});

/** Recent postings with verdicts — the test rig view. */
admin.get("/postings", async (c) => {
  const { data } = await db.from("postings").select("id, company, title, source, url, score, verdict, signals, scored_at, first_seen_at").order("scored_at", { ascending: false, nullsFirst: false }).limit(Number(c.req.query("limit") ?? 100));
  return c.json(data ?? []);
});
