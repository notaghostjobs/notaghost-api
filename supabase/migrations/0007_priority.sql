-- Resolve big-company sectors first: priority 1 goes before 5.
alter table employers add column if not exists priority int not null default 5;
create index if not exists employers_priority_idx on employers (priority, created_at) where resolved_at is null;
