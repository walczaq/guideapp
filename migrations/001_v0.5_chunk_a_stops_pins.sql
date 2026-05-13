-- ============================================================================
-- Fieldnote v0.5 chunk A — Stops + Pins hierarchy
--
-- What this does:
--   1. Creates `stops`, `pins`, `stop_activations`, `push_subscriptions` tables
--   2. Adds RLS policies (chunk A is read-only for clients; writes come in B-D)
--   3. Migrates the two seed tours by wrapping their existing `tours.pins`
--      jsonb under a single auto-generated stop per tour
--   4. Leaves `tours.pins` column in place as a safety net for one milestone
--
-- How to run:
--   - Open Supabase SQL editor → paste this whole file → run
--   - All steps are idempotent (re-runnable safely) — `create table if not exists`,
--     guarded inserts with `not exists` clauses
--
-- Sanity checks after running: see the SELECTs at the bottom of this file
-- ============================================================================


-- ── 1. Tables ────────────────────────────────────────────────────────────────

create table if not exists stops (
  id                   bigserial primary key,
  tour_id              uuid not null references tours(id) on delete cascade,
  ordinal              int not null,
  name                 text not null,
  subtitle             text,
  lng                  float8 not null,
  lat                  float8 not null,
  activation_radius_m  int not null default 150,
  created_at           timestamptz default now()
);
create index if not exists stops_tour_id_ordinal_idx on stops (tour_id, ordinal);

create table if not exists pins (
  id                bigserial primary key,
  stop_id           bigint not null references stops(id) on delete cascade,
  ordinal           int not null,
  title             text not null,
  body              text not null,
  lng               float8 not null,
  lat               float8 not null,
  trigger_radius_m  int not null default 25,
  created_at        timestamptz default now()
);
create index if not exists pins_stop_id_ordinal_idx on pins (stop_id, ordinal);

create table if not exists stop_activations (
  id            bigserial primary key,
  session_id    text not null references sessions(id) on delete cascade,
  stop_id       bigint not null references stops(id) on delete cascade,
  activated_at  timestamptz default now(),
  activated_by  text
);
create unique index if not exists stop_activations_session_stop_unique
  on stop_activations (session_id, stop_id);
create index if not exists stop_activations_session_time_idx
  on stop_activations (session_id, activated_at);

create table if not exists push_subscriptions (
  id            bigserial primary key,
  session_id    text not null references sessions(id) on delete cascade,
  passenger_id  text not null,
  endpoint      text not null,
  p256dh        text not null,
  auth          text not null,
  created_at    timestamptz default now()
);
create unique index if not exists push_subscriptions_unique
  on push_subscriptions (session_id, passenger_id, endpoint);
create index if not exists push_subscriptions_session_idx
  on push_subscriptions (session_id);


-- ── 2. Row Level Security ────────────────────────────────────────────────────

alter table stops enable row level security;
alter table pins enable row level security;
alter table stop_activations enable row level security;
alter table push_subscriptions enable row level security;

-- Stops + pins: public read (tour data isn't secret; anyone with a session
-- link can see the tour anyway). Writes are service-role only until authoring
-- lands in v0.6.
drop policy if exists "Anyone can read stops" on stops;
create policy "Anyone can read stops"
  on stops for select using (true);

drop policy if exists "Anyone can read pins" on pins;
create policy "Anyone can read pins"
  on pins for select using (true);

-- Stop activations: read = anyone with the session id (guides AND passengers
-- both need to know which stops are active). Insert/update/delete = service
-- role only for chunk A; chunk B/C tightens insert to authenticated guide of
-- the owning session.
drop policy if exists "Anyone can read stop_activations" on stop_activations;
create policy "Anyone can read stop_activations"
  on stop_activations for select using (true);

-- Push subscriptions: passenger can insert their own row. No one else can
-- read them back from the client — only the service-role Edge Function reads
-- them when fanning out a push.
drop policy if exists "Passengers can insert their own push subscription"
  on push_subscriptions;
create policy "Passengers can insert their own push subscription"
  on push_subscriptions for insert with check (true);

drop policy if exists "Passengers can delete their own push subscription"
  on push_subscriptions;
create policy "Passengers can delete their own push subscription"
  on push_subscriptions for delete using (true);


-- ── 3. Seed migration: wrap each existing tour in one stop ───────────────────
--
-- The two seed tours have `pins` as a jsonb array on `tours`. We wrap each
-- tour's pins inside a single auto-generated stop. The stop sits at the tour's
-- home_lng/home_lat with a generous 500m activation radius — chunk A simply
-- treats all stops as active on session load (parity behavior), so the radius
-- isn't yet load-bearing.

-- Step 1: one stop per migrated tour
insert into stops (tour_id, ordinal, name, subtitle, lng, lat, activation_radius_m)
select t.id, 1, t.name, 'auto-migrated single stop (v0.5 chunk A)',
       t.home_lng, t.home_lat, 500
from tours t
where t.slug in ('fossvogsdalur-001', 'gautland-block')
  and not exists (select 1 from stops s where s.tour_id = t.id);

-- Step 2: copy each pin from tours.pins jsonb into the pins table,
-- preserving original array order via WITH ORDINALITY
insert into pins (stop_id, ordinal, title, body, lng, lat, trigger_radius_m)
select
  s.id,
  pe.ord::int,
  pe.value->>'title',
  pe.value->>'body',
  (pe.value->>'lng')::float8,
  (pe.value->>'lat')::float8,
  coalesce(nullif(pe.value->>'radius', '')::int, 25)
from tours t
  join stops s on s.tour_id = t.id and s.ordinal = 1
  cross join lateral jsonb_array_elements(t.pins) with ordinality as pe(value, ord)
where t.slug in ('fossvogsdalur-001', 'gautland-block')
  and not exists (select 1 from pins p where p.stop_id = s.id);


-- ── 4. Sanity checks (run after migration; rows should match) ────────────────

-- Old pin counts from jsonb:
--   select slug, jsonb_array_length(pins) as old_count from tours;
--
-- New pin counts from relational tables:
--   select t.slug, count(p.id) as new_count
--   from tours t
--     join stops s on s.tour_id = t.id
--     join pins p on p.stop_id = s.id
--   group by t.slug;
--
-- The two should be equal for fossvogsdalur-001 and gautland-block.


-- ── 5. Rollback (uncomment + run if you need to start over) ──────────────────

-- drop table if exists push_subscriptions;
-- drop table if exists stop_activations;
-- drop table if exists pins;
-- drop table if exists stops;

-- Note: `tours.pins` jsonb is NOT dropped by this migration. Keep it through
-- v0.5 as the source-of-truth backup. Drop in a follow-up migration once v0.5
-- ships and proves stable.
