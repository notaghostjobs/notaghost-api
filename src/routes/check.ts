import { Hono } from "hono";
import { z } from "zod";
import { ghostCheck, snapshotDue } from "../engine/ghost/index.js";
import { db } from "../lib/db.js";

export const check = new Hono();

/** Paste a link (or the posting text). Same job → same score until a fact changes. */
check.post("/", async (c) => {
  const body = z.object({ url: z.string().min(8).optional(), text: z.string().min(80).optional(), force: z.boolean().optional() })
    .refine((b) => b.url || b.text, "Paste a job link or the posting text.").safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
  try {
    const r = await ghostCheck({ url: body.data.url, text: body.data.text }, { force: !!body.data.force && c.req.header("x-admin") === process.env.ADMIN_SECRET });
    return c.json(r);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    if (status >= 500) console.error("[check]", e);
    return c.json({ error: status >= 500 ? "Couldn’t check that link right now. Paste the posting text instead." : (e as Error).message }, status as 400);
  }
});

/** The stored verdict for a posting (the verdict page reload; the Sharpen step). */
check.get("/:id", async (c) => {
  const { data } = await db.from("postings").select("id, url, title, company, score, verdict, signals, ghost, scored_at, history").eq("id", c.req.param("id")).maybeSingle();
  return data ? c.json(data) : c.json({ error: "Not found." }, 404);
});

/** Admin: run the daily snapshot now. Also runs on a timer in index.ts. */
check.post("/snapshot", async (c) => {
  if (c.req.header("x-admin") !== process.env.ADMIN_SECRET) return c.json({ error: "no" }, 403);
  const n = await snapshotDue(Number(c.req.query("limit") ?? 200));
  return c.json({ ok: true, rechecked: n });
});
