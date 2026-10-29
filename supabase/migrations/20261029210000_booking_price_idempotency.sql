-- Bookings record the tool-computed price and discount, an idempotency key,
-- and at most one pending or confirmed booking per business and start time.
-- NOT APPLIED. Created 2026-10-29. Apply after 20261029200000_brain_source.sql.

alter table bookings
  add column if not exists price_cents integer check (price_cents >= 0),
  add column if not exists currency text,
  add column if not exists discount_id text,
  add column if not exists idempotency_key text;

create unique index if not exists bookings_idempotency_key on bookings (idempotency_key);
create unique index if not exists bookings_active_slot on bookings (business_id, starts_at)
  where status in ('pending_approval', 'confirmed');
