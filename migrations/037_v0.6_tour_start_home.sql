-- ============================================================================
-- Fieldnote v0.6 — boarding → "Start tour" + home origin for the route line.
--
-- The guide boards passengers (headcount screen), then taps "Start tour", which
-- stamps tour_started_at and captures the boarding location (home_*). The route
-- line then draws from home to the first attraction. Both flags live on the
-- session so passengers get them over the existing sessions realtime channel.
-- ============================================================================

alter table sessions add column if not exists tour_started_at timestamptz;
alter table sessions add column if not exists home_lng double precision;
alter table sessions add column if not exists home_lat double precision;

create or replace function start_tour(p_session_id text, p_guide_token text,
                                      p_home_lng double precision, p_home_lat double precision)
returns void language plpgsql security definer set search_path = public as $$
declare v_gid uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  -- coalesce so a re-tap never moves the original start time / home.
  update sessions set
    tour_started_at = coalesce(tour_started_at, now()),
    home_lng = coalesce(home_lng, p_home_lng),
    home_lat = coalesce(home_lat, p_home_lat)
  where id = p_session_id;
end; $$;
grant execute on function start_tour(text, text, double precision, double precision) to anon, authenticated;
