-- ============================================================================
-- Fieldnote v0.6 — let a passenger turn notifications OFF (remove their row)
--
-- The "Notifications off" toggle needs to delete this device's push_subscriptions
-- row so the Edge Functions stop targeting it. A direct client DELETE removes 0
-- rows: push_subscriptions has RLS enabled with no SELECT policy (push keys are
-- intentionally not world-readable), and PostgREST's filtered delete can't act
-- on rows the anon role can't see. So — mirroring save_push_subscription on the
-- insert side — expose a SECURITY DEFINER RPC that deletes the (session,endpoint)
-- row, scoped so it only removes that one subscription.
-- ============================================================================

create or replace function unsubscribe_push_subscription(p_session_id text, p_endpoint text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from push_subscriptions
  where session_id = p_session_id and endpoint = p_endpoint;
end; $$;

grant execute on function unsubscribe_push_subscription(text, text) to anon, authenticated;
