-- Reader v2: clean slate. Employers + sightings. The old reader's data is wiped; the ghost check's own cache tables stay.

-- 1. wipe the old reader's data (companies was its seed/feed cache; observations and ats-sourced postings were its output)
truncate table observations;
delete from postings where source = 'ats';
truncate table companies;

-- 2. employers: every organisation we have seen hiring in Bengaluru, and where their jobs truly live
create table if not exists employers (
  key           text primary key,            -- normalised name (companyKey)
  name          text not null,
  website       text,
  careers_url   text,
  ats           text,                        -- greenhouse | lever | ashby | smartrecruiters | workday | darwinbox | keka | ... | page | none | null (unresolved)
  ats_ref       text,                        -- slug, tenant/site, or feed URL — whatever the reader needs
  confidence    text,                        -- link (from a job URL) | page (found on the careers page) | search (web search) | guess (slug probe)
  evidence      text,                        -- one line: how we decided
  source        text not null default 'seed',-- seed | naukri | linkedin | ats
  resolved_at   timestamptz,
  resolve_error text,
  read_at       timestamptz,
  read_error    text,
  openings      int,                         -- jobs in the feed, all locations
  blr_openings  int,                         -- Bengaluru / India-remote
  created_at    timestamptz default now()
);
create index if not exists employers_ats_idx on employers (ats);
create index if not exists employers_unresolved_idx on employers (resolved_at) where resolved_at is null;
alter table employers enable row level security;
grant all on employers to service_role;

-- 3. sightings: one row per (source, id). A job seen on an employer's own system or on a board. Nothing clever here.
create table if not exists sightings (
  id             bigserial primary key,
  source         text not null,              -- greenhouse | lever | ... | naukri | linkedin
  source_id      text not null,
  employer_key   text references employers(key),
  company_name   text,
  title          text,
  location       text,
  url            text,
  posted_at      timestamptz,                -- the source's own date, when it gives one
  updated_at_src timestamptz,
  posted_text    text,                       -- "3 days ago" as the board said it
  salary_text    text,
  blr            boolean not null default false,
  raw            jsonb,
  first_seen     timestamptz not null default now(),
  last_seen      timestamptz not null default now(),
  gone_at        timestamptz,
  unique (source, source_id)
);
create index if not exists sightings_employer_idx on sightings (employer_key);
create index if not exists sightings_blr_idx on sightings (blr) where gone_at is null;
create index if not exists sightings_last_seen_idx on sightings (last_seen);
alter table sightings enable row level security;
grant all on sightings to service_role;
grant usage, select on sequence sightings_id_seq to service_role;

-- 4. a tiny control table so the admin page can ask the worker to run a step now
create table if not exists reader_control (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);
alter table reader_control enable row level security;
grant all on reader_control to service_role;

-- 5. plans: the column from 0005, in case it was not run
alter table plans add column if not exists resume_name text;
