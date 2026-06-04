-- ============================================================================
-- Fieldnote v0.6 — open guide self-signup (name + passkey)
--
-- Lowers the onboarding gate: a guide can register themselves with just a name
-- + a passkey (a password they choose), no invite code needed. The existing
-- invite-code flow is left intact (redeem_invite_code / recover_guide_access
-- still work) — this just adds an open path.
--
-- Auth stays custom (no Supabase Auth): the client generates a 32-char device
-- token and the server stores it on the guide row, exactly like invite
-- redemption. The passkey is stored only as a bcrypt hash (pgcrypto crypt()).
-- Name is the login handle and is unique (case-insensitive), enforced here.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

alter table guides add column if not exists passkey_hash text;

-- Register a brand-new guide with name + passkey. The client passes a fresh
-- device token (p_token) which it then stores. Errors if the name is taken.
create or replace function register_guide_open(p_name text, p_passkey text, p_token text)
returns table (guide_id uuid, guide_name text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_name text; v_id uuid;
begin
  v_name := btrim(coalesce(p_name, ''));
  if length(v_name) < 2 then raise exception 'Please enter your name' using errcode = '22023'; end if;
  if length(coalesce(p_passkey, '')) < 4 then raise exception 'Passkey must be at least 4 characters' using errcode = '22023'; end if;
  if exists (select 1 from guides where lower(name) = lower(v_name)) then
    raise exception 'That name is taken — pick another, or log in instead' using errcode = '23505';
  end if;
  insert into guides (name, device_token, passkey_hash)
    values (v_name, p_token, crypt(p_passkey, gen_salt('bf')))
    returning id into v_id;
  return query select v_id, v_name;
end; $$;
grant execute on function register_guide_open(text, text, text) to anon, authenticated;

-- Log in (or move to a new device) with name + passkey. Verifies the hash and
-- rotates the device token to p_new_token. Only matches accounts that have a
-- passkey set (invite-code-only guides have none and use their token / the
-- recover flow instead).
create or replace function login_guide(p_name text, p_passkey text, p_new_token text)
returns table (guide_id uuid, guide_name text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid; v_name text; v_hash text;
begin
  select id, name, passkey_hash into v_id, v_name, v_hash
    from guides
    where lower(name) = lower(btrim(coalesce(p_name, ''))) and passkey_hash is not null
    limit 1;
  if v_id is null then raise exception 'No guide account with that name' using errcode = '28000'; end if;
  if crypt(coalesce(p_passkey, ''), v_hash) <> v_hash then
    raise exception 'Wrong passkey' using errcode = '28P01';
  end if;
  update guides set device_token = p_new_token where id = v_id;
  return query select v_id, v_name;
end; $$;
grant execute on function login_guide(text, text, text) to anon, authenticated;
