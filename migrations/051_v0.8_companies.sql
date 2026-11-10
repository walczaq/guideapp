-- ============================================================================
-- Fieldnote v0.8 — company level.
--
-- Until now everything belonged to one guide. A tour company runs 7–20 tours a
-- day with different drivers on the same buses, so the things they share move
-- up a level:
--
--   * BUSES      — one company bus list; every guide in the company picks
--                  from it on the Pickup screen. Only company admins edit it.
--   * TEXTS/GPS  — the company's own way of sending pickup texts (gateway
--                  phone or SMS provider) and its own fleet GPS connection,
--                  stored here instead of in server-wide secrets, so more
--                  than one company can use Fieldnote.
--   * TOURS      — a guide can share a tour with the company; every member
--                  can then run it or duplicate it (only the owner edits it).
--   * OVERVIEW   — admins see every tour the company is running right now.
--
-- Membership: an admin adds each guide by their Fieldnote name; there is no
-- join code. A company can have several admins and never fewer than one.
-- Guides who are in no company keep working exactly as before (050): their
-- own buses, their own tours, the server-wide text/GPS settings.
--
-- Access model as elsewhere: RLS on, NO client policies. The companies table
-- holds credentials (SMS gateway password, fleet API headers, the GPS ingest
-- key) — they are written through admin RPCs, read back only as "is set", and
-- used by the edge functions with the service role.
-- ============================================================================

create table if not exists companies (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  created_at       timestamptz not null default now(),
  -- Fleet GPS. bus_gps_key is what the fleet platform presents when pushing
  -- positions to the bus_gps function; bus_feed_* is for the pull direction.
  bus_gps_key      text not null unique
                   default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  bus_feed_url     text,
  bus_feed_headers jsonb,
  -- Pickup texts. sms_config keys — gateway: user, pass, url;
  -- twilio: sid, token, from, messaging_service_sid.
  sms_provider     text check (sms_provider in ('gateway', 'twilio')),
  sms_config       jsonb not null default '{}'::jsonb
);
alter table companies enable row level security;
-- Intentionally no client RLS policies.

alter table guides add column if not exists company_id uuid references companies(id) on delete set null;
alter table guides add column if not exists company_role text check (company_role in ('admin', 'member'));
create index if not exists guides_company_idx on guides (company_id);

alter table buses add column if not exists company_id uuid references companies(id) on delete set null;
create index if not exists buses_company_idx on buses (company_id);

-- tours.company_id set = shared with that company (owner_guide_id stays the
-- guide who built it and is still the only one who can edit it).
alter table tours add column if not exists company_id uuid references companies(id) on delete set null;
create index if not exists tours_company_idx on tours (company_id);

-- ── helpers (not callable by clients) ───────────────────────────────────────
create or replace function _guide_by_token(p_guide_token text)
returns guides language plpgsql security definer set search_path = public as $$
declare v_g guides;
begin
  select * into v_g from guides where device_token = p_guide_token;
  if v_g.id is null then
    raise exception 'Invalid or unknown guide token' using errcode = '28000';
  end if;
  return v_g;
end; $$;
revoke all on function _guide_by_token(text) from public, anon, authenticated;

