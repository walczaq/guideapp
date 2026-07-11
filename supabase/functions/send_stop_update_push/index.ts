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
//   FIREBASE_SERVICE_ACCOUNT (native Android push via FCM v1; skipped if unset)
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

// ── Native push (Capacitor Android app) — FCM HTTP v1 ─────────────────────
// Crypto verbatim from app/specs/appendix-push-reference.md. Kept inline
// (same convention as this function's other helpers: no shared-code
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
// have only native (app) subscribers. Errors never fail the request:
// web-push delivery must not depend on FCM health.
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

// Does this notes blob contain a [bus] line? The HUD-timer departure tap is
// the only thing that emits these; detecting "new bus line vs old" lets us
// fire a separate push without conflating with caution/danger warnings.
function hasBusLine(notes: string | null | undefined): boolean {
  if (!notes) return false;
  for (const raw of notes.split(/\r?\n/)) {
    if (/^\[bus\]/.test(raw.trim())) return true;
  }
  return false;
}

// Format a departure clock time (HH:MM) from an activated_at ISO string
// plus a duration in minutes. Rendered in UTC, which equals local time in
// Iceland (the tour region — no DST, UTC year-round). Returns '' on bad input.
function fmtUTCHHMM(activatedAtIso: string | null | undefined, durationMinutes: number | null): string {
  if (!activatedAtIso || durationMinutes == null) return '';
  const base = Date.parse(activatedAtIso);
  if (Number.isNaN(base)) return '';
  const d = new Date(base + durationMinutes * 60 * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// The bus line's actual text (sans prefix). Used as the body when present.
function firstBusLine(notes: string | null | undefined): string {
  if (!notes) return '';
  for (const raw of notes.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (/^\[bus\]/.test(trimmed)) return stripLevelPrefix(trimmed);
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

  // ── Filter 1: must be one of three push-worthy changes:
  //   (a) escalated caution/danger warning level
  //   (b) a brand-new [bus] departure signal (bus tap doesn't escalate
  //       warning_level — severity 0 in the client — so it arrives with
  //       newLevel='none' but a [bus] line freshly added)
  //   (c) the departure time (duration_minutes) changed
  const newLevel = String(newRow.warning_level || 'none');
  const isEscalated = ESCALATED_LEVELS.has(newLevel);
  const newHasBus = hasBusLine(newRow.notes);
  const oldHasBus = oldRow ? hasBusLine(oldRow.notes) : false;
  const isNewBusSignal = newHasBus && !oldHasBus;
  const newDuration = (newRow.duration_minutes == null) ? null : Number(newRow.duration_minutes);
  const oldDuration = (oldRow && oldRow.duration_minutes != null) ? Number(oldRow.duration_minutes) : null;
  const durationChanged = !!oldRow && newDuration != null && oldDuration != null && newDuration !== oldDuration;
  if (!isEscalated && !isNewBusSignal && !durationChanged) {
    return jsonResp(200, {
      ok: true,
      skipped: 'nothing push-worthy changed',
      level: newLevel,
    });
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
    if (oldLevel === newLevel && oldNotes === newNotes && !durationChanged) {
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
  // NOTE: no early return on zero web subscriptions — a session can have
  // only native (app) subscribers, and the FCM fan-out below must still run.

  // ── Build the notification. Precedence: escalated warning wins over a
  // bare bus signal (a danger sent simultaneously is more urgent than the
  // bus call). Tag is distinct per trigger type so a bus push and a
  // warning push for the same stop don't collapse onto each other on
  // the lockscreen.
  // Renamed from `body` to avoid shadowing the `let body: any` declared
  // at the top of the handler for the request payload — same-scope
  // redeclaration was a TS/Deno compile error.
  let title: string;
  let notificationBody: string;
  let tag: string;
  if (isEscalated) {
    const titlePrefix = newLevel === 'danger' ? '🚨 Danger' : '⚠ Caution';
    title = `${titlePrefix} at ${stopName}`;
    const noteText = firstNotesLine(newRow.notes);
    const levelWord = newLevel === 'danger' ? 'danger' : 'caution';
    notificationBody = noteText
      ? `Your guide sent a ${levelWord} note: "${noteText}". Tap to open the map.`
      : `Your guide flagged a ${levelWord} at ${stopName}. Tap to open the map.`;
    tag = `fieldnote-warning-${stopId}`;
  } else if (isNewBusSignal) {
    title = `🚌 Time to head back · ${stopName}`;
    const busText = firstBusLine(newRow.notes);
    notificationBody = busText
      ? `${busText}. Tap to open the map.`
      : `Your guide signaled departure. Tap to open the map.`;
    tag = `fieldnote-bus-${stopId}`;
  } else {
    // durationChanged === true (Filter 1 guarantees one of the three).
    // Departure clock time = activated_at + duration. Formatted in UTC,
    // which is correct local time for Iceland (no DST, UTC year-round).
    const depHHMM = fmtUTCHHMM(newRow.activated_at, newDuration);
    title = `🕒 Departure time updated · ${stopName}`;
    notificationBody = depHHMM
      ? `Departure is now ${depHHMM}. Tap to open the map.`
      : `Your guide changed the departure time. Tap to open the map.`;
    tag = `fieldnote-departure-${stopId}`;
  }
  // Deep-link the tap back to the passenger's active session path. Worker
  // serves /v0.5 (no .html); boot reads ?session= and rejoins.
  const deepLinkUrl = `/v0.5?session=${encodeURIComponent(sessionId)}`;
  const payload = JSON.stringify({
    title,
    body: notificationBody,
    tag,
    url: deepLinkUrl,
    stop_id: stopId,
    session_id: sessionId,
    warning_level: newLevel,
    bus_signal: isNewBusSignal,
  });

  // ── Fire all sends in parallel; clean up dead endpoints inline.
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
  }

  // Native app tokens (Android via FCM; ios deferred — TODO(ios)). Same
  // title/body as the web-push payload; kind mirrors the tag choice above.
  const native = await sendNativePushes(supabase, sessionId, title, notificationBody, {
    sessionId,
    stopId: String(stopId),
    kind: isEscalated ? 'warning' : (isNewBusSignal ? 'bus' : 'departure'),
  });

  return jsonResp(200, {
    ok: true,
    sent,
    failed,
    expired: expired.length,
    total: subs?.length ?? 0,
    level: newLevel,
    ...native,
  });
});

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
