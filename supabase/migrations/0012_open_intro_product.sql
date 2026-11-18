-- Ghosted Open takes its first payments: ₹499 when a candidate an employer invited agrees to talk.
-- One additive change: the payments table learns the product. Nothing existing is altered or removed.
-- Open's own records (employers, questions, answers) stay where they are; migration 0011 remains for later.
alter type product add value if not exists 'open_intro';
