-- ============================================================================
-- Fieldnote v0.6 — auto-end stale sessions (pg_cron)
--
-- Sessions were never reliably ended: trial-1's session was closed a day
-- late, trial-2's only because the guide remembered at 21:23, and two
-- abandoned 06-12 sessions sat open for weeks. An open session keeps
-- passengers joinable-by-guide-name into a dead tour and skews any
-- report that counts "live" sessions.
--
-- Rule: a session with NO activity for 3 hours is over. Activity = the
-- freshest of session start / tour start / passenger presence / guide
-- broadcast / location sync / stop activation. Three hours comfortably
-- exceeds any real gap seen in five trials (longest: ~90min lunch, with
-- presence pings continuing throughout), and an abandoned just-created
-- session closes the same way. Ending sets sessions.ended_at, so the
-- existing realtime UPDATE → "Tour ended" passenger flow fires as if the
-- guide pressed End session.
--
-- Runs every 30 minutes via pg_cron.
-- ============================================================================

create extension if not exists pg_cron;

create or replace function auto_end_stale_sessions() returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update sessions s
     set ended_at = now()
   where s.ended_at is null
     and greatest(
       s.started_at,
       coalesce(s.tour_started_at, s.started_at),
       coalesce((select max(p.last_seen)   from session_passengers p  where p.session_id  = s.id), s.started_at),
       coalesce((select max(p.joined_at)   from session_passengers p  where p.session_id  = s.id), s.started_at),
       coalesce((select max(g.set_at)      from guide_locations g     where g.session_id  = s.id), s.started_at),
       coalesce((select max(pl.synced_at)  from passenger_locations pl where pl.session_id = s.id), s.started_at),
       coalesce((select max(sa.activated_at) from stop_activations sa where sa.session_id = s.id), s.started_at)
     ) < now() - interval '3 hours';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Reschedule idempotently.
select cron.unschedule('auto-end-stale-sessions')
 where exists (select 1 from cron.job where jobname = 'auto-end-stale-sessions');
select cron.schedule('auto-end-stale-sessions', '*/30 * * * *',
                     'select auto_end_stale_sessions()');
