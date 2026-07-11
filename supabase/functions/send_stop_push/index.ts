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
//   FIREBASE_SERVICE_ACCOUNT — full service-account JSON (native Android
//                              push via FCM v1; fan-out skipped if unset)
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

// ── Native push (Capacitor Android app) — FCM HTTP v1 ─────────────────────
// Crypto verbatim from app/specs/appendix-push-reference.md. Kept inline
// (same convention as send_stop_update_push's helpers: no shared-code
// dependency between functions). ios tokens are NOT delivered here yet —
// the iOS migration session adds direct APNs (spec I2.1). TODO(ios).

const FIREBASE_SERVICE_ACCOUNT = Deno.env.get('FIREBASE_SERVICE_ACCOUNT') || '';

// Cache across warm invocations.
let _gToken: { token: string; exp: number } | null = null;

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (obj: unknown) =>
  b64url(new TextEncoder().encode(JSON.stringify(obj)));
const pemToDer = (pem: string) =>
  Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "")),
    (c) => c.charCodeAt(0));

async function googleAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (_gToken && _gToken.exp - 60 > now) return _gToken.token;
  const sa = JSON.parse(Deno.env.get("FIREBASE_SERVICE_ACCOUNT")!);
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const unsigned =
    b64urlJson({ alg: "RS256", typ: "JWT" }) + "." +
    b64urlJson({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now, exp: now + 3600,
    });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key,
    new TextEncoder().encode(unsigned));
  const assertion = unsigned + "." + b64url(sig);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) throw new Error("google token: " + res.status + " " + await res.text());
  const j = await res.json();
  _gToken = { token: j.access_token, exp: now + (j.expires_in ?? 3600) };
  return _gToken.token;
}

// project id comes from the same service-account JSON (sa.project_id)
async function sendFcm(saProjectId: string, token: string,
                       title: string, body: string,
                       data: Record<string, string>): Promise<"ok" | "gone" | "error"> {
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${saProjectId}/messages:send`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + await googleAccessToken(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: {
      token,
      notification: { title, body },
      data,                                   // string values ONLY
      android: { priority: "HIGH" },
    }}),
  });
  if (res.ok) return "ok";
  const txt = await res.text();
  // UNREGISTERED / NOT_FOUND → delete the token row.
  if (res.status === 404 || txt.includes("UNREGISTERED")) return "gone";
  console.warn("[fcm]", res.status, txt);
  return "error";
}

// Fan out the SAME copy as the web-push path to the session's native
// tokens. Runs even when there are zero web subscriptions — a session can
// have only native subscribers. Errors never fail the request: web-push
// delivery must not depend on FCM health.
async function sendNativePushes(supabase: any, sessionId: string,
                                title: string, body: string,
                                data: Record<string, string>) {
  const out = { nativeSent: 0, nativeFailed: 0, nativeRemoved: 0, nativeDeferred: 0 };
  if (!FIREBASE_SERVICE_ACCOUNT) return out;   // secret not configured yet
  let saProjectId = '';
  try { saProjectId = JSON.parse(FIREBASE_SERVICE_ACCOUNT).project_id || ''; } catch { /* fall through */ }
  if (!saProjectId) { console.warn('[fcm] FIREBASE_SERVICE_ACCOUNT missing project_id'); return out; }
  const { data: natives, error } = await supabase
    .from('native_push_tokens')
    .select('id, platform, token, lang')
    .eq('session_id', sessionId);
  if (error) { console.warn('[fcm] native token lookup failed', error); return out; }
  for (const t of natives ?? []) {
    // TODO(ios): deliver ios tokens via direct APNs (native-ios-migration.md I2.1).
    if (t.platform !== 'android') { out.nativeDeferred++; continue; }
    try {
      const r = await sendFcm(saProjectId, t.token, title, body, data);
      if (r === 'ok') out.nativeSent++;
      else if (r === 'gone') {
        out.nativeRemoved++;
        try { await supabase.from('native_push_tokens').delete().eq('id', t.id); } catch { /* next send retries */ }
      } else out.nativeFailed++;
    } catch (err) {
      out.nativeFailed++;
      console.warn('[fcm] send threw', err);
    }
  }
  return out;
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

  // NOTE: no early return on zero web subscriptions — a session can have
  // only native (app) subscribers, and the FCM fan-out below must still run.

  // Title: action + name. Body: what happened, ending with the tap CTA.
  // We keep the stop ordinal in the title only when present so the user
  // sees both the place and the position in the tour at a glance.
  const title = stopOrdinal != null
    ? `Stop ${String(stopOrdinal).padStart(2, '0')} · ${stopName}`
    : stopName;
  // Renamed from `body` to avoid shadowing the `let body: any` declared
  // at the top of the handler for the request payload — same-scope
  // redeclaration was a TS/Deno compile error and crashed the function
  // on every invocation, silently breaking push delivery.
  const notificationBody = stopOrdinal != null
    ? `Your guide just started Stop ${String(stopOrdinal).padStart(2, '0')} — ${stopName}. Tap to open the map.`
    : `Your guide just started a new stop: ${stopName}. Tap to open the map.`;
  // Deep-link the notification tap back to the passenger's active session
  // path. The Worker serves /v0.5 (no .html suffix); the boot path reads
  // ?session= from the query string and rejoins the session.
  const deepLinkUrl = `/v0.5?session=${encodeURIComponent(sessionId)}`;
  const payload = JSON.stringify({
    title,
    body: notificationBody,
    tag: `fieldnote-stop-${stopId}`,
    url: deepLinkUrl,
    stop_id: stopId,
    session_id: sessionId,
  });

  let sent = 0;
  let failed = 0;
  const expired: string[] = [];

  if (subs && subs.length > 0) {
    await Promise.allSettled(subs.map((s) => {
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
  }

  // Native app tokens (Android via FCM; ios deferred — TODO(ios)). Same
  // title/body as the web-push payload.
  const native = await sendNativePushes(supabase, sessionId, title, notificationBody, {
    sessionId,
    stopId: String(stopId),
    kind: 'stop',
  });

  return jsonResp(200, {
    ok: true,
    sent,
    failed,
    expired: expired.length,
    total: subs?.length ?? 0,
    ...native,
  });
});

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
