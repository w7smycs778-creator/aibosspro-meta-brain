-- Conversation engine (Block B1): channel keys and booking contact fields.
-- NOT APPLIED. Created 2026-10-29. Apply after 20261029090000_storage_and_durable_ledger.sql.

alter table conversations drop constraint if exists conversations_channel_check;
alter table conversations add constraint conversations_channel_check check (channel in ('whatsapp', 'panel'));
alter table conversations add column if not exists external_id text not null;
alter table conversations add constraint conversations_external_key unique (business_id, channel, external_id);

alter table bookings
  add column if not exists customer_name text,
  add column if not exists customer_contact text;
create index if not exists bookings_conversation_idx on bookings (conversation_id, status);
