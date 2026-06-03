-- ============================================================================
-- Fieldnote v0.6 — retire the SQL-seeded + test tours
--
-- Now that the in-app builder (migration 011/012) and the Start-session tour
-- picker exist, the hand-seeded Golden Circle (seeded by migration 011) and
-- two ad-hoc test tours are removed. Real Golden Circle now lives as a
-- guide-built, owner-owned tour created through the builder.
--
-- Safety:
--   - owner_guide_id IS NULL guard → no guide-owned tour is ever touched.
--   - test-tour slugs won't exist in a fresh DB, so those deletes no-op.
--   - sessions.tour_slug is a FK to tours.slug (NO ACTION), so the test
--     sessions on these slugs are deleted first. Their non-cascading children
--     (guide_locations, passenger_locations, session_passengers) are removed
--     explicitly; push_subscriptions + stop_activations cascade on session
--     delete. Deleting the tours then cascades stops -> pins.
-- ============================================================================

delete from guide_locations    where session_id in (select id from sessions where tour_slug in ('golden-circle','fossvogsdalur-001','gautland-block'));
delete from passenger_locations where session_id in (select id from sessions where tour_slug in ('golden-circle','fossvogsdalur-001','gautland-block'));
delete from session_passengers  where session_id in (select id from sessions where tour_slug in ('golden-circle','fossvogsdalur-001','gautland-block'));
delete from sessions            where tour_slug in ('golden-circle','fossvogsdalur-001','gautland-block');
delete from tours where owner_guide_id is null and slug in ('golden-circle','fossvogsdalur-001','gautland-block');
