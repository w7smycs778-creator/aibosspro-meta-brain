-- Ledger rows record the provider finish reason, reasoning tokens and raw usage.
-- NOT APPLIED. Created 2026-10-29. Apply after 20261029150000_engine_b1.sql.

alter table model_spend_reservations
  add column if not exists finish_reason text,
  add column if not exists reasoning_tokens integer check (reasoning_tokens >= 0),
  add column if not exists usage_raw text;

drop function if exists settle_model_spend(uuid, bigint, integer, integer);

-- Settle to actual cost (may exceed the reservation; recorded as charged).
create or replace function settle_model_spend(
  p_reservation_id uuid,
  p_actual_nano bigint,
  p_tokens_in integer default 0,
  p_tokens_out integer default 0,
  p_finish_reason text default null,
  p_reasoning_tokens integer default null,
  p_usage_raw text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_actual_nano is null or p_actual_nano < 0 then
    raise exception 'settlement must be non-negative';
  end if;
  perform 1 from model_spend_lock where id = 1 for update;
  update model_spend_reservations
     set state = 'settled',
         settled_nano = p_actual_nano,
         tokens_in = coalesce(p_tokens_in, 0),
         tokens_out = coalesce(p_tokens_out, 0),
         finish_reason = p_finish_reason,
         reasoning_tokens = p_reasoning_tokens,
         usage_raw = p_usage_raw,
         closed_at = now()
   where id = p_reservation_id and state = 'reserved';
  if not found then
    raise exception 'reservation % is not open', p_reservation_id;
  end if;
end;
$$;

revoke all on function settle_model_spend(uuid, bigint, integer, integer, text, integer, text) from public, anon, authenticated;
grant execute on function settle_model_spend(uuid, bigint, integer, integer, text, integer, text) to service_role;
