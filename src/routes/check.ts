import { Hono } from "hono";
import { z } from "zod";
import { createHash } from "node:crypto";
import { db } from "../lib/db.js";
import { fetchPosting } from "../engine/extract.js";
import { json, FAST } from "../engine/claude.js";

export const check = new Hono();

type Kind = "ok" | "bad" | "warn" | "na";
type Signal = { kind: Kind; text: string; strong?: string; tail?: string; pts: number };

interface Read {
  title: string; company: string; location: string;
  posted: string | null;            // as written, e.g. "1 month ago", "Posted 12 Oct 2026"
  posted_days: number | null;       // best estimate in days, null if unknown
  applicants: number | null;        // as written, null if unknown
  salary_present: boolean;
  description_words: number;
  generic: boolean;                 // JD is boilerplate / could be any company
  evergreen: boolean;               // "always hiring", "talent pool", "future opportunities", multiple locations/levels
  urgency: boolean;                 // "urgent", "immediate joiners"
  contact_present: boolean;         // a named recruiter / hiring manager or team email
  requirements_count: number;
}

const ATS = /greenhouse\.io|lever\.co|myworkdayjobs|workday|ashbyhq|smartrecruiters|darwinbox|keka|zohorecruit|bamboohr|icims|taleo|successfactors|jobvite|recruitee|freshteam/i;
const BOARD = /linkedin\.com|naukri\.com|indeed\.|foundit|shine\.com|glassdoor|instahyre|cutshort|hirist|iimjobs|wellfound|internshala|apna\.co/i;

/**
 * v1 ghost check. Layer 1 (the posting) + what our own table knows (first seen).
 * Verdicts are deliberately conservative: "Can't verify" is the default.
 */
check.post("/", async (c) => {
  const body = z.object({ url: z.string().url() }).safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "Paste a job link." }, 400);
  const url = body.data.url.trim();
  const url_hash = createHash("sha256").update(url.toLowerCase()).digest("hex");

  // cache: our own first-seen is a real signal once we've seen a posting before
  const { data: cached } = await db.from("postings").select("id, raw_text, first_seen_at, ghost").eq("url_hash", url_hash).maybeSingle();
  if (cached?.ghost && Date.now() - new Date((cached.ghost as any).checked_at).getTime() < 6 * 3600e3) return c.json(cached.ghost);

  let text: string;
  try { text = cached?.raw_text ?? (await fetchPosting(url)); }
  catch {
    return c.json(verdict(url, null, [{ kind: "na", text: "Couldn’t open this link — the site blocks automated reading. Paste the posting text on the next step and we’ll read it there.", pts: 0 }], null));
  }
  if (!cached) await db.from("postings").insert({ url, url_hash, raw_text: text, source: BOARD.test(url) ? "board" : ATS.test(url) ? "ats" : "careers" }).select("id").maybeSingle();

  const r = await json<Read>(
    `You read a job posting page (text extracted from HTML, may include navigation noise) and report only what is literally present. Never guess. posted_days: convert phrases like "1 month ago" to days (30), "3 weeks ago" (21), "Reposted 2 days ago" (2); null if not stated. applicants: the number if shown ("Over 100 applicants" -> 100), else null. generic = true only if the description could apply to any company (no product, team, or specifics named). evergreen = true if it says always hiring / talent pool / future opportunities / many locations or levels in one posting. Keep strings short.`,
    `URL: ${url}\n\nPAGE TEXT:\n${text.slice(0, 12000)}\n\nReturn: {title, company, location, posted, posted_days, applicants, salary_present, description_words, generic, evergreen, urgency, contact_present, requirements_count}`,
    1200, FAST
  );

  const sig: Signal[] = [];
  // where it lives
  if (ATS.test(url)) sig.push({ kind: "ok", text: "Posted through the company’s own hiring system", pts: 0 });
  else if (BOARD.test(url)) sig.push({ kind: "warn", text: "Read from a job board —", strong: "not yet checked against the company’s own site", pts: 4 });
  else sig.push({ kind: "ok", text: "On the company’s own site", pts: 0 });
  // age
  if (r.posted_days == null) sig.push({ kind: "na", text: "Posting date not shown", pts: 0 });
  else if (r.posted_days >= 45) sig.push({ kind: "bad", text: "Posted", strong: r.posted ?? `${r.posted_days} days ago`, tail: "— older than 45 days", pts: 8 });
  else if (r.posted_days >= 21) sig.push({ kind: "warn", text: "Posted", strong: r.posted ?? `${r.posted_days} days ago`, pts: 4 });
  else sig.push({ kind: "ok", text: "Posted", strong: r.posted ?? `${r.posted_days} days ago`, pts: 0 });
  // our own first-seen
  if (cached?.first_seen_at) {
    const days = Math.floor((Date.now() - new Date(cached.first_seen_at).getTime()) / 86400e3);
    if (r.posted_days != null && days - r.posted_days >= 14) sig.push({ kind: "bad", text: "We first saw this", strong: `${days} days ago`, tail: `— the page says ${r.posted ?? "newer"}`, pts: 15 });
  }
  // applicants
  if (r.applicants != null) sig.push({ kind: r.applicants >= 200 ? "warn" : "ok", text: `${r.applicants}+ applicants shown`, pts: r.applicants >= 200 ? 4 : 0 });
  // pay
  sig.push(r.salary_present ? { kind: "ok", text: "Pay figure shown", pts: 0 } : { kind: "warn", text: "No pay figure anywhere in the posting", pts: 4 });
  // text quality
  if (r.generic) sig.push({ kind: "bad", text: "Description is boilerplate —", strong: "no team, product or specifics named", pts: 8 });
  if (r.evergreen) sig.push({ kind: "bad", text: "Reads as an evergreen / talent-pool posting", pts: 8 });
  if (r.urgency) sig.push({ kind: "warn", text: "Uses urgency language (“urgent”, “immediate joiners”)", pts: 4 });
  if (r.contact_present) sig.push({ kind: "ok", text: "A named contact or team address is given", pts: 0 });

  const out = verdict(url, r, sig, cached?.id ?? null);
  if (cached?.id) await db.from("postings").update({ company: r.company, title: r.title, ghost: out }).eq("id", cached.id);
  return c.json(out);
});

