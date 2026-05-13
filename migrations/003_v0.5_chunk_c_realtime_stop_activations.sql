-- ============================================================================
-- Fieldnote v0.5 chunk C — Enable realtime on stop_activations
--
-- Adds stop_activations to Supabase's realtime publication. Clients can then
-- subscribe via supabaseClient.channel(...).on('postgres_changes', ...) and
-- receive INSERT events as guides activate stops.
--
-- This is the only backend piece chunk C needs — the table, RLS, and the
-- activate_stop RPC already exist from chunks A and B.
-- ============================================================================

alter publication supabase_realtime add table stop_activations;
