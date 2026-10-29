// Orchestrates the ghost check. Rule: a posting's score only changes when a FACT changes, and every change is logged.
import { db } from "../../lib/db.js";
import { readPosting, extractFacts, extractFactsRules, daysFromText } from "./read.js";
import { findAts, matchTitle } from "./ats.js";
import { research } from "./research.js";
import { score } from "./score.js";
import { readerFacts } from "./reader.js";
import { jobKey, strip, companyKey, fingerprint, hamming, stripFurniture, CLEAN_SINCE, FULL_LIST_SINCE } from "./canon.js";
import type { PostingFacts, Scored } from "./types.js";

const DAY = 86400e3;
const TTL = { ats: 7 * DAY, boards: 7 * DAY, news: 7 * DAY, size: 30 * DAY, recheck: 7 * DAY, userRecheck: 1 * DAY };

export interface CheckResult extends Scored {
  flags: number; checks_run: number; clear: number;
  posting_id: string; job_key: string; link: string; title: string; company: string; location: string;
  scored_at: string; history: { at: string; score: number; verdict: string; why: string }[]; note: string; fresh: boolean;
}

/**
 * One row per view. The extension hands us what the board showed the user today — applicant count, "posted" text, whether the
 * board says it's closed — and that series (not the first view alone) is where applicants-per-day and board-closed dates come from.
 */
async function observe(postingId: string, page: { posted_text?: string; applicants?: number; closed?: boolean; source?: string } | undefined, extra: { posted_text?: string | null; applicants?: number | null; hash?: string } = {}) {
  if (!page && !extra.hash) return;
  const closed = page?.closed === true;
  const row: Record<string, unknown> = { posting_id: postingId, present: !closed, posted_text: page?.posted_text ?? extra.posted_text ?? null, applicants: page?.applicants ?? extra.applicants ?? null, hash: extra.hash ?? null, status: closed ? "closed" : "open", source: page?.source ?? (page ? "extension" : "site") };
  let { error } = await db.from("observations").insert(row);
  if (error && /column/i.test(error.message)) { delete row.status; delete row.source; ({ error } = await db.from("observations").insert(row)); }  // before migration 0009
  if (error) console.error("[check] observe", error.message);
  if (closed) {
    const { error: e2 } = await db.from("postings").update({ closed_at: new Date().toISOString() }).eq("id", postingId).is("closed_at", null);
    if (e2 && !/column/i.test(e2.message)) console.error("[check] closed", e2.message);
  }
}

