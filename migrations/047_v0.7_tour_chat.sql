-- ============================================================================
-- Fieldnote v0.7 — in-app tour chat (replaces the external WhatsApp link)
--
-- Two kinds of conversation per session, in one table:
--   * Group room   — thread_passenger_id IS NULL. Guide + every passenger.
--   * Private      — thread_passenger_id = <passenger>. Only that passenger
--                    and the session's guide can read or post.
--
-- Access model (same as the guides room, 021): RLS on, NO client policies, so
-- direct selects and realtime return nothing. Everything goes through the
-- SECURITY DEFINER RPCs below; clients poll while the chat is open.
--
-- Caller identity:
--   * Guide     — p_guide_token, must own the session (lenient for legacy
--                 sessions with owner_guide_id NULL, like 038).
--   * Passenger — p_passenger_id + p_chat_key. passenger_id alone is NOT a
--                 secret (session_passengers is public-read so the map can
--                 show names), so each device generates a random chat key and
--                 claims it once via claim_session_chat_key; we store only its
--                 md5. Without the key, another passenger who knows your id
--                 can't read your private thread with the guide.
--
-- Posting is blocked once the session has ended; reading stays available.
-- Photos: public-read bucket `session-chat`, uploads via the
-- session_chat_upload edge function (validates guide token or chat key).
-- ============================================================================

create table if not exists session_chat_messages (
  id                  bigserial primary key,
  session_id          text not null references sessions(id) on delete cascade,
  thread_passenger_id text,            -- null = group room
  sender_role         text not null check (sender_role in ('guide', 'passenger')),
  sender_passenger_id text,            -- set when sender_role = 'passenger'
  sender_name         text not null,
  body                text not null default '',
  media_url           text,
  created_at          timestamptz not null default now()
);
create index if not exists session_chat_messages_room_idx
  on session_chat_messages (session_id, thread_passenger_id, id);
alter table session_chat_messages enable row level security;
-- Intentionally no client RLS policies.

