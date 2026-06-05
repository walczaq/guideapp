-- ============================================================================
-- Fieldnote v0.6 — guide-declared "next stop" for the live banner
--
-- The guide sets which stop is next (prompted after deactivating a stop); the
-- value lives on the session and is delivered to passengers over the existing
-- sessions realtime channel. The passenger banner shows this stop (+ its stored
-- driving ETA) and only falls back to "first not-yet-activated" when the guide
-- hasn't set one (or the set one has since been activated).
-- ============================================================================

alter table sessions add column if not exists next_stop_id bigint references stops(id) on delete set null;

-- Guide (session owner) sets/clears the next stop. p_stop_id null clears it.
create or replace function set_session_next_stop(p_session_id text, p_guide_token text, p_stop_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare v_gid uuid; v_owner uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  select owner_guide_id into v_owner from sessions where id = p_session_id;
  if v_owner is null or v_owner <> v_gid then
    raise exception 'Session not found or not owned' using errcode = 'P0002';
  end if;
  update sessions set next_stop_id = p_stop_id where id = p_session_id;
end; $$;
grant execute on function set_session_next_stop(text, text, bigint) to anon, authenticated;
