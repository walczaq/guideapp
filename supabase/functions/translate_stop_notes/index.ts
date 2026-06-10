// Fieldnote v0.6 — translate_stop_notes Edge Function (AI-1 lite).
//
// Translates a live stop-activation's notes (the warnings/notes a guide
// publishes mid-tour) into ES + ZH via DeepL and stores the result in
// stop_activations.notes_i18n = {_src, es, zh}. That UPDATE fires the
// existing realtime channel, which is what delivers the translation to
// passengers — no new client subscription needed.
//
// Notes format (see parseNoteLine in the app): newline-separated lines, each
// with an optional "[info|caution|danger|bus] " prefix. Prefixes are preserved
// verbatim. "[bus]" lines are NOT translated: their text is an exact-match
// sentinel ('Time to head back to the bus') the client maps to t('bus_headback'),
// so translating it would break that lookup.
//
// Auth: requires a valid guide device token; when the session has an owner the
// caller must be that owner (same lenient-legacy rule as migration 038 — a
// null-owner session is controllable by any valid guide).
//
// Secret required: DEEPL_API_KEY (already configured for translate_tour).
// Optional DEEPL_API_URL override (defaults to the free endpoint).
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const DEEPL_KEY = Deno.env.get('DEEPL_API_KEY') || '';
const DEEPL_URL = Deno.env.get('DEEPL_API_URL') || 'https://api-free.deepl.com/v2/translate';
const TARGETS = [ { lang: 'es', deepl: 'ES' }, { lang: 'zh', deepl: 'ZH' } ];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}

async function deepl(texts: string[], target: string): Promise<string[]> {
  if (!texts.length) return [];
  const resp = await fetch(DEEPL_URL, {
    method: 'POST',
    headers: { 'Authorization': `DeepL-Auth-Key ${DEEPL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: texts, target_lang: target }),
  });
  if (!resp.ok) throw new Error(`DeepL ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  return (data.translations || []).map((t: any) => t.text);
}

// "[info] mind the rocks" → {prefix: "[info] ", level: "info", text: "mind the rocks"}
function parseLine(line: string) {
  const m = /^\[(info|caution|danger|bus)\]\s*(.*)$/.exec(line);
  if (m) return { prefix: `[${m[1]}] `, level: m[1], text: m[2] };
  return { prefix: '', level: 'none', text: line };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' });
  if (!DEEPL_KEY) return json(500, { error: 'DEEPL_API_KEY not configured' });

  let body: any;
  try { body = await req.json(); } catch (_e) { return json(400, { error: 'invalid JSON' }); }
  const token = String(body?.token || '').trim();
  const sessionId = String(body?.sessionId || '').trim();
  const stopId = Number(body?.stopId);
  if (!token || !sessionId || !Number.isFinite(stopId)) return json(400, { error: 'missing token/sessionId/stopId' });

  const sb = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
  const { data: g } = await sb.from('guides').select('id').eq('device_token', token).maybeSingle();
  if (!g) return json(401, { error: 'invalid guide token' });
  const { data: session } = await sb.from('sessions').select('id, owner_guide_id').eq('id', sessionId).maybeSingle();
  if (!session) return json(404, { error: 'session not found' });
  if (session.owner_guide_id && session.owner_guide_id !== g.id) return json(403, { error: 'session not owned' });

  const { data: act } = await sb.from('stop_activations')
    .select('id, notes').eq('session_id', sessionId).eq('stop_id', stopId).maybeSingle();
  if (!act) return json(404, { error: 'no activation for this stop' });

  const notes = (act.notes || '').trim();
  if (!notes) {
    // Notes were cleared — clear the translation too so nothing stale lingers.
    await sb.from('stop_activations').update({ notes_i18n: null }).eq('id', act.id);
    return json(200, { ok: true, translated: 0, note: 'notes empty — cleared notes_i18n' });
  }

  const lines = notes.split(/\r?\n/).map((s: string) => s.trim()).filter(Boolean).map(parseLine);
  const uniq = [...new Set(lines.filter((l: any) => l.level !== 'bus' && l.text).map((l: any) => l.text))] as string[];

  const map: Record<string, any> = {};
  try {
    for (const tgt of TARGETS) {
      const out = await deepl(uniq, tgt.deepl);
      uniq.forEach((src, i) => { (map[src] ||= {})[tgt.lang] = (out[i] != null ? out[i] : src); });
    }
  } catch (err) { return json(502, { error: String((err as any)?.message || err) }); }

  const rebuild = (lang: string) => lines.map((l: any) => {
    if (l.level === 'bus' || !l.text) return l.prefix + l.text; // bus sentinel stays verbatim
    const tr = map[l.text]?.[lang];
    return l.prefix + (tr || l.text);
  }).join('\n');

  const notes_i18n = { _src: notes, es: rebuild('es'), zh: rebuild('zh') };
  const { error } = await sb.from('stop_activations').update({ notes_i18n }).eq('id', act.id);
  if (error) return json(500, { error: error.message });

  return json(200, { ok: true, translated: uniq.length });
});
