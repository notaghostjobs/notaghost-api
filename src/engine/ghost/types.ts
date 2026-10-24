// Everything the ghost check knows about a posting, with where it came from.
// Facts are READ (by code or by the model); the score is ARITHMETIC on facts. Nothing else.

export interface PostingFacts {
  read_at: string;
  source: "linkedin" | "naukri" | "indeed" | "board" | "ats" | "careers" | "pasted";
  url: string;
  job_key: string;

  // --- A. the posting itself
  title: string;
  company: string;
  location: string;
  locations_count: number;                 // distinct cities/"remote" named for this one posting
  description: string;                     // cleaned text (stored for fingerprinting)
  posted_text: string | null;              // "1 month ago" as written
  posted_days: number | null;
  applicants: number | null;
  pay_stated: boolean;
  templated: boolean;                      // no team / manager / specifics
  evergreen: boolean;                      // talent community / future opportunities / always looking
  kitchen_sink: boolean;                   // unrelated stacks, 15+ must-haves, senior title + junior years
  apply_route: "system" | "email" | "dm" | "external_form" | "unknown";
  apply_domain: string | null;             // domain of the apply link if any
  contact_present: boolean;
  agency: boolean;                         // "leading client", consultancy, employer unnamed
  scam_tells: string[];                    // fee, deposit, whatsapp-only, telegram, "registration charges"
  poster: { name: string | null; is_recruiter_account: boolean | null; account_age_months: number | null } | null;

  // --- B. company's own hiring system (filled from companies.ats_jobs)
  ats?: {
    system: string;                        // greenhouse | lever | ...
    found: boolean;                        // this title found in their system
    created_at: string | null;             // true creation date
    updated_at: string | null;
    copies: number;                        // same title open count
    req_id: string | null;
    req_reopened: boolean;                 // same req id seen closed earlier (from observations)
    careers_url: string | null;
  };

  // --- C. boards (from research)
  boards?: {
    listings: { board: string; posted_days: number | null; url: string; applicants: number | null }[];
    distinct_dates: number;                // how many different "posted" dates across boards
    oldest_days: number | null;
    never_heard_back: boolean;             // Glassdoor/Indeed reviews citing no response
    checked_at: string;
  };

  // --- D. company situation
  company_news?: {
    layoffs_90d: boolean;
    freeze_90d: boolean;
    items: { title: string; url: string; date: string | null }[];
    checked_at: string;
  };
  headcount?: number | null;
  openings?: number | null;

  // --- E. our own observation
  observation?: {
    first_seen: string;
    days_seen: number;
    vanished_and_returned: boolean;
    claimed_vs_seen_gap_days: number | null;   // page says "3 days", we first saw it 60 days ago
  };
  reply_rate?: { applied: number; replied: number; rate: number | null };

  // --- same-text check (signal 7)
  same_text_companies?: string[];
}

export type Verdict = "Real" | "Caution" | "Ghost" | "Scam" | "Can’t verify";

export interface FiredSignal {
  n: number;                               // 1..22
  pts: number;
  kind: "bad" | "warn" | "ok" | "na";
  text: string;
  strong?: string;
  tail?: string;
}

export interface Scored {
  score: number;
  verdict: Verdict;
  signals: FiredSignal[];                  // fired + a few "ok"/"na" context lines
  headline: string;
  body: string;
  adviceLabel: string;
  advice: string;
  checked: number;                         // how many of the 22 we could evaluate
  coverage: string;                        // "17 of 22 checks ran"
}
