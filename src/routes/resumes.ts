import { Hono } from "hono";
import { db, type User } from "../lib/db.js";
import { requireUser } from "../lib/auth.js";
import { processResume } from "../engine/worker.js";

export const resumes = new Hono<{ Variables: { user: User } }>();
resumes.use("*", requireUser);

// multipart: file=<pdf|docx>
resumes.post("/", async (c) => {
  const user = c.get("user");
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "Attach a PDF or DOCX." }, 400);
  if (file.size > 5 * 1024 * 1024) return c.json({ error: "Keep it under 5 MB." }, 400);

  const id = crypto.randomUUID();
  const ext = file.name.toLowerCase().endsWith(".docx") ? "docx" : "pdf";
  const path = `${user.id}/${id}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());

  const up = await db.storage.from("resumes").upload(path, buf, { contentType: file.type });
  if (up.error) return c.json({ error: up.error.message }, 500);

  await db.from("resumes").update({ is_current: false }).eq("user_id", user.id);
  const { data, error } = await db
    .from("resumes")
    .insert({ id, user_id: user.id, storage_path: path, filename: file.name })
    .select("id, filename, created_at")
    .single();
  if (error) return c.json({ error: error.message }, 500);
  try {
    const parsed = await processResume(id);
    // One login, one person. When LOCK_RESUME_NAME is on, a plan is tied to the name on the résumé it was bought with.
    if (process.env.LOCK_RESUME_NAME === "1") {
      const { data: plans } = await db.from("plans").select("id, resume_name").eq("user_id", user.id).gt("expires_at", new Date().toISOString()).limit(5);
      const held = (plans ?? []).map((p: any) => p.resume_name).filter(Boolean) as string[];
      if (held.length && !held.some((n) => sameName(n, parsed?.name ?? ""))) {
        await db.from("resumes").delete().eq("id", id);
        await db.from("resumes").update({ is_current: true }).eq("user_id", user.id).order("created_at", { ascending: false }).limit(1);
        return c.json({ error: `This plan is for ${held[0]}’s résumé. A different person needs their own plan.` }, 403);
      }
    }
    return c.json({ resume: { ...data, parsed } });
  } catch (e) {
    await db.from("resumes").delete().eq("id", id);
    throw e;
  }
});

resumes.get("/current", async (c) => {
  const { data } = await db
    .from("resumes")
    .select("id, filename, parsed, created_at")
    .eq("user_id", c.get("user").id)
    .eq("is_current", true)
    .maybeSingle();
  return c.json({ resume: data });
});

function sameName(a: string, b: string) {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w.length > 1);
  const A = n(a), B = n(b); if (!A.length || !B.length) return true;
  const common = A.filter((w) => B.includes(w)).length;
  return common >= Math.min(2, Math.min(A.length, B.length));
}