-- The caller's company id, or an error unless they are one of its admins.
create or replace function _company_admin(p_guide_token text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_g guides;
begin
  v_g := _guide_by_token(p_guide_token);
  if v_g.company_id is null or v_g.company_role is distinct from 'admin' then
    raise exception 'Only a company admin can do this' using errcode = '42501';
  end if;
  return v_g.company_id;
end; $$;
revoke all on function _company_admin(text) from public, anon, authenticated;

-- May this guide see / pick this bus?
create or replace function _bus_visible(p_bus buses, p_guide guides)
returns boolean language sql immutable as $$
  select coalesce(
    (p_bus.company_id is not null and p_bus.company_id = p_guide.company_id)
    or (p_bus.company_id is null and p_bus.owner_guide_id = p_guide.id),
  false);
$$;
revoke all on function _bus_visible(buses, guides) from public, anon, authenticated;

-- ── create a company ────────────────────────────────────────────────────────
-- Any guide who isn't in one can start a company and becomes its first admin.
-- Buses they had added for themselves become the company's.
create or replace function create_company(p_guide_token text, p_name text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_g guides;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_id uuid;
begin
  v_g := _guide_by_token(p_guide_token);
  if v_g.company_id is not null then
    raise exception 'You are already in a company' using errcode = '22023';
  end if;
  if v_name is null or length(v_name) > 80 then
    raise exception 'Give the company a name (up to 80 characters)' using errcode = '22023';
  end if;
  insert into companies (name) values (v_name) returning id into v_id;
  update guides set company_id = v_id, company_role = 'admin' where id = v_g.id;
  update buses set company_id = v_id where owner_guide_id = v_g.id and company_id is null;
  return json_build_object('id', v_id, 'name', v_name);
end; $$;
grant execute on function create_company(text, text) to anon, authenticated;

-- ── members ─────────────────────────────────────────────────────────────────
-- Add a guide by the name they log in to Fieldnote with.
create or replace function company_add_member(p_guide_token text, p_guide_name text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_cid uuid;
  v_name text := btrim(coalesce(p_guide_name, ''));
  v_n int;
  v_t guides;
begin
  v_cid := _company_admin(p_guide_token);
  select count(*) into v_n from guides where lower(name) = lower(v_name);
  if v_n = 0 then
    raise exception 'No guide called "%" has a Fieldnote account yet', v_name using errcode = 'P0002';
  end if;
  if v_n > 1 then
    raise exception 'More than one guide is called "%" — ask them to rename their account first', v_name
      using errcode = '22023';
  end if;
  select * into v_t from guides where lower(name) = lower(v_name);
  if v_t.company_id = v_cid then
    return json_build_object('id', v_t.id, 'name', v_t.name, 'role', v_t.company_role);
  end if;
  if v_t.company_id is not null then
    raise exception '% is already in another company', v_t.name using errcode = '22023';
  end if;
  update guides set company_id = v_cid, company_role = 'member' where id = v_t.id;
  return json_build_object('id', v_t.id, 'name', v_t.name, 'role', 'member');
end; $$;
grant execute on function company_add_member(text, text) to anon, authenticated;

-- p_role 'admin' | 'member' changes the role; NULL removes the guide from the
-- company. The company always keeps at least one admin.
create or replace function company_set_member(p_guide_token text, p_guide_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_cid uuid;
  v_t guides;
begin
  v_cid := _company_admin(p_guide_token);
  if p_role is not null and p_role not in ('admin', 'member') then
    raise exception 'Unknown role' using errcode = '22023';
  end if;
  select * into v_t from guides where id = p_guide_id and company_id = v_cid;
  if v_t.id is null then
    raise exception 'That guide is not in your company' using errcode = 'P0002';
  end if;
  if v_t.company_role = 'admin' and p_role is distinct from 'admin'
     and (select count(*) from guides where company_id = v_cid and company_role = 'admin') <= 1 then
    raise exception 'A company needs at least one admin — make someone else an admin first'
      using errcode = '22023';
  end if;
  if p_role is null then
    update guides set company_id = null, company_role = null where id = p_guide_id;
    -- Their tours stop being shared; they keep them.
    update tours set company_id = null where owner_guide_id = p_guide_id and company_id = v_cid;
  else
    update guides set company_role = p_role where id = p_guide_id;
  end if;
end; $$;
grant execute on function company_set_member(text, uuid, text) to anon, authenticated;

-- ── settings: pickup texts ──────────────────────────────────────────────────
-- p_provider 'gateway' (the company's Android phone running SMS Gateway for
-- Android) | 'twilio' | NULL (off — fall back to the server default).
-- p_config carries that provider's fields; a secret left out or sent empty
-- keeps the stored one, so the app never needs to read a secret back.
create or replace function set_company_sms(p_guide_token text, p_provider text, p_config jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_cid uuid;
  v_old jsonb;
  v_new jsonb := '{}'::jsonb;
  v_keys text[];
  v_secret text[];
  k text;
  v text;
begin
  v_cid := _company_admin(p_guide_token);
  if p_provider is null then
    update companies set sms_provider = null, sms_config = '{}'::jsonb where id = v_cid;
    return;
  end if;
  if p_provider = 'gateway' then
    v_keys := array['user', 'pass', 'url']; v_secret := array['pass'];
  elsif p_provider = 'twilio' then
    v_keys := array['sid', 'token', 'from', 'messaging_service_sid']; v_secret := array['token'];
  else
    raise exception 'Unknown text provider' using errcode = '22023';
  end if;
  select case when sms_provider = p_provider then sms_config else '{}'::jsonb end
    into v_old from companies where id = v_cid;
  foreach k in array v_keys loop
    v := nullif(btrim(coalesce(p_config->>k, '')), '');
    if v is null and k = any(v_secret) then v := v_old->>k; end if;
    if v is not null then
      if length(v) > 300 then raise exception 'A setting is too long' using errcode = '22023'; end if;
      v_new := v_new || jsonb_build_object(k, v);
    end if;
  end loop;
  if v_new ? 'url' and v_new->>'url' !~* '^https://' then
    raise exception 'The gateway address must start with https://' using errcode = '22023';
  end if;
  if p_provider = 'gateway' and not (v_new ? 'user' and v_new ? 'pass') then
    raise exception 'Enter the username and password the gateway app shows' using errcode = '22023';
  end if;
  if p_provider = 'twilio' and not (v_new ? 'sid' and v_new ? 'token'
       and (v_new ? 'from' or v_new ? 'messaging_service_sid')) then
    raise exception 'Enter the account SID, auth token and a sender' using errcode = '22023';
  end if;
  update companies set sms_provider = p_provider, sms_config = v_new where id = v_cid;
end; $$;
grant execute on function set_company_sms(text, text, jsonb) to anon, authenticated;

-- ── settings: fleet GPS ─────────────────────────────────────────────────────
-- p_feed_url: the fleet platform's "current positions" address for the pull
--   direction ('' clears it, NULL leaves it). p_headers: request headers for
--   it, e.g. {"Authorization":"Bearer …"} (NULL leaves them, {} clears).
-- p_new_key: issue a new ingest key (the old one stops working at once).
create or replace function set_company_bus_feed(p_guide_token text, p_feed_url text,
                                                p_headers jsonb, p_new_key boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_cid uuid;
  v_url text := btrim(coalesce(p_feed_url, ''));
begin
  v_cid := _company_admin(p_guide_token);
  if p_feed_url is not null then
    if v_url <> '' and (v_url !~* '^https://[^/ ]+' or length(v_url) > 600) then
      raise exception 'The fleet address must start with https://' using errcode = '22023';
    end if;
    update companies set bus_feed_url = nullif(v_url, '') where id = v_cid;
  end if;
  if p_headers is not null then
    if jsonb_typeof(p_headers) <> 'object' or length(p_headers::text) > 2000 then
      raise exception 'Headers must be a small JSON object' using errcode = '22023';
    end if;
    update companies set bus_feed_headers = nullif(p_headers, '{}'::jsonb) where id = v_cid;
  end if;
  if p_new_key then
    update companies
       set bus_gps_key = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
     where id = v_cid;
  end if;
end; $$;
grant execute on function set_company_bus_feed(text, text, jsonb, boolean) to anon, authenticated;

-- ── the Company screen, in one round trip ───────────────────────────────────
-- NULL when the guide is in no company. Members get the name and who is in
-- it; admins also get the bus list and the settings (secrets as "is set").
create or replace function get_company(p_guide_token text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_g guides;
  v_c companies;
  v_admin boolean;
  v_out jsonb;
begin
  v_g := _guide_by_token(p_guide_token);
  if v_g.company_id is null then return null; end if;
  select * into v_c from companies where id = v_g.company_id;
  v_admin := v_g.company_role = 'admin';
  v_out := jsonb_build_object(
    'id', v_c.id, 'name', v_c.name, 'role', v_g.company_role, 'me', v_g.id,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'role', m.company_role)
                       order by (m.company_role <> 'admin'), lower(m.name))
        from guides m where m.company_id = v_c.id), '[]'::jsonb));
  if v_admin then
    v_out := v_out || jsonb_build_object(
      'buses', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', b.id, 'name', b.name, 'tracker_id', b.tracker_id, 'last_fix_at', b.last_fix_at)
               order by lower(b.name))
          from buses b where b.company_id = v_c.id), '[]'::jsonb),
      'bus_gps_key', v_c.bus_gps_key,
      'bus_feed_url', v_c.bus_feed_url,
      'bus_feed_headers_set', v_c.bus_feed_headers is not null,
      'sms_provider', v_c.sms_provider,
      'sms', jsonb_build_object(
        'user', v_c.sms_config->>'user',
        'url', v_c.sms_config->>'url',
        'pass_set', v_c.sms_config ? 'pass',
        'sid', v_c.sms_config->>'sid',
        'from', v_c.sms_config->>'from',
        'messaging_service_sid', v_c.sms_config->>'messaging_service_sid',
        'token_set', v_c.sms_config ? 'token'));
  end if;
  return v_out::json;
