-- ============================================================================
-- Fieldnote v0.6 — passenger presence heartbeat (R2-F #1)
--
-- A live "the app is open right now" signal independent of GPS. The passenger
-- app writes last_seen every ~45s while foregrounded (suspends on screen-lock,
-- like GPS). The guide reads it to tell "present, using the app, no location"
-- apart from "joined then left" — something no other signal gives without GPS.
-- ============================================================================

alter table session_passengers add column if not exists last_seen timestamptz;

create or replace function touch_passenger_presence(p_session_id text, p_passenger_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update session_passengers set last_seen = now()
  where session_id = p_session_id and passenger_id = p_passenger_id;
end; $$;

grant execute on function touch_passenger_presence(text, text) to anon, authenticated;
