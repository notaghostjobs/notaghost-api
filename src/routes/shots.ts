import { asUrl } from "../engine/ghost/canon.js";
import { docLink } from "./doc.js";
import { Hono } from "hono";
import { prewarm, draftKey } from "../engine/prewarm.js";
import { rewriteResume, type ResumeProfile, type PostingProfile, type Match } from "../engine/sharpen.js";
import { MODEL } from "../engine/claude.js";
import { addedFacts } from "../engine/told.js";
import { z } from "zod";
import { db, activePlan, currentResume, type User, type Product } from "../lib/db.js";
import { currentParsedResume } from "../lib/resumeReady.js";
import { srcOf, logEvent } from "../lib/src.js";
import { requireUser } from "../lib/auth.js";
import { runShot } from "../engine/worker.js";
import { env } from "../lib/env.js";

export const shots = new Hono<{ Variables: { user: User } }>();
shots.use("*", requireUser);

import { isTester as isTestUser } from "../lib/testers.js";

shots.get("/plan", async (c) => {
  const u = c.get("user");
  const [sharpen, build] = await Promise.all([activePlan(u.id, "sharpen"), activePlan(u.id, "build")]);
  return c.json({ sharpen, build, test_user: isTestUser(u) });
});

// Test phones only: end every active plan so the whole flow — fit page, checkout, Razorpay, delivery — can be walked from zero.
shots.post("/reset", async (c) => {
  const u = c.get("user");
  if (!isTestUser(u)) return c.json({ error: "Not available on this account." }, 403);
  const now = new Date().toISOString();
  const { data } = await db.from("plans").update({ expires_at: now }).eq("user_id", u.id).gt("expires_at", now).select("id");
  // a clean walk-through: every résumé, preview and shot on this test account is forgotten, so the next run is a first run
  // children first: shots and previews point at résumés, so the résumé row can only go last
  const sh = await db.from("shots").delete().eq("user_id", u.id).select("id");
  const pv = await db.from("previews").delete().eq("user_id", u.id).select("id");
  const rs = await db.from("resumes").delete().eq("user_id", u.id).select("id, storage_path");
  const paths = (rs.data ?? []).map((r: any) => r.storage_path).filter(Boolean);
  if (paths.length) await db.storage.from("resumes").remove(paths).then(() => {}, () => {});
  const errors = [sh.error, pv.error, rs.error].filter(Boolean).map((e) => e!.message);
  if (errors.length) return c.json({ error: `Reset incomplete: ${errors.join("; ")}` }, 500);
  return c.json({ ended: data?.length ?? 0, resumes: rs.data?.length ?? 0, previews: pv.data?.length ?? 0, shots: sh.data?.length ?? 0 });
});

// Test phones only: give the plan one shot back (used when a run broke the promise rule on our side).
shots.post("/return-one", async (c) => {
  const u = c.get("user");
  if (!isTestUser(u)) return c.json({ error: "Not available on this account." }, 403);
  const plan = await activePlan(u.id, "sharpen");
  if (!plan) return c.json({ error: "No active plan." }, 404);
  await db.rpc("refund_shot", { p_plan: plan.id });
  return c.json({ ok: true, plan: plan.id });
});

// Spend one shot. Body: { product, posting_url? , posting_text? }
shots.post("/", async (c) => {
  const u = c.get("user");
  const body = z
    .object({
      product: z.enum(["sharpen", "build"]),
      posting_url: z.string().min(8).transform(asUrl).optional(),
      posting_text: z.string().min(80).optional(),
      preview_id: z.string().uuid().optional(),
      fresh: z.boolean().optional(),            // "Sharpen anyway" on a pair that already has a document: run anew, spend the shot
    })
    .refine((b) => b.posting_url || b.posting_text, "Give a link or paste the posting.")
    .safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);

  const product = body.data.product as Product;
  const plan = await activePlan(u.id, product);
  if (!plan) return c.json({ error: "No active plan.", pay: product }, 402);

  const resume = await currentParsedResume<{ id: string; parsed: any }>(u.id, "id, parsed");
  if (!resume?.parsed) return c.json({ error: "Upload your résumé first." }, 400);

  const { data: shot, error } = await db
    .from("shots")
    .insert({ user_id: u.id, plan_id: plan.id, product, resume_id: resume.id, input: body.data })
    .select("id, status, created_at")
    .single();
  if (error) return c.json({ error: error.message }, 500);

  await db.from("plans").update({ shots_used: plan.shots_used + 1 }).eq("id", plan.id);
  void logEvent("shot", { src: srcOf(c), userId: u.id, meta: { shot_id: shot.id, product } });
  void runShot(shot.id);
  return c.json({ shot, remaining: plan.shots_total - plan.shots_used - 1 });
});


