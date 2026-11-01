-- Pancafe Live: where PC time and member top-ups are counted from (PanCafe or Net Hub).
-- The "Data source" card on the Overview page reads and writes this one row.
-- Run once in Supabase: SQL Editor > New query > paste > Run. Run nethub.sql first. Safe to run again.
-- Nothing in PanCafe or Net Hub is changed; this only tells the dashboard which rows to count.

create table if not exists public.pancafe_settings (
  id             int primary key default 1 check (id = 1),
  pc_source      text not null default 'pancafe' check (pc_source in ('pancafe', 'nethub')),
  pc_source_from timestamptz,          -- start of the first cafe day the chosen source counts from
  locked         boolean not null default true,
  updated_by     text,
  updated_at     timestamptz not null default now()
);
insert into public.pancafe_settings (id) values (1) on conflict (id) do nothing;

-- The lock is enforced here too: while locked, the source and start date can't change.
create or replace function public.pancafe_settings_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.locked and new.locked and (new.pc_source is distinct from old.pc_source
      or new.pc_source_from is distinct from old.pc_source_from) then
    raise exception 'The data source is locked. Unlock it first.';
  end if;
  new.updated_at := now();
  new.updated_by := auth.jwt() ->> 'email';
  return new;
end $$;
drop trigger if exists pancafe_settings_guard on public.pancafe_settings;
create trigger pancafe_settings_guard before update on public.pancafe_settings
  for each row execute function public.pancafe_settings_guard();

alter table public.pancafe_settings enable row level security;

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
  execute 'drop policy if exists "viewers read" on public.pancafe_settings';
  execute 'drop policy if exists "viewers change" on public.pancafe_settings';
  execute format('create policy "viewers read" on public.pancafe_settings for select to authenticated using (%s)', rule);
  execute format('create policy "viewers change" on public.pancafe_settings for update to authenticated using (%s) with check (%s)', rule, rule);
end $$;

revoke all on public.pancafe_settings from anon;
grant select, update on public.pancafe_settings to authenticated;

-- Live updates, so every open dashboard switches at once.
do $$ begin
  alter publication supabase_realtime add table public.pancafe_settings;
exception when duplicate_object then null; end $$;
