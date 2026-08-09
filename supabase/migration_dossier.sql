-- The Agent Dossier — adds the three columns dossier.ts needs to
-- persist a player's concept/title record. Paste into the Supabase
-- SQL Editor and run once, same as schema.sql — not something Claude
-- Code should run itself.
--
-- Idempotent: every statement uses IF NOT EXISTS, so re-running this
-- (e.g. against a project that already has some of these columns) is
-- safe and a no-op for whatever's already there.

alter table progress add column if not exists unlocked_concepts jsonb not null default '[]'::jsonb;
alter table progress add column if not exists unlocked_titles jsonb not null default '[]'::jsonb;
alter table progress add column if not exists active_title text;

-- No new RLS policies needed — these are columns on the existing
-- `progress` table, already covered by its own select/insert/update
-- "own row only" policies (see schema.sql).
