import type { PostingFacts, FiredSignal, Scored, Verdict } from "./types.js";

/**
 * The 22 signals, exactly as in the playbook (chapter 01). Pure: same facts → same score.
 * 15 = nearly settles it · 8 = matters, has innocent explanations · 4 = counts only in company.
 */
export function score(f: PostingFacts): Scored {
  const fired: FiredSignal[] = [];
  const ctx: FiredSignal[] = [];           // non-scoring lines that explain what we checked
  let evaluated = 0;
  const bad = (n: number, pts: number, text: string, strong?: string, tail?: string) => fired.push({ n, pts, kind: "bad", text, strong, tail });
  const ok = (n: number, text: string, strong?: string, tail?: string) => ctx.push({ n, pts: 0, kind: "ok", text, strong, tail });
  const na = (n: number, text: string) => ctx.push({ n, pts: 0, kind: "na", text });

  // ---------- A. the posting itself ----------
  evaluated += 7;
  if (!f.pay_stated) bad(1, 8, "No pay band anywhere in the posting"); else ok(1, "Pay band stated");
  if (f.templated) bad(2, 4, "Templated description —", "no team, manager or specifics about the work"); else ok(2, "Describes a specific team and work");
  if (f.locations_count >= 3) bad(3, 4, "Catch-all location —", `${f.locations_count} cities or remote on one posting`);
  if (f.evergreen) bad(4, 8, "Evergreen language —", "“talent community”, “future opportunities”, “always looking”");
  if (f.kitchen_sink) bad(5, 4, "Kitchen-sink requirements —", "unrelated stacks or an unrealistic must-have list");
  if (f.apply_route === "email" || f.apply_route === "dm") bad(6, 8, "Off-system apply route —", f.apply_route === "dm" ? "“DM me” / WhatsApp" : "email your CV to a personal address");
  else if (f.apply_route === "external_form" && f.apply_domain) bad(6, 8, "Apply form on an unrelated domain —", f.apply_domain);
  // signal 7 (same text under other employers) is OFF until the posting index is clean: 27 Oct split-view reads cross-filed
  // text between jobs, and a duplicate check over a polluted index accuses honest postings. Turn back on with SIGNAL7=on.
  if (process.env.SIGNAL7 === "on" && (f.same_text_companies?.length ?? 0) >= 1) bad(7, 4, "Same description posted under", `${f.same_text_companies!.length + 1} employers`, "— agency boilerplate");

  // ---------- B. the company's own hiring system ----------
  if (f.ats && f.ats.system !== "unknown" && f.ats.system !== "none") {
    evaluated += 5;
    if (f.ats.found) {
      ok(9, "On the company’s own hiring system", undefined, f.reader?.blr_openings != null ? `(${f.ats.system}; ${f.reader.blr_openings} Bengaluru roles open there today)` : `(${f.ats.system})`);
      if (f.ats.created_at && f.posted_days != null) {
        const createdDays = daysAgo(f.ats.created_at);
        if (createdDays - f.posted_days >= 30) bad(8, 15, "Created", `${createdDays} days ago`, `in ${f.ats.system} — the page says “${f.posted_text ?? `${f.posted_days} days ago`}”`);
        else ok(8, "Creation date matches the page");
      }
      if (f.ats.copies >= 5) bad(10, 8, "Many copies of one title —", `${f.ats.copies} open “${f.title}” requisitions`);
      if (f.ats.updated_at && daysAgo(f.ats.updated_at) >= 60) bad(11, 8, "Stale in their system —", `not updated in ${daysAgo(f.ats.updated_at)} days`);
      if (f.ats.req_reopened) bad(12, 8, "Same requisition ID closed and reopened");
    } else if (f.reader && f.reader.live >= 20) {
      // we read their system today and it has a real list; the role is simply not there
      bad(9, 15, "Not on the company’s own hiring system —", `${f.reader.blr_openings ?? f.reader.live} roles open there today, this title not among them`, "— listed on boards only");
    } else {
      bad(9, 8, "Not on the company’s own careers page —", "listed on boards only");
    }
  } else if (!f.company) {
    // we never learned who the employer is: say that, and score nothing for it
    na(9, "Couldn’t read the company name on this page");
  } else {
    // nothing of the employer's own to check this posting against: that uncertainty carries weight of its own
    evaluated += 1;
    bad(9, 15, "Not on any hiring system we can read —", "we’ll watch it from here");
  }

  // ---------- C. the job boards ----------
  if (f.boards) {
    evaluated += 5;
    if (f.boards.distinct_dates >= 2) bad(13, 15, "Reposted —", `${f.boards.listings.length} listings with ${f.boards.distinct_dates} different dates`, "across boards");
    const age = Math.max(f.posted_days ?? 0, f.boards.oldest_days ?? 0, f.observation?.days_seen ?? 0);
    if (age > 90) bad(14, 15, "Open for", `${age} days`, "— real Bengaluru roles fill in 3–6 weeks");
    else if (age >= 45) bad(14, 10, "Open for", `${age} days`);
    else if (f.posted_days != null) ok(14, "Posted", f.posted_text ?? `${f.posted_days} days ago`);
    if (f.agency) bad(15, 8, "Posted by an agency —", "“leading client”, employer not named");
    if ((f.applicants ?? 0) >= 200 && age >= 60) bad(16, 4, `${f.applicants}+ applicants and still open after ${age} days`);
    else if (f.applicants != null) ok(16, `${f.applicants}+ applicants`);
    if (f.boards.never_heard_back) bad(17, 4, "Public “never heard back” record —", "reviews cite no response from this company");
  } else {
    // posting-level age still counts even without board research
    evaluated += 2;
    if (f.posted_days != null) {
      if (f.posted_days > 90) bad(14, 15, "Open for", `${f.posted_days} days`);
      else if (f.posted_days >= 45) bad(14, 10, "Open for", `${f.posted_days} days`);
      else ok(14, "Posted", f.posted_text ?? `${f.posted_days} days ago`);
    } else na(14, "Posting date not shown");
    if (f.agency) bad(15, 8, "Posted by an agency —", "employer not named");
  }

  // ---------- D. the company's situation ----------
  if (f.company_news) {
    evaluated += 1;
    if (f.company_news.layoffs_90d || f.company_news.freeze_90d) bad(18, 15, f.company_news.layoffs_90d ? "Layoffs announced in the last 90 days" : "Hiring freeze reported in the last 90 days", undefined, "— and the posting is still live");
    else ok(18, "No layoffs or freeze reported in 90 days");
  }
  if (f.headcount != null && f.openings != null) {
    evaluated += 1;
    if (f.headcount > 0 && f.openings / f.headcount >= 0.5 && f.openings >= 20) bad(19, 8, "Openings out of proportion —", `${f.openings} open roles for ~${f.headcount} employees`);
  }
  evaluated += 1;
  const scam = f.scam_tells.length > 0;
  if (scam) fired.push({ n: 20, pts: 0, kind: "bad", text: "Scam tell —", strong: f.scam_tells[0] });

  // ---------- E. our own observation ----------
  if (f.observation) {
    evaluated += 1;
    if (f.observation.vanished_and_returned) bad(21, 15, "Disappeared, then came back with a fresh date");
    if (f.observation.claimed_vs_seen_gap_days != null && f.observation.claimed_vs_seen_gap_days >= 14)
      bad(8, 15, "We first saw this", `${f.observation.days_seen} days ago`, `— the page says “${f.posted_text}”`);
  }
  if (f.reply_rate && f.reply_rate.applied >= 20) {
    evaluated += 1;
    if ((f.reply_rate.rate ?? 1) < 0.10) bad(22, 15, "Reply rate", `${Math.round((f.reply_rate.rate ?? 0) * 100)}%`, `— from ${f.reply_rate.applied} members who applied to this company`);
    else ok(22, "Reply rate", `${Math.round((f.reply_rate.rate ?? 0) * 100)}%`, `from ${f.reply_rate.applied} members`);
  } else {
    na(22, f.reply_rate?.applied ? `Reply rate: not enough data yet (${f.reply_rate.applied} of 20 members)` : "Reply rate: not enough data yet");
  }

  // de-dupe signal 8 if fired twice (ATS + observation): keep one
  const seen = new Set<number>();
  const uniq = fired.filter((s) => (seen.has(s.n) ? false : (seen.add(s.n), true)));
  const total = Math.min(100, uniq.reduce((a, s) => a + s.pts, 0));
  const has15 = uniq.some((s) => s.pts === 15);

  // Real needs something FOR it, not just little against it: the employer's own system lists the role, or the posting is
  // fresh with nothing worse than one small flag. Two or more flags with no anchor is a Caution, whatever the arithmetic says.
  const anchored = f.ats?.found === true || (f.posted_days != null && f.posted_days <= 30 && uniq.length <= 1);
  let verdict: Verdict;
  if (scam) verdict = "Scam";
  else if (total >= 60 && has15) verdict = "Ghost";
  else if (total >= 25) verdict = "Caution";
  else if (!anchored && uniq.length >= 2) verdict = "Caution";
  else if (total < 25 && f.ats?.found === false && (f.boards?.listings.length ?? 1) <= 1 && evaluated < 14) verdict = "Can’t verify";
  else if (evaluated < 9) verdict = "Can’t verify";
  else verdict = "Real";

  const copy = COPY[verdict](total, uniq, f);
  const signals = [...uniq.sort((a, b) => b.pts - a.pts), ...ctx.filter((c) => c.kind === "ok").slice(0, 3), ...ctx.filter((c) => c.kind === "na").slice(0, 2)];
  return { score: total, verdict, signals, ...copy, checked: evaluated, coverage: `${evaluated} checks ran` };
}

