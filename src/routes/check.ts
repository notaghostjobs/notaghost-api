import { Hono } from "hono";
import { z } from "zod";
import { ghostCheck, snapshotDue } from "../engine/ghost/index.js";
import { db } from "../lib/db.js";
import { identify, gate, refund, type Caller } from "../lib/quota.js";
import { jobKey } from "../engine/ghost/canon.js";
import { fingerprint } from "../engine/ghost/canon.js";

export const check = new Hono();

/** Paste a link (or the posting text). Same job → same score until a fact changes. */
check.post("/", async (c) => {
  const body = z.object({ url: z.string().min(8).optional(), text: z.string().min(80).optional(), force: z.boolean().optional(), quick: z.boolean().optional(), full: z.boolean().optional(),
    // the extension sends the page it is looking at, so we read nothing twice
    page: z.object({ title: z.string().optional(), company: z.string().optional(), location: z.string().optional(), posted_text: z.string().optional(), applicants: z.number().optional(), apply_url: z.string().optional(), closed: z.boolean().optional(), source: z.enum(["extension", "site"]).optional() }).optional() })
    .refine((b) => b.url || b.text, "Paste a job link or the posting text.").safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
  // the gate: who is asking, and have they used today's free checks (admin header bypasses, for audits)
  const admin = !!process.env.ADMIN_SECRET && c.req.header("x-admin") === process.env.ADMIN_SECRET;
  let quota: { used: number; limit: number | null } | undefined;
  let granted: { caller: Caller; key: string } | undefined;
  if (!admin) {
    const url = body.data.url ? (/^https?:\/\//i.test(body.data.url) ? body.data.url.trim() : `https://${body.data.url.trim()}`) : null;
    const key = url ? jobKey(url).key : `text:${fingerprint(body.data.text ?? "").slice(0, 24)}`;
    const caller = await identify(c);
    const g = await gate(caller, key);
    if (!g.allowed) {
      return c.json({
        error: g.gate === "otp" ? "That’s your free check for today. Sign in — it’s free — to keep checking." : `You’ve checked ${g.limit} postings today. Sharpen gives you unlimited checks, or let Radar read them for you.`,
        gate: g.gate, used: g.used, limit: g.limit,
      }, 429);
    }
    quota = { used: g.used, limit: g.limit };
    granted = { caller, key };
  }
  try {
    const r = await ghostCheck({ url: body.data.url, text: body.data.text, page: body.data.page }, { force: !!body.data.force && c.req.header("x-admin") === process.env.ADMIN_SECRET, quick: !(body.data.full && c.req.header("x-admin") === process.env.ADMIN_SECRET) });
    return c.json(quota ? { ...r, quota } : r);
  } catch (e) {
    if (granted) await refund(granted.caller, granted.key).catch(() => {});   // our failure, not their check
    const status = (e as { status?: number }).status ?? 500;
    const msg = (e as Error).message ?? "";
    // a failure of OUR service (model credits, rate limit, outage) is never shown as the user's fault, and never verbatim
    if (/credit balance|rate_limit|overloaded|invalid_request_error|authentication_error|api_error/i.test(msg)) { console.error("[check] upstream", msg.slice(0, 300)); return c.json({ error: "Checks are paused for a moment — please try again shortly." }, 503); }
    if (status >= 500) console.error("[check]", e);
    return c.json({ error: status >= 500 ? "Couldn’t check that link right now. Paste the posting text instead." : msg }, status as 400);
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

/** Waitlist for products not yet open (Radar, Build): phone + product, kept in the control table until the product exists. */
check.post("/waitlist", async (c) => {
  const body = z.object({ product: z.enum(["radar", "build"]), phone: z.string().min(10).max(16), note: z.string().max(200).optional() }).safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "A phone number, please." }, 400);
  const phone = body.data.phone.replace(/\D/g, "").slice(-10);
  if (phone.length !== 10) return c.json({ error: "That doesn’t look like an Indian mobile number." }, 400);
  const key = `waitlist:${body.data.product}:${phone}`;
  await db.from("reader_control").upsert({ key, value: { product: body.data.product, phone, note: body.data.note ?? null, at: new Date().toISOString() } }, { onConflict: "key" });
  return c.json({ ok: true });
});
