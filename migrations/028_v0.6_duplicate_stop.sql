-- ============================================================================
-- Fieldnote v0.6 — duplicate a stop (with all its spots/pins)
--
-- Copies a stop and every pin under it into the SAME tour, placed right after
-- the original (ordinals of later stops are bumped to make room). Name gets a
-- " (copy)" suffix and the copy is nudged a few metres east so it isn't exactly
-- on top of the original. Editable on base tours (owner null) or the guide's
-- own tours, matching the other authoring RPCs.
-- ============================================================================

create or replace function duplicate_stop(p_guide_token text, p_stop_id bigint)
returns json language plpgsql security definer set search_path = public as $$
declare v_gid uuid; v_stop stops; v_tour uuid; v_new_stop bigint;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  select s.* into v_stop
    from stops s join tours t on t.id = s.tour_id
    where s.id = p_stop_id and (t.owner_guide_id is null or t.owner_guide_id = v_gid);
  if v_stop.id is null then raise exception 'Stop not found or not editable' using errcode = 'P0002'; end if;
  v_tour := v_stop.tour_id;

  update stops set ordinal = ordinal + 1 where tour_id = v_tour and ordinal > v_stop.ordinal;
  insert into stops (tour_id, ordinal, name, subtitle, lng, lat, activation_radius_m)
    values (v_tour, v_stop.ordinal + 1,
            left(coalesce(v_stop.name, 'Stop') || ' (copy)', 200), v_stop.subtitle,
            v_stop.lng + 0.0001, v_stop.lat, v_stop.activation_radius_m)
    returning id into v_new_stop;

  insert into pins (stop_id, ordinal, title, body, lng, lat, trigger_radius_m, category)
    select v_new_stop, ordinal, title, body, lng, lat, trigger_radius_m, category
    from pins where stop_id = v_stop.id;

  return json_build_object('id', v_new_stop);
end; $$;
grant execute on function duplicate_stop(text, bigint) to anon, authenticated;
