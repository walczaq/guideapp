-- ============================================================================
-- Fieldnote v0.6 — guide account self-service
--
-- Lets a logged-in guide (validated by device token) view + update their own
-- name, email, and passkey. This is how EXISTING accounts (invite-era guides
-- with no email/passkey) add the email that powers recovery/contact and set a
-- passkey so they can log in by name + passkey on another device.
-- ============================================================================

create or replace function get_guide_account(p_guide_token text)
returns table (guide_name text, email text, has_passkey boolean)
language plpgsql security definer set search_path = public as $$
declare v_gid uuid;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  return query
    select g.name, g.email, (g.passkey_hash is not null)
    from guides g where g.id = v_gid;
end; $$;
grant execute on function get_guide_account(text) to anon, authenticated;

-- Update name (must stay unique across guides), email (validated; '' clears it),
-- and optionally set/replace the passkey (non-empty → hashed; '' = keep current).
create or replace function update_guide_account(p_guide_token text, p_name text, p_email text, p_passkey text)
returns table (guide_id uuid, guide_name text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_gid uuid; v_name text; v_email text;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode = '28000'; end if;
  v_name  := btrim(coalesce(p_name, ''));
  v_email := lower(btrim(coalesce(p_email, '')));
  if length(v_name) < 2 then raise exception 'Please enter your name' using errcode = '22023'; end if;
  if v_email <> '' and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Please enter a valid email' using errcode = '22023';
  end if;
  if exists (select 1 from guides where lower(name) = lower(v_name) and id <> v_gid) then
    raise exception 'That name is taken — pick another' using errcode = '23505';
  end if;
  update guides set name = v_name, email = nullif(v_email, '') where id = v_gid;
  if coalesce(p_passkey, '') <> '' then
    if length(p_passkey) < 4 then raise exception 'Passkey must be at least 4 characters' using errcode = '22023'; end if;
    update guides set passkey_hash = crypt(p_passkey, gen_salt('bf')) where id = v_gid;
  end if;
  return query select v_gid, v_name;
exception when unique_violation then
  raise exception 'That name is taken — pick another' using errcode = '23505';
end; $$;
grant execute on function update_guide_account(text, text, text, text) to anon, authenticated;
