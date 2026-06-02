-- ============================================================================
-- Fieldnote v0.6 — in-app tour authoring (Phase 1: schema + RPCs + seed)
--
-- Ownership model:
--   tours.owner_guide_id NULL = BASE tour (admin/shared, e.g. Golden Circle);
--   set = a guide-created tour. Guides may EDIT base + their own tours, but
--   only DELETE their own (base tours are protected). All writes go through
--   guide-token-validated SECURITY DEFINER RPCs, mirroring the rest of v0.5.
--
-- RPCs: list_guide_tours, create_tour, update_tour, delete_tour,
--       create_stop, update_stop, delete_stop, create_pin, update_pin,
--       delete_pin. ordinals auto-assigned (max+1); radii default
--       150 m (stop activation) / 25 m (pin trigger).
--
-- Seeds the Golden Circle base tour at the bottom (guarded, safe to re-run).
-- ============================================================================

alter table tours add column if not exists owner_guide_id uuid references guides(id);
create index if not exists tours_owner_idx on tours (owner_guide_id);

create or replace function list_guide_tours(p_guide_token text)
returns table(id uuid, slug text, name text, subtitle text, home_lng double precision,
              home_lat double precision, owner_guide_id uuid, stop_count bigint)
language plpgsql security definer set search_path = public as $$
declare v_gid uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode='28000'; end if;
  return query
    select t.id, t.slug, t.name, t.subtitle, t.home_lng, t.home_lat, t.owner_guide_id,
           (select count(*) from stops s where s.tour_id = t.id)
    from tours t
    where t.owner_guide_id is null or t.owner_guide_id = v_gid
    order by (t.owner_guide_id is not null), t.name;
end; $$;
grant execute on function list_guide_tours(text) to anon, authenticated;

create or replace function create_tour(p_guide_token text, p_name text, p_subtitle text,
                                       p_home_lng double precision, p_home_lat double precision)
returns json language plpgsql security definer set search_path = public as $$
declare v_gid uuid; v_slug text; v_row tours;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode='28000'; end if;
  if p_name is null or length(btrim(p_name))=0 then raise exception 'Name required' using errcode='22023'; end if;
  v_slug := lower(regexp_replace(btrim(p_name), '[^a-zA-Z0-9]+', '-', 'g'));
  v_slug := btrim(v_slug, '-');
  if v_slug = '' then v_slug := 'tour'; end if;
  v_slug := v_slug || '-' || substr(md5(random()::text), 1, 6);
  insert into tours (slug, name, subtitle, home_lng, home_lat, owner_guide_id, pins)
    values (v_slug, btrim(p_name), nullif(btrim(coalesce(p_subtitle,'')),''),
            p_home_lng, p_home_lat, v_gid, '[]'::jsonb)
    returning * into v_row;
  return row_to_json(v_row);
end; $$;
grant execute on function create_tour(text, text, text, double precision, double precision) to anon, authenticated;

create or replace function update_tour(p_guide_token text, p_tour_id uuid, p_name text, p_subtitle text,
                                       p_home_lng double precision, p_home_lat double precision)
returns json language plpgsql security definer set search_path = public as $$
declare v_gid uuid; v_row tours;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode='28000'; end if;
  update tours set
    name = coalesce(nullif(btrim(coalesce(p_name,'')),''), name),
    subtitle = coalesce(p_subtitle, subtitle),
    home_lng = coalesce(p_home_lng, home_lng),
    home_lat = coalesce(p_home_lat, home_lat)
    where id = p_tour_id and (owner_guide_id is null or owner_guide_id = v_gid)
    returning * into v_row;
  if v_row.id is null then raise exception 'Tour not found or not editable' using errcode='P0002'; end if;
  return row_to_json(v_row);
end; $$;
grant execute on function update_tour(text, uuid, text, text, double precision, double precision) to anon, authenticated;

