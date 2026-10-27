-- Model spend ledger (Postgres implementation of SpendLedger).
-- NOT APPLIED. Created 2026-10-27; apply when the Supabase project exists.
-- Amounts are integer nano-USD (1e-9 USD), matching src/lib/gateway/money.ts.
-- Only the server (service role) touches these tables; RLS is on with no policies.

create table if not exists model_spend_budget (
  id smallint primary key default 1 check (id = 1),
  hard_cap_nano bigint not null check (hard_cap_nano between 0 and 130000000000),
  credit_balance_nano bigint not null check (credit_balance_nano >= 0),
  buffer_nano bigint not null default 20000000000 check (buffer_nano >= 0),
  settled_nano bigint not null default 0 check (settled_nano >= 0),
  reserved_nano bigint not null default 0 check (reserved_nano >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists model_spend_reservations (
  id uuid primary key default gen_random_uuid(),
  run_id text,
  business_id uuid,
  model text not null,
  reserved_nano bigint not null check (reserved_nano > 0),
  settled_nano bigint check (settled_nano >= 0),
  state text not null default 'reserved' check (state in ('reserved', 'settled', 'released')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists model_spend_reservations_run_idx on model_spend_reservations (run_id, state);

alter table model_spend_budget enable row level security;
alter table model_spend_reservations enable row level security;

-- Atomic reserve: the budget row lock serialises every concurrent reservation.
-- Returns the reservation id, or null with the deny reason in p_reason.
create or replace function reserve_model_spend(
  p_amount_nano bigint,
  p_model text,
  p_run_id text default null,
  p_run_cap_nano bigint default null,
  p_business_id uuid default null,
  out reservation_id uuid,
  out deny_reason text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  b model_spend_budget%rowtype;
  committed bigint;
  run_committed bigint;
begin
  if p_amount_nano is null or p_amount_nano <= 0 then
    raise exception 'reservation must be positive';
  end if;

  select * into b from model_spend_budget where id = 1 for update;
  if not found then
    deny_reason := 'insufficient_credit';
    return;
  end if;

  committed := b.settled_nano + b.reserved_nano;
  if committed + p_amount_nano > b.hard_cap_nano then
    deny_reason := 'hard_cap_reached';
    return;
  end if;
  if p_amount_nano > b.credit_balance_nano - b.buffer_nano - committed then
    deny_reason := 'insufficient_credit';
    return;
  end if;

  if p_run_cap_nano is not null then
    select coalesce(sum(case when state = 'reserved' then reserved_nano
                             when state = 'settled' then settled_nano
                             else 0 end), 0)
      into run_committed
      from model_spend_reservations
     where run_id is not distinct from p_run_id;
    if run_committed + p_amount_nano > p_run_cap_nano then
      deny_reason := 'run_cap_reached';
      return;
    end if;
  end if;

  insert into model_spend_reservations (run_id, business_id, model, reserved_nano)
  values (p_run_id, p_business_id, p_model, p_amount_nano)
  returning id into reservation_id;

  update model_spend_budget
     set reserved_nano = reserved_nano + p_amount_nano, updated_at = now()
   where id = 1;
end;
$$;

-- Settle to actual cost (may exceed the reservation; recorded as charged).
create or replace function settle_model_spend(p_reservation_id uuid, p_actual_nano bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r model_spend_reservations%rowtype;
begin
  if p_actual_nano is null or p_actual_nano < 0 then
    raise exception 'settlement must be non-negative';
  end if;
  perform 1 from model_spend_budget where id = 1 for update;
  select * into r from model_spend_reservations where id = p_reservation_id for update;
  if not found or r.state <> 'reserved' then
    raise exception 'reservation % is not open', p_reservation_id;
  end if;
  update model_spend_reservations
     set state = 'settled', settled_nano = p_actual_nano, closed_at = now()
   where id = p_reservation_id;
  update model_spend_budget
     set reserved_nano = reserved_nano - r.reserved_nano,
         settled_nano = settled_nano + p_actual_nano,
         updated_at = now()
   where id = 1;
end;
$$;

-- Release a reservation whose attempt never reached the provider.
create or replace function release_model_spend(p_reservation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r model_spend_reservations%rowtype;
begin
  perform 1 from model_spend_budget where id = 1 for update;
  select * into r from model_spend_reservations where id = p_reservation_id for update;
  if not found or r.state <> 'reserved' then
    raise exception 'reservation % is not open', p_reservation_id;
  end if;
  update model_spend_reservations set state = 'released', closed_at = now() where id = p_reservation_id;
  update model_spend_budget
     set reserved_nano = reserved_nano - r.reserved_nano, updated_at = now()
   where id = 1;
end;
$$;

revoke all on function reserve_model_spend(bigint, text, text, bigint, uuid) from public, anon, authenticated;
revoke all on function settle_model_spend(uuid, bigint) from public, anon, authenticated;
revoke all on function release_model_spend(uuid) from public, anon, authenticated;
