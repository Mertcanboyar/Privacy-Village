-- §4 "Contact Exchange" (see PLAN.md's live-event build) — a new
-- `contacts` table (one row per completed handshake, one row per
-- direction) plus a `contact_info` column on the existing `progress`
-- table for the player's own opt-in, editable-anytime contact string.
-- Paste into the Supabase SQL Editor and run once, same as schema.sql /
-- migration_dossier.sql — not something Claude Code should run itself.
--
-- Idempotent: every statement uses IF NOT EXISTS, so re-running this is
-- safe and a no-op for whatever's already there.

alter table progress add column if not exists contact_info text not null default '';

create table if not exists contacts (
  id bigint generated always as identity primary key,
  owner_id uuid not null references profiles (id) on delete cascade,
  other_id uuid references profiles (id),
  other_name text not null,
  other_contact text not null default '',
  created_at timestamptz not null default now()
);

alter table contacts enable row level security;

drop policy if exists "contacts_select_own" on contacts;
create policy "contacts_select_own" on contacts
  for select using (owner_id = auth.uid());

drop policy if exists "contacts_insert_own" on contacts;
create policy "contacts_insert_own" on contacts
  for insert with check (owner_id = auth.uid());

-- No update policy and no delete policy — insert + select own only,
-- same "a log that could be edited isn't much of a log" reasoning as
-- the `decisions` table in schema.sql.

create index if not exists contacts_owner_id_idx on contacts (owner_id);
