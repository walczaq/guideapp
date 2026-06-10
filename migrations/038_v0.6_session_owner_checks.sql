-- ============================================================================
-- Fieldnote v0.6 — session-ownership checks on live-control RPCs (smoketest S3)
--
-- Problem: activate_stop / deactivate_stop / end_session /
-- update_stop_activation_notes accepted ANY valid guide token on ANY session —
-- a logged-in guide could control another guide's live tour. This was
-- inconsistent with set_session_next_stop (030), which already enforces
-- "Session not found or not owned".
--
-- Fix: each RPC now resolves the caller's guide id and requires
-- sessions.owner_guide_id to match. Sessions whose owner_guide_id is NULL
-- (pre-010 legacy rows the backfill couldn't match) stay controllable by any
-- valid guide — same lenient pattern as the tour-authoring RPCs
-- (`owner_guide_id is null or owner_guide_id = v_gid`) — so nothing old
-- bricks. Every session created since 010 has an owner and is now protected.
--
-- ⚠ Before applying to prod: resolve the duplicate "Filip" guide accounts
-- (a3efb519 desktop / 47f6c087 mobile). After this migration a guide token
-- can no longer drive a session owned by the *other* account.
-- ============================================================================

-- ── activate_stop (signature unchanged from 006) ───────────────────────────
create or replace function activate_stop(
  p_session_id text,
  p_stop_id    bigint,
  p_guide_token text,
  p_duration_minutes int default 20,
  p_notes text default null,
  p_warning_level text default 'none'
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gid uuid;
  v_guide_name text;
  v_owner uuid;
  v_session_tour_slug text;
  v_stop_tour_slug text;
  v_row stop_activations;
begin
  select id, name into v_gid, v_guide_name from guides where device_token = p_guide_token;
  if v_gid is null then
    raise exception 'Invalid or unknown guide token' using errcode = '28000';
  end if;

  select owner_guide_id, tour_slug into v_owner, v_session_tour_slug
    from sessions where id = p_session_id;
  if v_session_tour_slug is null then
    raise exception 'Session not found: %', p_session_id using errcode = 'P0002';
  end if;
  if v_owner is not null and v_owner <> v_gid then
    raise exception 'Session not found or not owned' using errcode = 'P0002';
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

  if p_warning_level not in ('none', 'info', 'caution', 'danger') then
    raise exception 'Invalid warning level: %', p_warning_level using errcode = '22023';
  end if;

  insert into stop_activations (session_id, stop_id, activated_by, duration_minutes, notes, warning_level)
    values (p_session_id, p_stop_id, v_guide_name, p_duration_minutes, p_notes, p_warning_level)
    on conflict (session_id, stop_id) do nothing
    returning * into v_row;

  if v_row.id is null then
    select * into v_row from stop_activations
      where session_id = p_session_id and stop_id = p_stop_id;
  end if;

  return row_to_json(v_row);
end;
$$;

grant execute on function activate_stop(text, bigint, text, int, text, text) to anon, authenticated;


-- ── deactivate_stop (signature unchanged from 004) ──────────────────────────
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
  v_gid uuid;
  v_owner uuid;
  v_session_tour_slug text;
  v_stop_tour_slug text;
begin
  select id into v_gid from guides where device_token = p_guide_token;
  if v_gid is null then
    raise exception 'Invalid or unknown guide token' using errcode = '28000';
  end if;

  select owner_guide_id, tour_slug into v_owner, v_session_tour_slug
    from sessions where id = p_session_id;
  if v_session_tour_slug is null then
    raise exception 'Session not found: %', p_session_id using errcode = 'P0002';
  end if;
  if v_owner is not null and v_owner <> v_gid then
    raise exception 'Session not found or not owned' using errcode = 'P0002';
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


-- ── end_session (signature unchanged from 004) ──────────────────────────────
create or replace function end_session(
  p_session_id text,
  p_guide_token text
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gid uuid;
  v_owner uuid;
  v_row sessions;
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

  update sessions
    set ended_at = coalesce(ended_at, now())
    where id = p_session_id
    returning * into v_row;

  return row_to_json(v_row);
end;
$$;

grant execute on function end_session(text, text) to anon, authenticated;


-- ── update_stop_activation_notes (signature unchanged from 009) ─────────────
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
  v_gid uuid;
  v_owner uuid;
  v_row stop_activations;
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

  if p_warning_level is not null
     and p_warning_level not in ('none', 'info', 'caution', 'danger') then
    raise exception 'Invalid warning level: %', p_warning_level using errcode = '22023';
  end if;

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
