-- 0013: at most one plan per payment (25 Nov 2026).
-- settle() in src/routes/payments.ts relies on this: when the Razorpay webhook and the checkout confirmation arrive at
-- the same moment, the second plan insert is refused here (23505) and that caller returns the first one's plan.
-- Apply it BEFORE the code that relies on it, on its own, in the Supabase SQL editor (how every migration here is applied;
-- the QA database was built once from 0001–0010 by supabase/qa/qa-database.sql and takes later migrations the same way).
--
-- Plans with no payment are not affected: test and probe grants (the Sharpen flow probe, src/probe/sharpen.ts) insert
-- plans without a payment_id, and a unique index treats every null as distinct. 61 such rows in production on 25 Nov.
--
-- A plain index, not CONCURRENTLY: plans is small (99 rows in production, 0 in QA, 25 Nov), so the build takes
-- milliseconds and briefly holds back writes to plans only; and it runs inside or outside a transaction alike.
--
-- Before applying, this must return 0 (production and QA both did on 25 Nov):
--   select count(*) from (select payment_id from plans where payment_id is not null group by 1 having count(*) > 1) x;
create unique index if not exists plans_payment_id_key on public.plans (payment_id);

-- After: this must return one row.
--   select indexname from pg_indexes where tablename = 'plans' and indexname = 'plans_payment_id_key';
-- Rollback (removes only this index; no data changes either way; roll the code back first):
--   drop index if exists public.plans_payment_id_key;
