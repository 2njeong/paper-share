create extension if not exists pgcrypto;

create table team_members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  notion_user_id text not null,
  api_key_hash text not null unique,
  created_at timestamptz not null default now()
);

alter table team_members enable row level security;
-- No policies: only the service role (used by the Edge Function) can read/write this table.
-- RLS with zero policies denies all access to anon/authenticated roles by default.
