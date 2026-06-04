-- ============================================================================
-- Fieldnote v0.6 — hard-delete a session (guide side)
--
-- end_session only sets ended_at (session stays in the list as history).
-- delete_session removes it entirely. Ownership is validated via the guide
-- token. Non-cascading children (guide_locations, passenger_locations,
-- session_passengers are ON DELETE NO ACTION) are removed first;
-- push_subscriptions + stop_activations cascade on the session delete.
-- ============================================================================

create or replace function delete_session(p_session_id text, p_guide_token text)
returns void language plpgsql security definer set search_path = public as $$
declare v_gid uuid; v_owner uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  select owner_guide_id into v_owner from sessions where id = p_session_id;
  if v_owner is null or v_owner <> v_gid then
    raise exception 'Session not found or not owned' using errcode = 'P0002';
  end if;
  delete from guide_locations    where session_id = p_session_id;
  delete from passenger_locations where session_id = p_session_id;
  delete from session_passengers  where session_id = p_session_id;
  delete from sessions where id = p_session_id and owner_guide_id = v_gid;
end; $$;
grant execute on function delete_session(text, text) to anon, authenticated;
