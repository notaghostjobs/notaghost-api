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
