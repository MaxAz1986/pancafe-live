-- Pancafe Live: rows left out of the dashboard totals ("Exclude" button on Live transactions).
-- PanCafe's own records are never changed; this table only tells the dashboard which rows to skip.
-- Run once in Supabase: SQL Editor > New query > paste > Run.

create table if not exists public.pancafe_excluded (
  row_id      text primary key,               -- id of the pancafe_cash row (or POS row) that is left out
  note        text,
  excluded_by text default (auth.jwt() ->> 'email'),
  created_at  timestamptz not null default now()
);

alter table public.pancafe_excluded enable row level security;

-- Same viewers as the rest of the dashboard: copy the read rule already used on pancafe_cash.
do $$
declare rule text;
begin
  select qual into rule from pg_policies
   where schemaname = 'public' and tablename = 'pancafe_cash' and cmd in ('SELECT', 'ALL') and qual is not null
   limit 1;
  if rule is null then
    raise exception 'Could not find the read rule on pancafe_cash; nothing was changed.';
  end if;
  execute 'drop policy if exists "viewers read" on public.pancafe_excluded';
  execute 'drop policy if exists "viewers add" on public.pancafe_excluded';
  execute 'drop policy if exists "viewers remove" on public.pancafe_excluded';
  execute format('create policy "viewers read" on public.pancafe_excluded for select to authenticated using (%s)', rule);
  execute format('create policy "viewers add" on public.pancafe_excluded for insert to authenticated with check (%s)', rule);
  execute format('create policy "viewers remove" on public.pancafe_excluded for delete to authenticated using (%s)', rule);
end $$;

grant select, insert, delete on public.pancafe_excluded to authenticated;

-- Live updates, so every open dashboard drops the row at once.
do $$ begin
  alter publication supabase_realtime add table public.pancafe_excluded;
exception when duplicate_object then null; end $$;
