-- Brain versions record where a draft came from (voice note, typed text, seed).
-- NOT APPLIED. Created 2026-10-29. Apply after 20261029190000_ledger_finish_reason.sql.

alter table brain_versions
  add column if not exists source_kind text check (source_kind in ('voice', 'text', 'seed')),
  add column if not exists source_text text,
  add column if not exists audio_path text;