create table if not exists session_chat_keys (
  session_id   text not null references sessions(id) on delete cascade,
  passenger_id text not null,
  key_hash     text not null,
  created_at   timestamptz not null default now(),
  primary key (session_id, passenger_id)
);
alter table session_chat_keys enable row level security;
-- Intentionally no client RLS policies.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('session-chat', 'session-chat', true, 6291456, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── claim_session_chat_key ──────────────────────────────────────────────────
-- First call for (session, passenger) stores md5(key). Later calls succeed
-- only with the same key. The passenger must already have joined (have a
-- session_passengers row).
create or replace function claim_session_chat_key(p_session_id text, p_passenger_id text, p_chat_key text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_hash text; v_existing text;
begin
  if coalesce(length(p_chat_key), 0) < 24 then
    raise exception 'Invalid chat key' using errcode = '22023';
  end if;
  if not exists (select 1 from session_passengers
                 where session_id = p_session_id and passenger_id = p_passenger_id) then
    raise exception 'Not a passenger in this session' using errcode = '28000';
  end if;
  v_hash := md5(p_chat_key);
  insert into session_chat_keys (session_id, passenger_id, key_hash)
    values (p_session_id, p_passenger_id, v_hash)
    on conflict (session_id, passenger_id) do nothing;
  select key_hash into v_existing from session_chat_keys
    where session_id = p_session_id and passenger_id = p_passenger_id;
  if v_existing <> v_hash then
    raise exception 'Chat key mismatch' using errcode = '28000';
  end if;
  return true;
end; $$;
grant execute on function claim_session_chat_key(text, text, text) to anon, authenticated;

-- ── _session_chat_caller (internal) ─────────────────────────────────────────
-- Resolves who is calling. Returns role ('guide' | 'passenger'), display name,
-- passenger id (passenger only) and whether the session has ended. Raises if
-- the credentials don't check out.
create or replace function _session_chat_caller(
  p_session_id text, p_guide_token text, p_passenger_id text, p_chat_key text,
  out o_role text, out o_name text, out o_passenger_id text, out o_ended boolean
) language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_ended timestamptz; v_found boolean; v_gid uuid; v_gname text;
begin
  select true, owner_guide_id, ended_at into v_found, v_owner, v_ended
    from sessions where id = p_session_id;
  if v_found is null then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;
  o_ended := v_ended is not null;

  if nullif(btrim(coalesce(p_guide_token, '')), '') is not null then
    select id, name into v_gid, v_gname from guides where device_token = p_guide_token;
    if v_gid is null then
      raise exception 'Invalid or unknown guide token' using errcode = '28000';
    end if;
    if v_owner is not null and v_owner <> v_gid then
      raise exception 'Session not found or not owned' using errcode = 'P0002';
    end if;
    o_role := 'guide';
    o_name := coalesce(v_gname, 'Guide');
    o_passenger_id := null;
    return;
  end if;

  if not exists (select 1 from session_chat_keys
                 where session_id = p_session_id and passenger_id = p_passenger_id
                   and key_hash = md5(coalesce(p_chat_key, ''))) then
    raise exception 'Chat not authorised for this device' using errcode = '28000';
  end if;
  select name into o_name from session_passengers
    where session_id = p_session_id and passenger_id = p_passenger_id;
  o_role := 'passenger';
  o_name := coalesce(nullif(btrim(o_name), ''), 'Passenger');
  o_passenger_id := p_passenger_id;
end; $$;
revoke all on function _session_chat_caller(text, text, text, text) from public, anon, authenticated;

-- ── post_session_chat ───────────────────────────────────────────────────────
create or replace function post_session_chat(
  p_session_id text,
  p_thread_passenger_id text,   -- null = group room
  p_body text,
  p_media_url text default null,
  p_guide_token text default null,
  p_passenger_id text default null,
  p_chat_key text default null
) returns json language plpgsql security definer set search_path = public as $$
declare c record; v_body text; v_media text; v_thread text; v_id bigint; v_recent int;
begin
  select * into c from _session_chat_caller(p_session_id, p_guide_token, p_passenger_id, p_chat_key);
  if c.o_ended then
    raise exception 'This tour has ended' using errcode = '22023';
  end if;

  v_thread := nullif(btrim(coalesce(p_thread_passenger_id, '')), '');
  if c.o_role = 'passenger' then
    if v_thread is not null and v_thread <> c.o_passenger_id then
      raise exception 'Not your conversation' using errcode = '28000';
    end if;
    -- Light flood guard: at most 20 messages per minute per passenger.
    select count(*) into v_recent from session_chat_messages
      where session_id = p_session_id and sender_passenger_id = c.o_passenger_id
        and created_at > now() - interval '1 minute';
    if v_recent >= 20 then
      raise exception 'Slow down a little' using errcode = '22023';
    end if;
  elsif v_thread is not null and not exists (
      select 1 from session_passengers where session_id = p_session_id and passenger_id = v_thread) then
    raise exception 'Passenger not found in this session' using errcode = 'P0002';
  end if;

  v_body  := btrim(coalesce(p_body, ''));
  v_media := nullif(btrim(coalesce(p_media_url, '')), '');
  if v_media is not null and v_media not like
     'https://xgelrfdrdvrlltcsquqh.supabase.co/storage/v1/object/public/session-chat/' || p_session_id || '/%' then
    raise exception 'Invalid media URL' using errcode = '22023';
  end if;
  if v_body = '' and v_media is null then
    raise exception 'Empty message' using errcode = '22023';
  end if;

  insert into session_chat_messages
    (session_id, thread_passenger_id, sender_role, sender_passenger_id, sender_name, body, media_url)
  values
    (p_session_id, v_thread, c.o_role, c.o_passenger_id, c.o_name, left(v_body, 1000), v_media)
  returning id into v_id;
  return json_build_object('id', v_id);
end; $$;
grant execute on function post_session_chat(text, text, text, text, text, text, text) to anon, authenticated;

-- ── list_session_chat ───────────────────────────────────────────────────────
-- One conversation (group room or one private thread). p_after_id > 0 → only
-- newer messages (cheap poll); otherwise the latest p_limit, oldest→newest.
create or replace function list_session_chat(
  p_session_id text,
  p_thread_passenger_id text,
  p_after_id bigint default 0,
  p_limit int default 100,
  p_guide_token text default null,
  p_passenger_id text default null,
  p_chat_key text default null
) returns table (id bigint, sender_role text, sender_name text, body text, media_url text,
                 created_at timestamptz, mine boolean)
language plpgsql security definer set search_path = public as $$
declare c record; v_thread text;
begin
  select * into c from _session_chat_caller(p_session_id, p_guide_token, p_passenger_id, p_chat_key);
  v_thread := nullif(btrim(coalesce(p_thread_passenger_id, '')), '');
  if c.o_role = 'passenger' and v_thread is not null and v_thread <> c.o_passenger_id then
    raise exception 'Not your conversation' using errcode = '28000';
  end if;

  return query
    select m.id, m.sender_role, m.sender_name, m.body, m.media_url, m.created_at,
           (case when c.o_role = 'guide' then m.sender_role = 'guide'
                 else coalesce(m.sender_passenger_id = c.o_passenger_id, false) end) as mine
    from (
      select * from session_chat_messages x
      where x.session_id = p_session_id
        and x.thread_passenger_id is not distinct from v_thread
        and x.id > coalesce(p_after_id, 0)
      order by x.id desc
      limit greatest(1, least(coalesce(p_limit, 100), 500))
    ) m
    order by m.id asc;
end; $$;
grant execute on function list_session_chat(text, text, bigint, int, text, text, text) to anon, authenticated;

-- ── list_session_chat_threads (guide inbox) ─────────────────────────────────
-- Every passenger in the session, with their private-thread summary. Passengers
-- who never messaged are listed too (last_id null) so the guide can start a
-- conversation. Sorted: most recent activity first, then by name.
create or replace function list_session_chat_threads(p_session_id text, p_guide_token text)
returns table (passenger_id text, passenger_name text, last_id bigint, last_body text,
               last_at timestamptz, last_from_guide boolean, last_passenger_msg_id bigint)
language plpgsql security definer set search_path = public as $$
declare c record;
begin
  select * into c from _session_chat_caller(p_session_id, p_guide_token, null, null);
  if c.o_role <> 'guide' then
    raise exception 'Guides only' using errcode = '28000';
  end if;
  return query
    select sp.passenger_id, sp.name, lm.id,
           case when lm.body = '' and lm.media_url is not null then '📷 Photo' else lm.body end,
           lm.created_at, (lm.sender_role = 'guide'),
           (select max(p.id) from session_chat_messages p
             where p.session_id = p_session_id and p.thread_passenger_id = sp.passenger_id
               and p.sender_role = 'passenger')
    from session_passengers sp
    left join lateral (
      select m.id, m.body, m.media_url, m.created_at, m.sender_role
      from session_chat_messages m
      where m.session_id = p_session_id and m.thread_passenger_id = sp.passenger_id
      order by m.id desc limit 1
    ) lm on true
    where sp.session_id = p_session_id
    order by lm.id desc nulls last, sp.name asc;
end; $$;
grant execute on function list_session_chat_threads(text, text) to anon, authenticated;

-- ── session_chat_latest (unread badge poll) ─────────────────────────────────
-- Cheap summary for the unread dot. Only counts messages from the OTHER side
-- so your own posts never light your badge.
--   group_last_id   — newest group message not sent by the caller
--   private_last_id — passenger: newest guide message in their thread;
--                     guide: newest passenger message in any private thread
create or replace function session_chat_latest(
  p_session_id text,
  p_guide_token text default null,
  p_passenger_id text default null,
  p_chat_key text default null
) returns json language plpgsql security definer set search_path = public as $$
declare c record; v_group bigint; v_private bigint;
begin
  select * into c from _session_chat_caller(p_session_id, p_guide_token, p_passenger_id, p_chat_key);
  if c.o_role = 'guide' then
    select max(id) into v_group from session_chat_messages
      where session_id = p_session_id and thread_passenger_id is null and sender_role <> 'guide';
    select max(id) into v_private from session_chat_messages
      where session_id = p_session_id and thread_passenger_id is not null and sender_role = 'passenger';
  else
    select max(id) into v_group from session_chat_messages
      where session_id = p_session_id and thread_passenger_id is null
        and sender_passenger_id is distinct from c.o_passenger_id;
    select max(id) into v_private from session_chat_messages
      where session_id = p_session_id and thread_passenger_id = c.o_passenger_id
        and sender_role = 'guide';
  end if;
  return json_build_object('group_last_id', coalesce(v_group, 0),
                           'private_last_id', coalesce(v_private, 0),
                           'ended', c.o_ended);
end; $$;
grant execute on function session_chat_latest(text, text, text, text) to anon, authenticated;
