-- Privacy Village — persistent accounts + progress schema.
--
-- Paste this whole file into the Supabase SQL Editor (Dashboard ->
-- SQL Editor -> New query) for a fresh project and run it once. Not
-- something Claude Code should run itself — this is meant to be
-- pasted and reviewed by a human before it touches a real database.
--
-- Auth is Supabase's built-in email magic link (see
-- client/src/scenes/Title.ts) — auth.users already exists once Auth
-- is enabled on the project; nothing here creates it.

-- ---------------------------------------------------------------------
-- profiles — one row per authenticated player, created the first time
-- they finish avatar/faction creation (or the first time a guest
-- upgrades mid-session — see hud.ts's "SAVE YOUR RECORD").
-- ---------------------------------------------------------------------
create table if not exists profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  agent_name text not null,
  sprite_id text not null,
  faction text,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

drop policy if exists "profiles_select_own" on profiles;
create policy "profiles_select_own" on profiles
  for select using (id = auth.uid());

drop policy if exists "profiles_insert_own" on profiles;
create policy "profiles_insert_own" on profiles
  for insert with check (id = auth.uid());

drop policy if exists "profiles_update_own" on profiles;
create policy "profiles_update_own" on profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- No delete policy — with RLS on and no delete policy, no row can be
-- deleted by anyone using the anon/authenticated role, by design.

-- ---------------------------------------------------------------------
-- progress — one row per player, upserted by client/src/cloud/save.ts
-- on quest/module/clearance/XP changes (debounced). quest_state and
-- module_state are versioned jsonb blobs (see save.ts's {"v":1, ...}
-- shape) so their internal structure can change later without an ALTER
-- TABLE — the client reads the "v" field itself to decide how to
-- interpret the rest.
-- ---------------------------------------------------------------------
create table if not exists progress (
  player_id uuid primary key references profiles (id) on delete cascade,
  clearance int not null default 1,
  xp int not null default 0,
  quest_state jsonb not null default '{}'::jsonb,
  module_state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table progress enable row level security;

drop policy if exists "progress_select_own" on progress;
create policy "progress_select_own" on progress
  for select using (player_id = auth.uid());

drop policy if exists "progress_insert_own" on progress;
create policy "progress_insert_own" on progress
  for insert with check (player_id = auth.uid());

drop policy if exists "progress_update_own" on progress;
create policy "progress_update_own" on progress
  for update using (player_id = auth.uid()) with check (player_id = auth.uid());

-- No delete policy, same reasoning as profiles.

-- ---------------------------------------------------------------------
-- decisions — append-only log of answer/choice moments (Breach M1/M2,
-- Innkeeper's Shards, Wall Fell clock choices, Academy quiz/card-drill
-- answers — see save.ts's logDecision() call sites). Insert + select
-- only, by design: a decision log that could be edited or deleted by
-- the client isn't much of a log.
--
-- event examples: "breach_m1_answer", "breach_m2_answer",
-- "shards_answer", "wallfell_choice", "wallfell_clock_choice",
-- "module_quiz_answer", "module_card_drill_answer" — detail holds
-- whatever's relevant to that event (answer/label, attempt number,
-- clock penalty hours, module + question id, etc.), also versioned
-- with a "v":1 field.
-- ---------------------------------------------------------------------
create table if not exists decisions (
  id bigint generated always as identity primary key,
  player_id uuid not null references profiles (id) on delete cascade,
  event text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table decisions enable row level security;

drop policy if exists "decisions_select_own" on decisions;
create policy "decisions_select_own" on decisions
  for select using (player_id = auth.uid());

drop policy if exists "decisions_insert_own" on decisions;
create policy "decisions_insert_own" on decisions
  for insert with check (player_id = auth.uid());

-- No update policy and no delete policy — insert + select own only.

-- Helpful for querying a single player's decision log in order.
create index if not exists decisions_player_id_created_at_idx
  on decisions (player_id, created_at);
