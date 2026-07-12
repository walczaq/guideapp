-- ============================================================================
-- Fieldnote v0.7 — permanent per-guide QR codes
--
-- Product decision (Filip, 2026-07-12): each guide gets ONE permanent QR —
-- printable, laminated, saved on the phone — handed out at the start of
-- every tour, instead of a fresh per-session QR each day.
--
-- Mechanics: guides.qr_code is a short IMMUTABLE random code (never derived
-- from the name — printed laminates must never break). The public URL
-- fieldnote.guide/g/<code> resolves to that guide's CURRENT live session:
-- newest session owned by the guide with ended_at IS NULL, started within
-- 18h. This is only safe because migration 041's auto-end cron guarantees
-- ended_at is trustworthy — a stale open session can no longer hijack the
-- permanent code. No live session → the client shows a "tour hasn't
-- started yet" state (and, post-app-first-flip, the install buttons — the
-- same printed code works in booking emails the night before the tour).
--
-- resolve_guide_qr is anon-callable and returns ONLY name + session id —
-- never token/passkey/email columns. get_my_guide_qr authenticates by
-- device token (same pattern as the other guide RPCs).
-- ============================================================================

alter table guides add column if not exists qr_code text unique;

alter table guides
  alter column qr_code
  set default lower(substr(md5(random()::text || clock_timestamp()::text), 1, 8));

update guides
   set qr_code = lower(substr(md5(random()::text || id::text || clock_timestamp()::text), 1, 8))
 where qr_code is null;

create or replace function resolve_guide_qr(p_code text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_name text;
  v_session_id text;
begin
  select id, name into v_id, v_name
    from guides where qr_code = lower(trim(p_code));
  if v_id is null then
    return json_build_object('found', false);
  end if;
  select id into v_session_id
    from sessions
   where owner_guide_id = v_id
     and ended_at is null
     and started_at > now() - interval '18 hours'
   order by started_at desc
   limit 1;
  return json_build_object('found', true, 'guide_name', v_name,
                           'session_id', v_session_id);
end;
$$;
grant execute on function resolve_guide_qr(text) to anon, authenticated;

create or replace function get_my_guide_qr(p_guide_token text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  select qr_code into v_code from guides where device_token = p_guide_token;
  if v_code is null then
    raise exception 'Invalid or unknown guide token' using errcode = '28000';
  end if;
  return v_code;
end;
$$;
grant execute on function get_my_guide_qr(text) to anon, authenticated;
