import { Hono, type Context } from "hono";
import { z } from "zod";
import { formPdf } from "../engine/formpdf.js";
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

  return ingest(c, user, file.name, Buffer.from(await file.arrayBuffer()), file.type);
});

// A student with no résumé yet: a few details typed in, set out as a plain one-page PDF and put on file exactly as an upload
// would be, so the fit and the Sharpen that follow work from it like any other. Nothing here is written by a model.
const formIn = z.object({
  name: z.string().trim().min(2).max(80), email: z.string().trim().email().max(120).optional().or(z.literal("")),
  city: z.string().trim().max(60).optional(), links: z.string().trim().max(200).optional(),
  college: z.string().trim().min(2).max(140), degree: z.string().trim().min(2).max(140),
  year: z.string().trim().regex(/^20\d\d$/), score: z.string().trim().max(40).optional(),
  skills: z.string().trim().min(3).max(500),
  projects: z.array(z.object({ title: z.string().trim().min(2).max(120), what: z.string().trim().min(20).max(600) })).min(1).max(3),
  experience: z.string().trim().max(800).optional(), extras: z.string().trim().max(400).optional(),
});
/** For phones, which cannot save a file handed to the page: a one-hour link that downloads the résumé on file under its own name. */
resumes.get("/current/file-link", async (c) => {
  const cur = await currentResume<{ id: string; storage_path: string; filename: string }>(c.get("user").id, "id, storage_path, filename");
  if (!cur?.storage_path) return c.json({ error: "No résumé on file yet." }, 404);
  const name = (cur.filename ?? "resume.pdf").replace(/[^A-Za-z0-9._-]/g, "-");
  const { data, error } = await db.storage.from("resumes").createSignedUrl(cur.storage_path, 3600, { download: name });
  if (error || !data?.signedUrl) return c.json({ error: error?.message ?? "Couldn’t make the link." }, 500);
  return c.json({ url: data.signedUrl, name });
});
/** What they typed last time, so a line can be changed and the résumé made again without typing it all twice. */
// "Let employers find me": one yes/no per person, and when they said it. Off until they tick it; they can untick it any
// time. Saying yes lets an employer on Open see their skills and experience without a name or contact details; those are
// shared only when they accept a conversation. Kept as find:<user id>. `v` is the wording they agreed to.
const FIND_WORDING = 1;
resumes.get("/findable", async (c) => {
  const { data } = await db.from("reader_control").select("value").eq("key", `find:${c.get("user").id}`).maybeSingle();
  const v = (data?.value as { on?: boolean; at?: string } | null) ?? null;
  return c.json({ on: v?.on === true, at: v?.at ?? null });
});
resumes.post("/findable", async (c) => {
  const body = z.object({ on: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "bad_request", message: "Say yes or no." }, 400);
  const key = `find:${c.get("user").id}`; const at = new Date().toISOString();
  const { data } = await db.from("reader_control").select("value").eq("key", key).maybeSingle();
  const had = (data?.value as { first_on_at?: string } | null) ?? null;
  const value = { on: body.data.on, at, first_on_at: had?.first_on_at ?? (body.data.on ? at : null), v: FIND_WORDING };
  const { error } = await db.from("reader_control").upsert({ key, value, updated_at: at }, { onConflict: "key" });
  if (error) return c.json({ error: "not_saved", message: "That did not save. Try again." }, 500);
  return c.json({ on: value.on, at });
});

resumes.get("/form", async (c) => {
  const { data } = await db.from("reader_control").select("value").eq("key", `form:${c.get("user").id}`).maybeSingle();
  return c.json({ form: (data?.value as any) ?? null });
});
/** The résumé on file, as the file itself: the free résumé is downloaded from here. */
resumes.get("/current/file", async (c) => {
  const cur = await currentResume<{ id: string; storage_path: string; filename: string }>(c.get("user").id, "id, storage_path, filename");
  if (!cur?.storage_path) return c.json({ error: "No résumé on file yet." }, 404);
  const f = await db.storage.from("resumes").download(cur.storage_path);
  if (f.error) return c.json({ error: f.error.message }, 500);
  const type = /\.pdf$/i.test(cur.filename ?? "") ? "application/pdf" : "application/octet-stream";
  return new Response(f.data, { headers: { "content-type": type, "content-disposition": `attachment; filename="${(cur.filename ?? "resume.pdf").replace(/[^A-Za-z0-9._-]/g, "-")}"` } });
});
resumes.post("/form", async (c) => {
  const user = c.get("user");
  const body = formIn.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Fill in your name, college, degree, passing year, skills and one project (a couple of lines on what you built).", code: "form" }, 400);
  const f = body.data;
  // a page with too little on it cannot be read back as text, and gives the Sharpen nothing to work from
  const said = [f.skills, f.experience ?? "", f.extras ?? "", ...f.projects.map((p) => `${p.title} ${p.what}`)].join(" ").length;
  if (said < 220) return c.json({ error: "Tell us a little more: a couple of lines on what you built in each project, and the tools you used.", code: "form_thin" }, 400);
  const buf = await formPdf({ ...f, email: f.email || undefined }, user.phone);
  await db.from("reader_control").upsert({ key: `form:${user.id}`, value: f, updated_at: new Date().toISOString() }, { onConflict: "key" });
  return ingest(c, user, `${f.name.replace(/[^A-Za-z ]/g, "").trim().replace(/\s+/g, "-") || "resume"}-resume.pdf`, buf, "application/pdf", { later: true });
});

/** Puts a résumé file on the account. `later` (the free résumé made from typed details): nothing is read by a model now;
 *  it is read on sight the first time a role is scored against it, like any résumé whose reading was cut short. */
async function ingest(c: Context<{ Variables: { user: User } }>, user: User, name: string, buf: Buffer, type: string, opts: { later?: boolean } = {}) {
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
  const ext = name.toLowerCase().endsWith(".docx") ? "docx" : name.toLowerCase().endsWith(".doc") ? "doc" : "pdf";
  const path = `${user.id}/${id}.${ext}`;
  
  const up = await db.storage.from("resumes").upload(path, buf, { contentType: type });
  if (up.error) return c.json({ error: up.error.message }, 500);

  const prev = await currentResume<{ id: string }>(user.id, "id");
  await db.from("resumes").update({ is_current: false }).eq("user_id", user.id);
  const { data, error } = await db
    .from("resumes")
    .insert({ id, user_id: user.id, storage_path: path, filename: name })
    .select("id, filename, created_at")
    .single();
  if (error) return c.json({ error: error.message }, 500);
  await db.from("resumes").update({ is_current: false }).eq("user_id", user.id).neq("id", id);   // concurrent uploads: the one that landed last is the one on file
  if (freeCount !== null) await db.from("reader_control").upsert({ key: freeKey, value: { n: freeCount + 1 }, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (opts.later) return c.json({ resume: { ...data, parsed: null }, radar_reset: false });
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
}

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
