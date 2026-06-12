create extension if not exists pgcrypto;

create table if not exists public.votes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  battle_id text not null,
  family text not null,
  left_item_id text not null,
  right_item_id text not null,
  winner_item_id text not null,
  loser_item_id text not null,
  session_id text not null,
  started_at timestamptz,
  models_loaded_at timestamptz,
  voted_at timestamptz,
  elapsed_ms integer,
  load_ms integer,
  hold_duration_ms integer,
  hold_target_ms integer,
  hold_passed boolean not null default false,
  duplicate_pair boolean not null default false,
  too_fast boolean not null default false,
  accepted_for_scoring boolean not null default false,
  quality_flags text[] not null default '{}',
  ip_hash text,
  user_agent_hash text,
  raw_payload jsonb not null default '{}'::jsonb
);

create table if not exists public.item_stats (
  item_id text primary key,
  family text not null,
  elo double precision not null default 1200,
  wins integer not null default 0,
  losses integer not null default 0,
  battle_count integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.pair_stats (
  pair_key text primary key,
  family text not null,
  item_a_id text not null,
  item_b_id text not null,
  item_a_wins integer not null default 0,
  item_b_wins integer not null default 0,
  battle_count integer not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists votes_session_pair_idx
  on public.votes (session_id, family, left_item_id, right_item_id);

create index if not exists votes_created_at_idx
  on public.votes (created_at desc);

create index if not exists votes_family_idx
  on public.votes (family);

alter table public.votes enable row level security;
alter table public.item_stats enable row level security;
alter table public.pair_stats enable row level security;

drop policy if exists "No public vote reads" on public.votes;
drop policy if exists "No public item stat reads" on public.item_stats;
drop policy if exists "No public pair stat reads" on public.pair_stats;

create policy "No public vote reads"
  on public.votes
  for all
  using (false)
  with check (false);

create policy "No public item stat reads"
  on public.item_stats
  for all
  using (false)
  with check (false);

create policy "No public pair stat reads"
  on public.pair_stats
  for all
  using (false)
  with check (false);
