-- ============================================================================
-- Fieldnote v0.6 — anonymous posting in the guides room
--
-- A guide can post anonymously. When anon, the message's display name is stored
-- as "Anonymous". The real guide_id is still recorded (for the sender's own
-- "mine" highlight and for accountability/moderation) but is NEVER returned to
-- other clients — list_guide_chat drops the guide_id column entirely and only
-- exposes a server-computed `mine` boolean, so peers can't correlate anonymous
-- messages back to a guide.
-- ============================================================================

alter table guide_chat_messages add column if not exists anon boolean not null default false;

-- Replace post: add p_anon. Display name becomes 'Anonymous' when set.
drop function if exists post_guide_chat(text, text);
create or replace function post_guide_chat(p_guide_token text, p_body text, p_anon boolean default false)
returns json language plpgsql security definer set search_path = public as $$
declare v_gid uuid; v_name text; v_body text; v_id bigint; v_anon boolean;
begin
  select g.id, g.name into v_gid, v_name from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  v_body := btrim(coalesce(p_body, ''));
  if v_body = '' then raise exception 'Empty message' using errcode = '22023'; end if;
  v_anon := coalesce(p_anon, false);
  insert into guide_chat_messages (guide_id, guide_name, body, anon)
    values (v_gid, case when v_anon then 'Anonymous' else v_name end, left(v_body, 1000), v_anon)
    returning id into v_id;
  return json_build_object('id', v_id);
end; $$;
grant execute on function post_guide_chat(text, text, boolean) to anon, authenticated;

-- Replace list: drop guide_id from the output (return type changes, so DROP
-- first). `mine` is still computed server-side against the caller's id.
drop function if exists list_guide_chat(text, int, bigint);
create or replace function list_guide_chat(p_guide_token text, p_limit int default 100, p_after_id bigint default 0)
returns table (id bigint, guide_name text, body text, created_at timestamptz, mine boolean)
language plpgsql security definer set search_path = public as $$
declare v_gid uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  if coalesce(p_after_id, 0) > 0 then
    return query
      select m.id, m.guide_name, m.body, m.created_at, (m.guide_id = v_gid) as mine
      from guide_chat_messages m
      where m.id > p_after_id
      order by m.id asc
      limit 500;
  else
    return query
      select m.id, m.guide_name, m.body, m.created_at, (m.guide_id = v_gid) as mine
      from (
        select * from guide_chat_messages
        order by id desc
        limit greatest(1, least(coalesce(p_limit, 100), 500))
      ) m
      order by m.id asc;
  end if;
end; $$;
grant execute on function list_guide_chat(text, int, bigint) to anon, authenticated;
