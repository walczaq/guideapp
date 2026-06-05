-- ============================================================================
-- Fieldnote v0.6 — translations for guide-authored tour content
--
-- Stops + pins get *_i18n jsonb columns holding per-language translations,
-- e.g. {"es": "...", "zh": "..."}. Passengers render the translation for their
-- chosen language, falling back to the original (English column) when absent.
-- For now these are populated manually (pre-translated); a translate-on-save
-- pipeline (edge function + a translation API key) can fill them automatically
-- later — same "guide writes once, passengers read" model.
-- ============================================================================

alter table stops add column if not exists name_i18n     jsonb;
alter table stops add column if not exists subtitle_i18n jsonb;
alter table pins  add column if not exists title_i18n    jsonb;
alter table pins  add column if not exists body_i18n     jsonb;
