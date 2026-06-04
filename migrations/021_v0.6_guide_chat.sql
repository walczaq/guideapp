-- ============================================================================
-- Fieldnote v0.6 — guides-only community chat room
--
-- One global chat for every Fieldnote guide. NOT tied to any session or
-- passenger — a staff lounge / community room.
--
-- Privacy: the app has no per-user JWT (guides and passengers share the anon
-- key), so we can't tell them apart at the RLS layer. Instead BOTH reading and
-- posting go through SECURITY DEFINER RPCs validated by the guide device token.
-- RLS is enabled with NO client policies, so direct selects (and realtime,
-- which would force a public-read policy) return nothing — only a registered
-- guide, via the token-checked RPCs, can read or post. The client polls
-- list_guide_chat while the room is open.
-- ============================================================================

create table if not exists guide_chat_messages (
  id          bigserial primary key,
  guide_id    uuid not null references guides(id) on delete cascade,
  guide_name  text not null,
  body        text not null,
  created_at  timestamptz default now()
);
create index if not exists guide_chat_messages_id_idx on guide_chat_messages (id);

alter table guide_chat_messages enable row level security;
-- Intentionally no client RLS policies: all access is via the RPCs below.

-- Post a message to the global guides room. Validated by device token; stamps
-- the message with the guide's current display name so the room reads even if
-- the guide row is later renamed.
create or replace function post_guide_chat(p_guide_token text, p_body text)
returns json language plpgsql security definer set search_path = public as $$
declare v_gid uuid; v_name text; v_body text; v_id bigint;
begin
  select g.id, g.name into v_gid, v_name from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  v_body := btrim(coalesce(p_body, ''));
  if v_body = '' then raise exception 'Empty message' using errcode = '22023'; end if;
  insert into guide_chat_messages (guide_id, guide_name, body)
    values (v_gid, v_name, left(v_body, 1000))
    returning id into v_id;
  return json_build_object('id', v_id);
end; $$;
grant execute on function post_guide_chat(text, text) to anon, authenticated;

-- Read the room. With p_after_id > 0 returns only newer messages (cheap poll);
-- otherwise the most recent p_limit, oldest→newest. `mine` flags the caller's
-- own messages for right-aligned styling.
create or replace function list_guide_chat(p_guide_token text, p_limit int default 100, p_after_id bigint default 0)
returns table (id bigint, guide_id uuid, guide_name text, body text, created_at timestamptz, mine boolean)
language plpgsql security definer set search_path = public as $$
declare v_gid uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  if coalesce(p_after_id, 0) > 0 then
    return query
      select m.id, m.guide_id, m.guide_name, m.body, m.created_at, (m.guide_id = v_gid) as mine
      from guide_chat_messages m
      where m.id > p_after_id
      order by m.id asc
      limit 500;
  else
    return query
      select m.id, m.guide_id, m.guide_name, m.body, m.created_at, (m.guide_id = v_gid) as mine
      from (
        select * from guide_chat_messages
        order by id desc
        limit greatest(1, least(coalesce(p_limit, 100), 500))
      ) m
      order by m.id asc;
  end if;
end; $$;
grant execute on function list_guide_chat(text, int, bigint) to anon, authenticated;
