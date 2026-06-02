-- ============================================================================
-- Fieldnote v0.5 — editable departure time
--
-- Lets the guide change a stop's departure after activation by updating
-- duration_minutes (departure = activated_at + duration_minutes). The
-- update_stop_activation_notes RPC gains an optional p_duration_minutes
-- argument; NULL leaves the existing value untouched (so the 5-arg
-- notes/warning callers are unaffected).
--
-- The previous 5-arg overload is DROPped first: leaving both the old
-- (…, p_warning_level) and new (…, p_warning_level, p_duration_minutes)
-- signatures in place would make PostgREST ambiguous for the 5-named-arg
-- calls the client already makes. One function with trailing DEFAULTs
-- serves both shapes cleanly.
-- ============================================================================

drop function if exists update_stop_activation_notes(text, bigint, text, text, text);

create or replace function update_stop_activation_notes(
  p_session_id text,
  p_stop_id    bigint,
  p_guide_token text,
  p_notes text,
  p_warning_level text default null,
  p_duration_minutes int default null
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

  if p_warning_level is not null
     and p_warning_level not in ('none', 'info', 'caution', 'danger') then
    raise exception 'Invalid warning level: %', p_warning_level using errcode = '22023';
  end if;

  -- Clamp duration to a sane 1..360 window when provided.
  if p_duration_minutes is not null
     and (p_duration_minutes < 1 or p_duration_minutes > 360) then
    raise exception 'Invalid duration minutes: %', p_duration_minutes using errcode = '22023';
  end if;

  update stop_activations
    set notes = p_notes,
        warning_level = coalesce(p_warning_level, warning_level),
        duration_minutes = coalesce(p_duration_minutes, duration_minutes)
    where session_id = p_session_id and stop_id = p_stop_id
    returning * into v_row;

  if v_row.id is null then
    raise exception 'No active stop to update (session % / stop %)', p_session_id, p_stop_id
      using errcode = 'P0002';
  end if;

  return row_to_json(v_row);
end;
$$;

grant execute on function update_stop_activation_notes(text, bigint, text, text, text, int)
  to anon, authenticated;
