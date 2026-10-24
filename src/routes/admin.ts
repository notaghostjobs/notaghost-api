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

/** Recent postings with verdicts — the test rig view. */
admin.get("/postings", async (c) => {
  const { data } = await db.from("postings").select("id, company, title, source, url, score, verdict, signals, scored_at, first_seen_at").order("scored_at", { ascending: false, nullsFirst: false }).limit(Number(c.req.query("limit") ?? 100));
  return c.json(data ?? []);
});
