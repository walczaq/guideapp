-- ============================================================================
-- Fieldnote v0.6 — per-subscriber language for push notifications
--
-- Store each push subscription's chosen language so the edge functions can
-- build the notification in the passenger's language. save_push_subscription
-- gains p_lang.
-- ============================================================================

alter table push_subscriptions add column if not exists lang text;

drop function if exists save_push_subscription(text, text, text, text, text, text);
create or replace function save_push_subscription(
  p_session_id   text,
  p_endpoint     text,
  p_p256dh       text,
  p_auth         text,
  p_passenger_id text default null,
  p_user_agent   text default null,
  p_lang         text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from sessions where id = p_session_id and ended_at is null) then
    raise exception 'Session not found or ended: %', p_session_id using errcode = 'P0002';
  end if;
  insert into push_subscriptions
    (session_id, endpoint, p256dh, auth, passenger_id, user_agent, lang)
    values (p_session_id, p_endpoint, p_p256dh, p_auth, p_passenger_id, p_user_agent, p_lang)
    on conflict (session_id, endpoint) do update set
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      passenger_id = coalesce(excluded.passenger_id, push_subscriptions.passenger_id),
      user_agent = coalesce(excluded.user_agent, push_subscriptions.user_agent),
      lang = coalesce(excluded.lang, push_subscriptions.lang),
      updated_at = now();
end; $$;
grant execute on function save_push_subscription(text, text, text, text, text, text, text) to anon, authenticated;
