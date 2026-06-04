-- ============================================================================
-- Fieldnote v0.6 — duplicate a tour
--
-- A guide can copy any tour they can see (a base tour or one of their own)
-- into a NEW tour they own — the way to make an editable "version" of a base
-- tour without changing the original. Copies all stops and their pins.
-- ============================================================================

create or replace function duplicate_tour(p_guide_token text, p_tour_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_gid uuid; v_src tours; v_new_id uuid; v_new_slug text; v_name text;
  s record; v_new_stop bigint;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  select * into v_src from tours where id = p_tour_id and (owner_guide_id is null or owner_guide_id = v_gid);
  if v_src.id is null then raise exception 'Tour not found or not accessible' using errcode = 'P0002'; end if;

  v_name := left(coalesce(v_src.name, 'Tour') || ' (copy)', 120);
  v_new_slug := regexp_replace(lower(coalesce(v_src.slug, 'tour')), '[^a-z0-9-]+', '-', 'g')
                || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 6);

  insert into tours (id, slug, name, subtitle, home_lng, home_lat, owner_guide_id)
    values (gen_random_uuid(), v_new_slug, v_name, v_src.subtitle, v_src.home_lng, v_src.home_lat, v_gid)
    returning id into v_new_id;

  for s in select * from stops where tour_id = p_tour_id order by ordinal loop
    insert into stops (tour_id, ordinal, name, subtitle, lng, lat, activation_radius_m)
      values (v_new_id, s.ordinal, s.name, s.subtitle, s.lng, s.lat, s.activation_radius_m)
      returning id into v_new_stop;
    insert into pins (stop_id, ordinal, title, body, lng, lat, trigger_radius_m, category)
      select v_new_stop, ordinal, title, body, lng, lat, trigger_radius_m, category
      from pins where stop_id = s.id;
  end loop;

  return json_build_object('id', v_new_id, 'slug', v_new_slug, 'name', v_name);
end; $$;
grant execute on function duplicate_tour(text, uuid) to anon, authenticated;
