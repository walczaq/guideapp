// Fieldnote v0.5 chunk D extension — send_stop_update_push Edge Function.
//
// Triggered by a Supabase Database Webhook on stop_activations UPDATE.
// Fires a Web Push ONLY when the warning is consequential and recent:
//
//   - new.warning_level ∈ {'caution', 'danger'}
//   - AND (new.warning_level !== old.warning_level OR new.notes !== old.notes)
//   - AND a conditional UPDATE...RETURNING claims a rate-limit slot
//     (last_warning_pushed_at NULL or older than 60s)
//
// Rationale: realtime + slim banner is enough for foregrounded passengers
// on info-level edits and plain notes; system-level push is reserved for
// the case it exists for — locked phones missing safety information.
//
// Atomic rate-limit: the conditional UPDATE prevents two concurrent webhook
// invocations from both firing. The first to write `last_warning_pushed_at`
// wins; the second sees the fresh timestamp and gets an empty RETURNING.
//
// Env (set as Supabase function secrets) — same secrets as send_stop_push:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected)
//
// Deploy:
//   supabase functions deploy send_stop_update_push --no-verify-jwt
//
// Webhook (Supabase dashboard → Database → Webhooks):
//   Table: stop_activations, Events: UPDATE, POST to this function's URL.

// deno-lint-ignore-file no-explicit-any
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY') || '';
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') || '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:fieldnote@example.com';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const ESCALATED_LEVELS = new Set(['caution', 'danger']);

function extractRows(body: any): { newRow: any | null; oldRow: any | null } {
  // Supabase v2 webhook shape
  if (body?.record || body?.old_record) {
    return { newRow: body.record || null, oldRow: body.old_record || null };
  }
  // Older / hand-rolled shape
  if (body?.new || body?.old) {
    return { newRow: body.new || null, oldRow: body.old || null };
  }
  return { newRow: null, oldRow: null };
}

// Strip "[info] " / "[caution] " / "[danger] " / "[bus] " prefix from a notes
// line so the notification body reads naturally. Mirrors parseNoteLine in
// v0.5.html (kept inline here so the function has no shared-code dependency).
function stripLevelPrefix(line: string): string {
  const m = /^\[(info|caution|danger|bus)\]\s*(.*)$/.exec(line);
  return m ? m[2] : line;
}

function firstNotesLine(notes: string | null | undefined): string {
  if (!notes) return '';
  for (const raw of notes.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    return stripLevelPrefix(trimmed);
  }
  return '';
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!VAPID_PRIVATE_KEY || !VAPID_PUBLIC_KEY) {
    return jsonResp(500, { ok: false, error: 'VAPID keys not configured' });
  }

  let body: any;
  try { body = await req.json(); } catch (_e) {
    return jsonResp(400, { ok: false, error: 'invalid JSON' });
  }
  const { newRow, oldRow } = extractRows(body);
  if (!newRow) return jsonResp(400, { ok: false, error: 'no record in payload' });

  const sessionId = String(newRow.session_id || '');
  const stopId = newRow.stop_id;
  const rowId = newRow.id;
  if (!sessionId || stopId == null || rowId == null) {
    return jsonResp(400, { ok: false, error: 'missing session_id/stop_id/id' });
  }

  // ── Filter 1: warning level must be escalated.
  const newLevel = String(newRow.warning_level || 'none');
  if (!ESCALATED_LEVELS.has(newLevel)) {
    return jsonResp(200, { ok: true, skipped: 'level not escalated', level: newLevel });
  }

  // ── Filter 2: something meaningful must have actually changed.
  // Without an old row we can't compare — treat that as "something changed"
  // and proceed (a missing old_record likely means the webhook fired with
  // a payload shape we don't recognize; better to send than to silently
  // drop a danger).
  if (oldRow) {
    const oldLevel = String(oldRow.warning_level || 'none');
    const oldNotes = oldRow.notes || '';
    const newNotes = newRow.notes || '';
    if (oldLevel === newLevel && oldNotes === newNotes) {
      return jsonResp(200, { ok: true, skipped: 'no meaningful change' });
    }
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // ── Filter 3: atomic rate-limit. claim_warning_push_slot returns the row
  // id IFF this invocation wins the 60s slot; empty result = another push
  // beat us and we should skip. The RPC's UPDATE...RETURNING is serialized
  // by Postgres so two concurrent webhook invocations cannot both win.
  const { data: claimRows, error: claimErr } = await supabase
    .rpc('claim_warning_push_slot', { p_id: rowId });
  if (claimErr) {
    console.warn('[send_stop_update_push] claim RPC failed', claimErr);
    return jsonResp(500, { ok: false, error: claimErr.message });
  }
  if (!Array.isArray(claimRows) || claimRows.length === 0) {
    return jsonResp(200, { ok: true, skipped: 'rate-limited' });
  }

  // ── Load stop name for the notification title.
  let stopName = 'this stop';
  try {
    const { data: stop } = await supabase
      .from('stops')
      .select('name')
      .eq('id', stopId)
      .maybeSingle();
    if (stop?.name) stopName = stop.name;
  } catch (err) {
    console.warn('[send_stop_update_push] stop lookup failed', err);
  }

  // ── Load every push subscription for this session.
  const { data: subs, error: subsErr } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('session_id', sessionId);
  if (subsErr) {
    console.warn('[send_stop_update_push] subscription lookup failed', subsErr);
    return jsonResp(500, { ok: false, error: subsErr.message });
  }
  if (!subs || subs.length === 0) {
    return jsonResp(200, { ok: true, sent: 0, note: 'no subscriptions' });
  }

  // ── Build the notification.
  const titlePrefix = newLevel === 'danger' ? '🚨 Danger' : '⚠ Caution';
  const title = `${titlePrefix} at ${stopName}`;
  const bodyLine = firstNotesLine(newRow.notes)
    || (newLevel === 'danger' ? 'Take this seriously — tap for details.' : 'Heads up from your guide.');
  const payload = JSON.stringify({
    title,
    body: bodyLine,
    tag: `fieldnote-warning-${stopId}`,
    url: '/',
    stop_id: stopId,
    session_id: sessionId,
    warning_level: newLevel,
  });

  // ── Fire all sends in parallel; clean up dead endpoints inline.
  let sent = 0;
  let failed = 0;
  const expired: string[] = [];
  const results = await Promise.allSettled(subs.map((s) => {
    return webpush.sendNotification(
      { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
      payload,
    ).then(() => { sent++; })
      .catch((err: any) => {
        failed++;
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          expired.push(s.endpoint);
        } else {
          console.warn('[send_stop_update_push] send failed', err?.statusCode, err?.body);
        }
      });
  }));

  if (expired.length) {
    try {
      await supabase
        .from('push_subscriptions')
        .delete()
        .in('endpoint', expired);
    } catch (err) {
      console.warn('[send_stop_update_push] expired cleanup failed', err);
    }
  }

  return jsonResp(200, {
    ok: true,
    sent,
    failed,
    expired: expired.length,
    total: results.length,
    level: newLevel,
  });
});

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
