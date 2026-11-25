-- 0013: at most one plan per payment (25 Nov 2026).
-- settle() in src/routes/payments.ts relies on this: when the Razorpay webhook and the checkout confirmation arrive at
-- the same moment, the second plan insert is refused here (23505) and that caller returns the first one's plan.
-- Plans without a payment (payment_id null: test grants made before payments existed) are not affected: a unique index
-- treats nulls as distinct.
--
-- Before applying, this must return no rows (it did on 25 Nov: every payment has at most one plan):
--   select payment_id, count(*) from plans where payment_id is not null group by 1 having count(*) > 1;
--
-- CONCURRENTLY: no lock on plans while it builds. It cannot run inside a transaction, so apply it on its own.
create unique index concurrently if not exists plans_payment_id_key on public.plans (payment_id);

-- Rollback (removes only this index; no data changes either way):
--   drop index concurrently if exists public.plans_payment_id_key;
