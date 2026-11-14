-- GHOSTED QA DATABASE · run ONCE, in the NEW QA Supabase project's SQL editor. Never in production.
-- Generated from this repository's migrations (0001_init.sql … 0010_sources.sql) by scripts/qa-schema.mjs. Nothing comes from production.
--
-- BEFORE RUNNING: replace PASTE_QA_PROJECT_REF (it appears in two statements: step 1 and step 5) with the QA project's reference — the 20 letters in its address
-- (https://<these 20 letters>.supabase.co, also under Project Settings → General → Reference ID).
-- Or let the script do it: node scripts/qa-schema.mjs --ref=<reference> writes a filled-in copy.
--
-- Everything runs in one transaction. The identity check comes first; if it fails, or anything after it fails,
-- nothing at all is changed.
begin;

-- ═════════ 1 · IDENTITY CHECK — before any change ═════════
do $check$
declare
  qa_ref  text := 'PASTE_QA_PROJECT_REF';
  n       int;
begin
  if qa_ref !~ '^[a-z]{20}$' then
    raise exception 'STOP: put the QA project''s 20-letter reference in place of PASTE_QA_PROJECT_REF. Nothing was changed.';
  end if;
  if qa_ref = 'vviporiiqwykfcetusta' then
    raise exception 'STOP: that is the PRODUCTION project''s reference. Nothing was changed.';
  end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind in ('r','p','v','m','S');
  if n > 0 then
    raise exception 'STOP: this project already has % object(s) in its public schema. A new QA project has none. This may be production. Nothing was changed.', n;
  end if;
  select count(*) into n from pg_type t join pg_namespace s on s.oid = t.typnamespace where s.nspname = 'public' and t.typtype = 'e';
  if n > 0 then raise exception 'STOP: this project already has custom types. It is not a new project. Nothing was changed.'; end if;
  select count(*) into n from storage.buckets;
  if n > 0 then raise exception 'STOP: this project already has % storage bucket(s). It is not a new project. Nothing was changed.', n; end if;
  select count(*) into n from auth.users;
  if n > 0 then raise exception 'STOP: this project already has sign-in users. It is not a new project. Nothing was changed.'; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role' and rolbypassrls)
     or not exists (select 1 from pg_roles where rolname = 'anon') or not exists (select 1 from pg_roles where rolname = 'authenticated') then
    raise exception 'STOP: this does not look like a Supabase project (its standard roles are missing). Nothing was changed.';
  end if;
end
$check$;

-- ═════════ 2 · STRUCTURE — the repository's migrations, in order ═════════

-- ───────── from supabase/migrations/0001_init.sql ─────────
-- notaghost · initial schema · v0.1
-- Runs in the Supabase SQL editor. Everything is server-only (service_role);
-- RLS is enabled with no policies so the anon key can read nothing.

create extension if not exists "pgcrypto";

-- ---------- users ----------
create table users (
  id            uuid primary key default gen_random_uuid(),
  phone         text unique not null check (phone ~ '^\+91\d{10}$'),
  email         text,
  name          text,
  city          text default 'Bengaluru',
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);

-- ---------- otp ----------
create table otp_codes (
  id          uuid primary key default gen_random_uuid(),
  phone       text not null,
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    int not null default 0,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index on otp_codes (phone, created_at desc);

-- ---------- sessions (bearer tokens) ----------
create table sessions (
  token       text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index on sessions (user_id);

-- ---------- résumés ----------
create table resumes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  storage_path  text not null,          -- supabase storage: resumes/<user>/<id>.pdf
  filename      text,
  text          text,                   -- extracted plain text
  parsed        jsonb,                  -- {headline, skills[], roles[], years, ...}
  is_current    boolean not null default true,
  created_at    timestamptz not null default now()
);
create index on resumes (user_id, created_at desc);

-- ---------- postings ----------
create table postings (
  id             uuid primary key default gen_random_uuid(),
  url            text,
  url_hash       text unique,           -- sha256(normalised url); null for pasted text
  source         text,                  -- linkedin | naukri | greenhouse | lever | careers | pasted
  company        text,
  title          text,
  location       text,
  raw_text       text not null,
  parsed         jsonb,                 -- {must_have[], nice_to_have[], years, salary, ...}
  ghost          jsonb,                 -- {score, verdict, signals[{id,pts,note}], checked_at}
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);

-- ---------- plans & shots ----------
-- One purchase = one plan row. Shots are drawn down from it.
create type product as enum ('sharpen', 'build', 'radar');

create table plans (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  product       product not null,
  shots_total   int not null,           -- 25
  shots_used    int not null default 0,
  starts_at     timestamptz not null default now(),
  expires_at    timestamptz not null,   -- starts_at + 30 days
  payment_id    uuid,                   -- set after payments row exists
  created_at    timestamptz not null default now()
);
create index on plans (user_id, expires_at desc);

create table shots (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  plan_id     uuid not null references plans(id),
  product     product not null,
  resume_id   uuid references resumes(id),
  posting_id  uuid references postings(id),
  input       jsonb,                    -- anything the user typed
  output      jsonb,                    -- {rewrite, referral_note, pdf_path, ...} | {questions, answers, feedback}
  status      text not null default 'queued',  -- queued | running | done | failed
  error       text,
  created_at  timestamptz not null default now(),
  done_at     timestamptz
);
create index on shots (user_id, created_at desc);

-- ---------- payments ----------
create table payments (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(id),
  product             product not null,
  amount_paise        int not null,     -- 49900 | 99900
  currency            text not null default 'INR',
  razorpay_order_id   text unique not null,
  razorpay_payment_id text unique,
  razorpay_signature  text,
  status              text not null default 'created', -- created | paid | failed | refunded
  receipt_no          text unique,      -- NAG-2026-000001
  receipt_path        text,             -- storage: receipts/<id>.pdf
  raw                 jsonb,
  created_at          timestamptz not null default now(),
  paid_at             timestamptz
);
create index on payments (user_id, created_at desc);

alter table plans add constraint plans_payment_fk
  foreign key (payment_id) references payments(id);

-- ---------- receipt numbering ----------
create sequence receipt_seq start 1;
create or replace function next_receipt_no() returns text language sql as $$
  select 'NAG-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('receipt_seq')::text, 6, '0');
$$;

-- ---------- lock everything down ----------
alter table users     enable row level security;
alter table otp_codes enable row level security;
alter table sessions  enable row level security;
alter table resumes   enable row level security;
alter table postings  enable row level security;
alter table plans     enable row level security;
alter table shots     enable row level security;
alter table payments  enable row level security;

-- ---------- storage buckets ----------
-- (a statement that only applies to an existing database was left out here)

-- ───────── from supabase/migrations/0002_refund.sql ─────────
-- give a shot back when a run fails
create or replace function refund_shot(p_plan uuid) returns void language sql as $$
  update plans set shots_used = greatest(shots_used - 1, 0) where id = p_plan;
$$;

-- ───────── from supabase/migrations/0003_previews.sql ─────────
create table if not exists previews (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  resume_id     uuid references resumes(id),
  posting_id    uuid references postings(id),
  posting_text  text,
  posting       jsonb,
  matches       jsonb,
  score_before  int,
  score_after   int,
  created_at    timestamptz not null default now()
);
create index on previews (user_id, created_at desc);
alter table previews enable row level security;
grant all on previews to service_role;

-- ───────── from supabase/migrations/0004_ghost.sql ─────────
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

-- ───────── from supabase/migrations/0005_plan_name.sql ─────────
alter table plans add column if not exists resume_name text;

-- ───────── from supabase/migrations/0006_reader.sql ─────────
-- Reader v2: clean slate. Employers + sightings. The old reader's data is wiped; the ghost check's own cache tables stay.

-- 1. wipe the old reader's data (companies was its seed/feed cache; observations and ats-sourced postings were its output)
-- (a statement that only applies to an existing database was left out here)
-- (a statement that only applies to an existing database was left out here)
-- (a statement that only applies to an existing database was left out here)
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

-- ───────── from supabase/migrations/0007_priority.sql ─────────
-- Resolve big-company sectors first: priority 1 goes before 5.
alter table employers add column if not exists priority int not null default 5;
create index if not exists employers_priority_idx on employers (priority, created_at) where resolved_at is null;

-- ───────── from supabase/migrations/0008_enrich.sql ─────────
-- Enrich: what we learn by opening each Bengaluru job page once.
alter table sightings add column if not exists description text;        -- plain text of the job page
alter table sightings add column if not exists fingerprint text;         -- simhash of the description (repost signal)
alter table sightings add column if not exists enriched_at timestamptz;
alter table sightings add column if not exists enrich_error text;
create index if not exists sightings_enrich_idx on sightings (enriched_at) where blr and gone_at is null;

-- ───────── from supabase/migrations/0009_observations.sql ─────────
-- 27 Oct: every extension view is an observation (not only the first); the board can report a closed posting;
-- a posting remembers which reader sighting it matched and when that role first appeared on the employer's system.
alter table observations add column if not exists status text;            -- 'open' | 'closed' as the board shows it
alter table observations add column if not exists source text;            -- 'extension' | 'site' | 'snapshot'
alter table postings add column if not exists closed_at timestamptz;      -- first time a board said "no longer accepting"
alter table postings add column if not exists sighting_source text;       -- reader system (workday, greenhouse, …)
alter table postings add column if not exists sighting_id text;           -- sightings.source_id the posting matched
alter table postings add column if not exists system_first_seen timestamptz;  -- when the role first appeared on the employer's own system
alter table postings add column if not exists system_linked_at timestamptz;   -- when we made the link
create index if not exists postings_sighting_idx on postings (sighting_source, sighting_id);

-- ───────── from supabase/migrations/0010_sources.sql ─────────
-- 3 Nov: where every person came from, carried from the first click to the payment.
-- Run once in the Supabase SQL editor.

alter table users    add column if not exists src_first    text;         -- the channel that brought them (never overwritten)
alter table users    add column if not exists src_first_at timestamptz;
alter table users    add column if not exists src_last     text;         -- the channel of their latest visit
alter table payments add column if not exists src_first    text;
alter table payments add column if not exists src_last     text;

-- one row per funnel stage: click, check, signin, preview, shot, order, paid, wa_in
create table if not exists events (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  kind       text not null,
  src_first  text,
  src_last   text,
  anon       text,                 -- the browser's anonymous id, so clicks → checks can be counted before any sign-in
  user_id    uuid references users(id) on delete set null,
  meta       jsonb
);
create index if not exists events_at_idx   on events (at desc);
create index if not exists events_kind_idx on events (kind, at desc);
create index if not exists events_src_idx  on events (src_first, at desc);

-- ═════════ 3 · QA-ONLY ADDITIONS ═════════
-- a column one internal page reads that the migrations never declared
alter table public.postings add column if not exists created_at timestamptz default now();

-- the QA database can never hold a real phone number: only the synthetic +91 00000 0xxxx identities fit
alter table public.users     add constraint qa_identities_only check (phone ~ '^\+9100000\d{5}$');
alter table public.otp_codes add constraint qa_identities_only check (phone ~ '^\+9100000\d{5}$');

-- private file storage: uploaded résumés, delivered PDFs, receipts
insert into storage.buckets (id, name, public) values ('resumes', 'resumes', false), ('outputs', 'outputs', false), ('receipts', 'receipts', false);

-- ═════════ 4 · PERMISSIONS — tighter than a default project, never looser ═════════
-- every table is closed to the public keys; only the service key (held by the QA service alone) can use them
do $lock$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end
$lock$;
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant usage on schema public to service_role;
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- ═════════ 5 · MARK THIS DATABASE AS QA ═════════
-- The QA service starts only if this mark names the same project as its own settings. Production refuses to run on a marked database.
do $mark$
declare qa_ref text := 'PASTE_QA_PROJECT_REF';
begin
  if qa_ref !~ '^[a-z]{20}$' or qa_ref = 'vviporiiqwykfcetusta' then raise exception 'STOP: the project reference in step 5 is not filled in correctly.'; end if;
  insert into public.reader_control (key, value) values ('qa:environment', jsonb_build_object('name', 'qa', 'database', qa_ref, 'created', now()));
end
$mark$;

commit;

select 'QA database ready: ' || count(*) || ' tables, marked for project ' || (select value->>'database' from public.reader_control where key = 'qa:environment') as result
from pg_tables where schemaname = 'public';
