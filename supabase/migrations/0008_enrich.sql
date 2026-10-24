-- Enrich: what we learn by opening each Bengaluru job page once.
alter table sightings add column if not exists description text;        -- plain text of the job page
alter table sightings add column if not exists fingerprint text;         -- simhash of the description (repost signal)
alter table sightings add column if not exists enriched_at timestamptz;
alter table sightings add column if not exists enrich_error text;
create index if not exists sightings_enrich_idx on sightings (enriched_at) where blr and gone_at is null;
