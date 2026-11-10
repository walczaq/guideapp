-- ============================================================================
-- Fieldnote v0.8 — pickup phase + live bus position from the fleet's GPS.
--
-- What the guide gets:
--   * "Pickup": before the tour starts the guide pastes the passengers' phone
--     numbers, picks today's bus and taps Start pickup. Every passenger gets an
--     SMS with the session's Fieldnote link (send_pickup_sms edge function), so
--     they join — and are counted on the boarding screen — before the bus
--     reaches them.
--   * The bus is shown on the passengers' map from the bus's OWN GPS tracker
--     (bus_gps edge function → ingest_bus_positions below), from pickup until
--     the session ends. No guide phone, no manual pin needed.
--
-- Data flow for the bus position: the fleet feed reports "vehicle X is at
-- lng/lat". Every `buses` row whose tracker_id matches gets its last position
-- updated, and one guide_locations row (source 'bus_gps') is written for each
-- LIVE session that bus is attached to. Passengers already listen to
-- guide_locations for the guide dot / manual bus pin, so the bus icon rides
-- the existing realtime channel.
--
-- Access model (same as chat, 021/047): RLS on, NO client policies. Phone
-- numbers and the bus list are only reachable through the guide-token RPCs
-- below; ingest_bus_positions is service-role only.
-- ============================================================================

-- ── guide_locations: allow the new source + carry a heading ────────────────
-- The original check constraint predates the migrations folder, so its name
-- isn't known — drop whichever check mentions `source`.
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'guide_locations'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%source%'
  loop
    execute format('alter table guide_locations drop constraint %I', c);
  end loop;
end $$;
alter table guide_locations
  add constraint guide_locations_source_check
  check (source in ('phone', 'bus_pin', 'bus_gps'));
alter table guide_locations add column if not exists heading double precision;

