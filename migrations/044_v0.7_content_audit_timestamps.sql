-- ============================================================================
-- Fieldnote v0.7 — audit timestamps on tour content
--
-- Motivation (2026-07-12): a guide who self-registered as "Attacker" prompted
-- an exposure review. tours/stops/pins had only created_at, so an in-place
-- edit (update_tour/update_stop/update_pin — see migration 045) left NO trace:
-- we could confirm no rows were *created*, but not prove nothing was silently
-- *edited*. This adds an updated_at column + BEFORE UPDATE trigger to all three
-- content tables so any future edit is visible.
--
-- Additive only: new column defaults to now(); existing rows backfill from
-- created_at. The content RPCs use explicit column lists on INSERT, so they
-- don't touch updated_at directly — the DEFAULT covers new rows, the trigger
-- covers edits. row_to_json returns in those RPCs simply gain the new field.
-- ============================================================================

alter table tours add column if not exists updated_at timestamptz not null default now();
alter table stops add column if not exists updated_at timestamptz not null default now();
alter table pins  add column if not exists updated_at timestamptz not null default now();

-- Backfill honest values: an untouched row's "last edit" is its creation.
update tours set updated_at = coalesce(created_at, now());
update stops set updated_at = coalesce(created_at, now());
update pins  set updated_at = coalesce(created_at, now());

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tours_updated_at on tours;
create trigger trg_tours_updated_at before update on tours
  for each row execute function set_updated_at();

drop trigger if exists trg_stops_updated_at on stops;
create trigger trg_stops_updated_at before update on stops
  for each row execute function set_updated_at();

drop trigger if exists trg_pins_updated_at on pins;
create trigger trg_pins_updated_at before update on pins
  for each row execute function set_updated_at();
