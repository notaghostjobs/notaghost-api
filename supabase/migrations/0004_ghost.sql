-- Ghost check v2: stable, cached, explained scores.

-- postings: one row per JOB (canonical key), not per link
alter table postings add column if not exists job_key      text unique;     -- "linkedin:4478119235" | "naukri:..." | "url:<sha>"
alter table postings add column if not exists company_key  text;            -- normalised company name
alter table postings add column if not exists facts        jsonb;           -- everything we read, with sources and timestamps
alter table postings add column if not exists signals      jsonb;           -- the fired signals the user sees
alter table postings add column if not exists score        int;
alter table postings add column if not exists verdict      text;            -- Real | Caution | Ghost | Scam | Can't verify
alter table postings add column if not exists scored_at    timestamptz;
alter table postings add column if not exists next_check   timestamptz;     -- scheduled re-check
alter table postings add column if not exists history      jsonb default '[]'::jsonb;  -- [{at, score, verdict, why}]
alter table postings add column if not exists fingerprint  text;            -- simhash of the description, for signal 7
alter table postings add column if not exists checks       int default 0;   -- how many users asked
create index if not exists postings_company_idx on postings (company_key);
create index if not exists postings_fp_idx on postings (fingerprint);
create index if not exists postings_next_idx on postings (next_check);

-- companies: what we know about the employer, cached
create table if not exists companies (
  key           text primary key,            -- normalised name
  name          text not null,
  domain        text,
  careers_url   text,
  ats           text,                        -- greenhouse | lever | ashby | smartrecruiters | workday | darwinbox | keka | careers | none | unknown
  ats_slug      text,
  ats_checked   timestamptz,
  ats_jobs      jsonb,                       -- [{id, title, location, created_at, updated_at, url}] snapshot
  news          jsonb,                       -- {layoffs_90d, freeze_90d, funding_90d, items[], checked_at}
  headcount     int,
  openings      int,
  size_checked  timestamptz,
  research      jsonb,                       -- board research cache keyed by title
  reply_stats   jsonb,                       -- {applied, replied, rate, updated_at}
  updated_at    timestamptz default now()
);
alter table companies enable row level security;
grant all on companies to service_role;

-- observations: daily snapshots of every posting we know (signal 21)
create table if not exists observations (
  id          bigserial primary key,
  posting_id  uuid not null references postings(id) on delete cascade,
  seen_at     timestamptz not null default now(),
  present     boolean not null,
  posted_text text,                          -- "3 days ago" as the page said that day
  applicants  int,
  hash        text                           -- description hash that day
);
create index if not exists obs_posting_idx on observations (posting_id, seen_at desc);
alter table observations enable row level security;
grant all on observations to service_role;
grant usage, select on sequence observations_id_seq to service_role;

-- application outcomes (signal 22): filled by the tracker
create table if not exists outcomes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  posting_id  uuid references postings(id),
  company_key text,
  applied_at  timestamptz not null default now(),
  status      text not null default 'applied',   -- applied | replied | interview | offer | rejected | silence
  replied_at  timestamptz,
  updated_at  timestamptz default now()
);
create index if not exists outcomes_company_idx on outcomes (company_key);
alter table outcomes enable row level security;
grant all on outcomes to service_role;
