import { canonicalPostingUrl, asUrl } from "../engine/ghost/canon.js";
import { checkedProfile } from "../engine/worker.js";
import { Hono } from "hono";
import { z } from "zod";
import { createHash } from "node:crypto";
import { db, currentResume, type User } from "../lib/db.js";
import { currentParsedResume } from "../lib/resumeReady.js";
import { srcOf, stampUser, logEvent } from "../lib/src.js";
import { requireUser } from "../lib/auth.js";
import { fetchPosting } from "../engine/extract.js";
import { assess, fit, ENGINE_VERSION } from "../engine/fit.js";
import { parsePosting, matchAndGrade, type ResumeProfile, type Match } from "../engine/sharpen.js";
import { radarMatchesFor } from "./radar.js";
import { withMeter } from "../engine/meter.js";
import { ownDocumentFor } from "../engine/own.js";
import { cleanTitle } from "../radar/v2.js";
import { gapsOf, flagOwnership, fillOptions, assembleLine, shapeFree, acceptInto, withdrawFrom, recallAnswers, rememberAnswer, forgetAnswer, applyRemembered, type Facts } from "../engine/told.js";

const hashUrl = (u: string) => createHash("sha256").update(canonicalPostingUrl(u).trim().toLowerCase()).digest("hex");
/** The description on file for a role Radar follows, by its link: the employer's own words, as the reader took them. */
async function knownPosting(url: string): Promise<string | null> {
  const bare = url.trim().replace(/[?#].*$/, "").replace(/\/$/, "");
  const { data } = await db.from("sightings").select("title, company_name, location, description").in("url", [url.trim(), bare, bare + "/"]).not("description", "is", null).limit(1);
  const s: any = data?.[0];
  if (!s || String(s.description ?? "").length < 200) return null;
  return `${cleanTitle(s.title)}\n${s.company_name ?? ""}${/bengaluru|bangalore/i.test(s.location ?? "") ? " · Bengaluru" : ""}\n\n${s.description}`;
}

export const preview = new Hono<{ Variables: { user: User } }>();
preview.use("*", requireUser);

/** Kept for the worker's import; the numbers now come from engine/fit.ts, one scorer for before, promise and delivered. */
export function scores(matches: Match[]) {
  const a = assess(matches);
  return { before: a.current, after: a.promised };
}

/** Free step: read the posting, match against the current résumé. No shot spent. */

/** The upload page knows the posting before the résumé is in: read and parse it now, so the fit check only has to match. */
preview.post("/warm", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const url = typeof b?.posting_url === "string" ? b.posting_url : "";
  if (!/^https?:\/\//.test(url)) return c.json({ ok: false });
  void (async () => {
    try {
      const url_hash = hashUrl(url);
      const { data: cached } = await db.from("postings").select("id, parsed").eq("url_hash", url_hash).maybeSingle();
      if (cached?.parsed) return;
      let id = cached?.id ?? null, text = "";
      if (!cached) { text = await fetchPosting(url); const { data: p } = await db.from("postings").insert({ url, url_hash, raw_text: text }).select("id").single(); id = p?.id ?? null; }
      else { const { data: r } = await db.from("postings").select("raw_text").eq("id", cached.id).single(); text = r?.raw_text ?? ""; }
      if (!id || text.length < 80) return;
      const posting = await parsePosting(text);
      await db.from("postings").update({ company: posting.company, title: posting.title, parsed: posting }).eq("id", id);
    } catch { /* the fit check does it the slow way */ }
  })();
  return c.json({ ok: true });
});

preview.post("/", async (c) => {
  const u = c.get("user");
  const body = z.object({ posting_url: z.string().min(8).transform(asUrl).optional(), posting_text: z.string().min(80).optional() })
    .refine((b) => b.posting_url || b.posting_text, "Give a link or paste the posting.").safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);

  const resume = await currentParsedResume<{ id: string; parsed: any }>(u.id, "id, parsed");
  if (!resume?.parsed) return c.json({ error: "Upload your résumé first." }, 400);
  // the fit is read from the checked parse — the one the document will be written from
  { const checked = await checkedProfile(resume.id, "preview").catch(() => null); if (checked) resume.parsed = checked; }
  // a layout whose lines we could not attribute to their roles with certainty, even on a second reading: nothing is sold on it
  if (resume.parsed?.parse_check?.verified === false)
    return c.json({ error: "We couldn’t be sure which lines belong to which job in this résumé’s layout, so we won’t rewrite it — a line under the wrong employer is worse than no rewrite. Upload a simpler version: one column, each job followed by its own points (a Word or Google Docs file, or a PDF saved from one). Nothing has been used.", code: "layout" }, 400);
  { const src = srcOf(c); await stampUser(u.id, src); void logEvent("preview", { src, userId: u.id, meta: { posting_url: body.data.posting_url ?? null } }); }

  let postingText = body.data.posting_text ?? "", postingId: string | null = null, parsed: any = null;
  if (body.data.posting_url) {
    const url_hash = hashUrl(body.data.posting_url);
    const { data: cached } = await db.from("postings").select("id, raw_text, parsed").eq("url_hash", url_hash).maybeSingle();
    // a page that came back as a shell ("Career Portal", 13 characters) is not a posting: it is not kept, and not reused
    if (cached && (cached.raw_text ?? "").length >= 200) { postingId = cached.id; postingText = cached.raw_text; parsed = cached.parsed; }
    else {
      postingText = await fetchPosting(body.data.posting_url).catch(() => "");
      // a careers portal that draws the job with script gives the fetch nothing. If this is a role we already follow
      // (it is on Radar, with the employer's own description on file), that description is the posting.
      if (postingText.length < 200) { const known = await knownPosting(body.data.posting_url); if (known) postingText = known; }
      if (postingText.length >= 200) {
        if (cached) { await db.from("postings").update({ raw_text: postingText, parsed: null }).eq("id", cached.id); postingId = cached.id; }
        else { const { data: p } = await db.from("postings").insert({ url: body.data.posting_url, url_hash, raw_text: postingText }).select("id").single(); postingId = p?.id ?? null; }
      }
    }
  }
  if (postingText.length < 80) return c.json({ error: body.data.posting_url ? "That page didn’t give us the job’s text — some career sites only show it inside the browser. Use “change” and paste the job description instead." : "That posting is too short to work with. Paste the full description." }, 400);

  let posting = parsed ?? (await parsePosting(postingText));
  // A cached row can hold a page that wasn't the job (a search page or a login wall read before today's fixes): it parses to
  // almost nothing and every later visitor would inherit the 8%. Fewer than three requirements from a link = read it fresh,
  // bypassing the cache, and overwrite the row. Still nothing = tell the person plainly instead of showing a hollow number.
  const thin = (pp: any) => ((pp?.must_have?.length ?? 0) + (pp?.nice_to_have?.length ?? 0)) < 3;
  let refreshed = false;
  if (body.data.posting_url && thin(posting)) {
    const fresh = await fetchPosting(body.data.posting_url, { bypassCache: true }).catch(() => "");
    if (fresh.length >= 80) {
      const again = await parsePosting(fresh);
      if (!thin(again)) { posting = again; postingText = fresh; parsed = null; refreshed = true; if (postingId) await db.from("postings").update({ raw_text: fresh }).eq("id", postingId); }
    }
    if (thin(posting)) return c.json({ error: "We couldn’t read the requirements on that page. Open the job, copy everything on it, and paste the description instead — no shot is used." }, 400);
  }
  if (postingId && !parsed) await db.from("postings").update({ company: posting.company, title: posting.title, parsed: posting }).eq("id", postingId);
  // the upload is the very document we delivered for this posting: the number is the one it was delivered with, nothing is re-scored
  {
    const own = await ownDocumentFor(u.id, resume.parsed, postingId, posting).catch(() => null);
    if (own) return c.json({ already: own, prior_shot: own, preview_id: null, posting_id: postingId, posting: { company: posting.company, title: posting.title, location: posting.location },
      score_before: own.after, score_after: own.after, band: "high", reachable: own.after, can_lift: false, floor_shown: own.after, similar_open: 0,
      counts: { said: 0, unsaid: 0, buried: 0, missing: 0, total: 0 }, changes: [], reasons: [], matches: [], fits: null, gaps: [], roles: [] });
  }
  // The same résumé against the same posting is the same fit: the first read is kept and returned again, to the digit, for 30
  // days or until the résumé changes. A number that moved between two looks at one posting was never a promise.
  const since = new Date(Date.now() - 30 * 86400e3).toISOString();
  const { data: prior } = postingId
    ? await db.from("previews").select("id, matches, posting").eq("user_id", u.id).eq("resume_id", resume.id).eq("posting_id", postingId).order("created_at", { ascending: false }).limit(1).maybeSingle()
    : { data: null };
  // The number is holy: once this résumé has been matched against this posting, the stored result is what the user sees,
  // every time, whatever the engine does later. An engine change applies to pairs scored after it, never to one already shown.
  let matches: Match[], fits: string | null, previewId: string | null;   // matches may gain options below
  const similar_open = await similarOpen(posting.title);
  // a prior read with fewer than three requirements was a hollow page, not a fit: never replay it
  const priorUsable = !refreshed && !!prior?.matches && (prior.matches as Match[]).length >= 3 && !thin((prior as any).posting);
  if (priorUsable) { matches = prior!.matches as Match[]; fits = null; previewId = prior!.id; }
  else {
    // Radar already paid for this pair: its match (same engine, same résumé) is the match — nothing is scored twice
    const fromRadar = await radarMatchesFor(u.id, resume.id, body.data.posting_url ?? "").catch(() => null);
    const g = fromRadar ? { matches: fromRadar, fits: null as string | null } : await withMeter({ tag: "preview", user: u.id }, () => matchAndGrade(resume.parsed as ResumeProfile, posting));
    matches = g.matches; fits = g.fits ?? null;
    // what they told us on earlier postings answers the same question here, before they are asked again
    try { const bank = await recallAnswers(u.id); const re = applyRemembered(matches, bank); if (re.n) { matches = re.matches; console.error("[preview] remembered answers applied", re.n); } } catch {}
    matches = flagOwnership(matches);   // the ownership question, only for an ambiguous must-have
    const a0 = assess(matches);
    // remember this exact match so the paid run scores against the same list the user saw
    const { data: pv } = await db.from("previews").insert({ user_id: u.id, resume_id: resume.id, posting_id: postingId, posting_text: postingText, posting: { ...posting, __engine: ENGINE_VERSION }, matches, score_before: a0.current, score_after: a0.promised }).select("id").single();
    previewId = pv?.id ?? null;
  }
  // "things we couldn't see": the three tap-able ways of having done each missing requirement, made once and kept
  if (previewId && matches.some((m) => (m.bucket === "missing" || (m as any).ownership_asked) && !m.options?.length)) {
    try { const withOpts = await fillOptions(matches); if (withOpts !== matches) { matches = withOpts; await db.from("previews").update({ matches }).eq("id", previewId); } } catch { /* the page works without options; the card falls back to "say it my way" */ }
  }
  const roles = ((resume.parsed as ResumeProfile).roles ?? []).map((r) => ({ company: r.company, start: r.start, end: r.end })).slice(0, 8);
  const a = assess(matches);
  const pv = { id: previewId };
  // already sharpened: the same résumé on this posting has a delivered document. The page offers to open it (free) or sharpen anyway (a real shot).
  let prior_shot: { id: string; at: string; before: number; after: number } | null = null;
  if (previewId) {
    const { data: ps } = await db.from("shots").select("id, done_at, output").eq("user_id", u.id).eq("status", "done").contains("input", { preview_id: previewId }).order("done_at", { ascending: false }).limit(1).maybeSingle();
    if (ps?.output && (ps.output as any).pdf_path) prior_shot = { id: ps.id, at: ps.done_at, before: (ps.output as any).before, after: Math.min(97, (ps.output as any).after) };
  }
  // the change list: what's unsaid (we can say it), what's buried (a keyword only), what's missing (we won't claim it)
  const unsaid = matches.filter((m) => m.bucket === "have_not_said" && !m.told && m.evidence_kind !== "keyword");
  const buried = matches.filter((m) => m.bucket === "have_not_said" && !m.told && m.evidence_kind === "keyword");
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
    score_before: a.current, score_after: a.promised, band: a.band, reachable: a.reachable, can_lift: a.can_lift, floor_shown: a.floor_shown,
    counts: { said: matches.filter((m) => m.bucket === "said").length, unsaid: unsaid.length, buried: buried.length, missing: matches.filter((m) => m.bucket === "missing" || m.told).length, total: matches.length },
    changes, reasons, matches, fits: fits ?? null, gaps: gapsOf(matches), roles, prior_shot });
});


