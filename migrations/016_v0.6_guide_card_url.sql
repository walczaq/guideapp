-- ============================================================================
-- Fieldnote v0.6 — per-guide "card" link (website / Linktree / contact)
--
-- The guide sets a single link once (their business card); it shows to
-- passengers as a menu item and is editable from the menu. Stored on the
-- guide, not the session. Passengers can't read the guides table directly
-- (device tokens live there), so they fetch just the card via a SECURITY
-- DEFINER getter scoped to a session's owner guide.
-- ============================================================================

alter table guides add column if not exists card_url text;

create or replace function set_guide_card_url(p_guide_token text, p_card_url text)
returns void language plpgsql security definer set search_path = public as $$
declare v_gid uuid;
begin
  select id into v_gid from guides where device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  update guides set card_url = nullif(btrim(coalesce(p_card_url, '')), '') where id = v_gid;
end; $$;
grant execute on function set_guide_card_url(text, text) to anon, authenticated;

create or replace function get_session_guide_card(p_session_id text)
returns text language sql security definer set search_path = public stable as $$
  select g.card_url from sessions s join guides g on g.id = s.owner_guide_id where s.id = p_session_id;
$$;
grant execute on function get_session_guide_card(text) to anon, authenticated;
