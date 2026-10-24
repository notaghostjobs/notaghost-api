import { Hono } from "hono";
import { z } from "zod";
import { createHash } from "node:crypto";
import { db, type User } from "../lib/db.js";
import { requireUser } from "../lib/auth.js";
import { fetchPosting } from "../engine/extract.js";
import { parsePosting, matchAndGrade, type ResumeProfile, type Match } from "../engine/sharpen.js";

export const preview = new Hono<{ Variables: { user: User } }>();
preview.use("*", requireUser);

/** Language-match score from the buckets. before = what they can see now; after = if the hidden proof were said. */
export function scores(matches: Match[]) {
  // before = what a screener ticks today. "said" counts fully; a strength the résumé has but under-writes ("line")
  // counts half, because screeners (and the model) often disagree on where "said" ends; a keyword-only mention counts a fifth.
  // after = what the rewrite can make a screener tick: every line strength, a third of keyword ones; missing stays missing.
  let tot = 0, before = 0, after = 0;
  for (const m of matches) {
    const w = m.kind === "must" ? 2 : 1; tot += w;
    if (m.bucket === "said") { before += w; after += w; }
    else if (m.bucket === "have_not_said") { const kw = m.evidence_kind === "keyword"; before += w * (kw ? 0.2 : 0.5); after += w * (kw ? 0.35 : 1); }
  }
  if (!tot) return { before: 0, after: 0 };
  // Promise only 70% of the lift (not every strength survives the verifier); never promise 100 unless nothing is missing.
  const b = before / tot, a = after / tot;
  const promised = b + (a - b) * 0.7;
  return { before: Math.round(b * 100), after: Math.min(Math.round(promised * 100), 96 + (matches.some((m) => m.bucket === "missing") ? 0 : 4)) };
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
    const url_hash = createHash("sha256").update(body.data.posting_url.trim().toLowerCase()).digest("hex");
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
  const { matches, fits } = await matchAndGrade(resume.parsed as ResumeProfile, posting);
  const s = scores(matches);
  // remember this exact match so the paid run scores against the same list the user saw
  const { data: pv } = await db.from("previews").insert({ user_id: u.id, resume_id: resume.id, posting_id: postingId, posting_text: postingText, posting, matches, score_before: s.before, score_after: s.after }).select("id").single();
  // the three reasons the verdict page shows: strongest have_not_said, a missing must, and another have_not_said/said-weak
  const reasons = [
    ...matches.filter((m) => m.bucket === "have_not_said").slice(0, 2).map((m) => ({ tone: "ok", label: "You have it, you just didn’t say it", title: m.requirement, body: m.suggestion, evidence: m.evidence })),
    ...matches.filter((m) => m.bucket === "missing" && m.kind === "must").slice(0, 1).map((m) => ({ tone: "bad", label: "Genuinely missing", title: m.requirement, body: m.suggestion })),
  ].slice(0, 3);
  return c.json({ preview_id: pv?.id ?? null, posting_id: postingId, posting: { company: posting.company, title: posting.title, location: posting.location }, score_before: s.before, score_after: s.after, reasons, matches, fits: fits ?? null });
});