/** Copy is built from the signals that fired — never a template that could contradict the list. */
const COPY: Record<Verdict, (s: number, f: FiredSignal[], p: PostingFacts) => Pick<Scored, "headline" | "body" | "adviceLabel" | "advice">> = {
  Ghost: (s, f) => ({
    headline: "Your chance of hearing back: close to nil.",
    body: `Not because of you. ${sentence(f.filter((x) => x.pts >= 8).slice(0, 3))} Nobody is reading applications here.`,
    adviceLabel: "Our advice:", advice: "don’t spend a shot on the apply button. Check another listing — or, if you must, find one person on the team and use the message we’ve written.",
  }),
  Caution: (s, f) => ({
    headline: "Something’s off.",
    body: `${sentence(f.filter((x) => x.pts > 0).slice(0, 3))} Nothing here proves it’s fake — but these are the things we see on postings that never reply.`,
    adviceLabel: "Our advice:", advice: "apply only with a referral, or sharpen first so you’re not one of the pile.",
  }),
  Real: (s, f, p) => ({
    headline: "Worth your shot.",
    // the anchor leads; at most one caveat, and only a weighty one — the rest stay in the signal list
    body: `${positives(p)}${(() => { const c = f.filter((x) => x.pts >= 8).slice(0, 1); return c.length ? ` One thing to know: ${sentence(c).replace(/^\w/, (ch) => ch.toLowerCase())}` : ""; })()} ${p.ats?.found ? "It’s on the employer’s own system, which is the strongest sign we have." : "Nothing we checked says it’s fake."}`,
    adviceLabel: "Next move:", advice: "make sure they can see you. Let’s check your résumé against this posting — free.",
  }),
  "Can’t verify": (s, f, p) => ({
    headline: "First time we’ve seen this one.",
    body: `${p.ats?.system === "unknown" || p.ats?.system === "none" ? "We can’t find the company’s hiring system" : "We could only read part of this posting"}${f.length ? `, and ${sentence(f).replace(/^\w/, (c) => c.toLowerCase())}` : "."} Here’s what we can tell today; we’ll know more as we watch it.`,
    adviceLabel: "What we’d do:", advice: "go ahead, but make sure they can see you — check your résumé against this posting first.",
  }),
  Scam: (s, f) => ({
    headline: "Don’t apply. Don’t pay.",
    body: `This posting ${f.find((x) => x.n === 20)?.strong ? `shows a scam tell — ${f.find((x) => x.n === 20)!.strong}` : "asks for money or moves you off the company’s own channels"}. Real employers never do that.`,
    adviceLabel: "Our advice:", advice: "close it. If it came from a message, report the sender.",
  }),
};

