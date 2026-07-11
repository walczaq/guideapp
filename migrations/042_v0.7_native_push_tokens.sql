-- ============================================================================
-- Fieldnote v0.7 — native push tokens (Capacitor app: FCM on Android,
-- APNs on iOS). Mirrors push_subscriptions' trust model: anon can WRITE
-- its own token via the RPC, nothing can read them back from the client;
-- only the service-role edge functions read.
-- ============================================================================

create table native_push_tokens (
  id           bigint generated always as identity primary key,
  session_id   text not null references sessions(id) on delete cascade,
  passenger_id text,
  platform     text not null check (platform in ('android', 'ios')),
  token        text not null,
  lang         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (session_id, token)
);

alter table native_push_tokens enable row level security;
-- No policies: client reads/writes go through the RPC below; edge
-- functions use the service role which bypasses RLS.

create or replace function save_native_push_token(
  p_session_id   text,
  p_passenger_id text,
  p_platform     text,
  p_token        text,
  p_lang         text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_platform not in ('android', 'ios') then
    raise exception 'Unknown platform: %', p_platform using errcode = '22023';
  end if;
  if not exists (select 1 from sessions where id = p_session_id) then
    raise exception 'Session not found: %', p_session_id using errcode = 'P0002';
  end if;
  insert into native_push_tokens (session_id, passenger_id, platform, token, lang)
  values (p_session_id, p_passenger_id, p_platform, p_token, p_lang)
  on conflict (session_id, token)
  do update set passenger_id = excluded.passenger_id,
                lang         = excluded.lang,
                updated_at   = now();
end;
$$;

grant execute on function save_native_push_token(text, text, text, text, text)
  to anon, authenticated;
