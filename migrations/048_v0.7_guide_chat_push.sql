-- ============================================================================
-- Fieldnote v0.7 — notify the guide when a passenger writes in the tour chat
--
-- Guide devices are stored separately from push_subscriptions /
-- native_push_tokens: those are per-session passenger lists that the stop
-- pushes fan out to, and a guide row there would start receiving stop pushes.
-- guide_push_targets is per GUIDE, so one opt-in covers every session they run.
--
-- Delivery: an AFTER INSERT trigger on session_chat_messages POSTs the row to
-- the send_chat_push edge function (same mechanism as a dashboard Database
-- Webhook). The function re-reads the message with the service role and
-- claims it via guide_notified_at, so each message can notify at most once —
-- calling the function by hand can't be used to spam a guide.
-- ============================================================================

create table if not exists guide_push_targets (
  id          bigint generated always as identity primary key,
  guide_id    uuid not null references guides(id) on delete cascade,
  kind        text not null check (kind in ('web', 'android', 'ios')),
  endpoint    text not null,          -- web-push endpoint, or the native token
  p256dh      text,                   -- web only
  auth        text,                   -- web only
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (guide_id, endpoint)
);
alter table guide_push_targets enable row level security;
-- No client policies: writes via the RPCs below, reads by the edge function.

alter table session_chat_messages add column if not exists guide_notified_at timestamptz;
alter table session_chat_messages add column if not exists guide_pushed boolean not null default false;

-- Save (upsert) this device as a push target for the calling guide.
create or replace function save_guide_push_target(
  p_guide_token text, p_kind text, p_endpoint text,
  p_p256dh text default null, p_auth text default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_gid uuid;
begin
  select id into v_gid from guides where device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  if p_kind not in ('web', 'android', 'ios') then
    raise exception 'Unknown kind: %', p_kind using errcode = '22023';
  end if;
  if coalesce(length(p_endpoint), 0) < 10 or length(p_endpoint) > 2000 then
    raise exception 'Invalid endpoint' using errcode = '22023';
  end if;
  if p_kind = 'web' and (p_p256dh is null or p_auth is null) then
    raise exception 'Web push needs keys' using errcode = '22023';
  end if;
  insert into guide_push_targets (guide_id, kind, endpoint, p256dh, auth)
    values (v_gid, p_kind, p_endpoint, p_p256dh, p_auth)
    on conflict (guide_id, endpoint)
    do update set kind = excluded.kind, p256dh = excluded.p256dh,
                  auth = excluded.auth, updated_at = now();
end; $$;
grant execute on function save_guide_push_target(text, text, text, text, text) to anon, authenticated;

-- Remove this device (turning notifications off).
create or replace function delete_guide_push_target(p_guide_token text, p_endpoint text)
returns void language plpgsql security definer set search_path = public as $$
declare v_gid uuid;
begin
  select id into v_gid from guides where device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  delete from guide_push_targets where guide_id = v_gid and endpoint = p_endpoint;
end; $$;
grant execute on function delete_guide_push_target(text, text) to anon, authenticated;

-- Fire the edge function for every new message. The function ignores guide
-- messages itself; filtering here too saves a call per guide post.
-- supabase_functions.http_request is what dashboard Database Webhooks use
-- (async via pg_net, never blocks or fails the insert).
drop trigger if exists session_chat_messages_guide_push on session_chat_messages;
create trigger session_chat_messages_guide_push
  after insert on session_chat_messages
  for each row
  when (new.sender_role = 'passenger')
  execute function supabase_functions.http_request(
    'https://xgelrfdrdvrlltcsquqh.supabase.co/functions/v1/send_chat_push',
    'POST',
    '{"Content-Type":"application/json"}',
    '{}',
    '5000'
  );
