-- ============================================================================
-- Fieldnote v0.6 — guide-side "who has notifications on" for the stop-1 setup
-- check. push_subscriptions has no SELECT policy (it holds sensitive push keys),
-- so the guide can't read it directly. This SECURITY DEFINER RPC returns ONLY
-- the passenger_ids that have a subscription for the session — no keys — so the
-- Control Center can show a 🔔/🔕 per passenger.
-- ============================================================================

create or replace function list_push_passengers(p_session_id text)
returns table(passenger_id text)
language sql security definer set search_path = public as $$
  select distinct ps.passenger_id
  from push_subscriptions ps
  where ps.session_id = p_session_id and ps.passenger_id is not null;
$$;

grant execute on function list_push_passengers(text) to anon, authenticated;