end; $$;
grant execute on function get_company(text) to anon, authenticated;

-- ── office overview: every tour the company is running right now ────────────
create or replace function list_company_live_sessions(p_guide_token text)
returns json language plpgsql security definer set search_path = public as $$
declare v_cid uuid;
begin
  v_cid := _company_admin(p_guide_token);
  return coalesce((
    select json_agg(json_build_object(
             'id', s.id,
             'label', s.label,
             'tour', coalesce(t.name, s.tour_slug),
             'guide', g.name,
             'started_at', s.started_at,
             'pickup_started_at', s.pickup_started_at,
             'tour_started_at', s.tour_started_at,
             'bus', b.name,
             'bus_last_fix_at', b.last_fix_at,
             'joined', (select count(*) from session_passengers p where p.session_id = s.id),
             'contacts', (select count(*) from session_contacts c where c.session_id = s.id),
             'texted', (select count(*) from session_contacts c
                         where c.session_id = s.id and c.sms_status = 'sent'))
           order by s.started_at desc)
      from sessions s
      join guides g on g.id = s.owner_guide_id
      left join tours t on t.slug = s.tour_slug
      left join buses b on b.id = s.bus_id
     where g.company_id = v_cid and s.ended_at is null), '[]'::json);
end; $$;
grant execute on function list_company_live_sessions(text) to anon, authenticated;

