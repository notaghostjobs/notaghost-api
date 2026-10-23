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
insert into storage.buckets (id, name, public) values
  ('resumes',  'resumes',  false),
  ('outputs',  'outputs',  false),
  ('receipts', 'receipts', false)
on conflict do nothing;
