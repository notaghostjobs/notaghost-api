// Orchestrates the ghost check. Rule: a posting's score only changes when a FACT changes, and every change is logged.
import { db } from "../../lib/db.js";
import { readPosting, extractFacts, daysFromText } from "./read.js";
import { findAts, matchTitle } from "./ats.js";
import { research } from "./research.js";
import { score } from "./score.js";
import { jobKey, strip, companyKey, fingerprint, hamming } from "./canon.js";
import type { PostingFacts, Scored } from "./types.js";

const DAY = 86400e3;
const TTL = { ats: 7 * DAY, boards: 7 * DAY, news: 7 * DAY, size: 30 * DAY, recheck: 7 * DAY, userRecheck: 1 * DAY };

export interface CheckResult extends Scored {
  posting_id: string; job_key: string; link: string; title: string; company: string; location: string;
  scored_at: string; history: { at: string; score: number; verdict: string; why: string }[]; note: string; fresh: boolean;
}

/** Check a link (or pasted text). Returns the stored score if it's current; computes and stores otherwise. */
export async function ghostCheck(input: { url?: string; text?: string }, opts: { force?: boolean } = {}): Promise<CheckResult> {
  const url = input.url ? (/^https?:\/\//i.test(input.url) ? input.url.trim() : `https://${input.url.trim()}`) : null;
  const key = url ? jobKey(url).key : `text:${fingerprint(input.text ?? "").slice(0, 24)}`;

  // 1. existing, current score → return as-is (this is the stability rule)
  const { data: existing } = await db.from("postings").select("*").eq("job_key", key).maybeSingle();
  if (existing?.scored_at && !opts.force) {
    const age = Date.now() - new Date(existing.scored_at).getTime();
    if (age < TTL.userRecheck || (existing.next_check && new Date(existing.next_check).getTime() > Date.now())) {
      await db.from("postings").update({ checks: (existing.checks ?? 0) + 1 }).eq("id", existing.id);
      return present(existing, false);
    }
  }

  // 2. read the posting (facts layer A)
  const raw = url ? await readPosting(url) : { text: input.text!, source: "pasted" as const };
  const a = await extractFacts(raw, url ?? "pasted");
  const facts: PostingFacts = { ...a, read_at: new Date().toISOString(), source: raw.source, url: url ?? "", job_key: key, description: raw.text.slice(0, 20000) };
  if (facts.posted_days == null && facts.posted_text) facts.posted_days = daysFromText(facts.posted_text);
  const ckey = companyKey(facts.company || "");
  const fp = fingerprint(facts.description);

  // upsert the posting row early so observations can attach
  const row = existing ?? (await db.from("postings").insert({ job_key: key, url: url ? strip(url) : null, url_hash: key, source: raw.source, raw_text: raw.text, company: facts.company, title: facts.title, company_key: ckey, fingerprint: fp }).select("*").single()).data!;
  if (!existing) await db.from("observations").insert({ posting_id: row.id, present: true, posted_text: facts.posted_text, applicants: facts.applicants, hash: fp });

  // 3. same text under other companies (signal 7) — our own index
  if (ckey) {
    const { data: sims } = await db.from("postings").select("company_key, fingerprint").neq("company_key", ckey).not("fingerprint", "is", null).limit(2000);
    facts.same_text_companies = [...new Set((sims ?? []).filter((s) => s.fingerprint && hamming(s.fingerprint, fp) <= 16).map((s) => s.company_key as string))].slice(0, 5);
  }

  // 4. company-level facts, cached (layers B, C, D) — all in parallel
  if (ckey) {
    const company = await loadCompany(ckey, facts.company);
    const stale = (t?: string | null, ttl = DAY) => !t || Date.now() - new Date(t).getTime() > ttl;
    const [ats, boards, news, size] = await Promise.all([
      stale(company.ats_checked, TTL.ats) ? findAts(facts.company, raw.apply_url ?? null, company.domain).catch(() => null) : null,
      stale(company.research?.[titleKey(facts.title)]?.checked_at, TTL.boards) ? research.boards(facts.company, facts.title, facts.location).catch(() => null) : null,
      stale(company.news?.checked_at, TTL.news) ? research.news(facts.company).catch(() => null) : null,
      stale(company.size_checked, TTL.size) ? research.size(facts.company).catch(() => null) : null,
    ]);
    const now = new Date().toISOString();
    const patch: any = { name: facts.company, updated_at: now };
    if (ats) { patch.ats = ats.system; patch.ats_slug = ats.slug; patch.careers_url = ats.careers_url; patch.ats_jobs = ats.jobs; patch.ats_checked = now; Object.assign(company, patch); }
    if (boards) { company.research = { ...(company.research ?? {}), [titleKey(facts.title)]: { ...boards, checked_at: now } }; patch.research = company.research; }
    if (news) { company.news = { ...news, checked_at: now }; patch.news = company.news; }
    if (size) { company.headcount = size.headcount; company.openings = size.openings ?? company.openings; company.size_checked = now; patch.headcount = size.headcount; patch.openings = company.openings; patch.size_checked = now; }
    await db.from("companies").upsert({ key: ckey, ...patch }, { onConflict: "key" });

    // B
    if (company.ats && company.ats !== "unknown") {
      const jobs = (company.ats_jobs ?? []) as any[];
      const { best, copies } = matchTitle(facts.title, jobs);
      const reopened = best ? await reqReopened(row.id, best.id) : false;
      facts.ats = { system: company.ats, found: !!best || company.ats === "careers" && jobs.length === 0 && false, created_at: best?.created_at ?? null, updated_at: best?.updated_at ?? null, copies, req_id: best?.id ?? null, req_reopened: reopened, careers_url: company.careers_url };
      if (company.ats === "none") facts.ats.found = false;
      if (jobs.length && company.openings == null) company.openings = jobs.length;
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
    facts.headcount = company.headcount ?? null; facts.openings = company.openings ?? null;
    // E (22)
    facts.reply_rate = await replyRate(ckey);
  }
  // E (21)
  facts.observation = await observation(row.id, facts);

  // 5. score (pure) and store, with history
  const s = score(facts);
  const prev = existing?.score;
  const why = existing?.scored_at ? diffWhy(existing.signals ?? [], s.signals) : "first check";
  const history = [...(existing?.history ?? [])];
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
    score: row.score ?? 0, verdict: row.verdict ?? "Can’t verify", signals: row.signals ?? [], headline: g.headline ?? "", body: g.body ?? "", adviceLabel: g.adviceLabel ?? "", advice: g.advice ?? "",
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