function verdict(url: string, r: Read | null, signals: Signal[], posting_id: string | null) {
  const score = Math.min(100, signals.reduce((a, s) => a + s.pts, 0));
  const strong = signals.some((s) => s.pts >= 15);
  const checked = signals.filter((s) => s.kind !== "na").length;
  let word: "Ghost" | "Caution" | "Looks real" | "Can’t verify";
  let headline: string, body: string, adviceLabel: string, advice: string;
  if (!r || checked < 3) {
    word = "Can’t verify";
    headline = "Not enough to call it.";
    body = "We could only read part of this posting. That isn’t a mark against it — it means we don’t know yet.";
    adviceLabel = "What we’d do:"; advice = "go ahead, but make sure they can see you — check your résumé against this posting first.";
  } else if (score >= 60 && strong) {
    word = "Ghost";
    headline = "Your chance of hearing back: low.";
    body = "The posting is older than it says it is, and the other signs point the same way. Nobody is likely reading applications here.";
    adviceLabel = "Our advice:"; advice = "don’t spend a shot on the apply button. If you must, find one person on the team and use the message we’ve written.";
  } else if (score >= 25) {
    word = "Caution";
    headline = "Some signs this one may be slow or stale.";
    body = "Nothing here proves it’s fake — but age, silence on pay, or boilerplate text are the things we see on postings that never reply.";
    adviceLabel = "Our advice:"; advice = "apply only with a referral, or sharpen first so you’re not one of the pile.";
  } else {
    word = "Looks real";
    headline = "Worth your shot.";
    body = "Fresh, specific, and nothing in the posting itself points the wrong way. We’ll know more once applications to this company start reporting back.";
    adviceLabel = "Next move:"; advice = "make sure they can see you. Let’s check your résumé against this posting — free.";
  }
  return {
    link: url.replace(/^https?:\/\//, ""), posting_id, checked_at: new Date().toISOString(),
    title: r?.title ?? "", company: r?.company ?? "", location: r?.location ?? "",
    word, isGhost: word === "Ghost", score, signals,
    headline, body, adviceLabel, advice,
    note: "v1: read from the posting itself. Reply rates arrive once applications are tracked.",
  };
}
