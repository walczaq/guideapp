-- ============================================================================
-- Fieldnote v0.5 chunk D extension — UPDATE-push rate-limit
--
-- Two pieces:
--   1. `last_warning_pushed_at` column on stop_activations — the high-water
--      mark for the most recent caution/danger UPDATE push for this row.
--   2. `claim_warning_push_slot(p_id)` RPC — atomically claims a 60s window:
--      sets the timestamp to now() and returns the row id IFF the previous
--      value was null or older than 60s. Empty return = already pushed
--      within window; the caller skips.
--
-- The conditional UPDATE serializes inside Postgres, so two concurrent
-- webhook invocations cannot both claim the slot. The first wins; the
-- second sees the fresh timestamp and gets nothing back.
--
-- Standalone migration so base chunk D can ship + smoke-test before this
-- extension lands.
-- ============================================================================

alter table stop_activations
  add column if not exists last_warning_pushed_at timestamptz;

comment on column stop_activations.last_warning_pushed_at is
  'Timestamp of the most recent caution/danger UPDATE push for this row. '
  'Set by claim_warning_push_slot in the send_stop_update_push Edge Function '
  'to rate-limit warning pushes to 1 per 60s.';

-- Atomic claim: returns the id IFF this caller wins the 60s slot. The
-- caller treats an empty result (no row returned) as "another push got
-- there first, skip".
create or replace function claim_warning_push_slot(
  p_id bigint
) returns table (id bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    update stop_activations
       set last_warning_pushed_at = now()
     where stop_activations.id = p_id
       and (stop_activations.last_warning_pushed_at is null
            or stop_activations.last_warning_pushed_at < now() - interval '60 seconds')
    returning stop_activations.id;
end;
$$;

-- Only the Edge Function (service role) should call this.
grant execute on function claim_warning_push_slot(bigint) to service_role;
