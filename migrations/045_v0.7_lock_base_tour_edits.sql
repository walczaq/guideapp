-- ============================================================================
-- Fieldnote v0.7 — lock base-tour editing to admins
--
-- Motivation (2026-07-12, exposure review): the shared "base" tours
-- (south-coast, golden-circle*) have owner_guide_id IS NULL. The content RPCs
-- treated NULL-owner as "editable by ANY logged-in guide" via the check
--   (owner_guide_id IS NULL OR owner_guide_id = <me>)
-- so any registered guide — including the "Attacker" signup — could rename a
-- live tour, move its stops, or rewrite pin text. (They could never DELETE a
-- base tour; delete_tour already requires ownership.)
--
-- We must NOT simply assign the base tours an owner: list_guide_tours and
-- duplicate_tour show/allow them to every guide *precisely because* the owner
-- is NULL. Reassigning them would hide the templates from all other guides.
--
-- Fix: keep base tours NULL-owned (still listable + duplicable by everyone) but
-- gate in-place EDITS of a NULL-owned tour behind a new guides.is_admin flag.
--   editable  ==  owner = me  OR  (owner IS NULL AND I am admin)
-- Filip (the operator, 47f6c087…) is the sole admin. Owned-tour editing is
-- unchanged for everyone; listing, duplication, and running sessions are
-- untouched. Net effect: non-admin guides can no longer edit base tours.
-- ============================================================================

alter table guides add column if not exists is_admin boolean not null default false;

-- Filip — operator account, the only guide who curates the base tours.
update guides set is_admin = true
 where id = '47f6c087-b3be-4082-b7d1-76fd9114cb0e';

