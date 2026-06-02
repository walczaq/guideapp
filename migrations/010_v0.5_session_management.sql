-- ============================================================================
-- Fieldnote v0.5 — per-guide session management
--
-- v0.4 linked sessions to a guide only by free-text guide_name, so a guide
-- couldn't see/resume/clean their own sessions (only the single localStorage
-- "last session" memo). This adds real ownership + management RPCs:
--   - sessions.owner_guide_id (uuid → guides.id), set on create, backfilled
--     for existing rows by matching guide_name to a guide.
--   - list_guide_sessions   — the calling guide's sessions, active first.
--   - rename_session         — relabel a session the guide owns.
--   - cleanup_stale_sessions — auto-end the guide's sessions still active
--                              after N hours (default 12), run on guide login.
--
-- Ending is handled by the existing end_session(session_id, guide_token) RPC.
-- All new RPCs are SECURITY DEFINER and validate the device token → guide.
-- ============================================================================

alter table sessions add column if not exists owner_guide_id uuid references guides(id);
create index if not exists sessions_owner_idx on sessions (owner_guide_id);

-- Backfill existing rows by matching the free-text guide_name to a guide.
update sessions s
  set owner_guide_id = g.id
  from guides g
  where s.owner_guide_id is null and s.guide_name = g.name;

-- List the calling guide's sessions, active first then most-recent.
create or replace function list_guide_sessions(p_guide_token text)
returns table(id text, label text, tour_slug text, started_at timestamptz, ended_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare v_gid uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then
    raise exception 'Invalid or unknown guide token' using errcode = '28000';
  end if;
  return query
    select s.id, s.label, s.tour_slug, s.started_at, s.ended_at
    from sessions s
    where s.owner_guide_id = v_gid
    order by (s.ended_at is not null), coalesce(s.started_at, 'epoch'::timestamptz) desc
    limit 50;
end; $$;
grant execute on function list_guide_sessions(text) to anon, authenticated;

-- Rename a session the guide owns.
create or replace function rename_session(p_session_id text, p_guide_token text, p_label text)
returns json language plpgsql security definer set search_path = public as $$
declare v_gid uuid; v_row sessions;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then
    raise exception 'Invalid or unknown guide token' using errcode = '28000';
  end if;
  if p_label is null or length(btrim(p_label)) = 0 then
    raise exception 'Label required' using errcode = '22023';
  end if;
  update sessions set label = btrim(p_label)
    where id = p_session_id and owner_guide_id = v_gid
    returning * into v_row;
  if v_row.id is null then
    raise exception 'Session not found or not owned' using errcode = 'P0002';
  end if;
  return row_to_json(v_row);
end; $$;
grant execute on function rename_session(text, text, text) to anon, authenticated;

-- Auto-end the guide's own sessions still active after p_hours. Returns count.
create or replace function cleanup_stale_sessions(p_guide_token text, p_hours int default 12)
returns integer language plpgsql security definer set search_path = public as $$
declare v_gid uuid; v_count int;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then
    raise exception 'Invalid or unknown guide token' using errcode = '28000';
  end if;
  update sessions set ended_at = now()
    where owner_guide_id = v_gid and ended_at is null
      and coalesce(started_at, 'epoch'::timestamptz) < now() - make_interval(hours => greatest(1, p_hours));
  get diagnostics v_count = row_count;
  return v_count;
end; $$;
grant execute on function cleanup_stale_sessions(text, int) to anon, authenticated;
