-- ============================================================================
-- Fieldnote v0.6 — manual spot arrivals (GPS-free check-in)
--
-- A passenger (especially one with no GPS) taps a spot, reads it, and taps
-- "Arrived" — logging that they reached that spot. The guide sees it live, so
-- they can account for no-location passengers without any GPS. Insert goes
-- through a SECURITY DEFINER RPC; the guide reads via SELECT + realtime.
-- ============================================================================

create table if not exists spot_arrivals (
  id           bigint generated always as identity primary key,
  session_id   text not null,
  passenger_id text not null,
  pin_id       bigint,
  pin_title    text,
  arrived_at   timestamptz not null default now()
);
create index if not exists spot_arrivals_session_idx on spot_arrivals (session_id, arrived_at);

alter table spot_arrivals enable row level security;
drop policy if exists "anyone can read spot_arrivals" on spot_arrivals;
create policy "anyone can read spot_arrivals" on spot_arrivals for select using (true);

-- Passenger logs an arrival (no direct INSERT grant needed — definer bypasses RLS).
create or replace function log_spot_arrival(p_session_id text, p_passenger_id text, p_pin_id bigint, p_pin_title text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from sessions where id = p_session_id and ended_at is null) then
    return;   -- ignore arrivals for ended/unknown sessions
  end if;
  insert into spot_arrivals (session_id, passenger_id, pin_id, pin_title)
  values (p_session_id, p_passenger_id, p_pin_id, p_pin_title);
end; $$;
grant execute on function log_spot_arrival(text, text, bigint, text) to anon, authenticated;

alter publication supabase_realtime add table spot_arrivals;
