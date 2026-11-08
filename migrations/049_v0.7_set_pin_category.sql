-- ============================================================================
-- Fieldnote v0.7 — switch a spot between "main" and "extra" (side quest)
--
-- The tour editor gets a toggle on each walking-sequence spot: a main route
-- pin ('pin') can become an extra ('side') and back. update_pin doesn't take
-- a category, so this is a narrow RPC for exactly that switch. It only allows
-- 'pin' <-> 'side' — amenities and zones keep their own kind — and uses the
-- same edit gate as every other content RPC (can_edit_tour_owner).
-- Ordinal is untouched, so the spot keeps its place in the walking order.
-- ============================================================================

create or replace function set_pin_category(p_guide_token text, p_pin_id bigint, p_category text)
returns json language plpgsql security definer set search_path to 'public'
as $function$
declare v_gid uuid; v_row pins;
begin
  select g.id into v_gid from guides g where g.device_token = p_guide_token;
  if v_gid is null then raise exception 'Invalid or unknown guide token' using errcode='28000'; end if;
  if p_category not in ('pin', 'side') then
    raise exception 'Category must be pin or side' using errcode='22023'; end if;
  if not exists (select 1 from pins p join stops s on s.id=p.stop_id join tours t on t.id=s.tour_id
                 where p.id=p_pin_id and p.category in ('pin', 'side')
                   and can_edit_tour_owner(t.owner_guide_id, v_gid)) then
    raise exception 'Pin not found or not editable' using errcode='P0002'; end if;
  update pins set category = p_category where id = p_pin_id returning * into v_row;
  return row_to_json(v_row);
end; $function$;

grant execute on function set_pin_category(text, bigint, text) to anon, authenticated;
