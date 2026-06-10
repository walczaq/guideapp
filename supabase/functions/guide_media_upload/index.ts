// Fieldnote v0.6 — guide_media_upload Edge Function.
//
// Returns a one-time SIGNED UPLOAD URL for the public `guide-chat` storage
// bucket, but only to a caller holding a valid guide device token. This keeps
// uploads guides-only even though clients use the public anon key: the anon
// key alone can't write to the bucket; it must first prove a guide token here.
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const BUCKET = 'guide-chat';
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' });

  let body: any;
  try { body = await req.json(); } catch (_e) { return json(400, { error: 'invalid JSON' }); }

  const token = String(body?.token || '').trim();
  let ext = String(body?.ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!ALLOWED[ext]) ext = 'jpg';
  if (!token) return json(400, { error: 'missing token' });

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { data: guide, error: gErr } = await sb
    .from('guides').select('id').eq('device_token', token).maybeSingle();
  if (gErr) return json(500, { error: gErr.message });
  if (!guide) return json(401, { error: 'invalid guide token' });

  const rid = crypto.randomUUID().replace(/-/g, '');
  const path = `chat/${rid}.${ext}`;
  const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) return json(500, { error: error.message });

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
  return json(200, { path, token: data.token, publicUrl });
});
