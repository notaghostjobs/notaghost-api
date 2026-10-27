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
