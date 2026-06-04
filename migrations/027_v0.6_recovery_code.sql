-- ============================================================================
-- Fieldnote v0.6 — passkey recovery via a recovery code (no email provider)
--
-- At signup a guide is given a one-off recovery code (shown once to save). If
-- they forget their passkey, name + recovery code lets them set a new one. The
-- code is stored only as a bcrypt hash and normalized (uppercase, no dashes)
-- on both store and verify, so the user can type it any way. The code is
-- reusable (a backup-code model); the Guide account screen can regenerate it.
-- ============================================================================

alter table guides add column if not exists recovery_hash text;

-- register gains p_recovery_code (required).
drop function if exists register_guide_open(text, text, text, text);
create or replace function register_guide_open(p_name text, p_passkey text, p_token text, p_email text, p_recovery_code text)
returns table (guide_id uuid, guide_name text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_name text; v_email text; v_code text; v_id uuid;
begin
  v_name  := btrim(coalesce(p_name, ''));
  v_email := lower(btrim(coalesce(p_email, '')));
  v_code  := upper(regexp_replace(coalesce(p_recovery_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if length(v_name) < 2 then raise exception 'Please enter your name' using errcode = '22023'; end if;
  if length(coalesce(p_passkey, '')) < 4 then raise exception 'Passkey must be at least 4 characters' using errcode = '22023'; end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Please enter a valid email' using errcode = '22023';
  end if;
  if length(v_code) < 8 then raise exception 'Missing recovery code' using errcode = '22023'; end if;
  if exists (select 1 from guides where lower(name) = lower(v_name)) then
    raise exception 'That name is taken — pick another, or log in instead' using errcode = '23505';
  end if;
  insert into guides (name, device_token, passkey_hash, email, recovery_hash)
    values (v_name, p_token, crypt(p_passkey, gen_salt('bf')), v_email, crypt(v_code, gen_salt('bf')))
    returning id into v_id;
  return query select v_id, v_name;
exception when unique_violation then
  raise exception 'That name is taken — pick another, or log in instead' using errcode = '23505';
end; $$;
grant execute on function register_guide_open(text, text, text, text, text) to anon, authenticated;

-- Set/replace the recovery code for the logged-in guide (account screen).
create or replace function set_recovery_code(p_guide_token text, p_recovery_code text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_gid uuid; v_code text;
begin
  select id into v_gid from guides where device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  v_code := upper(regexp_replace(coalesce(p_recovery_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if length(v_code) < 8 then raise exception 'Invalid recovery code' using errcode = '22023'; end if;
  update guides set recovery_hash = crypt(v_code, gen_salt('bf')) where id = v_gid;
end; $$;
grant execute on function set_recovery_code(text, text) to anon, authenticated;

-- Reset passkey using name + recovery code. Rotates the device token.
create or replace function reset_passkey_with_code(p_name text, p_recovery_code text, p_new_passkey text, p_new_token text)
returns table (guide_id uuid, guide_name text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid; v_name text; v_hash text; v_code text;
begin
  v_code := upper(regexp_replace(coalesce(p_recovery_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if length(coalesce(p_new_passkey, '')) < 4 then raise exception 'Passkey must be at least 4 characters' using errcode = '22023'; end if;
  select id, name, recovery_hash into v_id, v_name, v_hash
    from guides where lower(name) = lower(btrim(coalesce(p_name, ''))) and recovery_hash is not null
    limit 1;
  if v_id is null then raise exception 'No account with that name and a recovery code' using errcode = '28000'; end if;
  if v_code = '' or crypt(v_code, v_hash) <> v_hash then
    raise exception 'Wrong recovery code' using errcode = '28P01';
  end if;
  update guides set passkey_hash = crypt(p_new_passkey, gen_salt('bf')), device_token = p_new_token where id = v_id;
  return query select v_id, v_name;
end; $$;
grant execute on function reset_passkey_with_code(text, text, text, text) to anon, authenticated;

-- get_guide_account now also reports whether a recovery code is set.
drop function if exists get_guide_account(text);
create or replace function get_guide_account(p_guide_token text)
returns table (guide_name text, email text, has_passkey boolean, has_recovery boolean)
language plpgsql security definer set search_path = public as $$
declare v_gid uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  return query
    select g.name, g.email, (g.passkey_hash is not null), (g.recovery_hash is not null)
    from guides g where g.id = v_gid;
end; $$;
grant execute on function get_guide_account(text) to anon, authenticated;
