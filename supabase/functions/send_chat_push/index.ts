// Fieldnote v0.7 — send_chat_push Edge Function.
//
// Notifies the session's GUIDE when a passenger writes in the tour chat.
// Called by the AFTER INSERT trigger on session_chat_messages (migration
// 048), which POSTs the Database-Webhook shape { type, table, record }.
//
// Never trusts the payload beyond the message id: the row is re-read with
// the service role and claimed via guide_notified_at (set once, atomically),
// so each message notifies at most once even if this URL is called by hand.
//
// Noise control:
//   • Private message (thread_passenger_id set) → always notify.
//   • Group message → notify unless the guide was already pushed about a
//     group message in this session in the last 2 minutes.
//
// Delivery: web push (VAPID, same keys as send_stop_push) + Android via FCM
// v1 (FIREBASE_SERVICE_ACCOUNT). iOS native tokens are skipped, like the stop
// pushes (TODO(ios)).
//
// Deploy with JWT verification OFF (the trigger sends no Authorization):
//   supabase functions deploy send_chat_push --no-verify-jwt
//
// deno-lint-ignore-file no-explicit-any
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY') || '';
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') || '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:fieldnote@example.com';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const FIREBASE_SERVICE_ACCOUNT = Deno.env.get('FIREBASE_SERVICE_ACCOUNT') || '';
const GROUP_QUIET_MS = 2 * 60 * 1000;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// ── FCM v1 helpers (inline, same as send_stop_push — no shared code) ──────
let _gToken: { token: string; exp: number } | null = null;
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (obj: unknown) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
const pemToDer = (pem: string) =>
  Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')), (c) => c.charCodeAt(0));

async function googleAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (_gToken && _gToken.exp - 60 > now) return _gToken.token;
  const sa = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const unsigned =
    b64urlJson({ alg: 'RS256', typ: 'JWT' }) + '.' +
    b64urlJson({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now, exp: now + 3600,
    });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + b64url(sig),
    }),
  });
  if (!res.ok) throw new Error('google token: ' + res.status + ' ' + await res.text());
  const j = await res.json();
  _gToken = { token: j.access_token, exp: now + (j.expires_in ?? 3600) };
  return _gToken.token;
}

async function sendFcm(projectId: string, token: string, title: string, body: string,
                       data: Record<string, string>): Promise<'ok' | 'gone' | 'error'> {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + await googleAccessToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: {
      token, notification: { title, body }, data, android: { priority: 'HIGH' },
    }}),
  });
  if (res.ok) return 'ok';
  const txt = await res.text();
  if (res.status === 404 || txt.includes('UNREGISTERED')) return 'gone';
  console.warn('[fcm]', res.status, txt);
  return 'error';
}

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function clip(s: string, n: number) {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return jsonResp(405, { ok: false, error: 'method not allowed' });
  let payload: any;
  try { payload = await req.json(); } catch (_e) { return jsonResp(400, { ok: false, error: 'invalid JSON' }); }
  const rec = payload?.record || payload?.new || payload;
  const msgId = Number(rec?.id);
  if (!Number.isFinite(msgId) || msgId <= 0) return jsonResp(400, { ok: false, error: 'no message id' });

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Claim the message: only the first call for a passenger message proceeds.
  const { data: claimed, error: cErr } = await sb
    .from('session_chat_messages')
    .update({ guide_notified_at: new Date().toISOString() })
    .eq('id', msgId).eq('sender_role', 'passenger').is('guide_notified_at', null)
    .select('id, session_id, thread_passenger_id, sender_name, body, media_url, created_at');
  if (cErr) return jsonResp(500, { ok: false, error: cErr.message });
  const msg = claimed && claimed[0];
  if (!msg) return jsonResp(200, { ok: true, skipped: 'not a new passenger message' });

  const isPrivate = !!msg.thread_passenger_id;
  if (!isPrivate) {
    const since = new Date(Date.now() - GROUP_QUIET_MS).toISOString();
    const { count } = await sb
      .from('session_chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', msg.session_id).is('thread_passenger_id', null)
      .eq('guide_pushed', true).gte('guide_notified_at', since).neq('id', msg.id);
    if ((count ?? 0) > 0) return jsonResp(200, { ok: true, skipped: 'group quiet period' });
  }

  const { data: session } = await sb
    .from('sessions').select('id, label, owner_guide_id, ended_at').eq('id', msg.session_id).maybeSingle();
  if (!session || !session.owner_guide_id) return jsonResp(200, { ok: true, skipped: 'no session owner' });
  if (session.ended_at) return jsonResp(200, { ok: true, skipped: 'session ended' });

  const { data: targets, error: tErr } = await sb
    .from('guide_push_targets').select('id, kind, endpoint, p256dh, auth')
    .eq('guide_id', session.owner_guide_id);
  if (tErr) return jsonResp(500, { ok: false, error: tErr.message });
  if (!targets || !targets.length) return jsonResp(200, { ok: true, skipped: 'guide has no devices' });

  const who = clip(msg.sender_name || 'A passenger', 40);
  const title = isPrivate ? `💬 ${who} (private)` : `💬 ${who} in group chat`;
  const body = msg.body ? clip(msg.body, 140) : '📷 Photo';
  const url = `/v0.5?session=${encodeURIComponent(msg.session_id)}&role=guide&chat=1`;
  const tag = isPrivate ? `fieldnote-chat-${msg.session_id}-${msg.thread_passenger_id}` : `fieldnote-chat-${msg.session_id}-group`;
  const webPayload = JSON.stringify({ title, body, tag, url, session_id: msg.session_id, kind: 'chat' });

  let sent = 0, failed = 0;
  const dead: number[] = [];
  let projectId = '';
  try { projectId = FIREBASE_SERVICE_ACCOUNT ? (JSON.parse(FIREBASE_SERVICE_ACCOUNT).project_id || '') : ''; } catch { /* none */ }

  await Promise.allSettled(targets.map(async (t: any) => {
    try {
      if (t.kind === 'web') {
        if (!VAPID_PRIVATE_KEY) { failed++; return; }
        await webpush.sendNotification({ endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } }, webPayload);
        sent++;
      } else if (t.kind === 'android') {
        if (!projectId) { failed++; return; }
        const r = await sendFcm(projectId, t.endpoint, title, body,
          { sessionId: String(msg.session_id), kind: 'chat' });
        if (r === 'ok') sent++; else { failed++; if (r === 'gone') dead.push(t.id); }
      }
      // ios: not delivered yet (TODO(ios)), same as the stop pushes.
    } catch (err: any) {
      failed++;
      if (err?.statusCode === 404 || err?.statusCode === 410) dead.push(t.id);
      else console.warn('[send_chat_push] send failed', err?.statusCode, err?.body || err);
    }
  }));

  if (dead.length) {
    try { await sb.from('guide_push_targets').delete().in('id', dead); } catch { /* retried next time */ }
  }
  if (sent > 0) {
    try { await sb.from('session_chat_messages').update({ guide_pushed: true }).eq('id', msg.id); } catch { /* best effort */ }
  }
  return jsonResp(200, { ok: true, sent, failed, removed: dead.length });
});
