-- Kaizen — schemat bazy.
-- Uruchom raz w Supabase: SQL Editor → New query → wklej → Run.

create table if not exists public.kv_store (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  key        text        not null check (key in ('daily-log', 'tasks', 'config')),
  value      jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.kv_store enable row level security;

-- Każdy użytkownik widzi i zmienia wyłącznie własne dane.
drop policy if exists "own rows" on public.kv_store;
create policy "own rows" on public.kv_store
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
