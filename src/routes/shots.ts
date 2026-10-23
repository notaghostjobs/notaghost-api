import { Hono } from "hono";
import { z } from "zod";
import { db, activePlan, type User, type Product } from "../lib/db.js";
import { requireUser } from "../lib/auth.js";
import { runShot } from "../engine/worker.js";

export const shots = new Hono<{ Variables: { user: User } }>();
shots.use("*", requireUser);

shots.get("/plan", async (c) => {
  const u = c.get("user");
  const [sharpen, build] = await Promise.all([activePlan(u.id, "sharpen"), activePlan(u.id, "build")]);
  return c.json({ sharpen, build });
});

// Spend one shot. Body: { product, posting_url? , posting_text? }
shots.post("/", async (c) => {
  const u = c.get("user");
  const body = z
    .object({
      product: z.enum(["sharpen", "build"]),
      posting_url: z.string().url().optional(),
      posting_text: z.string().min(80).optional(),
      preview_id: z.string().uuid().optional(),
    })
    .refine((b) => b.posting_url || b.posting_text, "Give a link or paste the posting.")
    .safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);

  const product = body.data.product as Product;
  const plan = await activePlan(u.id, product);
  if (!plan) return c.json({ error: "No active plan.", pay: product }, 402);

  const { data: resume } = await db
    .from("resumes").select("id, parsed").eq("user_id", u.id).eq("is_current", true).maybeSingle();
  if (!resume?.parsed) return c.json({ error: "Upload your résumé first." }, 400);

  const { data: shot, error } = await db
    .from("shots")
    .insert({ user_id: u.id, plan_id: plan.id, product, resume_id: resume.id, input: body.data })
    .select("id, status, created_at")
    .single();
  if (error) return c.json({ error: error.message }, 500);

  await db.from("plans").update({ shots_used: plan.shots_used + 1 }).eq("id", plan.id);
  void runShot(shot.id);
  return c.json({ shot, remaining: plan.shots_total - plan.shots_used - 1 });
});

shots.get("/:id/pdf", async (c) => {
  const { data } = await db.from("shots").select("output").eq("id", c.req.param("id")).eq("user_id", c.get("user").id).maybeSingle();
  const path = (data?.output as { pdf_path?: string } | null)?.pdf_path;
  if (!path) return c.json({ error: "Not ready." }, 404);
  const f = await db.storage.from("outputs").download(path);
  if (f.error) return c.json({ error: f.error.message }, 500);
  return new Response(f.data, { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="resume-sharpened.pdf"` } });
});

shots.get("/:id", async (c) => {
  const { data } = await db
    .from("shots").select("*").eq("id", c.req.param("id")).eq("user_id", c.get("user").id).maybeSingle();
  return data ? c.json({ shot: data }) : c.json({ error: "Not found." }, 404);
});
