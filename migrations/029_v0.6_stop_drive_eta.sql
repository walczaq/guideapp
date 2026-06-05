-- ============================================================================
-- Fieldnote v0.6 — store the driving ETA between stops on the tour
--
-- The GUIDE's builder computes per-leg driving seconds (Mapbox Directions) and
-- persists them here, so PASSENGERS read the "time to next stop" straight from
-- the tour data with zero Mapbox calls of their own. `drive_secs_from_prev` is
-- the driving time from the previous stop (by ordinal) to this one; the first
-- stop is null.
-- ============================================================================

alter table stops add column if not exists drive_secs_from_prev int;

-- Bulk-set the per-stop driving seconds for a tour (guide-only, editable tours).
-- p_stop_ids[i] gets p_secs[i].
create or replace function set_tour_drive_etas(p_guide_token text, p_tour_id uuid, p_stop_ids bigint[], p_secs int[])
returns void language plpgsql security definer set search_path = public as $$
declare v_gid uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  if not exists (select 1 from tours t where t.id = p_tour_id and (t.owner_guide_id is null or t.owner_guide_id = v_gid)) then
    raise exception 'Tour not found or not editable' using errcode = 'P0002';
  end if;
  update stops s set drive_secs_from_prev = d.secs
    from (select unnest(p_stop_ids) as id, unnest(p_secs) as secs) d
    where s.id = d.id and s.tour_id = p_tour_id;
end; $$;
grant execute on function set_tour_drive_etas(text, uuid, bigint[], int[]) to anon, authenticated;
