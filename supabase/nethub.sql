-- PanCafe Bridge: Net Hub add-on (cash from NetCafe Hub, the new café app).
-- Run once in the Supabase SQL editor, after schema.sql. Safe to run again.
-- The PC agent writes only through pancafe_ingest_nethub() with the same secret token.
-- Only PC time and member top-ups paid in money are stored (no member names, no food sales:
-- food comes from the POS). Rows Net Hub imported from PanCafe's history are never sent,
-- so nothing is counted twice.

create table if not exists public.pancafe_nethub_tx (
  id bigint primary key,           -- Net Hub transactions.id
  at timestamptz not null,         -- when the money was taken
  type text not null,              -- 'time' (PC time) or 'topup' (member top-up)
  method text,                     -- how it was paid (cash, ...)
  amount numeric(12,2) not null,
  station text,                    -- PC name, for PC time
  staff text,                      -- Net Hub staff username who took the money
  note text
);
create index if not exists pancafe_nethub_tx_at on public.pancafe_nethub_tx (at);

create table if not exists public.pancafe_nethub_status (
  id int primary key default 1 check (id = 1),
  last_seen timestamptz, db_path text, newest_at timestamptz
);

do $$
declare t text;
begin
  foreach t in array array['pancafe_nethub_tx','pancafe_nethub_status'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists viewer_read on public.%I', t);
    execute format('create policy viewer_read on public.%I for select to authenticated using ((select public.pancafe_is_viewer()))', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- Payload keys (all optional):
--   rows:   [{id, at, type, method, amount, station, staff, note}]
--   window: {since, ids: [ids]}  rows since `since` that still exist in Net Hub; others in that window are removed here
--   status: {db_path, newest_at}
create or replace function public.pancafe_ingest_nethub(p_token text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare w jsonb;
begin
  if not exists (select 1 from public.pancafe_agent_tokens
                 where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')) then
    raise exception 'invalid agent token' using errcode = '28000';
  end if;

  if p_payload ? 'rows' then
    insert into public.pancafe_nethub_tx
      select * from jsonb_populate_recordset(null::public.pancafe_nethub_tx, p_payload->'rows')
    on conflict (id) do update set at=excluded.at, type=excluded.type, method=excluded.method,
      amount=excluded.amount, station=excluded.station, staff=excluded.staff, note=excluded.note;
  end if;

  if p_payload ? 'window' then
    w := p_payload->'window';
    delete from public.pancafe_nethub_tx where at >= (w->>'since')::timestamptz
      and id not in (select (x)::bigint from jsonb_array_elements_text(coalesce(w->'ids', '[]'::jsonb)) x);
  end if;

  if p_payload ? 'status' then
    insert into public.pancafe_nethub_status (id, last_seen, db_path, newest_at)
    values (1, now(), p_payload->'status'->>'db_path', (p_payload->'status'->>'newest_at')::timestamptz)
    on conflict (id) do update set last_seen=excluded.last_seen, db_path=excluded.db_path, newest_at=excluded.newest_at;
  end if;

  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.pancafe_ingest_nethub(text, jsonb) from public, authenticated;
grant execute on function public.pancafe_ingest_nethub(text, jsonb) to anon;

-- Live updates for the dashboard.
do $$ begin
  alter publication supabase_realtime add table public.pancafe_nethub_tx;
exception when duplicate_object then null; end $$;