/** "No pay band shown, not on the company’s careers page yet, and open for 48 days." */
function sentence(sig: FiredSignal[]) {
  const parts = sig.map((x) => phrase(x)).filter(Boolean);
  if (!parts.length) return "";
  const joined = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
  return joined.charAt(0).toUpperCase() + joined.slice(1) + ".";
}
function phrase(x: FiredSignal) {
  switch (x.n) {
    case 1: return "no pay band shown";
    case 2: return "the description is boilerplate";
    case 3: return `it’s open in ${x.strong?.split(" ")[0] ?? "several"} cities at once`;
    case 4: return "it reads like a talent-pool posting";
    case 5: return "the requirements list is a kitchen sink";
    case 6: return "it asks you to apply outside the company’s system";
    case 7: return "the same text appears under other employers";
    case 8: return `it was created ${x.strong ?? "much earlier"} in the company’s system`;
    case 9: return "we couldn’t find it on the company’s own careers page";
    case 10: return `there are ${x.strong?.split(" ")[0] ?? "many"} open copies of this title`;
    case 11: return "it hasn’t been touched in their system for two months";
    case 12: return "the same requisition was closed and reopened";
    case 13: return "it’s been reposted with new dates";
    case 14: return `it’s been open for ${x.strong ?? "a long time"}`;
    case 15: return "it’s posted by an agency, not the employer";
    case 16: return "it has hundreds of applicants and is still open";
    case 17: return "people report never hearing back from this company";
    case 18: return "the company announced layoffs or a freeze recently";
    case 19: return "the company has far more openings than its size suggests";
    case 21: return "it disappeared and came back with a fresh date";
    case 22: return `only ${x.strong ?? "few"} of our members who applied here heard back`;
    default: return "";
  }
}
function positives(p: PostingFacts) {
  const bits: string[] = [];
  if (p.posted_days != null && p.posted_days <= 21) bits.push(`posted ${p.posted_text?.toLowerCase() ?? `${p.posted_days} days ago`}`);
  if (!p.templated) bits.push("describes a specific team");
  if (p.pay_stated) bits.push("pay stated");
  if (p.ats?.found) bits.unshift(`on ${p.company || "the company"}’s own hiring system${p.ats.created_at ? ` since ${new Date(p.ats.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}` : ""}`);
  if (p.company_news && !p.company_news.layoffs_90d && !p.company_news.freeze_90d) bits.push("no layoffs in the news");
  if (!bits.length) return "";
  const j = bits.length === 1 ? bits[0] : bits.slice(0, -1).join(", ") + " and " + bits[bits.length - 1];
  return j.charAt(0).toUpperCase() + j.slice(1) + ".";
}

export function daysAgo(iso: string) { return Math.floor((Date.now() - new Date(iso).getTime()) / 86400e3); }
