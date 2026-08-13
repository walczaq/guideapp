-- ============================================================================
-- Fieldnote v0.7 — enforce "location sharing turns off when the tour ends"
-- SERVER-SIDE (A6 gate finding, 2026-08-13: a passenger client with a stale
-- realtime socket kept inserting for ~28s after ended_at; client-side stop
-- signals can always arrive late, so the DB is the enforcement point).
--
-- New rule for anon/authenticated inserts into passenger_locations:
--   * session still live  → insert allowed (unchanged behavior), OR
--   * session ended       → ONLY backfill of fixes RECORDED BEFORE the end
--                           (client_recorded_at <= ended_at), and only
--                           within a 1-hour grace window — covers the
--                           store-and-forward queue flushing after a locked
--                           phone wakes up post-tour, without ever accepting
--                           post-end collection.
-- client_recorded_at is client-supplied and thus spoofable in the backfill
-- branch, but the 1h cap bounds exposure; the live product's privacy promise
-- ("turns off by itself when the tour ends") is about collection, and no
-- honest client records after end (bgShareStop + the poll backstop see to
-- it) — this policy makes the dishonest/late cases fail server-side.
-- ============================================================================

drop policy "anyone can insert passenger_locations (v0.3 only)"
  on passenger_locations;

create policy "insert only while session live (or 1h pre-end backfill)"
  on passenger_locations for insert to anon, authenticated
  with check (
    exists (
      select 1 from sessions s
      where s.id = session_id
        and (
          s.ended_at is null
          or (client_recorded_at <= s.ended_at
              and now() - s.ended_at < interval '1 hour')
        )
    )
  );
