-- ============================================================================
-- Fieldnote v0.6 — "inside the bus" passenger state
--
-- Replaces the guide-side distance headcount with a passenger-DECLARED state.
-- The passenger app sets in_bus once it reaches the broadcast bus pin (within
-- ~10 m); the flag is STICKY and one-way (never unset), so a passenger who
-- boards and pockets/loses their phone stays counted. The guide simply reads
-- the flag — no geometry, no "stale = dropped" guessing.
-- ============================================================================

alter table session_passengers add column if not exists in_bus boolean not null default false;
alter table session_passengers add column if not exists in_bus_at timestamptz;

-- One-way setter, callable by the (anon) passenger. Updates the membership row
-- if present; otherwise inserts a minimal one. Never unsets in_bus.
create or replace function mark_passenger_in_bus(p_session_id text, p_passenger_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update session_passengers
     set in_bus = true, in_bus_at = now()
     where session_id = p_session_id and passenger_id = p_passenger_id and in_bus = false;
  if not found then
    insert into session_passengers (session_id, passenger_id, in_bus, in_bus_at)
      select p_session_id, p_passenger_id, true, now()
      where not exists (
        select 1 from session_passengers
        where session_id = p_session_id and passenger_id = p_passenger_id);
  end if;
end; $$;
grant execute on function mark_passenger_in_bus(text, text) to anon, authenticated;
