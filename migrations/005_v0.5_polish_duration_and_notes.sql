-- ============================================================================
-- Fieldnote v0.5 polish — duration + notes on stop activations
--
-- Adds:
--   - stop_activations.duration_minutes (default 20)
--   - stop_activations.notes (nullable text)
--   - activate_stop(): updated signature with optional p_duration_minutes
--     and p_notes (back-compatible via DEFAULTs so 3-arg callers still work)
--   - update_stop_activation_notes(): new RPC for the Edit-Note flow on the
--     guide bottom sheet. Updates the row in place; realtime UPDATE fans out.
--
-- Replica identity FULL on stop_activations (from migration 004) means the
-- UPDATE payload includes the new notes value, so passenger views see edits.
-- ============================================================================

alter table stop_activations add column if not exists duration_minutes int default 20;
alter table stop_activations add column if not exists notes text;

drop function if exists activate_stop(text, bigint, text);

create or replace function activate_stop(
  p_session_id text,
  p_stop_id    bigint,
  p_guide_token text,
  p_duration_minutes int default 20,
  p_notes text default null
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guide_name text;
  v_session_tour_slug text;
  v_stop_tour_slug text;
  v_row stop_activations;
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

  insert into stop_activations (session_id, stop_id, activated_by, duration_minutes, notes)
    values (p_session_id, p_stop_id, v_guide_name, p_duration_minutes, p_notes)
    on conflict (session_id, stop_id) do nothing
    returning * into v_row;

  if v_row.id is null then
    select * into v_row from stop_activations
      where session_id = p_session_id and stop_id = p_stop_id;
  end if;

  return row_to_json(v_row);
end;
$$;

grant execute on function activate_stop(text, bigint, text, int, text) to anon, authenticated;


create or replace function update_stop_activation_notes(
  p_session_id text,
  p_stop_id    bigint,
  p_guide_token text,
  p_notes text
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guide_name text;
  v_row stop_activations;
begin
  select name into v_guide_name from guides where device_token = p_guide_token;
  if v_guide_name is null then
    raise exception 'Invalid or unknown guide token' using errcode = '28000';
  end if;

  update stop_activations
    set notes = p_notes
    where session_id = p_session_id and stop_id = p_stop_id
    returning * into v_row;

  if v_row.id is null then
    raise exception 'No active stop to update (session % / stop %)', p_session_id, p_stop_id
      using errcode = 'P0002';
  end if;

  return row_to_json(v_row);
end;
$$;

grant execute on function update_stop_activation_notes(text, bigint, text, text) to anon, authenticated;
