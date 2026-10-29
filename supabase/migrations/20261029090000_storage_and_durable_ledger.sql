-- Engine storage and the durable spend ledger (Postgres side of src/lib/storage).
-- NOT APPLIED. Created 2026-10-29. Apply after 20261027120000_model_spend_ledger.sql.
-- Only the server (service role) touches these tables; RLS is on with no policies.
--
-- Ledger change from 20261027120000: limits now come from the caller's env
-- (MODEL_SPEND_HARD_CAP_USD, MODEL_CREDIT_BALANCE_USD) and every check sums the
-- ledger rows under a lock, instead of reading counters on a budget row.

-- Spend ledger -------------------------------------------------------------

drop function if exists reserve_model_spend(bigint, text, text, bigint, uuid);
drop function if exists settle_model_spend(uuid, bigint);
drop function if exists release_model_spend(uuid);
drop table if exists model_spend_budget;

create table if not exists model_spend_lock (
  id smallint primary key default 1 check (id = 1)
);
insert into model_spend_lock (id) values (1) on conflict do nothing;
alter table model_spend_lock enable row level security;

alter table model_spend_reservations alter column business_id type text using business_id::text;
alter table model_spend_reservations
  add column if not exists turn_id text,
  add column if not exists tokens_in integer not null default 0 check (tokens_in >= 0),
  add column if not exists tokens_out integer not null default 0 check (tokens_out >= 0);
create index if not exists model_spend_reservations_state_idx on model_spend_reservations (state);

