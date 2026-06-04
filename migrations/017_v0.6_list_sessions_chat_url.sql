-- ============================================================================
-- Fieldnote v0.6 — expose chat_url in list_guide_sessions
--
-- The per-session group-chat link moves from the main burger menu into the
-- My Sessions hub, so a guide can open/edit a tour's chat later — even after
-- the session has ended. That requires the link in the session list.
-- (Adding an OUT column changes the return type → drop + recreate.)
-- ============================================================================

drop function if exists list_guide_sessions(text);
create or replace function list_guide_sessions(p_guide_token text)
returns table(id text, label text, tour_slug text, started_at timestamptz, ended_at timestamptz, chat_url text)
language plpgsql security definer set search_path = public as $$
declare v_gid uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then
    raise exception 'Invalid or unknown guide token' using errcode = '28000';
  end if;
  return query
    select s.id, s.label, s.tour_slug, s.started_at, s.ended_at, s.chat_url
    from sessions s
    where s.owner_guide_id = v_gid
    order by (s.ended_at is not null), coalesce(s.started_at, 'epoch'::timestamptz) desc
    limit 50;
end; $$;
grant execute on function list_guide_sessions(text) to anon, authenticated;
