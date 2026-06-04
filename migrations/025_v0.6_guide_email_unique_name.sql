-- ============================================================================
-- Fieldnote v0.6 — guide email + exclusive names
--
-- 1. Collect an email at self-signup (for future password recovery + contact).
-- 2. Make guide names exclusive. The register RPC already rejects a name that
--    matches ANY existing guide (case-insensitive). We add a DB-level unique
--    index as a race backstop, scoped to passkey (self-signup) accounts so it
--    builds cleanly despite pre-existing duplicate legacy/invite names.
-- ============================================================================

alter table guides add column if not exists email text;

create unique index if not exists guides_name_lower_passkey_uniq
  on guides (lower(name)) where passkey_hash is not null;

-- Replace register: add p_email (required, basic format check). Name still must
-- be free across ALL guides. unique_violation (race on the index) maps to the
-- same friendly "name taken" message.
drop function if exists register_guide_open(text, text, text);
create or replace function register_guide_open(p_name text, p_passkey text, p_token text, p_email text)
returns table (guide_id uuid, guide_name text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_name text; v_email text; v_id uuid;
begin
  v_name  := btrim(coalesce(p_name, ''));
  v_email := lower(btrim(coalesce(p_email, '')));
  if length(v_name) < 2 then raise exception 'Please enter your name' using errcode = '22023'; end if;
  if length(coalesce(p_passkey, '')) < 4 then raise exception 'Passkey must be at least 4 characters' using errcode = '22023'; end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Please enter a valid email' using errcode = '22023';
  end if;
  if exists (select 1 from guides where lower(name) = lower(v_name)) then
    raise exception 'That name is taken — pick another, or log in instead' using errcode = '23505';
  end if;
  insert into guides (name, device_token, passkey_hash, email)
    values (v_name, p_token, crypt(p_passkey, gen_salt('bf')), v_email)
    returning id into v_id;
  return query select v_id, v_name;
exception when unique_violation then
  raise exception 'That name is taken — pick another, or log in instead' using errcode = '23505';
end; $$;
grant execute on function register_guide_open(text, text, text, text) to anon, authenticated;
