-- give a shot back when a run fails
create or replace function refund_shot(p_plan uuid) returns void language sql as $$
  update plans set shots_used = greatest(shots_used - 1, 0) where id = p_plan;
$$;