/** Check a link (or pasted text). Returns the stored score if it's current; computes and stores otherwise. */
export async function ghostCheck(input: { url?: string; text?: string; page?: { title?: string; company?: string; location?: string; posted_text?: string; applicants?: number; apply_url?: string; closed?: boolean; source?: string } }, opts: { force?: boolean; quick?: boolean } = {}): Promise<CheckResult> {
  const url = input.url ? (/^https?:\/\//i.test(input.url) ? input.url.trim() : `https://${input.url.trim()}`) : null;
  const key = url ? jobKey(url).key : `text:${fingerprint(input.text ?? "").slice(0, 24)}`;

  // 1. existing, current score → return as-is (this is the stability rule)
  const { data: existing } = await db.from("postings").select("*").eq("job_key", key).maybeSingle();
  // Every LinkedIn verdict scored before the split-view misread was fixed (extension 0.3.3, 27 Oct 08:20Z) may carry another
  // job's text. Such a row is re-read and re-scored on sight, with its history started afresh — the old entries were wrong.
  const claimsSystem = Array.isArray(existing?.signals) && (existing!.signals as any[]).some((s) => s?.n === 9 && s?.kind === "ok");
  const tainted = (Array.isArray(existing?.signals) && (existing!.signals as any[]).some((s) => s?.n === 7))
    || (existing?.source === "linkedin" && !!existing?.scored_at && existing.scored_at < CLEAN_SINCE)
    || (claimsSystem && !existing?.sighting_id);   // scored before the link was stored: re-score once so the link lands
  // scored before every check became a line: re-score so the card shows the whole list (₹0 — rules and the reader), history kept
  const partial = !!existing?.scored_at && existing.scored_at < FULL_LIST_SINCE;
  if (existing?.scored_at && !opts.force && !tainted && !partial) {
    const age = Date.now() - new Date(existing.scored_at).getTime();
    if (age < TTL.userRecheck || (existing.next_check && new Date(existing.next_check).getTime() > Date.now())) {
      await db.from("postings").update({ checks: (existing.checks ?? 0) + 1 }).eq("id", existing.id);
      await observe(existing.id, input.page);
      return present(existing, false);
    }
  }

  // 2. read the posting (facts layer A)
  // a URL with the page text already supplied (the extension) is read as-is; a bare URL is fetched; bare text is "pasted"
  const raw = url && input.text && input.text.length >= 80
    ? { text: input.text, source: jobKey(url).source, title: input.page?.title ?? null, company: input.page?.company ?? null, location: input.page?.location ?? null, posted_text: input.page?.posted_text ?? null, applicants: input.page?.applicants ?? null, apply_url: input.page?.apply_url ?? null, posted_days: daysFromText(input.page?.posted_text ?? null) }
    : url ? await readPosting(url) : { text: input.text!, source: "pasted" as const };
  raw.text = stripFurniture(raw.text);   // the job, not the job board's panels around it
  // a page that gave us no posting (board furniture, a collapsed pane, a login wall) gets no verdict — a score here would be about nothing
  // the description is everything after "About the job" (LinkedIn) or after the header block (others); the whole text as a fallback
  const about = raw.text.search(/about the (job|role|position)/i);
  const body = about >= 0 ? raw.text.slice(about) : raw.text.split("\n\n").slice(1).join("\n\n") || raw.text;
  if (body.trim().length < 200 && raw.text.trim().length < 600) throw Object.assign(new Error("Couldn’t read the posting on this page. Open the job in its own tab, or paste the posting text."), { status: 422 });
  // quick = the ₹0 reading: rules + the reader, no model, no web research. The default for every free check.
  const quick = opts.quick !== false;
  const a = quick ? extractFactsRules(raw, url ?? "pasted") : await extractFacts(raw, url ?? "pasted");
  const facts: PostingFacts = { ...a, read_at: new Date().toISOString(), source: raw.source, url: url ?? "", job_key: key, description: raw.text.slice(0, 20000) };
  if (facts.posted_days == null && facts.posted_text) facts.posted_days = daysFromText(facts.posted_text);
  const ckey = companyKey(facts.company || "");
  const fp = fingerprint(facts.description);

  // upsert the posting row early so observations can attach
  const row = existing ?? (await db.from("postings").insert({ job_key: key, url: url ? strip(url) : null, url_hash: key, source: raw.source, raw_text: raw.text, company: facts.company, title: facts.title, company_key: ckey, fingerprint: fp }).select("*").single()).data!;
  await observe(row.id, input.page, { posted_text: facts.posted_text, applicants: facts.applicants, hash: fp });

  // 3. same text under other companies (signal 7) — our own index
  if (ckey) {
    const { data: sims } = await db.from("postings").select("company_key, fingerprint").neq("company_key", ckey).not("fingerprint", "is", null).limit(2000);
    const same = [...new Set((sims ?? []).filter((s) => s.fingerprint && hamming(s.fingerprint, fp) <= 16).map((s) => s.company_key as string))];
    // a text shared by a handful of employers is an agency's; one shared by many is the job board's own furniture leaking through — not a signal
    facts.same_text_companies = same.length > 8 ? [] : same.slice(0, 5);
  }

  // 4. company-level facts. Layer B comes from the reader (free). Research (paid, cached per company) runs only where the reader cannot answer.
  if (ckey) {
    const rf = await readerFacts(ckey, facts.company, facts.title, url);
    facts.reader = { known: rf.known, system: rf.system, blr_openings: rf.blr_openings, live: rf.live, by_url: rf.by_url, evidence: rf.evidence };
    // the board posting ↔ the role on the employer's own system: kept, with both dates, so "seen on the system N days before the board" is measurable
    if (rf.ats?.found && rf.ats.req_id) {
      const link = { sighting_source: rf.ats.system, sighting_id: rf.ats.req_id, system_first_seen: rf.ats.created_at, system_linked_at: existing?.system_linked_at ?? new Date().toISOString() };
      const { error } = await db.from("postings").update(link).eq("id", row.id);
      if (error && !/column/i.test(error.message)) console.error("[check] link", error.message);
    }
    const company = await loadCompany(ckey, facts.company);
    const stale = (t?: string | null, ttl = DAY) => !t || Date.now() - new Date(t).getTime() > ttl;
    const readable = !!rf.ats;                                                                    // the employer's own system, read by us
    const confirmedFresh = readable && rf.ats!.found && !!rf.ats!.created_at && (Date.now() - new Date(rf.ats!.created_at).getTime()) / DAY <= 30;
    const [ats, boards, news] = await Promise.all([
      // own-system detection by probing: only for companies the reader does not know at all (free, http only)
      !rf.known && stale(company.ats_checked, TTL.ats) ? findAts(facts.company, raw.apply_url ?? null, company.domain).catch(() => null) : null,
      // boards research (≈ ₹3–5, cached 7 days per company+title): skipped when the employer's own system confirms a fresh posting
      !quick && !confirmedFresh && stale(company.research?.[titleKey(facts.title)]?.checked_at, TTL.boards) ? research.boards(facts.company, facts.title, facts.location).catch(() => null) : null,
      // news (≈ ₹3, cached 7 days): only when the reader could not confirm the role on the company's own system
      !quick && !(readable && rf.ats!.found) && stale(company.news?.checked_at, TTL.news) ? research.news(facts.company).catch(() => null) : null,
    ]);
    const now = new Date().toISOString();
    const patch: any = { name: facts.company, updated_at: now };
    if (ats) { patch.ats = ats.system; patch.ats_slug = ats.slug; patch.careers_url = ats.careers_url; patch.ats_jobs = ats.jobs; patch.ats_checked = now; Object.assign(company, patch); }
    if (boards) { company.research = { ...(company.research ?? {}), [titleKey(facts.title)]: { ...boards, checked_at: now } }; patch.research = company.research; }
    if (news) { company.news = { ...news, checked_at: now }; patch.news = company.news; }
    await db.from("companies").upsert({ key: ckey, ...patch }, { onConflict: "key" });

    // B
    if (readable) facts.ats = rf.ats!;
    else if (rf.system === "none") facts.ats = { system: "none", found: false, created_at: null, updated_at: null, copies: 0, req_id: null, req_reopened: false, careers_url: null };
    else if (company.ats && company.ats !== "unknown") {
      const jobs = (company.ats_jobs ?? []) as any[];
      const { best, copies } = matchTitle(facts.title, jobs);
      facts.ats = { system: company.ats, found: !!best, created_at: best?.created_at ?? null, updated_at: best?.updated_at ?? null, copies, req_id: best?.id ?? null, req_reopened: false, careers_url: company.careers_url };
      if (company.ats === "none") facts.ats.found = false;
    } else facts.ats = { system: "unknown", found: false, created_at: null, updated_at: null, copies: 0, req_id: null, req_reopened: false, careers_url: null };
    // C
    const br = company.research?.[titleKey(facts.title)];
    if (br) {
      const days = br.listings.map((l: any) => l.posted_days).filter((d: any) => d != null) as number[];
      facts.boards = { listings: br.listings, distinct_dates: new Set(days.map((d) => Math.round(d / 3))).size, oldest_days: days.length ? Math.max(...days) : null, never_heard_back: !!br.never_heard_back, checked_at: br.checked_at };
      if (br.agency_posts >= 1 && !facts.agency && br.listings.length && br.agency_posts >= br.listings.length) facts.agency = true;
    }
    // D
    if (company.news) facts.company_news = company.news;
    facts.headcount = company.headcount ?? null; facts.openings = rf.openings ?? company.openings ?? null;
    // E (22)
    facts.reply_rate = await replyRate(ckey);
  }
  // E (21)
  facts.observation = await observation(row.id, facts);

  // 5. score (pure) and store, with history
  const s = score(facts);
  const prev = existing?.score;
  const why = existing?.scored_at ? diffWhy(existing.signals ?? [], s.signals) : "first check";
  const history = tainted ? [] : [...(existing?.history ?? [])];
  if (!existing?.scored_at || prev !== s.score || existing.verdict !== s.verdict) history.push({ at: new Date().toISOString(), score: s.score, verdict: s.verdict, why });
  await db.from("postings").update({
    company: facts.company, title: facts.title, company_key: ckey, fingerprint: fp, raw_text: raw.text,
    facts, signals: s.signals, score: s.score, verdict: s.verdict, scored_at: new Date().toISOString(),
    next_check: new Date(Date.now() + TTL.recheck).toISOString(), history, checks: (existing?.checks ?? 0) + 1,
    ghost: { ...s, title: facts.title, company: facts.company, location: facts.location, checked_at: new Date().toISOString() },
  }).eq("id", row.id);
  const { data: updated } = await db.from("postings").select("*").eq("id", row.id).single();
  return present(updated!, true);
}

function present(row: any, fresh: boolean): CheckResult {
  const g = row.ghost ?? {};
  return { posting_id: row.id, job_key: row.job_key, link: (row.url ?? "").replace(/^https?:\/\//, ""), title: row.title ?? g.title ?? "", company: row.company ?? "", location: g.location ?? "",
    score: row.score ?? 0, verdict: row.verdict === "Can’t verify" ? "Caution" : row.verdict === "Scam" ? "Ghost" : (row.verdict ?? "Caution"), signals: row.signals ?? [],
    // the count the card shows: flags raised over checks run. A flag is a fired signal that counts against the posting.
    flags: (row.signals ?? []).filter((x: any) => x?.kind === "bad").length, checks_run: (row.signals ?? []).filter((x: any) => x?.kind && x.kind !== "na").length, clear: (row.signals ?? []).filter((x: any) => x?.kind === "ok").length,
    headline: g.headline ?? "", body: g.body ?? "", adviceLabel: g.adviceLabel ?? "", advice: g.advice ?? "",
    checked: g.checked ?? 0, coverage: g.coverage ?? "", scored_at: row.scored_at, history: row.history ?? [], fresh,
    note: "Scores change only when a fact changes — a repost, a careers-page update, company news, or what members report. Re-checked weekly." };
}

async function loadCompany(key: string, name: string): Promise<any> {
  const { data } = await db.from("companies").select("*").eq("key", key).maybeSingle();
  return data ?? { key, name, research: {}, ats: null };
}
const titleKey = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);

async function reqReopened(postingId: string, reqId: string) {
  // seen absent then present again for the same req → reopened
  const { data } = await db.from("observations").select("present").eq("posting_id", postingId).order("seen_at", { ascending: true }).limit(200);
  const seq = (data ?? []).map((o) => o.present);
  let wasAbsent = false; for (const p of seq) { if (!p) wasAbsent = true; else if (wasAbsent) return true; }
  return false && reqId;
}
async function observation(postingId: string, facts: PostingFacts) {
  const { data } = await db.from("observations").select("seen_at, present, posted_text").eq("posting_id", postingId).order("seen_at", { ascending: true }).limit(400);
  const obs = data ?? [];
  if (!obs.length) return undefined;
  const first = obs[0].seen_at; const daysSeen = Math.floor((Date.now() - new Date(first).getTime()) / DAY);
  let vanished = false, returned = false; for (const o of obs) { if (!o.present) vanished = true; else if (vanished) returned = true; }
  const gap = facts.posted_days != null && daysSeen - facts.posted_days >= 0 ? daysSeen - facts.posted_days : null;
  return { first_seen: first, days_seen: daysSeen, vanished_and_returned: returned, claimed_vs_seen_gap_days: gap };
}
async function replyRate(ckey: string) {
  const { data } = await db.from("outcomes").select("status").eq("company_key", ckey).limit(2000);
  const rows = data ?? []; const applied = rows.length; const replied = rows.filter((r) => ["replied", "interview", "offer", "rejected"].includes(r.status)).length;
  return { applied, replied, rate: applied ? replied / applied : null };
}
function diffWhy(before: any[], after: any[]) {
  const b = new Set(before.filter((s) => s.pts > 0).map((s) => s.n)), a = new Set(after.filter((s) => s.pts > 0).map((s) => s.n));
  const added = after.filter((s) => s.pts > 0 && !b.has(s.n)).map((s) => s.text.replace(/\s—$/, "")), removed = before.filter((s) => s.pts > 0 && !a.has(s.n)).map((s) => s.text.replace(/\s—$/, ""));
  return [added.length ? `new: ${added.join("; ")}` : "", removed.length ? `cleared: ${removed.join("; ")}` : ""].filter(Boolean).join(" · ") || "re-checked, no change";
}

/** Daily snapshot: re-read every posting due, record presence, re-score only if a fact moved. */
export async function snapshotDue(limit = 200) {
  const { data: due } = await db.from("postings").select("id, url, job_key, next_check, facts").not("url", "is", null).lte("next_check", new Date().toISOString()).order("next_check", { ascending: true }).limit(limit);
  let n = 0;
  for (const p of due ?? []) {
    try {
      const raw = await readPosting(p.url);
      await db.from("observations").insert({ posting_id: p.id, present: true, posted_text: raw.posted_text ?? null, applicants: raw.applicants ?? null, hash: fingerprint(raw.text) });
      await ghostCheck({ url: p.url }, { force: true });
    } catch (e) {
      const gone = (e as any).status === 422 || /404|410/.test(String(e));
      await db.from("observations").insert({ posting_id: p.id, present: !gone, posted_text: null, applicants: null, hash: null });
      await db.from("postings").update({ next_check: new Date(Date.now() + TTL.recheck).toISOString() }).eq("id", p.id);
    }
    n++;
  }
  return n;
}
