// Fieldnote v0.5 chunk D — send_stop_push Edge Function.
//
// Triggered by a Supabase Database Webhook on stop_activations INSERT (and
// optionally UPDATE so notes/warning edits also notify). Loads every
// push_subscription for the session, builds a notification payload, fires
// a Web Push to each.
//
// Env (set as Supabase function secrets):
//   VAPID_PUBLIC_KEY       — must match VAPID_PUBLIC_KEY in v0.5.html
//   VAPID_PRIVATE_KEY      — the private key from `web-push generate-vapid-keys`
//   VAPID_SUBJECT          — e.g. "mailto:you@example.com" (required by the spec)
//   SUPABASE_URL           — Supabase project URL (auto-injected on Supabase)
//   SUPABASE_SERVICE_ROLE_KEY — service role key (auto-injected on Supabase)
//
// Deploy:
//   supabase functions deploy send_stop_push --no-verify-jwt
//
// Configure DB Webhook (Supabase dashboard → Database → Webhooks):
//   Table: stop_activations
//   Events: INSERT
//   HTTP request: POST to .../functions/v1/send_stop_push
//   Method: POST, type: application/json, default Supabase headers fine
//
// The webhook body shape (Supabase v2) is:
//   { type: "INSERT", table: "stop_activations", record: {...}, ... }
//
// We tolerate the older shape `{ event: "INSERT", new: {...} }` too so the
// same function works for hand-rolled invocations.

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

function extractActivationRow(body: any): any | null {
  // Supabase v2 webhook
  if (body?.record) return body.record;
  // Older shape
  if (body?.new) return body.new;
  // Direct invocation: the row IS the body
  if (body?.session_id && body?.stop_id) return body;
  return null;
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
  const row = extractActivationRow(body);
  if (!row) return jsonResp(400, { ok: false, error: 'no activation row in payload' });

  const sessionId = String(row.session_id || '');
  const stopId = row.stop_id;
  if (!sessionId || stopId == null) {
    return jsonResp(400, { ok: false, error: 'missing session_id/stop_id' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Look up the stop name so the notification can read like the activation
  // banner the foregrounded passengers saw. Best-effort — fall back to a
  // generic title if the join fails.
  let stopName = 'a new stop';
  let stopOrdinal: number | null = null;
  try {
    const { data: stop } = await supabase
      .from('stops')
      .select('name, ordinal')
      .eq('id', stopId)
      .maybeSingle();
    if (stop) {
      stopName = stop.name || stopName;
      stopOrdinal = (typeof stop.ordinal === 'number') ? stop.ordinal : null;
    }
  } catch (err) {
    console.warn('[send_stop_push] stop lookup failed', err);
  }

  // Load every push subscription for this session.
  const { data: subs, error: subsErr } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('session_id', sessionId);

  if (subsErr) {
    console.warn('[send_stop_push] subscription lookup failed', subsErr);
    return jsonResp(500, { ok: false, error: subsErr.message });
  }

  if (!subs || subs.length === 0) {
    return jsonResp(200, { ok: true, sent: 0, note: 'no subscriptions' });
  }

  const title = stopOrdinal != null
    ? `Stop ${String(stopOrdinal).padStart(2, '0')} · ${stopName}`
    : `${stopName} is now active`;
  // Deep-link the notification tap back to the passenger's active session
  // path. The Worker serves /v0.5 (no .html suffix); the boot path reads
  // ?session= from the query string and rejoins the session.
  const deepLinkUrl = `/v0.5?session=${encodeURIComponent(sessionId)}`;
  const payload = JSON.stringify({
    title,
    body: 'Tap to see the new pins.',
    tag: `fieldnote-stop-${stopId}`,
    url: deepLinkUrl,
    stop_id: stopId,
    session_id: sessionId,
  });

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
        // 404/410 → endpoint is dead; queue for cleanup.
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          expired.push(s.endpoint);
        } else {
          console.warn('[send_stop_push] send failed', err?.statusCode, err?.body);
        }
      });
  }));

  // Cleanup expired subscriptions in a single follow-up query — failures
  // here are non-fatal; the next activation will try them again.
  if (expired.length) {
    try {
      await supabase
        .from('push_subscriptions')
        .delete()
        .in('endpoint', expired);
    } catch (err) {
      console.warn('[send_stop_push] expired cleanup failed', err);
    }
  }

  return jsonResp(200, {
    ok: true,
    sent,
    failed,
    expired: expired.length,
    total: results.length,
  });
});

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
