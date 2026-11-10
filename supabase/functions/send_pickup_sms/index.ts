// Fieldnote v0.8 — send_pickup_sms Edge Function.
//
// When the guide starts pickup, texts every passenger on the session's phone
// list (session_contacts, migration 050) the session's Fieldnote link, so they
// open the app, join the tour and watch the bus approach before it arrives.
//
// Request (from the guide's app):
//   POST { session_id, guide_token, message? }
//     message — the guide's wording (optional). The join link is ALWAYS
//               appended here on the server, so a text can never go out
//               without it or with a different link.
// Response: { sent, failed, remaining, results: [{ id, status, error? }] }
//
// Only contacts not yet texted (pending / failed) are sent, so tapping again
// retries failures and covers numbers added later — nobody is texted twice.
//
// Two ways to send, chosen by which secrets are set:
//
//   A. The company's own Android phone (no per-message provider). The phone
//      runs the open-source "SMS Gateway for Android" app
//      (github.com/capcom6/android-sms-gateway) in Cloud Server mode; we hand
//      each text to the app's API and the phone sends it from its own SIM.
//      The phone must be switched on with signal. "sent" then means "handed to
//      the phone", not "delivered".
//   B. Twilio.
//
// Env (Supabase function secrets):
//   SMS_GATEWAY_USER, SMS_GATEWAY_PASS — (A) the username / password the app
//                                  shows under Cloud Server. Setting both
//                                  selects the phone gateway.
//   SMS_GATEWAY_URL              — (A) API base; default
//                                  https://api.sms-gate.app/3rdparty/v1
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN — (B) Twilio credentials.
//   TWILIO_FROM                  — sender: a Twilio number in E.164
//                                  (+354…) or an alphanumeric sender name.
//   TWILIO_MESSAGING_SERVICE_SID — alternative to TWILIO_FROM.
//   APP_URL                      — base of the join link (default
//                                  https://fieldnote.guide).
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — auto-injected on Supabase.
//
// Deploy:
//   supabase functions deploy send_pickup_sms --no-verify-jwt
//
// The providers live entirely in sendSms() — add another there.
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const TWILIO_SID = Deno.env.get('TWILIO_ACCOUNT_SID') || '';
const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') || '';
const TWILIO_FROM = Deno.env.get('TWILIO_FROM') || '';
const TWILIO_MSID = Deno.env.get('TWILIO_MESSAGING_SERVICE_SID') || '';
const APP_URL = (Deno.env.get('APP_URL') || 'https://fieldnote.guide').replace(/\/+$/, '');

const GATEWAY_USER = Deno.env.get('SMS_GATEWAY_USER') || '';
const GATEWAY_PASS = Deno.env.get('SMS_GATEWAY_PASS') || '';
const GATEWAY_URL = (Deno.env.get('SMS_GATEWAY_URL') || 'https://api.sms-gate.app/3rdparty/v1').replace(/\/+$/, '');
const useGateway = () => !!(GATEWAY_USER && GATEWAY_PASS);

const MAX_MESSAGE_CHARS = 300;
// Parallel sends per round. The phone queues and paces its own sending, so
// the gateway is fed gently; Twilio's limits are far above 8.
const BATCH = useGateway() ? 3 : 8;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'content-type': 'application/json' },
  });
}

const smsConfigured = () => useGateway() || !!(TWILIO_SID && TWILIO_TOKEN && (TWILIO_FROM || TWILIO_MSID));

// One request per passenger (not one for the whole list) so each row in the
// guide's list gets its own sent / failed status.
async function sendViaGateway(to: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${GATEWAY_URL}/message`, {
      method: 'POST',
      headers: {
        authorization: 'Basic ' + btoa(`${GATEWAY_USER}:${GATEWAY_PASS}`),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ textMessage: { text }, phoneNumbers: [to] }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return { ok: true };
    let msg = res.status === 401 ? 'The company phone rejected the login — check the gateway username and password.'
      : `The company phone's gateway answered ${res.status}`;
    try { const j: any = await res.json(); if (res.status !== 401 && j?.message) msg = String(j.message); } catch (_e) { /* keep status text */ }
    return { ok: false, error: msg.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e).slice(0, 200) };
  }
}

async function sendSms(to: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (useGateway()) return sendViaGateway(to, text);
  const form = new URLSearchParams({ To: to, Body: text });
  if (TWILIO_MSID) form.set('MessagingServiceSid', TWILIO_MSID);
  else form.set('From', TWILIO_FROM);
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_SID)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form,
        signal: AbortSignal.timeout(15000),
      },
    );
    if (res.ok) return { ok: true };
    let msg = `SMS provider answered ${res.status}`;
    try { const j: any = await res.json(); if (j?.message) msg = String(j.message); } catch (_e) { /* keep status text */ }
    return { ok: false, error: msg.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e).slice(0, 200) };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' });

  let body: any;
  try { body = await req.json(); } catch (_e) { return json(400, { error: 'invalid JSON' }); }

  const sessionId = String(body?.session_id || '').trim();
  const guideToken = String(body?.guide_token || '').trim();
  if (!sessionId || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) return json(400, { error: 'missing session' });
  if (!guideToken) return json(401, { error: 'missing guide token' });

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { data: session, error: sErr } = await sb
    .from('sessions').select('id, owner_guide_id, ended_at').eq('id', sessionId).maybeSingle();
  if (sErr) return json(500, { error: sErr.message });
  if (!session) return json(404, { error: 'session not found' });
  if (session.ended_at) return json(403, { error: 'this tour has ended' });

  const { data: guide, error: gErr } = await sb
    .from('guides').select('id').eq('device_token', guideToken).maybeSingle();
  if (gErr) return json(500, { error: gErr.message });
  if (!guide) return json(401, { error: 'invalid guide token' });
  if (session.owner_guide_id && session.owner_guide_id !== guide.id) {
    return json(403, { error: 'not your session' });
  }

  if (!smsConfigured()) {
    return json(503, { code: 'sms_not_configured', error: 'Text messages are not set up on the server yet.' });
  }

  const { data: contacts, error: cErr } = await sb
    .from('session_contacts').select('id, phone')
    .eq('session_id', sessionId).neq('sms_status', 'sent').order('id').limit(120);
  if (cErr) return json(500, { error: cErr.message });

  // Guide's wording (control characters and stray links stripped — the only
  // link in the text is the one we add) + the join link.
  let message = String(body?.message || '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[ \t]+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS);
  // Same default as the app; short so text + link stay within one SMS segment.
  if (!message) message = 'See your driver online, click this link:';
  const text = `${message}\n${APP_URL}/j/${encodeURIComponent(sessionId)}`;

  const results: { id: number; status: 'sent' | 'failed'; error?: string }[] = [];
  const list = contacts || [];
  for (let i = 0; i < list.length; i += BATCH) {
    await Promise.all(list.slice(i, i + BATCH).map(async (c: any) => {
      const r = await sendSms(c.phone, text);
      const patch = r.ok
        ? { sms_status: 'sent', sms_error: null, sms_sent_at: new Date().toISOString() }
        : { sms_status: 'failed', sms_error: r.error };
      const { error: uErr } = await sb.from('session_contacts').update(patch).eq('id', c.id);
      if (uErr) console.warn('[send_pickup_sms] status update failed', c.id, uErr.message);
      results.push(r.ok ? { id: c.id, status: 'sent' } : { id: c.id, status: 'failed', error: r.error });
    }));
  }

  const sent = results.filter((r) => r.status === 'sent').length;
  return json(200, { sent, failed: results.length - sent, remaining: results.length - sent, results });
});
