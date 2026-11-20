import { Hono } from "hono";
import { db, currentResume, type User } from "../lib/db.js";
import { isOwnDocument } from "../engine/own.js";
import { masterChanged } from "./radar.js";
import { currentParsedResume } from "../lib/resumeReady.js";
import { requireUser } from "../lib/auth.js";
import { isTester } from "../lib/testers.js";
import { withMeter } from "../engine/meter.js";
import { processResume } from "../engine/worker.js";

export const resumes = new Hono<{ Variables: { user: User } }>();
resumes.use("*", requireUser);

// multipart: file=<pdf|docx>
resumes.post("/", async (c) => {
  const user = c.get("user");
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "Attach a PDF, .docx or .doc." }, 400);
  if (!/\.(pdf|docx|doc)$/i.test(file.name)) return c.json({ error: "Upload a PDF, .docx or .doc résumé." }, 400);
  if (file.size > 5 * 1024 * 1024) return c.json({ error: "Keep it under 5 MB." }, 400);

  // Reading a résumé is the one thing that costs money before anyone has paid. A ceiling on how many are read in a day
  // for people with no plan (FREE_RESUMES_PER_DAY, 300 unless set) means a campaign can never run up a bill overnight:
  // past it, the person is asked to come back in the morning. Testers and anyone holding a plan are not counted.
  const freeKey = `free:resumes:${new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)}`;
  let freeCount: number | null = null;
  if (!isTester(user)) {
    const { data: plans } = await db.from("plans").select("id").eq("user_id", user.id).gt("expires_at", new Date().toISOString()).limit(1);
    if (!plans?.length) {
      const { data: row } = await db.from("reader_control").select("value").eq("key", freeKey).maybeSingle();
      freeCount = Number((row?.value as any)?.n ?? 0);
      const limit = Math.max(0, Number(process.env.FREE_RESUMES_PER_DAY ?? 300) || 0);
      if (freeCount >= limit) return c.json({ error: "We’ve reached today’s limit for free checks. Come back tomorrow morning and yours will be the first.", code: "free_limit" }, 429);
    }
  }

  const id = crypto.randomUUID();
  const ext = file.name.toLowerCase().endsWith(".docx") ? "docx" : file.name.toLowerCase().endsWith(".doc") ? "doc" : "pdf";
  const path = `${user.id}/${id}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());

  const up = await db.storage.from("resumes").upload(path, buf, { contentType: file.type });
  if (up.error) return c.json({ error: up.error.message }, 500);

  const prev = await currentResume<{ id: string }>(user.id, "id");
  await db.from("resumes").update({ is_current: false }).eq("user_id", user.id);
  const { data, error } = await db
    .from("resumes")
    .insert({ id, user_id: user.id, storage_path: path, filename: file.name })
    .select("id, filename, created_at")
    .single();
  if (error) return c.json({ error: error.message }, 500);
  await db.from("resumes").update({ is_current: false }).eq("user_id", user.id).neq("id", id);   // concurrent uploads: the one that landed last is the one on file
  if (freeCount !== null) await db.from("reader_control").upsert({ key: freeKey, value: { n: freeCount + 1 }, updated_at: new Date().toISOString() }, { onConflict: "key" });
  try {
    const parsed = await withMeter({ tag: "resume:read", user: user.id }, () => processResume(id));   // named on the meter, so what a free check costs can be read off it
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
    // A document we wrote for a job is not this person's résumé: it never replaces the one on file (their master, which
    // Radar and every Sharpen work from). With nothing else on file, it is accepted — there is nothing better to use.
    if (prev) {
      const { data: done } = await db.from("shots").select("id, output").eq("user_id", user.id).eq("status", "done").order("done_at", { ascending: false }).limit(25);
      const mine = (done ?? []).find((sh: any) => sh.output?.rewrite && isOwnDocument(parsed, sh.output.rewrite));
      if (mine) {
        await db.from("resumes").delete().eq("id", id);
        await db.from("resumes").update({ is_current: true }).eq("id", prev.id);
        const o: any = mine.output;
        return c.json({ error: `This is the résumé we sharpened for ${o.posting?.company ?? "a role"}${o.posting?.title ? ` · ${o.posting.title}` : ""}. It’s already done, at ${Math.min(97, o.after)}%. Your own résumé stays on file, and we work from that one.`, code: "own_document", shot_id: mine.id, after: Math.min(97, o.after) }, 409);
      }
    }
    const radar_reset = await masterChanged(user.id, id).catch(() => false);
    return c.json({ resume: { ...data, parsed }, radar_reset });
  } catch (e) {
    await db.from("resumes").delete().eq("id", id);
    if (prev) await db.from("resumes").update({ is_current: true }).eq("id", prev.id);   // a file that could not be read does not cost them the résumé they had
    throw e;
  }
});

resumes.get("/current", async (c) => {
  const data = await currentParsedResume<{ id: string; parsed: any }>(c.get("user").id, "id, filename, parsed, created_at");
  return c.json({ resume: data });
});

function sameName(a: string, b: string) {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w.length > 1);
  const A = n(a), B = n(b); if (!A.length || !B.length) return true;
  const common = A.filter((w) => B.includes(w)).length;
  return common >= Math.min(2, Math.min(A.length, B.length));
}
