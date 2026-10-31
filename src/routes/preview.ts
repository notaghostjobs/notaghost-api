import { Hono } from "hono";
import { z } from "zod";
import { createHash } from "node:crypto";
import { db, type User } from "../lib/db.js";
import { requireUser } from "../lib/auth.js";
import { fetchPosting } from "../engine/extract.js";
import { assess, fit, ENGINE_VERSION } from "../engine/fit.js";
import { parsePosting, matchAndGrade, type ResumeProfile, type Match } from "../engine/sharpen.js";

const hashUrl = (u: string) => createHash("sha256").update(u.trim().toLowerCase()).digest("hex");
export const preview = new Hono<{ Variables: { user: User } }>();
preview.use("*", requireUser);

/** Kept for the worker's import; the numbers now come from engine/fit.ts, one scorer for before, promise and delivered. */
export function scores(matches: Match[]) {
  const a = assess(matches);
  return { before: a.current, after: a.promised };
}

/** Free step: read the posting, match against the current résumé. No shot spent. */
preview.post("/", async (c) => {
  const u = c.get("user");
  const body = z.object({ posting_url: z.string().url().optional(), posting_text: z.string().min(80).optional() })
    .refine((b) => b.posting_url || b.posting_text, "Give a link or paste the posting.").safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);

  const { data: resume } = await db.from("resumes").select("id, parsed").eq("user_id", u.id).eq("is_current", true).maybeSingle();
  if (!resume?.parsed) return c.json({ error: "Upload your résumé first." }, 400);

  let postingText = body.data.posting_text ?? "", postingId: string | null = null, parsed: any = null;
  if (body.data.posting_url) {
    const url_hash = hashUrl(body.data.posting_url);
    const { data: cached } = await db.from("postings").select("id, raw_text, parsed").eq("url_hash", url_hash).maybeSingle();
    if (cached) { postingId = cached.id; postingText = cached.raw_text; parsed = cached.parsed; }
    else {
      postingText = await fetchPosting(body.data.posting_url);
      const { data: p } = await db.from("postings").insert({ url: body.data.posting_url, url_hash, raw_text: postingText }).select("id").single();
      postingId = p?.id ?? null;
    }
  }
  if (postingText.length < 80) return c.json({ error: "That posting is too short to work with. Paste the full description." }, 400);

  const posting = parsed ?? (await parsePosting(postingText));
  if (postingId && !parsed) await db.from("postings").update({ company: posting.company, title: posting.title, parsed: posting }).eq("id", postingId);
  // The same résumé against the same posting is the same fit: the first read is kept and returned again, to the digit, for 30
  // days or until the résumé changes. A number that moved between two looks at one posting was never a promise.
  const since = new Date(Date.now() - 30 * 86400e3).toISOString();
  const { data: prior } = postingId
    ? await db.from("previews").select("id, matches, posting").eq("user_id", u.id).eq("resume_id", resume.id).eq("posting_id", postingId).order("created_at", { ascending: false }).limit(1).maybeSingle()
    : { data: null };
  // The number is holy: once this résumé has been matched against this posting, the stored result is what the user sees,
  // every time, whatever the engine does later. An engine change applies to pairs scored after it, never to one already shown.
  let matches: Match[], fits: string | null, previewId: string | null;
  const similar_open = await similarOpen(posting.title);
  if (prior?.matches) { matches = prior.matches as Match[]; fits = null; previewId = prior.id; }
  else {
    const g = await matchAndGrade(resume.parsed as ResumeProfile, posting);
    matches = g.matches; fits = g.fits ?? null;
    const a0 = assess(matches);
    // remember this exact match so the paid run scores against the same list the user saw
    const { data: pv } = await db.from("previews").insert({ user_id: u.id, resume_id: resume.id, posting_id: postingId, posting_text: postingText, posting: { ...posting, __engine: ENGINE_VERSION }, matches, score_before: a0.current, score_after: a0.promised }).select("id").single();
    previewId = pv?.id ?? null;
  }
  const a = assess(matches);
  const pv = { id: previewId };
  // the change list: what's unsaid (we can say it), what's buried (a keyword only), what's missing (we won't claim it)
  const unsaid = matches.filter((m) => m.bucket === "have_not_said" && m.evidence_kind !== "keyword");
  const buried = matches.filter((m) => m.bucket === "have_not_said" && m.evidence_kind === "keyword");
  const missing = matches.filter((m) => m.bucket === "missing" && m.kind === "must");
  const changes = [
    ...unsaid.slice(0, 3).map((m) => ({ kind: "unsaid", requirement: m.requirement, evidence: m.evidence, how: m.suggestion })),
    ...buried.slice(0, 2).map((m) => ({ kind: "buried", requirement: m.requirement, evidence: m.evidence, how: m.suggestion })),
    ...missing.slice(0, 2).map((m) => ({ kind: "missing", requirement: m.requirement, how: m.suggestion })),
  ];
  const reasons = [
    ...unsaid.slice(0, 2).map((m) => ({ tone: "ok", label: "You have it, you just didn’t say it", title: m.requirement, body: m.suggestion, evidence: m.evidence })),
    ...missing.slice(0, 1).map((m) => ({ tone: "bad", label: "Genuinely missing", title: m.requirement, body: m.suggestion })),
  ].slice(0, 3);
  return c.json({ similar_open, preview_id: pv?.id ?? null, posting_id: postingId, posting: { company: posting.company, title: posting.title, location: posting.location },
    score_before: a.current, score_after: a.promised, band: a.band, reachable: a.reachable, can_lift: a.can_lift,
    counts: { said: matches.filter((m) => m.bucket === "said").length, unsaid: unsaid.length, buried: buried.length, missing: matches.filter((m) => m.bucket === "missing").length, total: matches.length },
    changes, reasons, matches, fits: fits ?? null });
});


/** Live Bengaluru roles on employers' own systems whose title shares the posting's two most specific words. */
async function similarOpen(title: string): Promise<number> {
  const stop = new Set(["senior","sr","junior","jr","lead","principal","staff","associate","assistant","head","director","manager","the","and","for","of","ii","iii","iv","i","india","bengaluru","bangalore"]);
  const words = (title || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !stop.has(w)).sort((a, b) => b.length - a.length).slice(0, 2);
  if (!words.length) return 0;
  let q = db.from("sightings").select("*", { count: "exact", head: true }).eq("blr", true).is("gone_at", null);
  for (const w of words) q = q.ilike("title", `%${w}%`);
  const { count } = await q;
  return count ?? 0;
}

/** Warm-up from the panel: parse the posting while the person is still uploading, so the fit verdict is ~8 s faster. */
preview.post("/warm", async (c) => {
  const body = z.object({ posting_url: z.string().min(8) }).safeParse(await c.req.json());
  if (!body.success) return c.json({ ok: false }, 400);
  const url_hash = hashUrl(body.data.posting_url);
  const { data: cached } = await db.from("postings").select("id, raw_text, parsed").eq("url_hash", url_hash).maybeSingle();
  if (cached?.parsed) return c.json({ ok: true, warm: true });
  try {
    const postingText = cached?.raw_text ?? (await fetchPosting(body.data.posting_url));
    const id = cached?.id ?? (await db.from("postings").insert({ url: body.data.posting_url, url_hash, raw_text: postingText }).select("id").single()).data?.id;
    const posting = await parsePosting(postingText);
    if (id) await db.from("postings").update({ company: posting.company, title: posting.title, parsed: posting }).eq("id", id);
    return c.json({ ok: true, warm: false });
  } catch { return c.json({ ok: false }); }
});
