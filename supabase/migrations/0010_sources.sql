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
