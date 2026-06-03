-- ============================================================================
-- Fieldnote v0.6 — typed pins (categories)
--
-- The tour builder's "Add" menu lets a guide drop different KINDS of markers,
-- not just generic content pins:
--   pin       — content pin (the original; default)
--   danger    — Dangerous Zone
--   border    — Border / "don't go there"
--   toilet    — Toilet (free/paid noted in the body for now)
--   cafe      — Café / Restaurant
--   souvenir  — Souvenirs
--
-- These are modelled as PINS with a `category`, kept under their stop (stops
-- remain the organising container). Drawn areas/zones and passenger-facing
-- behaviour per category are deliberately out of scope here — this is the
-- authoring side only.
-- ============================================================================

alter table pins add column if not exists category text not null default 'pin';

-- Recreate create_pin with p_category appended. Drop the old 7-arg form first
-- so PostgREST has no overload ambiguity. Default 'pin' keeps older callers OK.
drop function if exists create_pin(text, bigint, text, text, double precision, double precision, int);
create or replace function create_pin(p_guide_token text, p_stop_id bigint, p_title text, p_body text,
                                      p_lng double precision, p_lat double precision, p_trigger_radius_m int,
                                      p_category text default 'pin')
returns json language plpgsql security definer set search_path = public as $$
declare v_gid uuid; v_ord int; v_row pins;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode='28000'; end if;
  if not exists (select 1 from stops s join tours t on t.id=s.tour_id
                 where s.id=p_stop_id and (t.owner_guide_id is null or t.owner_guide_id=v_gid)) then
    raise exception 'Stop not found or not editable' using errcode='P0002'; end if;
  if p_title is null or length(btrim(p_title))=0 then raise exception 'Pin title required' using errcode='22023'; end if;
  select coalesce(max(ordinal)+1, 1) into v_ord from pins where stop_id=p_stop_id;
  insert into pins (stop_id, ordinal, title, body, lng, lat, trigger_radius_m, category)
    values (p_stop_id, v_ord, btrim(p_title), coalesce(p_body,''), p_lng, p_lat,
            coalesce(p_trigger_radius_m, 25), coalesce(nullif(btrim(coalesce(p_category,'')),''),'pin'))
    returning * into v_row;
  return row_to_json(v_row);
end; $$;
grant execute on function create_pin(text, bigint, text, text, double precision, double precision, int, text) to anon, authenticated;
