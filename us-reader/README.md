# The US reader

A separate checker for open roles in the United States. It shares no code and no tables with the Bengaluru reader.

- `discover.mjs` finds employers' public job boards from Common Crawl's index files (nobody is crawled to build the list).
- `lib.mjs` asks each board (Greenhouse, Lever, Ashby) for its open roles and marks the US ones.
- `curate.mjs` keeps what is worth showing a person: posted in the last 60 days, a full description, one entry per real role, no middlemen, nothing commission-only.
- `store.mjs` writes to `us_employers` and `us_roles` when the job has the database key; without it the reader only counts.
- `run.mjs` ties these together. `test.mjs` checks the rules offline: `node us-reader/test.mjs`.

It runs twice a day from `.github/workflows/us-reader.yml`, deploys nothing, and leaves its counts on the `us-reader-data` branch.
Rules it keeps: it says who it is, asks only the employer's own system, waits between requests, and never works around a refusal.
