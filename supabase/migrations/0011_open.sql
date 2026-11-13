-- Ghosted Open: proper tables. NOT YET APPLIED — the first build keeps Open's records in reader_control (key → json).
-- Run this in the Supabase SQL editor before Open takes real payments, then the storage in src/routes/open.ts moves here.
alter type product add value if not exists 'open_intro';

create table if not exists open_employers (
  user_id     uuid primary key references users(id) on delete cascade,
  company     text not null,
  email       text not null,
  domain      text not null,
  verified    boolean not null default false,
  verified_how text,
  created_at  timestamptz not null default now()
);
create table if not exists open_questions (
  id          text primary key,
  owner       uuid not null references users(id) on delete cascade,
  company     text not null,
  title       text not null,
  pay         text not null,
  exp_min     int not null,
  exp_max     int not null,
  location    text not null,
  question    text not null,
  status      text not null default 'live' check (status in ('live','closed')),
  outcome     text check (outcome in ('hired','not_hired')),
  note        text,
  views       int not null default 0,
  created_at  timestamptz not null default now(),
  closes_at   timestamptz not null,
  closed_at   timestamptz
);
create index if not exists open_questions_live on open_questions (status, closes_at);
create table if not exists open_answers (
  id          text primary key,
  question_id text not null references open_questions(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  n           int not null,
  label       text not null,
  body        text not null,
  how         jsonb not null default '{}',
  status      text not null default 'in' check (status in ('in','shortlisted','requested','accepted','declined','paid')),
  followup    jsonb,
  share       jsonb,
  payment_id  uuid,
  created_at  timestamptz not null default now(),
  unique (question_id, user_id),
  unique (question_id, n)
);
alter table open_employers enable row level security;
alter table open_questions enable row level security;
alter table open_answers enable row level security;
grant all on open_employers, open_questions, open_answers to service_role;