/** "Things we couldn't see": the candidate answers one missing requirement in a line. Vetted; accepted answers live on the
 *  preview, so the same pair shows the same questions and answers every time, and the promise is recomputed from the same
 *  scorer. Today's number never moves (a told fact earns nothing until it is in the document); only the promise does. */
preview.post("/:id/answer", async (c) => {
  const u = c.get("user");
  const id = c.req.param("id");
  const body = z.object({
    requirement: z.string().min(2), withdraw: z.boolean().optional(),
    what: z.string().max(200).optional(), where: z.string().max(80).optional(), when: z.string().max(40).optional(), size: z.string().max(30).optional(), unit: z.string().max(30).optional(), free: z.string().max(600).optional(),
  }).safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
  const { data: pv } = await db.from("previews").select("id, resume_id, matches").eq("id", id).eq("user_id", u.id).maybeSingle();
  if (!pv?.matches) return c.json({ error: "That fit check has expired. Run it again." }, 404);
  const matches = pv.matches as Match[];
  // an ownership question is asked about a requirement the résumé already shows, so it is not "missing": it is answerable too
  const m = matches.find((x) => x.requirement === body.data.requirement && (x.bucket === "missing" || x.told || (x as any).ownership_asked));
  if (!m) return c.json({ error: "That isn’t one of the things we couldn’t see." }, 400);
  let next: Match[];
  if (body.data.withdraw) next = withdrawFrom(matches, m.requirement);
  else {
    const f = body.data as Facts;
    // their words, or their taps. Nothing is refused: what goes in is theirs to stand behind.
    const line = f.free?.trim() ? await shapeFree(m.requirement, f.free) : (f.what?.trim() ? assembleLine(f) : "");
    if (!line) return c.json({ error: "Pick one of the three, or say it your way." }, 400);
    const facts = f.free?.trim() ? f.free.trim() : [f.what, f.where && `at ${f.where}`, f.when, f.size && `${f.size} ${f.unit ?? ""}`.trim()].filter(Boolean).join(" · ");
    next = acceptInto(matches, m.requirement, facts, line);
  }
  const a = assess(next);
  await db.from("previews").update({ matches: next, score_after: a.promised }).eq("id", pv.id);
  // the answers bank: remembered on the account for every later posting; taken out when withdrawn
  try {
    const now = next.find((x) => x.requirement === m.requirement);
    if (body.data.withdraw) await forgetAnswer(u.id, m.requirement);
    else if (now?.told && now.line) await rememberAnswer(u.id, { requirement: m.requirement, fact: now.evidence, line: now.line });
  } catch (e) { console.error("[preview] answers bank", (e as Error).message); }
  return c.json({ ok: true, line: next.find((x) => x.requirement === m.requirement)?.line ?? null, score_before: a.current, score_after: a.promised, can_lift: a.can_lift, floor_shown: a.floor_shown, gaps: gapsOf(next) });
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
