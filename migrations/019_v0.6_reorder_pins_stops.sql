-- ============================================================================
-- Fieldnote v0.6 — reorder pins within a stop / stops within a tour
--
-- Walking order is the ordinal sequence. These RPCs take the ids in the
-- desired order and set ordinal = array position (1-based). Ownership is
-- validated via the guide token. Ordinals are bumped out of the way first so
-- there are no transient collisions if a unique (parent, ordinal) index ever
-- exists. The client passes ALL of a stop's pins / a tour's stops each call.
-- ============================================================================

create or replace function reorder_pins(p_guide_token text, p_stop_id bigint, p_pin_ids bigint[])
returns void language plpgsql security definer set search_path = public as $$
declare v_gid uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  if not exists (select 1 from stops s join tours t on t.id = s.tour_id
                 where s.id = p_stop_id and (t.owner_guide_id is null or t.owner_guide_id = v_gid)) then
    raise exception 'Stop not found or not editable' using errcode = 'P0002'; end if;
  update pins set ordinal = ordinal + 100000 where stop_id = p_stop_id;
  update pins set ordinal = pos.idx
    from (select id, ordinality::int as idx from unnest(p_pin_ids) with ordinality as u(id, ordinality)) pos
    where pins.id = pos.id and pins.stop_id = p_stop_id;
end; $$;
grant execute on function reorder_pins(text, bigint, bigint[]) to anon, authenticated;

create or replace function reorder_stops(p_guide_token text, p_tour_id uuid, p_stop_ids bigint[])
returns void language plpgsql security definer set search_path = public as $$
declare v_gid uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  if not exists (select 1 from tours t where t.id = p_tour_id and (t.owner_guide_id is null or t.owner_guide_id = v_gid)) then
    raise exception 'Tour not found or not editable' using errcode = 'P0002'; end if;
  update stops set ordinal = ordinal + 100000 where tour_id = p_tour_id;
  update stops set ordinal = pos.idx
    from (select id, ordinality::int as idx from unnest(p_stop_ids) with ordinality as u(id, ordinality)) pos
    where stops.id = pos.id and stops.tour_id = p_tour_id;
end; $$;
grant execute on function reorder_stops(text, uuid, bigint[]) to anon, authenticated;
