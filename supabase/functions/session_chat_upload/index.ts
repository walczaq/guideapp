// Fieldnote v0.7 — session_chat_upload Edge Function.
//
// Returns a one-time SIGNED UPLOAD URL for the public `session-chat` storage
// bucket so tour-chat members can attach photos. The anon key alone can't
// write to the bucket; the caller must prove they belong to the session:
//   * guide     — { session_id, guide_token }   (must own the session)
//   * passenger — { session_id, passenger_id, chat_key }  (key claimed via
//                 claim_session_chat_key; we compare md5 like the RPCs do)
// Uploads are refused once the session has ended. Files land under
// `<session_id>/…` — post_session_chat only accepts URLs under that prefix.
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { crypto as stdCrypto } from 'jsr:@std/crypto@1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const BUCKET = 'session-chat';
const ALLOWED: Record<string, true> = { jpg: true, jpeg: true, png: true, webp: true };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}

async function md5Hex(s: string): Promise<string> {
  const buf = await stdCrypto.subtle.digest('MD5', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' });

  let body: any;
  try { body = await req.json(); } catch (_e) { return json(400, { error: 'invalid JSON' }); }

  const sessionId = String(body?.session_id || '').trim();
  const guideToken = String(body?.guide_token || '').trim();
  const passengerId = String(body?.passenger_id || '').trim();
  const chatKey = String(body?.chat_key || '').trim();
  let ext = String(body?.ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!ALLOWED[ext]) ext = 'jpg';
  if (!sessionId || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) return json(400, { error: 'missing session' });

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { data: session, error: sErr } = await sb
    .from('sessions').select('id, owner_guide_id, ended_at').eq('id', sessionId).maybeSingle();
  if (sErr) return json(500, { error: sErr.message });
  if (!session) return json(404, { error: 'session not found' });
  if (session.ended_at) return json(403, { error: 'this tour has ended' });

  if (guideToken) {
    const { data: guide, error: gErr } = await sb
      .from('guides').select('id').eq('device_token', guideToken).maybeSingle();
    if (gErr) return json(500, { error: gErr.message });
    if (!guide) return json(401, { error: 'invalid guide token' });
    if (session.owner_guide_id && session.owner_guide_id !== guide.id) {
      return json(403, { error: 'not your session' });
    }
  } else {
    if (!passengerId || !chatKey) return json(400, { error: 'missing credentials' });
    const { data: keyRow, error: kErr } = await sb
      .from('session_chat_keys').select('key_hash')
      .eq('session_id', sessionId).eq('passenger_id', passengerId).maybeSingle();
    if (kErr) return json(500, { error: kErr.message });
    if (!keyRow || keyRow.key_hash !== await md5Hex(chatKey)) {
      return json(401, { error: 'chat not authorised for this device' });
    }
  }

  const rid = crypto.randomUUID().replace(/-/g, '');
  const path = `${sessionId}/${rid}.${ext}`;
  const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) return json(500, { error: error.message });

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
  return json(200, { path, token: data.token, publicUrl });
});