-- Atomic reserve: the lock row serialises every reservation, settlement and
-- release; committed spend is the sum of open reservations and settled rows.
create or replace function reserve_model_spend(
  p_amount_nano bigint,
  p_model text,
  p_hard_cap_nano bigint,
  p_credit_balance_nano bigint,
  p_buffer_nano bigint,
  p_run_id text default null,
  p_run_cap_nano bigint default null,
  p_business_id text default null,
  p_turn_id text default null,
  out reservation_id uuid,
  out deny_reason text,
  out committed_nano bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  run_committed bigint;
begin
  if p_amount_nano is null or p_amount_nano <= 0 then
    raise exception 'reservation must be positive';
  end if;
  if p_hard_cap_nano is null or p_hard_cap_nano < 0 or p_hard_cap_nano > 130000000000 then
    raise exception 'hard cap must be between 0 and 130 USD';
  end if;
  if p_credit_balance_nano is null or p_buffer_nano is null then
    raise exception 'credit balance and buffer are required';
  end if;

  perform 1 from model_spend_lock where id = 1 for update;
  if not found then
    raise exception 'model_spend_lock row is missing';
  end if;

  select coalesce(sum(case r.state when 'reserved' then r.reserved_nano
                                   when 'settled' then r.settled_nano
                                   else 0 end), 0)
    into committed_nano
    from model_spend_reservations r;

  if committed_nano + p_amount_nano > p_hard_cap_nano then
    deny_reason := 'hard_cap_reached';
    return;
  end if;
  if p_amount_nano > p_credit_balance_nano - p_buffer_nano - committed_nano then
    deny_reason := 'insufficient_credit';
    return;
  end if;

  if p_run_cap_nano is not null then
    select coalesce(sum(case r.state when 'reserved' then r.reserved_nano
                                     when 'settled' then r.settled_nano
                                     else 0 end), 0)
      into run_committed
      from model_spend_reservations r
     where r.run_id is not distinct from p_run_id;
    if run_committed + p_amount_nano > p_run_cap_nano then
      deny_reason := 'run_cap_reached';
      return;
    end if;
  end if;

  insert into model_spend_reservations (run_id, business_id, turn_id, model, reserved_nano)
  values (p_run_id, p_business_id, p_turn_id, p_model, p_amount_nano)
  returning id into reservation_id;
end;
$$;

-- Settle to actual cost (may exceed the reservation; recorded as charged).
create or replace function settle_model_spend(
  p_reservation_id uuid,
  p_actual_nano bigint,
  p_tokens_in integer default 0,
  p_tokens_out integer default 0
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
         closed_at = now()
   where id = p_reservation_id and state = 'reserved';
  if not found then
    raise exception 'reservation % is not open', p_reservation_id;
  end if;
end;
$$;

-- Release a reservation whose attempt never reached the provider.
create or replace function release_model_spend(p_reservation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from model_spend_lock where id = 1 for update;
  update model_spend_reservations
     set state = 'released', closed_at = now()
   where id = p_reservation_id and state = 'reserved';
  if not found then
    raise exception 'reservation % is not open', p_reservation_id;
  end if;
end;
$$;

create or replace function model_spend_totals(p_run_id text default null)
returns table (settled_nano bigint, reserved_nano bigint, run_settled_nano bigint, run_reserved_nano bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(sum(r.settled_nano) filter (where r.state = 'settled'), 0)::bigint,
    coalesce(sum(r.reserved_nano) filter (where r.state = 'reserved'), 0)::bigint,
    coalesce(sum(r.settled_nano) filter (where r.state = 'settled' and r.run_id = p_run_id), 0)::bigint,
    coalesce(sum(r.reserved_nano) filter (where r.state = 'reserved' and r.run_id = p_run_id), 0)::bigint
  from model_spend_reservations r;
$$;

revoke all on function reserve_model_spend(bigint, text, bigint, bigint, bigint, text, bigint, text, text) from public, anon, authenticated;
revoke all on function settle_model_spend(uuid, bigint, integer, integer) from public, anon, authenticated;
revoke all on function release_model_spend(uuid) from public, anon, authenticated;
revoke all on function model_spend_totals(text) from public, anon, authenticated;
grant execute on function reserve_model_spend(bigint, text, bigint, bigint, bigint, text, bigint, text, text) to service_role;
grant execute on function settle_model_spend(uuid, bigint, integer, integer) to service_role;
grant execute on function release_model_spend(uuid) to service_role;
grant execute on function model_spend_totals(text) to service_role;

-- Engine storage ------------------------------------------------------------

create table if not exists businesses (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists brain_versions (
  business_id text not null references businesses(id) on delete cascade,
  version integer not null check (version > 0),
  brain jsonb not null,
  approved boolean not null default false,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  primary key (business_id, version)
);

create table if not exists conversations (
  id text primary key,
  business_id text not null references businesses(id) on delete cascade,
  channel text not null check (channel in ('whatsapp', 'web')),
  customer_ref text not null,
  mode text not null default 'HUMAN' check (mode in ('AUTO', 'HUMAN', 'PAUSED')),
  state text not null default 'active' check (state in ('active', 'owner_help', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists turns (
  seq bigint generated always as identity primary key,
  id text not null unique,
  conversation_id text not null references conversations(id) on delete cascade,
  role text not null check (role in ('customer', 'assistant', 'tool', 'owner', 'system')),
  content text not null,
  checkpoint jsonb,
  created_at timestamptz not null default now()
);
create index if not exists turns_conversation_idx on turns (conversation_id, seq);

create table if not exists approvals (
  id text primary key,
  business_id text not null references businesses(id) on delete cascade,
  conversation_id text references conversations(id) on delete set null,
  kind text not null check (kind in ('booking', 'publication')),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists approvals_pending_idx on approvals (business_id, status);

create table if not exists bookings (
  id text primary key,
  business_id text not null references businesses(id) on delete cascade,
  conversation_id text references conversations(id) on delete set null,
  service_id text not null,
  customer_ref text not null,
  starts_at timestamptz not null,
  status text not null check (status in ('pending_approval', 'confirmed', 'rejected', 'cancelled')),
  approval_id text references approvals(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists processed_events (
  source text not null,
  event_id text not null,
  processed_at timestamptz not null default now(),
  primary key (source, event_id)
);

alter table businesses enable row level security;
alter table brain_versions enable row level security;
alter table conversations enable row level security;
alter table turns enable row level security;
alter table approvals enable row level security;
alter table bookings enable row level security;
alter table processed_events enable row level security;
