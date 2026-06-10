-- ============================================================================
-- Fieldnote v0.6 — AI-1 lite: localized live notes (stop_activations.notes_i18n)
--
-- Live stop notes / warnings reach passengers in whatever language the guide
-- typed; tour CONTENT is pre-translated (DeepL, *_i18n columns) but the live
-- safety layer is not. This adds the storage half of the fix:
--
--   stop_activations.notes_i18n jsonb  →  {_src, es, zh}
--
-- filled fire-and-forget by the translate_stop_notes edge function (DeepL —
-- same free key as translate_tour, no new cost). `_src` is the exact notes
-- string the translation was made from; clients render their language only
-- when `_src` matches the current notes, so a fresh edit shows the guide's
-- original until its translation lands (a second realtime UPDATE re-renders).
--
-- stop_activations already has `replica identity full` (migration 004), so
-- realtime UPDATE payloads carry the new column automatically.
-- ============================================================================

alter table stop_activations add column if not exists notes_i18n jsonb;
