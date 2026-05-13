-- ============================================================================
-- Fieldnote v0.5 — session control RPCs (deactivate, end) + sessions realtime
--
-- Two new RPCs mirror activate_stop's auth/validation pattern:
--   deactivate_stop(session_id, stop_id, guide_token) → deletes the
--     stop_activations row. Realtime DELETE fires on stop_activations and
--     all clients hide the stop's pins.
--   end_session(session_id, guide_token) → sets sessions.ended_at = now().
--     Realtime UPDATE fires on sessions and passenger clients show an
--     "end of tour" state.
--
-- Also adds sessions to the realtime publication so the UPDATE above
-- actually propagates. stop_activations was added in migration 003 and
-- DELETE events fire on it automatically.
-- ============================================================================

create or replace function deactivate_stop(
  p_session_id text,
  p_stop_id    bigint,
  p_guide_token text
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guide_name text;
  v_session_tour_slug text;
  v_stop_tour_slug text;
begin
  select name into v_guide_name from guides where device_token = p_guide_token;
  if v_guide_name is null then
    raise exception 'Invalid or unknown guide token' using errcode = '28000';
  end if;

  select tour_slug into v_session_tour_slug from sessions where id = p_session_id;
  if v_session_tour_slug is null then
    raise exception 'Session not found: %', p_session_id using errcode = 'P0002';
  end if;

  select t.slug into v_stop_tour_slug
    from stops s join tours t on t.id = s.tour_id
    where s.id = p_stop_id;
  if v_stop_tour_slug is null then
    raise exception 'Stop not found: %', p_stop_id using errcode = 'P0002';
  end if;

  if v_stop_tour_slug <> v_session_tour_slug then
    raise exception 'Stop % does not belong to session %''s tour', p_stop_id, p_session_id
      using errcode = '22023';
  end if;

  delete from stop_activations
    where session_id = p_session_id and stop_id = p_stop_id;

  return json_build_object('session_id', p_session_id, 'stop_id', p_stop_id);
end;
$$;

grant execute on function deactivate_stop(text, bigint, text) to anon, authenticated;


create or replace function end_session(
  p_session_id text,
  p_guide_token text
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guide_name text;
  v_row sessions;
begin
  select name into v_guide_name from guides where device_token = p_guide_token;
  if v_guide_name is null then
    raise exception 'Invalid or unknown guide token' using errcode = '28000';
  end if;

  update sessions
    set ended_at = coalesce(ended_at, now())
    where id = p_session_id
    returning * into v_row;

  if v_row.id is null then
    raise exception 'Session not found: %', p_session_id using errcode = 'P0002';
  end if;

  return row_to_json(v_row);
end;
$$;

grant execute on function end_session(text, text) to anon, authenticated;


alter publication supabase_realtime add table sessions;

-- Realtime DELETE events only carry the primary key by default; we need
-- stop_id in the payload so clients know which stop got deactivated.
alter table stop_activations replica identity full;
alter table sessions replica identity full;