-- ── buses: company-aware versions of the 050 RPCs ───────────────────────────
-- In a company the bus list is the company's and only admins change it; a
-- guide in no company keeps a personal list, as in 050.
create or replace function save_bus(p_guide_token text, p_name text, p_tracker_id text,
                                    p_bus_id uuid default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_g guides;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_tracker text := nullif(btrim(coalesce(p_tracker_id, '')), '');
  v_row buses;
begin
  v_g := _guide_by_token(p_guide_token);
  if v_g.company_id is not null and v_g.company_role is distinct from 'admin' then
    raise exception 'Buses are managed by your company admin' using errcode = '42501';
  end if;
  if v_name is null or v_tracker is null then
    raise exception 'A bus needs a name and its tracker ID' using errcode = '22023';
  end if;
  if length(v_name) > 60 or length(v_tracker) > 80 then
    raise exception 'Bus name or tracker ID is too long' using errcode = '22023';
  end if;
  if p_bus_id is null then
    if (select count(*) from buses b where _bus_visible(b, v_g)) >= 300 then
      raise exception 'Too many buses' using errcode = '22023';
    end if;
    insert into buses (owner_guide_id, company_id, name, tracker_id)
      values (v_g.id, v_g.company_id, v_name, v_tracker) returning * into v_row;
  else
    select * into v_row from buses where id = p_bus_id;
    if v_row.id is null or not _bus_visible(v_row, v_g) then
      raise exception 'Bus not found' using errcode = 'P0002';
    end if;
    -- A changed tracker ID points at a different vehicle: forget the old
    -- vehicle's position rather than show it under the new one.
    update buses set
        name = v_name,
        last_lng       = case when lower(tracker_id) = lower(v_tracker) then last_lng end,
        last_lat       = case when lower(tracker_id) = lower(v_tracker) then last_lat end,
        last_heading   = case when lower(tracker_id) = lower(v_tracker) then last_heading end,
        last_speed_kmh = case when lower(tracker_id) = lower(v_tracker) then last_speed_kmh end,
        last_fix_at    = case when lower(tracker_id) = lower(v_tracker) then last_fix_at end,
        tracker_id = v_tracker
      where id = p_bus_id
      returning * into v_row;
  end if;
  return json_build_object('id', v_row.id, 'name', v_row.name, 'tracker_id', v_row.tracker_id);
end; $$;
grant execute on function save_bus(text, text, text, uuid) to anon, authenticated;

create or replace function delete_bus(p_guide_token text, p_bus_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_g guides;
  v_bus buses;
begin
  v_g := _guide_by_token(p_guide_token);
  if v_g.company_id is not null and v_g.company_role is distinct from 'admin' then
    raise exception 'Buses are managed by your company admin' using errcode = '42501';
  end if;
  select * into v_bus from buses where id = p_bus_id;
  if v_bus.id is null or not _bus_visible(v_bus, v_g) then return; end if;
  -- Hide the icon on any live tour still showing this bus.
  insert into guide_locations (session_id, source, lng, lat, is_off)
    select s.id, 'bus_gps', coalesce(v_bus.last_lng, 0), coalesce(v_bus.last_lat, 0), true
      from sessions s where s.bus_id = p_bus_id and s.ended_at is null;
  delete from buses where id = p_bus_id;
end; $$;
grant execute on function delete_bus(text, uuid) to anon, authenticated;

create or replace function set_session_bus(p_session_id text, p_guide_token text, p_bus_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_g guides;
  v_old uuid;
  v_bus buses;
begin
  perform _pickup_guide_for_session(p_session_id, p_guide_token);
  v_g := _guide_by_token(p_guide_token);
  select bus_id into v_old from sessions where id = p_session_id;
  if p_bus_id is not null then
    select * into v_bus from buses where id = p_bus_id;
    if v_bus.id is null or not _bus_visible(v_bus, v_g) then
      raise exception 'Bus not found' using errcode = 'P0002';
    end if;
  end if;
  if v_old is not distinct from p_bus_id then return; end if;
  update sessions set bus_id = p_bus_id where id = p_session_id;
  if v_bus.id is not null and v_bus.last_fix_at is not null then
    insert into guide_locations (session_id, source, lng, lat, heading, set_at)
      values (p_session_id, 'bus_gps', v_bus.last_lng, v_bus.last_lat, v_bus.last_heading, v_bus.last_fix_at);
  elsif v_old is not null then
    insert into guide_locations (session_id, source, lng, lat, is_off)
      values (p_session_id, 'bus_gps', 0, 0, true);
  end if;
end; $$;
grant execute on function set_session_bus(text, text, uuid) to anon, authenticated;

-- Adds: the company's buses, and whether this guide may edit the bus list.
create or replace function get_pickup_state(p_session_id text, p_guide_token text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_g guides;
  v_out json;
begin
  perform _pickup_guide_for_session(p_session_id, p_guide_token);
  v_g := _guide_by_token(p_guide_token);
  select json_build_object(
    'pickup_started_at', s.pickup_started_at,
    'bus_id', s.bus_id,
    'can_manage_buses', (v_g.company_id is null or v_g.company_role = 'admin'),
    'company', (select c.name from companies c where c.id = v_g.company_id),
    'buses', coalesce((
      select json_agg(json_build_object(
               'id', b.id, 'name', b.name, 'tracker_id', b.tracker_id,
               'last_lng', b.last_lng, 'last_lat', b.last_lat, 'last_fix_at', b.last_fix_at)
             order by lower(b.name))
        from buses b where _bus_visible(b, v_g)), '[]'::json),
    'contacts', coalesce((
      select json_agg(json_build_object(
               'id', c.id, 'name', c.name, 'phone', c.phone,
               'sms_status', c.sms_status, 'sms_error', c.sms_error)
             order by c.id)
        from session_contacts c where c.session_id = s.id), '[]'::json)
  ) into v_out
  from sessions s where s.id = p_session_id;
  return v_out;
end; $$;
grant execute on function get_pickup_state(text, text) to anon, authenticated;

-- ── fleet feed: scoped to one company ───────────────────────────────────────
-- p_company_id set  → only that company's buses can match (the caller proved
--                     itself with that company's ingest key).
-- p_company_id NULL → the server-wide key: only buses that belong to no
--                     company (guides running on their own, as in 050).
-- Replaces the one-argument 050 version.
drop function if exists ingest_bus_positions(jsonb);
create or replace function ingest_bus_positions(p_positions jsonb, p_company_id uuid default null)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_item jsonb;
  v_lng double precision;
  v_lat double precision;
  v_heading double precision;
  v_speed double precision;
  v_ts timestamptz;
  v_bus uuid;
  v_n integer;
  v_written integer := 0;
begin
  if p_positions is null or jsonb_typeof(p_positions) <> 'array' then return 0; end if;
  for v_item in select * from jsonb_array_elements(p_positions) loop
    begin
      v_lng := (v_item->>'lng')::double precision;
      v_lat := (v_item->>'lat')::double precision;
      v_heading := (v_item->>'heading')::double precision;
      v_speed := (v_item->>'speed')::double precision;
      v_ts := coalesce((v_item->>'ts')::timestamptz, now());
    exception when others then
      continue;   -- one malformed vehicle must not sink the batch
    end;
    if v_lng is null or v_lat is null or abs(v_lat) > 90 or abs(v_lng) > 180
       or (v_lng = 0 and v_lat = 0)                 -- trackers report 0,0 with no fix
       or jsonb_typeof(v_item->'ids') is distinct from 'array' then
      continue;
    end if;
    if v_ts > now() then v_ts := now(); end if;     -- tracker clock running ahead
    for v_bus in
      update buses set last_lng = v_lng, last_lat = v_lat, last_heading = v_heading,
                       last_speed_kmh = v_speed, last_fix_at = v_ts
       where lower(tracker_id) in (select lower(btrim(x)) from jsonb_array_elements_text(v_item->'ids') x)
         and company_id is not distinct from p_company_id
         and (last_fix_at is null or v_ts > last_fix_at + interval '4 seconds')
      returning id
    loop
      insert into guide_locations (session_id, source, lng, lat, heading, set_at)
        select s.id, 'bus_gps', v_lng, v_lat, v_heading, v_ts
          from sessions s where s.bus_id = v_bus and s.ended_at is null;
      get diagnostics v_n = row_count;
      v_written := v_written + v_n;
    end loop;
  end loop;
  return v_written;
end; $$;
revoke all on function ingest_bus_positions(jsonb, uuid) from public, anon, authenticated;
grant execute on function ingest_bus_positions(jsonb, uuid) to service_role;

-- ── tours: share with the company ───────────────────────────────────────────
create or replace function set_tour_shared(p_guide_token text, p_tour_id uuid, p_shared boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_g guides;
begin
  v_g := _guide_by_token(p_guide_token);
  if v_g.company_id is null then
    raise exception 'You are not in a company' using errcode = '22023';
  end if;
  update tours set company_id = case when p_shared then v_g.company_id end
   where id = p_tour_id and owner_guide_id = v_g.id;
  if not found then
    raise exception 'Only the guide who built a tour can share it' using errcode = 'P0002';
  end if;
end; $$;
grant execute on function set_tour_shared(text, uuid, boolean) to anon, authenticated;

-- list_guide_tours: + tours shared with my company, and two new columns
-- (company_id = shared, owner_name = who built it). Return type changes, so
-- the 011 version has to be dropped first.
drop function if exists list_guide_tours(text);
create function list_guide_tours(p_guide_token text)
returns table(id uuid, slug text, name text, subtitle text, home_lng double precision,
              home_lat double precision, owner_guide_id uuid, stop_count bigint,
              company_id uuid, owner_name text)
language plpgsql security definer set search_path = public as $$
declare v_g guides;
begin
  v_g := _guide_by_token(p_guide_token);
  return query
    select t.id, t.slug, t.name, t.subtitle, t.home_lng, t.home_lat, t.owner_guide_id,
           (select count(*) from stops s where s.tour_id = t.id),
           t.company_id,
           (select o.name from guides o where o.id = t.owner_guide_id)
    from tours t
    where t.owner_guide_id is null
       or t.owner_guide_id = v_g.id
       or (t.company_id is not null and t.company_id = v_g.company_id)
    order by (t.owner_guide_id is not null),
             (t.owner_guide_id is distinct from v_g.id),
             t.name;
end; $$;
grant execute on function list_guide_tours(text) to anon, authenticated;

-- duplicate_tour (020): a company-shared tour can be copied too. The copy is
-- the caller's own and starts unshared.
create or replace function duplicate_tour(p_guide_token text, p_tour_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_g guides; v_src tours; v_new_id uuid; v_new_slug text; v_name text;
  s record; v_new_stop bigint;
begin
  v_g := _guide_by_token(p_guide_token);
  select * into v_src from tours
   where id = p_tour_id
     and (owner_guide_id is null or owner_guide_id = v_g.id
          or (company_id is not null and company_id = v_g.company_id));
  if v_src.id is null then raise exception 'Tour not found or not accessible' using errcode = 'P0002'; end if;

  v_name := left(coalesce(v_src.name, 'Tour') || ' (copy)', 120);
  v_new_slug := regexp_replace(lower(coalesce(v_src.slug, 'tour')), '[^a-z0-9-]+', '-', 'g')
                || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 6);

  insert into tours (id, slug, name, subtitle, home_lng, home_lat, owner_guide_id)
    values (gen_random_uuid(), v_new_slug, v_name, v_src.subtitle, v_src.home_lng, v_src.home_lat, v_g.id)
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