// Checkout opened: start the first draft now, so the shot after payment skips its slowest step. Harmless if never used.
shots.post("/prewarm", async (c) => {
  const u = c.get("user");
  const b = await c.req.json().catch(() => ({}));
  const pid = typeof b?.preview_id === "string" ? b.preview_id : "";
  if (!pid) return c.json({ ok: false });
  const { data: pv } = await db.from("previews").select("resume_id, posting, matches").eq("id", pid).eq("user_id", u.id).maybeSingle();
  if (!pv?.posting || !pv?.matches) return c.json({ ok: false });
  const { data: res } = await db.from("resumes").select("parsed").eq("id", pv.resume_id).maybeSingle();
  if (!res?.parsed) return c.json({ ok: false });
  const matches = pv.matches as Match[];
  const told = addedFacts(matches);
  const source: ResumeProfile = told.length ? { ...(res.parsed as ResumeProfile), candidate_added_facts: told } : (res.parsed as ResumeProfile);
  const started = prewarm(draftKey(pid, matches), () => rewriteResume(source, pv.posting as PostingProfile, MODEL, matches));
  return c.json({ ok: true, started });
});

/** A one-hour link to the PDF for phones: Safari and in-app browsers cannot save a blob, but they can open a URL. */
shots.get("/:id/pdf-link", async (c) => {
  const { data } = await db.from("shots").select("output").eq("id", c.req.param("id")).eq("user_id", c.get("user").id).maybeSingle();
  const path = (data?.output as { pdf_path?: string } | null)?.pdf_path;
  if (!path) return c.json({ error: "Not ready." }, 404);
  const name = (c.req.query("name") ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return c.json({ url: docLink(c.req.param("id"), 3600, name && /\.pdf$/i.test(name) ? name : undefined) });
});

shots.get("/:id/pdf", async (c) => {
  const { data } = await db.from("shots").select("output").eq("id", c.req.param("id")).eq("user_id", c.get("user").id).maybeSingle();
  const path = (data?.output as { pdf_path?: string } | null)?.pdf_path;
  if (!path) return c.json({ error: "Not ready." }, 404);
  const f = await db.storage.from("outputs").download(path);
  if (f.error) return c.json({ error: f.error.message }, 500);
  return new Response(f.data, { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="resume-sharpened.pdf"` } });
});

/** Everything this person has sharpened, newest first: the role, the numbers, and a signed link to each document. */
shots.get("/history", async (c) => {
  const { data } = await db.from("shots").select("id, status, created_at, done_at, output").eq("user_id", c.get("user").id).eq("status", "done").order("created_at", { ascending: false }).limit(50);
  const rows = (data ?? []).map((r) => {
    const o = (r.output ?? {}) as { posting?: { title?: string; company?: string; location?: string }; before?: number; after?: number; pdf_path?: string; repeat?: boolean };
    const title = o.posting?.title ?? "Role", company = o.posting?.company ?? "";
    const name = `Resume-${String(company || "sharpened").replace(/[^A-Za-z0-9]+/g, "-")}.pdf`;
    return { id: r.id, at: r.done_at ?? r.created_at, title, company, location: o.posting?.location ?? "", before: o.before ?? null, after: o.after ?? null,
      pdf: o.pdf_path ? docLink(r.id, 7 * 86400, name) : null };
  });
  return c.json({ shots: rows });
});

shots.get("/:id", async (c) => {
  const { data } = await db
    .from("shots").select("*").eq("id", c.req.param("id")).eq("user_id", c.get("user").id).maybeSingle();
  return data ? c.json({ shot: data }) : c.json({ error: "Not found." }, 404);
});
