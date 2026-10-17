-- Pancafe Live: PC health for the customer PCs (temperatures, load, disks, crashes and shutdowns).
-- Filled by the PanCafe PC Health agent on each customer PC through pchealth_ingest().
-- Run once in Supabase: SQL Editor > New query > paste > Run. Safe to run again.

create extension if not exists pgcrypto with schema extensions;

-- Latest state of each PC (one row per PC, overwritten every 30 s).
create table if not exists public.pchealth_pcs (
  pc         text primary key,          -- PanCafe name, e.g. PC05
  host       text,                      -- Windows computer name
  version    text,
  last_seen  timestamptz,
  boot_at    timestamptz,
  info       jsonb,                     -- CPU, GPU, RAM, board, BIOS, Windows version
  now        jsonb,                     -- latest reading: load, temperatures, GPU power, fan, throttling, running app
  disks      jsonb                      -- drive health, wear, temperature, free space
);
-- The black box (last ~6 minutes of 10-second readings), refreshed every 20 s. Diskless PCs lose
-- their local copy when they restart, so this one is moved to pchealth_lastmoments on the next start.
alter table public.pchealth_pcs add column if not exists box jsonb;

-- One row per PC per minute: average load and highest temperature in that minute. Kept 7 days.
create table if not exists public.pchealth_samples (
  pc text not null, at timestamptz not null,
  cpu real, gpu real, ram real, cpu_temp real, gpu_temp real, gpu_power real, app text,
  primary key (pc, at)
);
create index if not exists pchealth_samples_at on public.pchealth_samples (at);

-- Windows event log entries about shutdowns, blue screens, hardware errors, GPU resets, disk errors and app crashes.
create table if not exists public.pchealth_events (
  pc text not null, log text not null, record_id bigint not null,
  at timestamptz not null, provider text, event_id int, level int, kind text, message text, data jsonb,
  primary key (pc, log, record_id, at)
);
create index if not exists pchealth_events_at on public.pchealth_events (at);
-- Diskless PCs start from the same image every time, so record numbers repeat: the time is part of the key.
do $$ begin
  if (select count(*) from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = 'public.pchealth_events'::regclass and i.indisprimary) < 4 then
    alter table public.pchealth_events drop constraint pchealth_events_pkey;
    alter table public.pchealth_events add primary key (pc, log, record_id, at);
  end if;
end $$;

-- The "black box": the last ~6 minutes of 10-second readings before each time a PC went off.
create table if not exists public.pchealth_lastmoments (
  pc text not null, ended_at timestamptz not null,
  boot_at timestamptz, next_boot_at timestamptz, samples jsonb,
  primary key (pc, ended_at)
);

-- Upload key for the agents. Separate from the PanCafe bridge's key: a key copied off a customer PC
-- can only add health readings, never touch sales data.
create table if not exists public.pchealth_agent_tokens (
  token_hash text primary key, label text, created_at timestamptz default now()
);
insert into public.pchealth_agent_tokens (token_hash, label)
values ('1327e985454cbedbf6711484527be8239aedf057cbdfaddf907dc884665420ca', 'customer PCs')
on conflict do nothing;