-- ── buses ───────────────────────────────────────────────────────────────────
-- One row per bus per guide account. tracker_id is whatever the fleet platform
-- calls the vehicle (its id, name or number plate) — matched case-insensitively
-- against every identifier the feed sends for a vehicle.
create table if not exists buses (
  id             uuid primary key default gen_random_uuid(),
  owner_guide_id uuid not null references guides(id) on delete cascade,
  name           text not null,
  tracker_id     text not null,
  last_lng       double precision,
  last_lat       double precision,
  last_heading   double precision,
  last_speed_kmh double precision,
  last_fix_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists buses_tracker_idx on buses (lower(tracker_id));
create index if not exists buses_owner_idx on buses (owner_guide_id);
alter table buses enable row level security;
-- Intentionally no client RLS policies.

alter table sessions add column if not exists bus_id uuid references buses(id) on delete set null;
alter table sessions add column if not exists pickup_started_at timestamptz;
create index if not exists sessions_bus_live_idx on sessions (bus_id) where ended_at is null;

-- ── session_contacts: who gets the pickup SMS ───────────────────────────────
create table if not exists session_contacts (
  id          bigserial primary key,
  session_id  text not null references sessions(id) on delete cascade,
  name        text,
  phone       text not null check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  sms_status  text not null default 'pending' check (sms_status in ('pending', 'sent', 'failed')),
  sms_error   text,
  sms_sent_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (session_id, phone)
);
alter table session_contacts enable row level security;
-- Intentionally no client RLS policies.

-- ── shared guard: valid guide token + owns the session ──────────────────────
-- Same lenient rule as 038 (a NULL owner stays controllable by any guide).
create or replace function _pickup_guide_for_session(p_session_id text, p_guide_token text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_gid uuid;
  v_owner uuid;
begin
  select id into v_gid from guides where device_token = p_guide_token;
  if v_gid is null then
    raise exception 'Invalid or unknown guide token' using errcode = '28000';
  end if;
  select owner_guide_id into v_owner from sessions where id = p_session_id;
  if not found then
    raise exception 'Session not found: %', p_session_id using errcode = 'P0002';
  end if;
  if v_owner is not null and v_owner <> v_gid then
    raise exception 'Session not found or not owned' using errcode = 'P0002';
  end if;
  return v_gid;
end; $$;
revoke all on function _pickup_guide_for_session(text, text) from public, anon, authenticated;

-- ── bus list management ─────────────────────────────────────────────────────
create or replace function save_bus(p_guide_token text, p_name text, p_tracker_id text,
                                    p_bus_id uuid default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_gid uuid;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_tracker text := nullif(btrim(coalesce(p_tracker_id, '')), '');
  v_row buses;
begin
  select id into v_gid from guides where device_token = p_guide_token;
  if v_gid is null then
    raise exception 'Invalid or unknown guide token' using errcode = '28000';
  end if;
  if v_name is null or v_tracker is null then
    raise exception 'A bus needs a name and its tracker ID' using errcode = '22023';
  end if;
  if length(v_name) > 60 or length(v_tracker) > 80 then
    raise exception 'Bus name or tracker ID is too long' using errcode = '22023';
  end if;
  if p_bus_id is null then
    if (select count(*) from buses where owner_guide_id = v_gid) >= 100 then
      raise exception 'Too many buses' using errcode = '22023';
    end if;
    insert into buses (owner_guide_id, name, tracker_id)
      values (v_gid, v_name, v_tracker) returning * into v_row;
  else
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
      where id = p_bus_id and owner_guide_id = v_gid
      returning * into v_row;
    if v_row.id is null then
      raise exception 'Bus not found' using errcode = 'P0002';
    end if;
  end if;
  return json_build_object('id', v_row.id, 'name', v_row.name, 'tracker_id', v_row.tracker_id);
end; $$;
grant execute on function save_bus(text, text, text, uuid) to anon, authenticated;

create or replace function delete_bus(p_guide_token text, p_bus_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_gid uuid;
begin
  select id into v_gid from guides where device_token = p_guide_token;
  if v_gid is null then
    raise exception 'Invalid or unknown guide token' using errcode = '28000';
  end if;
  -- Hide the icon on any live tour still showing this bus.
  insert into guide_locations (session_id, source, lng, lat, is_off)
    select s.id, 'bus_gps', coalesce(b.last_lng, 0), coalesce(b.last_lat, 0), true
      from sessions s join buses b on b.id = s.bus_id
     where b.id = p_bus_id and b.owner_guide_id = v_gid and s.ended_at is null;
  delete from buses where id = p_bus_id and owner_guide_id = v_gid;
end; $$;
grant execute on function delete_bus(text, uuid) to anon, authenticated;

-- ── attach / swap / detach the session's bus ────────────────────────────────
-- p_bus_id NULL detaches. The last known position is written straight away so
-- passengers see the icon without waiting for the tracker's next report; a
-- bus with no position yet (or none at all) clears the previous bus's icon.
create or replace function set_session_bus(p_session_id text, p_guide_token text, p_bus_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_gid uuid;
  v_old uuid;
  v_bus buses;
begin
  v_gid := _pickup_guide_for_session(p_session_id, p_guide_token);
  select bus_id into v_old from sessions where id = p_session_id;
  if p_bus_id is not null then
    select * into v_bus from buses where id = p_bus_id and owner_guide_id = v_gid;
    if v_bus.id is null then
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

-- ── passenger phone list ────────────────────────────────────────────────────
-- p_contacts: [{ "name": "Anna", "phone": "+3546001234" }, …]. Numbers must be
-- E.164 (the app normalises before calling); bad ones are skipped and counted.
-- Re-adding a number just refreshes its name — it is never texted twice.
create or replace function add_session_contacts(p_session_id text, p_guide_token text, p_contacts jsonb)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_item jsonb;
  v_phone text;
  v_name text;
  v_added int := 0;
  v_skipped int := 0;
  v_have int;
begin
  perform _pickup_guide_for_session(p_session_id, p_guide_token);
  if p_contacts is null or jsonb_typeof(p_contacts) <> 'array' then
    raise exception 'Contacts must be a list' using errcode = '22023';
  end if;
  select count(*) into v_have from session_contacts where session_id = p_session_id;
  for v_item in select * from jsonb_array_elements(p_contacts) loop
    v_phone := regexp_replace(coalesce(v_item->>'phone', ''), '[^0-9+]', '', 'g');
    v_name := nullif(left(btrim(coalesce(v_item->>'name', '')), 80), '');
    if v_phone !~ '^\+[1-9][0-9]{6,14}$' then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    if exists (select 1 from session_contacts where session_id = p_session_id and phone = v_phone) then
      update session_contacts set name = coalesce(v_name, name)
       where session_id = p_session_id and phone = v_phone;
      continue;
    end if;
    -- A coach-load plus slack; also the ceiling on SMS one session can send.
    if v_have >= 120 then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    insert into session_contacts (session_id, name, phone) values (p_session_id, v_name, v_phone);
    v_have := v_have + 1;
    v_added := v_added + 1;
  end loop;
  return json_build_object('added', v_added, 'skipped', v_skipped);
end; $$;
grant execute on function add_session_contacts(text, text, jsonb) to anon, authenticated;

create or replace function remove_session_contact(p_session_id text, p_guide_token text, p_contact_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _pickup_guide_for_session(p_session_id, p_guide_token);
  delete from session_contacts where id = p_contact_id and session_id = p_session_id;
end; $$;
grant execute on function remove_session_contact(text, text, bigint) to anon, authenticated;

-- ── start pickup ────────────────────────────────────────────────────────────
-- Only stamps the moment (coalesce: a re-tap never moves it). The texts are
-- sent by the send_pickup_sms edge function, which the app calls right after.
create or replace function start_pickup(p_session_id text, p_guide_token text)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare v_at timestamptz;
begin
  perform _pickup_guide_for_session(p_session_id, p_guide_token);
  update sessions set pickup_started_at = coalesce(pickup_started_at, now())
   where id = p_session_id and ended_at is null
   returning pickup_started_at into v_at;
  if v_at is null then
    raise exception 'This tour has ended' using errcode = '22023';
  end if;
  return v_at;
end; $$;
grant execute on function start_pickup(text, text) to anon, authenticated;

-- ── everything the guide's Pickup screen shows, in one round trip ───────────
create or replace function get_pickup_state(p_session_id text, p_guide_token text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_gid uuid;
  v_out json;
begin
  v_gid := _pickup_guide_for_session(p_session_id, p_guide_token);
  select json_build_object(
    'pickup_started_at', s.pickup_started_at,
    'bus_id', s.bus_id,
    'buses', coalesce((
      select json_agg(json_build_object(
               'id', b.id, 'name', b.name, 'tracker_id', b.tracker_id,
               'last_lng', b.last_lng, 'last_lat', b.last_lat, 'last_fix_at', b.last_fix_at)
             order by lower(b.name))
        from buses b where b.owner_guide_id = v_gid), '[]'::json),
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

-- ── fleet feed → buses → live sessions (service role only) ──────────────────
-- p_positions: [{ "ids": ["BUS-7","AB123"], "lng": -21.9, "lat": 64.1,
--                 "heading": 180, "speed": 42, "ts": "2026-11-10T08:00:00Z" }, …]
-- (already normalised by the bus_gps edge function). Returns how many session
-- rows were written. A fix is only taken if it is newer than the bus's last
-- one by a few seconds, so a feed that repeats the same position — or reports
-- every second — can't flood guide_locations.
create or replace function ingest_bus_positions(p_positions jsonb)
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
revoke all on function ingest_bus_positions(jsonb) from public, anon, authenticated;
grant execute on function ingest_bus_positions(jsonb) to service_role;

-- ── auto-end (041): the bus's tracker is not session activity ───────────────
-- A bus keeps reporting whether or not anyone is still on the tour (and gets
-- reused the next day), so its rows must not keep a forgotten session open.
create or replace function auto_end_stale_sessions() returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update sessions s
     set ended_at = now()
   where s.ended_at is null
     and greatest(
       s.started_at,
       coalesce(s.tour_started_at, s.started_at),
       coalesce(s.pickup_started_at, s.started_at),
       coalesce((select max(p.last_seen)   from session_passengers p  where p.session_id  = s.id), s.started_at),
       coalesce((select max(p.joined_at)   from session_passengers p  where p.session_id  = s.id), s.started_at),
       coalesce((select max(g.set_at)      from guide_locations g     where g.session_id  = s.id and g.source <> 'bus_gps'), s.started_at),
       coalesce((select max(pl.synced_at)  from passenger_locations pl where pl.session_id = s.id), s.started_at),
       coalesce((select max(sa.activated_at) from stop_activations sa where sa.session_id = s.id), s.started_at)
     ) < now() - interval '3 hours';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
