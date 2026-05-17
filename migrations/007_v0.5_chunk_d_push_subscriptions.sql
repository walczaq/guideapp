-- ============================================================================
-- Fieldnote v0.5 chunk D — push subscriptions (reconciled with chunk A schema)
--
-- The `push_subscriptions` table was originally created in migration 001 with
-- a tighter shape: passenger_id NOT NULL, unique on (session_id, passenger_id,
-- endpoint), no user_agent/updated_at columns. This migration brings it in
-- line with what chunk D's save_push_subscription RPC + the send_stop_push
-- Edge Function expect:
--   - adds user_agent + updated_at columns
--   - relaxes passenger_id NOT NULL
--   - swaps the unique index to (session_id, endpoint) so the RPC's
--     ON CONFLICT clause has a matching constraint
--
-- Then creates the SECURITY DEFINER RPCs the client + Edge Function call:
--   save_push_subscription   — upsert from the client (anon/authenticated)
--   delete_push_subscription — cleanup, called by the Edge Function when
--                              web-push returns 404/410 (subscription expired)
--
-- An Edge Function ("send_stop_push") is invoked by a Supabase Database
-- Webhook on stop_activations INSERT — it loads every subscription for that
-- session and dispatches a push via the web-push library.
-- ============================================================================

-- 1. Add missing columns to the existing table.
alter table push_subscriptions add column if not exists user_agent text;
alter table push_subscriptions add column if not exists updated_at timestamptz not null default now();

-- 2. Relax passenger_id NOT NULL.
alter table push_subscriptions alter column passenger_id drop not null;

-- 3. Swap the unique index from (session_id, passenger_id, endpoint) to
--    (session_id, endpoint). The new uniqueness matches what the RPC's
--    ON CONFLICT clause expects.
drop index if exists push_subscriptions_unique;
create unique index if not exists push_subscriptions_session_endpoint_uq
  on push_subscriptions (session_id, endpoint);

-- The non-unique helper index push_subscriptions_session_idx from
-- migration 001 already exists and is fine — leave it alone.

-- 4. Save (upsert) a push subscription for the current session. Idempotent
--    — the same browser re-subscribing just refreshes updated_at + keys.
create or replace function save_push_subscription(
  p_session_id   text,
  p_endpoint     text,
  p_p256dh       text,
  p_auth         text,
  p_passenger_id text default null,
  p_user_agent   text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from sessions where id = p_session_id and ended_at is null
  ) then
    raise exception 'Session not found or ended: %', p_session_id
      using errcode = 'P0002';
  end if;

  insert into push_subscriptions
    (session_id, endpoint, p256dh, auth, passenger_id, user_agent)
    values (p_session_id, p_endpoint, p_p256dh, p_auth, p_passenger_id, p_user_agent)
    on conflict (session_id, endpoint)
    do update set
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      passenger_id = coalesce(excluded.passenger_id, push_subscriptions.passenger_id),
      user_agent = coalesce(excluded.user_agent, push_subscriptions.user_agent),
      updated_at = now();
end;
$$;

grant execute on function save_push_subscription(text, text, text, text, text, text)
  to anon, authenticated;

-- 5. Cleanup helper. Called by the Edge Function when web-push reports a
--    404 or 410 (subscription expired/revoked).
create or replace function delete_push_subscription(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from push_subscriptions where endpoint = p_endpoint;
end;
$$;

grant execute on function delete_push_subscription(text) to service_role;
