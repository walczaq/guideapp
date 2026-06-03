-- ============================================================================
-- Fieldnote v0.6 — per-session group-chat link
--
-- The guide attaches a chat link (e.g. a WhatsApp group invite) to a session;
-- passengers get a "Group chat" button that opens it. No messages are stored
-- in Fieldnote — this is just a link, deliberately avoiding building/moderating
-- an in-app chat. Set at session creation (direct insert) or edited later via
-- set_session_chat_url (guide-token + ownership validated).
-- ============================================================================

alter table sessions add column if not exists chat_url text;

create or replace function set_session_chat_url(p_session_id text, p_guide_token text, p_chat_url text)
returns json language plpgsql security definer set search_path = public as $$
declare v_gid uuid; v_row sessions;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  update sessions
     set chat_url = nullif(btrim(coalesce(p_chat_url, '')), '')
     where id = p_session_id and owner_guide_id = v_gid
     returning * into v_row;
  if v_row.id is null then
    raise exception 'Session not found or not owned' using errcode = 'P0002';
  end if;
  return row_to_json(v_row);
end; $$;
grant execute on function set_session_chat_url(text, text, text) to anon, authenticated;