-- Single source of truth for "may this guide edit a tour with this owner?"
create or replace function can_edit_tour_owner(p_owner uuid, p_gid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- coalesce so a NULL-owner + non-admin yields FALSE, not NULL
  -- (NULL OR FALSE = NULL). Safe in WHERE either way, but explicit is better.
  select coalesce(
    p_owner = p_gid
    or (p_owner is null
        and exists (select 1 from guides where id = p_gid and is_admin)),
  false);
$$;
grant execute on function can_edit_tour_owner(uuid, uuid) to anon, authenticated;

-- ── content RPCs: swap the NULL-owner-is-editable check for can_edit_tour_owner ──

create or replace function create_stop(p_guide_token text, p_tour_id uuid, p_name text, p_subtitle text, p_lng double precision, p_lat double precision, p_activation_radius_m integer)
returns json language plpgsql security definer set search_path to 'public'
as $function$
declare v_gid uuid; v_ord int; v_row stops;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode='28000'; end if;
  if not exists (select 1 from tours where id=p_tour_id and can_edit_tour_owner(owner_guide_id, v_gid)) then
    raise exception 'Tour not found or not editable' using errcode='P0002'; end if;
  if p_name is null or length(btrim(p_name))=0 then raise exception 'Stop name required' using errcode='22023'; end if;
  select coalesce(max(ordinal)+1, 1) into v_ord from stops where tour_id=p_tour_id;
  insert into stops (tour_id, ordinal, name, subtitle, lng, lat, activation_radius_m)
    values (p_tour_id, v_ord, btrim(p_name), nullif(btrim(coalesce(p_subtitle,'')),''),
            p_lng, p_lat, coalesce(p_activation_radius_m, 150))
    returning * into v_row;
  return row_to_json(v_row);
end; $function$;

create or replace function update_stop(p_guide_token text, p_stop_id bigint, p_name text, p_subtitle text, p_lng double precision, p_lat double precision, p_activation_radius_m integer)
returns json language plpgsql security definer set search_path to 'public'
as $function$
declare v_gid uuid; v_row stops;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode='28000'; end if;
  if not exists (select 1 from stops s join tours t on t.id=s.tour_id
                 where s.id=p_stop_id and can_edit_tour_owner(t.owner_guide_id, v_gid)) then
    raise exception 'Stop not found or not editable' using errcode='P0002'; end if;
  update stops set
    name = coalesce(nullif(btrim(coalesce(p_name,'')),''), name),
    subtitle = coalesce(p_subtitle, subtitle),
    lng = coalesce(p_lng, lng), lat = coalesce(p_lat, lat),
    activation_radius_m = coalesce(p_activation_radius_m, activation_radius_m)
    where id = p_stop_id returning * into v_row;
  return row_to_json(v_row);
end; $function$;

create or replace function delete_stop(p_guide_token text, p_stop_id bigint)
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare v_gid uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode='28000'; end if;
  if not exists (select 1 from stops s join tours t on t.id=s.tour_id
                 where s.id=p_stop_id and can_edit_tour_owner(t.owner_guide_id, v_gid)) then
    raise exception 'Stop not found or not editable' using errcode='P0002'; end if;
  delete from pins where stop_id=p_stop_id;
  delete from stops where id=p_stop_id;
end; $function$;

create or replace function update_tour(p_guide_token text, p_tour_id uuid, p_name text, p_subtitle text, p_home_lng double precision, p_home_lat double precision)
returns json language plpgsql security definer set search_path to 'public'
as $function$
declare v_gid uuid; v_row tours;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode='28000'; end if;
  update tours set
    name = coalesce(nullif(btrim(coalesce(p_name,'')),''), name),
    subtitle = coalesce(p_subtitle, subtitle),
    home_lng = coalesce(p_home_lng, home_lng),
    home_lat = coalesce(p_home_lat, home_lat)
    where id = p_tour_id and can_edit_tour_owner(owner_guide_id, v_gid)
    returning * into v_row;
  if v_row.id is null then raise exception 'Tour not found or not editable' using errcode='P0002'; end if;
  return row_to_json(v_row);
end; $function$;

create or replace function create_pin(p_guide_token text, p_stop_id bigint, p_title text, p_body text, p_lng double precision, p_lat double precision, p_trigger_radius_m integer, p_category text DEFAULT 'pin'::text)
returns json language plpgsql security definer set search_path to 'public'
as $function$
declare v_gid uuid; v_ord int; v_row pins;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode='28000'; end if;
  if not exists (select 1 from stops s join tours t on t.id=s.tour_id
                 where s.id=p_stop_id and can_edit_tour_owner(t.owner_guide_id, v_gid)) then
    raise exception 'Stop not found or not editable' using errcode='P0002'; end if;
  if p_title is null or length(btrim(p_title))=0 then raise exception 'Pin title required' using errcode='22023'; end if;
  select coalesce(max(ordinal)+1, 1) into v_ord from pins where stop_id=p_stop_id;
  insert into pins (stop_id, ordinal, title, body, lng, lat, trigger_radius_m, category)
    values (p_stop_id, v_ord, btrim(p_title), coalesce(p_body,''), p_lng, p_lat,
            coalesce(p_trigger_radius_m, 25), coalesce(nullif(btrim(coalesce(p_category,'')),''),'pin'))
    returning * into v_row;
  return row_to_json(v_row);
end; $function$;

create or replace function update_pin(p_guide_token text, p_pin_id bigint, p_title text, p_body text, p_lng double precision, p_lat double precision, p_trigger_radius_m integer)
returns json language plpgsql security definer set search_path to 'public'
as $function$
declare v_gid uuid; v_row pins;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode='28000'; end if;
  if not exists (select 1 from pins p join stops s on s.id=p.stop_id join tours t on t.id=s.tour_id
                 where p.id=p_pin_id and can_edit_tour_owner(t.owner_guide_id, v_gid)) then
    raise exception 'Pin not found or not editable' using errcode='P0002'; end if;
  update pins set
    title = coalesce(nullif(btrim(coalesce(p_title,'')),''), title),
    body = coalesce(p_body, body),
    lng = coalesce(p_lng, lng), lat = coalesce(p_lat, lat),
    trigger_radius_m = coalesce(p_trigger_radius_m, trigger_radius_m)
    where id = p_pin_id returning * into v_row;
  return row_to_json(v_row);
end; $function$;

create or replace function delete_pin(p_guide_token text, p_pin_id bigint)
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare v_gid uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode='28000'; end if;
  if not exists (select 1 from pins p join stops s on s.id=p.stop_id join tours t on t.id=s.tour_id
                 where p.id=p_pin_id and can_edit_tour_owner(t.owner_guide_id, v_gid)) then
    raise exception 'Pin not found or not editable' using errcode='P0002'; end if;
  delete from pins where id=p_pin_id;
end; $function$;

create or replace function duplicate_stop(p_guide_token text, p_stop_id bigint)
returns json language plpgsql security definer set search_path to 'public'
as $function$
declare v_gid uuid; v_stop stops; v_tour uuid; v_new_stop bigint;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  select s.* into v_stop
    from stops s join tours t on t.id = s.tour_id
    where s.id = p_stop_id and can_edit_tour_owner(t.owner_guide_id, v_gid);
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
end; $function$;

create or replace function reorder_pins(p_guide_token text, p_stop_id bigint, p_pin_ids bigint[])
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare v_gid uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  if not exists (select 1 from stops s join tours t on t.id = s.tour_id
                 where s.id = p_stop_id and can_edit_tour_owner(t.owner_guide_id, v_gid)) then
    raise exception 'Stop not found or not editable' using errcode = 'P0002'; end if;
  update pins set ordinal = ordinal + 100000 where stop_id = p_stop_id;
  update pins set ordinal = pos.idx
    from (select id, ordinality::int as idx from unnest(p_pin_ids) with ordinality as u(id, ordinality)) pos
    where pins.id = pos.id and pins.stop_id = p_stop_id;
end; $function$;

create or replace function reorder_stops(p_guide_token text, p_tour_id uuid, p_stop_ids bigint[])
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare v_gid uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  if not exists (select 1 from tours t where t.id = p_tour_id and can_edit_tour_owner(t.owner_guide_id, v_gid)) then
    raise exception 'Tour not found or not editable' using errcode = 'P0002'; end if;
  update stops set ordinal = ordinal + 100000 where tour_id = p_tour_id;
  update stops set ordinal = pos.idx
    from (select id, ordinality::int as idx from unnest(p_stop_ids) with ordinality as u(id, ordinality)) pos
    where stops.id = pos.id and stops.tour_id = p_tour_id;
end; $function$;

create or replace function set_tour_drive_etas(p_guide_token text, p_tour_id uuid, p_stop_ids bigint[], p_secs integer[])
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare v_gid uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  if not exists (select 1 from tours t where t.id = p_tour_id and can_edit_tour_owner(t.owner_guide_id, v_gid)) then
    raise exception 'Tour not found or not editable' using errcode = 'P0002';
  end if;
  update stops s set drive_secs_from_prev = d.secs
    from (select unnest(p_stop_ids) as id, unnest(p_secs) as secs) d
    where s.id = d.id and s.tour_id = p_tour_id;
end; $function$;