create or replace function delete_tour(p_guide_token text, p_tour_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_gid uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode='28000'; end if;
  if not exists (select 1 from tours where id=p_tour_id and owner_guide_id=v_gid) then
    raise exception 'Tour not found or not owned (base tours cannot be deleted)' using errcode='P0002';
  end if;
  delete from pins where stop_id in (select id from stops where tour_id=p_tour_id);
  delete from stops where tour_id=p_tour_id;
  delete from tours where id=p_tour_id;
end; $$;
grant execute on function delete_tour(text, uuid) to anon, authenticated;

create or replace function create_stop(p_guide_token text, p_tour_id uuid, p_name text, p_subtitle text,
                                       p_lng double precision, p_lat double precision, p_activation_radius_m int)
returns json language plpgsql security definer set search_path = public as $$
declare v_gid uuid; v_ord int; v_row stops;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode='28000'; end if;
  if not exists (select 1 from tours where id=p_tour_id and (owner_guide_id is null or owner_guide_id=v_gid)) then
    raise exception 'Tour not found or not editable' using errcode='P0002'; end if;
  if p_name is null or length(btrim(p_name))=0 then raise exception 'Stop name required' using errcode='22023'; end if;
  select coalesce(max(ordinal)+1, 1) into v_ord from stops where tour_id=p_tour_id;
  insert into stops (tour_id, ordinal, name, subtitle, lng, lat, activation_radius_m)
    values (p_tour_id, v_ord, btrim(p_name), nullif(btrim(coalesce(p_subtitle,'')),''),
            p_lng, p_lat, coalesce(p_activation_radius_m, 150))
    returning * into v_row;
  return row_to_json(v_row);
end; $$;
grant execute on function create_stop(text, uuid, text, text, double precision, double precision, int) to anon, authenticated;

create or replace function update_stop(p_guide_token text, p_stop_id bigint, p_name text, p_subtitle text,
                                       p_lng double precision, p_lat double precision, p_activation_radius_m int)
returns json language plpgsql security definer set search_path = public as $$
declare v_gid uuid; v_row stops;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode='28000'; end if;
  if not exists (select 1 from stops s join tours t on t.id=s.tour_id
                 where s.id=p_stop_id and (t.owner_guide_id is null or t.owner_guide_id=v_gid)) then
    raise exception 'Stop not found or not editable' using errcode='P0002'; end if;
  update stops set
    name = coalesce(nullif(btrim(coalesce(p_name,'')),''), name),
    subtitle = coalesce(p_subtitle, subtitle),
    lng = coalesce(p_lng, lng), lat = coalesce(p_lat, lat),
    activation_radius_m = coalesce(p_activation_radius_m, activation_radius_m)
    where id = p_stop_id returning * into v_row;
  return row_to_json(v_row);
end; $$;
grant execute on function update_stop(text, bigint, text, text, double precision, double precision, int) to anon, authenticated;

create or replace function delete_stop(p_guide_token text, p_stop_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare v_gid uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode='28000'; end if;
  if not exists (select 1 from stops s join tours t on t.id=s.tour_id
                 where s.id=p_stop_id and (t.owner_guide_id is null or t.owner_guide_id=v_gid)) then
    raise exception 'Stop not found or not editable' using errcode='P0002'; end if;
  delete from pins where stop_id=p_stop_id;
  delete from stops where id=p_stop_id;
end; $$;
grant execute on function delete_stop(text, bigint) to anon, authenticated;

create or replace function create_pin(p_guide_token text, p_stop_id bigint, p_title text, p_body text,
                                      p_lng double precision, p_lat double precision, p_trigger_radius_m int)
returns json language plpgsql security definer set search_path = public as $$
declare v_gid uuid; v_ord int; v_row pins;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode='28000'; end if;
  if not exists (select 1 from stops s join tours t on t.id=s.tour_id
                 where s.id=p_stop_id and (t.owner_guide_id is null or t.owner_guide_id=v_gid)) then
    raise exception 'Stop not found or not editable' using errcode='P0002'; end if;
  if p_title is null or length(btrim(p_title))=0 then raise exception 'Pin title required' using errcode='22023'; end if;
  select coalesce(max(ordinal)+1, 1) into v_ord from pins where stop_id=p_stop_id;
  insert into pins (stop_id, ordinal, title, body, lng, lat, trigger_radius_m)
    values (p_stop_id, v_ord, btrim(p_title), coalesce(p_body,''), p_lng, p_lat, coalesce(p_trigger_radius_m, 25))
    returning * into v_row;
  return row_to_json(v_row);
end; $$;
grant execute on function create_pin(text, bigint, text, text, double precision, double precision, int) to anon, authenticated;

create or replace function update_pin(p_guide_token text, p_pin_id bigint, p_title text, p_body text,
                                      p_lng double precision, p_lat double precision, p_trigger_radius_m int)
returns json language plpgsql security definer set search_path = public as $$
declare v_gid uuid; v_row pins;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode='28000'; end if;
  if not exists (select 1 from pins p join stops s on s.id=p.stop_id join tours t on t.id=s.tour_id
                 where p.id=p_pin_id and (t.owner_guide_id is null or t.owner_guide_id=v_gid)) then
    raise exception 'Pin not found or not editable' using errcode='P0002'; end if;
  update pins set
    title = coalesce(nullif(btrim(coalesce(p_title,'')),''), title),
    body = coalesce(p_body, body),
    lng = coalesce(p_lng, lng), lat = coalesce(p_lat, lat),
    trigger_radius_m = coalesce(p_trigger_radius_m, trigger_radius_m)
    where id = p_pin_id returning * into v_row;
  return row_to_json(v_row);
end; $$;
grant execute on function update_pin(text, bigint, text, text, double precision, double precision, int) to anon, authenticated;

create or replace function delete_pin(p_guide_token text, p_pin_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare v_gid uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode='28000'; end if;
  if not exists (select 1 from pins p join stops s on s.id=p.stop_id join tours t on t.id=s.tour_id
                 where p.id=p_pin_id and (t.owner_guide_id is null or t.owner_guide_id=v_gid)) then
    raise exception 'Pin not found or not editable' using errcode='P0002'; end if;
  delete from pins where id=p_pin_id;
end; $$;
grant execute on function delete_pin(text, bigint) to anon, authenticated;

-- ── Seed: Golden Circle base tour (guarded; safe to re-run) ─────────────
do $$
declare v_tour uuid; v_s1 bigint; v_s2 bigint; v_s3 bigint;
begin
  if exists (select 1 from tours where slug='golden-circle') then return; end if;
  insert into tours (slug, name, subtitle, home_lng, home_lat, owner_guide_id, pins)
    values ('golden-circle','Golden Circle','Þingvellir · Geysir · Gullfoss', -21.9408, 64.1466, null, '[]'::jsonb)
    returning id into v_tour;
  insert into stops (tour_id, ordinal, name, subtitle, lng, lat, activation_radius_m)
    values (v_tour, 1, 'Þingvellir', 'Rift valley & old parliament', -21.1300, 64.2558, 300) returning id into v_s1;
  insert into stops (tour_id, ordinal, name, subtitle, lng, lat, activation_radius_m)
    values (v_tour, 2, 'Geysir', 'Strokkur & hot springs', -20.3017, 64.3104, 250) returning id into v_s2;
  insert into stops (tour_id, ordinal, name, subtitle, lng, lat, activation_radius_m)
    values (v_tour, 3, 'Gullfoss', 'The golden waterfall', -20.1213, 64.3275, 250) returning id into v_s3;
  insert into pins (stop_id, ordinal, title, body, lng, lat, trigger_radius_m) values
    (v_s1, 1, 'Almannagjá rift', 'Walk the path between the North American and Eurasian tectonic plates.', -21.1295, 64.2560, 60),
    (v_s1, 2, 'Lögberg (Law Rock)', 'Site of Iceland''s ancient parliament, the Alþingi, founded 930 AD.', -21.1180, 64.2433, 50),
    (v_s2, 1, 'Strokkur', 'Erupts every 5–10 minutes, up to 20–30 m high.', -20.3010, 64.3107, 40),
    (v_s2, 2, 'Great Geysir', 'The original geyser that named them all — mostly dormant now.', -20.3035, 64.3120, 40),
    (v_s3, 1, 'Upper viewpoint', 'The two-tier falls drop 32 m into a rugged canyon.', -20.1230, 64.3260, 50),
    (v_s3, 2, 'Lower path', 'Walk down toward the edge — expect spray.', -20.1200, 64.3283, 50);
end $$;
