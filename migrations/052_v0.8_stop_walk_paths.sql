-- ============================================================================
-- Fieldnote v0.8 — walking paths between a stop's spots
--
-- The spot trail (the line joining a stop's spots in walking order) was a
-- straight line from spot to spot. The GUIDE's builder now asks Mapbox
-- Directions (walking) for each leg once and stores the result here, so
-- PASSENGERS draw the trail along the real footpaths with no Mapbox call of
-- their own — same idea as drive_secs_from_prev (migration 029).
--
-- stops.walk_path = { "v": 1, "legs": { "<lngA>,<latA>;<lngB>,<latB>": [[lng,lat],…] } }
-- One entry per leg, keyed by the two spots' coordinates (5 decimals), so a
-- moved or reordered spot simply stops matching and that leg falls back to a
-- straight line until the builder recomputes it. An empty array means "asked,
-- no sensible footpath" (also drawn straight).
--
-- The app reads this column with its own tolerant query, so the app works
-- (straight trails) whether or not this migration has been applied.
-- ============================================================================

alter table stops add column if not exists walk_path jsonb;

create or replace function set_stop_walk_path(p_guide_token text, p_stop_id bigint, p_path jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_gid uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  if not exists (
    select 1 from stops s join tours t on t.id = s.tour_id
    where s.id = p_stop_id and can_edit_tour_owner(t.owner_guide_id, v_gid)
  ) then
    raise exception 'Stop not found or not editable' using errcode = 'P0002';
  end if;
  if p_path is not null and pg_column_size(p_path) > 300000 then
    raise exception 'Walk path too large' using errcode = '22023';
  end if;
  update stops set walk_path = p_path where id = p_stop_id;
end; $$;
grant execute on function set_stop_walk_path(text, bigint, jsonb) to anon, authenticated;