-- Read access: the same signed-in viewers as the rest of the dashboard. No writes through the API.
do $$
declare t text;
begin
  foreach t in array array['pchealth_pcs','pchealth_samples','pchealth_events','pchealth_lastmoments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists viewer_read on public.%I', t);
    execute format('create policy viewer_read on public.%I for select to authenticated using ((select public.pancafe_is_viewer()))', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
alter table public.pchealth_agent_tokens enable row level security;
revoke all on public.pchealth_agent_tokens from anon, authenticated;

create or replace function public.pchealth_ingest(p_token text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_pc text := upper(trim(p_payload->>'pc'));
  v_boot timestamptz := (p_payload->>'boot_at')::timestamptz;
  v_box jsonb := case when jsonb_typeof(p_payload->'box'->'samples') = 'array'
                       and jsonb_array_length(p_payload->'box'->'samples') <= 120 then p_payload->'box' end;
  old record;
  n jsonb := '{}'::jsonb; c int;
begin
  if not exists (select 1 from public.pchealth_agent_tokens
                 where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')) then
    raise exception 'invalid agent token' using errcode = '28000';
  end if;
  if v_pc is null or v_pc = '' or length(v_pc) > 32 then
    raise exception 'missing pc name';
  end if;

  -- The agent's own copy of the last moments before the previous shutdown (PCs with their own disk).
  if jsonb_typeof(p_payload->'lastmoments') = 'array' then
    delete from public.pchealth_lastmoments m using jsonb_to_recordset(p_payload->'lastmoments') as x(next_boot_at timestamptz)
     where m.pc = v_pc and m.next_boot_at = x.next_boot_at;
    insert into public.pchealth_lastmoments (pc, ended_at, boot_at, next_boot_at, samples)
    select v_pc, x.ended_at, x.boot_at, x.next_boot_at, x.samples
    from (select * from jsonb_to_recordset(p_payload->'lastmoments')
            as x(ended_at timestamptz, boot_at timestamptz, next_boot_at timestamptz, samples jsonb)
          limit 20) x
    where x.ended_at is not null
    on conflict (pc, ended_at) do nothing;
  end if;

  -- The PC restarted since its last report: keep the black box from before the restart.
  select boot_at, box into old from public.pchealth_pcs where pc = v_pc;
  if found and old.box is not null and v_boot is not null and old.boot_at is distinct from v_boot
     and jsonb_array_length(coalesce(old.box->'samples', '[]')) > 0
     and v_boot > ((old.box->'samples'->-1)->>'t')::timestamptz - interval '2 minutes'
     and not exists (select 1 from public.pchealth_lastmoments where pc = v_pc and next_boot_at = v_boot) then
    insert into public.pchealth_lastmoments (pc, ended_at, boot_at, next_boot_at, samples)
    values (v_pc, ((old.box->'samples'->-1)->>'t')::timestamptz, old.boot_at, v_boot, old.box->'samples')
    on conflict (pc, ended_at) do nothing;
  end if;

  insert into public.pchealth_pcs (pc, host, version, last_seen, boot_at, info, now, disks, box)
  values (v_pc, left(p_payload->>'host', 64), left(p_payload->>'version', 16), now(),
          v_boot, p_payload->'info', p_payload->'now', p_payload->'disks', v_box)
  on conflict (pc) do update set host = excluded.host, version = excluded.version, last_seen = now(),
    boot_at = excluded.boot_at, now = coalesce(excluded.now, pchealth_pcs.now),
    info = coalesce(excluded.info, pchealth_pcs.info), disks = coalesce(excluded.disks, pchealth_pcs.disks),
    box = coalesce(excluded.box, pchealth_pcs.box);

  if jsonb_typeof(p_payload->'samples') = 'array' then
    insert into public.pchealth_samples (pc, at, cpu, gpu, ram, cpu_temp, gpu_temp, gpu_power, app)
    select v_pc, x.at, x.cpu, x.gpu, x.ram, x.cpu_temp, x.gpu_temp, x.gpu_power, left(x.app, 64)
    from (select * from jsonb_to_recordset(p_payload->'samples')
            as x(at timestamptz, cpu real, gpu real, ram real, cpu_temp real, gpu_temp real, gpu_power real, app text)
          limit 2000) x
    where x.at > now() - interval '7 days' and x.at < now() + interval '1 day'
    on conflict (pc, at) do update set cpu = excluded.cpu, gpu = excluded.gpu, ram = excluded.ram,
      cpu_temp = excluded.cpu_temp, gpu_temp = excluded.gpu_temp, gpu_power = excluded.gpu_power, app = excluded.app;
    get diagnostics c = row_count; n := n || jsonb_build_object('samples', c);
  end if;

  if jsonb_typeof(p_payload->'events') = 'array' then
    insert into public.pchealth_events (pc, log, record_id, at, provider, event_id, level, kind, message, data)
    select v_pc, left(x.log, 32), x.record_id, x.at, left(x.provider, 128), x.event_id, x.level, left(x.kind, 32),
           left(x.message, 1000), x.data
    from (select * from jsonb_to_recordset(p_payload->'events')
            as x(log text, record_id bigint, at timestamptz, provider text, event_id int, level int, kind text, message text, data jsonb)
          limit 1000) x
    where x.record_id is not null and x.at is not null
    on conflict (pc, log, record_id, at) do nothing;
    get diagnostics c = row_count; n := n || jsonb_build_object('events', c);
  end if;

  -- Housekeeping now and then: keep 7 days of minute readings, 30 days of black boxes and 180 days of events.
  if random() < 0.003 then
    delete from public.pchealth_samples where at < now() - interval '7 days';
    delete from public.pchealth_events where at < now() - interval '180 days';
    delete from public.pchealth_lastmoments where ended_at < now() - interval '30 days';
  end if;

  return n;
end $$;
revoke all on function public.pchealth_ingest(text, jsonb) from public, authenticated;
grant execute on function public.pchealth_ingest(text, jsonb) to anon;

-- PanCafe's own log of each PC's client starting ("on") and closing ("off"), sent by the PanCafe Bridge.
-- PanCafe only writes "off" when a PC shuts down or restarts normally, so a missing "off" means a crash or power loss.
create table if not exists public.pancafe_pc_log (
  pc text not null, at timestamptz not null, event text not null,
  primary key (pc, at, event)
);
create index if not exists pancafe_pc_log_at on public.pancafe_pc_log (at);
alter table public.pancafe_pc_log enable row level security;
drop policy if exists viewer_read on public.pancafe_pc_log;
create policy viewer_read on public.pancafe_pc_log for select to authenticated using ((select public.pancafe_is_viewer()));
revoke all on public.pancafe_pc_log from anon;
grant select on public.pancafe_pc_log to authenticated;

create or replace function public.pancafe_ingest_pclog(p_token text, p_rows jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare c int;
begin
  if not exists (select 1 from public.pancafe_agent_tokens
                 where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')) then
    raise exception 'invalid agent token' using errcode = '28000';
  end if;
  insert into public.pancafe_pc_log (pc, at, event)
  select upper(left(x.pc, 32)), x.at, x.event
  from (select * from jsonb_to_recordset(p_rows) as x(pc text, at timestamptz, event text) limit 2000) x
  where x.pc is not null and x.at is not null and x.event in ('on', 'off')
  on conflict do nothing;
  get diagnostics c = row_count;
  if random() < 0.01 then delete from public.pancafe_pc_log where at < now() - interval '180 days'; end if;
  return c;
end $$;
revoke all on function public.pancafe_ingest_pclog(text, jsonb) from public, authenticated;
grant execute on function public.pancafe_ingest_pclog(text, jsonb) to anon;
