-- ============================================================================
-- Fieldnote v0.5 chunk B — activate_stop RPC
--
-- Adds a SECURITY DEFINER function that the guide app calls to insert a row
-- into stop_activations. The function:
--   1. Validates the guide token against the guides table
--   2. Validates the stop belongs to the session's tour
--   3. Inserts the activation idempotently (unique index handles re-fire)
--   4. Returns the activation row as json
--
-- Why an RPC instead of a direct INSERT with RLS:
--   The activation needs to verify "this guide owns this session" — but
--   v0.4's session schema doesn't have owner_guide_id (sessions are linked
--   to guides only by guide_name text). Until that's added, the RPC pattern
--   is the only way to do server-side authorization against guides.device_token,
--   which is the actual auth signal in v0.4.
--
--   This matches the existing pattern from v0.4 chunk A — redeem_invite_code
--   and lookup_guide_by_token are also SECURITY DEFINER RPCs.
-- ============================================================================

create or replace function activate_stop(
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
  v_row stop_activations;
begin
  -- 1. Validate guide token. NULL guide_name = unknown token; reject.
  select name
    into v_guide_name
    from guides
    where device_token = p_guide_token;

  if v_guide_name is null then
    raise exception 'Invalid or unknown guide token'
      using errcode = '28000';   -- 28000 = invalid_authorization_specification
  end if;

  -- 2. Look up the session's tour and the stop's tour. They must match.
  select tour_slug into v_session_tour_slug
    from sessions where id = p_session_id;
  if v_session_tour_slug is null then
    raise exception 'Session not found: %', p_session_id
      using errcode = 'P0002';
  end if;

  select t.slug into v_stop_tour_slug
    from stops s
    join tours t on t.id = s.tour_id
    where s.id = p_stop_id;
  if v_stop_tour_slug is null then
    raise exception 'Stop not found: %', p_stop_id
      using errcode = 'P0002';
  end if;

  if v_stop_tour_slug <> v_session_tour_slug then
    raise exception 'Stop % does not belong to session %''s tour (% vs %)',
      p_stop_id, p_session_id, v_stop_tour_slug, v_session_tour_slug
      using errcode = '22023';   -- invalid_parameter_value
  end if;

  -- 3. Insert. The unique (session_id, stop_id) index makes the on-conflict
  -- branch return the pre-existing row so the client always gets the row
  -- back (idempotent activate).
  insert into stop_activations (session_id, stop_id, activated_by)
    values (p_session_id, p_stop_id, v_guide_name)
    on conflict (session_id, stop_id) do nothing
    returning * into v_row;

  if v_row.id is null then
    select * into v_row from stop_activations
      where session_id = p_session_id and stop_id = p_stop_id;
  end if;

  return row_to_json(v_row);
end;
$$;

-- Allow callers to execute via the anon and authenticated roles (Supabase JS
-- client uses the publishable key which maps to anon).
grant execute on function activate_stop(text, bigint, text) to anon, authenticated;
