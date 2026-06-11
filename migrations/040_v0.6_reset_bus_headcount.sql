-- ============================================================================
-- Fieldnote v0.6 — reset the bus headcount when a new stop begins (trial 2
-- field obs 13)
--
-- in_bus was designed sticky-forever (015): once a passenger reached the bus
-- pin they stayed counted for the rest of the day. On the live tour that made
-- the headcount carry over between stops — the guide deactivated one stop,
-- activated the next, and the timer card still said "3/8 in bus" from the
-- previous stop.
--
-- A new ACTIVATION is the natural reset point: the bus has arrived somewhere
-- new and everyone is getting off, so the count starts over. The flag stays
-- sticky WITHIN a stop (a boarded passenger whose phone goes quiet stays
-- counted — the original design intent is preserved per-stop).
--
-- Called by the guide client right after a successful activate_stop. Same
-- owner-check pattern as 038.
-- ============================================================================

create or replace function reset_bus_headcount(
  p_session_id text,
  p_guide_token text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gid uuid;
  v_owner uuid;
begin
  select id into v_gid from guides where device_token = p_guide_token;
  if v_gid is null then
    raise exception 'Invalid or unknown guide token' using errcode = '28000';
  end if;

  select owner_guide_id into v_owner from sessions where id = p_session_id;
  if not found then
    raise exception 'Session not found: %', p_session_id using errcode = 'P0002';
  end if;
  if v_owner is not null and v_owner <> v_gid then
    raise exception 'Session not found or not owned' using errcode = 'P0002';
  end if;

  update session_passengers
     set in_bus = false, in_bus_at = null
   where session_id = p_session_id and in_bus = true;
end;
$$;

grant execute on function reset_bus_headcount(text, text) to anon, authenticated;
