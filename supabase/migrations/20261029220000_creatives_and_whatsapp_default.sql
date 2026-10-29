-- Content engine creatives and the per-business WhatsApp default mode.
-- NOT APPLIED. Created 2026-10-29. Apply after 20261029210000_booking_price_idempotency.sql.

alter table businesses
  add column if not exists whatsapp_default_mode text not null default 'HUMAN'
    check (whatsapp_default_mode in ('AUTO', 'HUMAN', 'PAUSED'));
update businesses set whatsapp_default_mode = 'AUTO' where id = 'biz_demo_harbor_lane';

create table if not exists creatives (
  id text primary key,
  business_id text not null references businesses(id) on delete cascade,
  offer_id text not null,
  offer jsonb not null,
  brain_version integer not null,
  status text not null default 'pending_approval' check (status in ('pending_approval', 'approved', 'rejected')),
  caption text not null,
  caption_log jsonb,
  media jsonb not null,
  cutout_kind text not null check (cutout_kind in ('mask', 'box', 'unavailable')),
  scene_kind text not null check (scene_kind in ('generated', 'flat')),
  diagnostics jsonb not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists creatives_business_idx on creatives (business_id, created_at desc);
alter table creatives enable row level security;
