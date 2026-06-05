// Fieldnote v0.6 — translate_tour Edge Function.
//
// Auto-translates a tour's guide-authored content (stop names/subtitles, pin
// titles/bodies) into ES + ZH via DeepL, storing results in the *_i18n columns
// passengers read. Token-gated to the tour's owner (or base tours). A field is
// re-translated when its source text changed since last run OR when an es/zh
// value is missing — each i18n value stores its source under _src — so repeated
// calls are cheap/idempotent AND self-heal any partial (missing-language)
// translations left behind by an interrupted run or a manual edit.
//
// Secret required: DEEPL_API_KEY (DeepL Free key from deepl.com). Optional
// DEEPL_API_URL override (defaults to the free endpoint).
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' });
  if (!DEEPL_KEY) return json(500, { error: 'DEEPL_API_KEY not configured' });

  let body: any;
  try { body = await req.json(); } catch (_e) { return json(400, { error: 'invalid JSON' }); }
  const token = String(body?.token || '').trim();
  const tourId = String(body?.tourId || '').trim();
  if (!token || !tourId) return json(400, { error: 'missing token/tourId' });

  const sb = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
  const { data: g } = await sb.from('guides').select('id').eq('device_token', token).maybeSingle();
  if (!g) return json(401, { error: 'invalid guide token' });
  const { data: tour } = await sb.from('tours').select('id, owner_guide_id').eq('id', tourId).maybeSingle();
  if (!tour) return json(404, { error: 'tour not found' });
  if (tour.owner_guide_id && tour.owner_guide_id !== g.id) return json(403, { error: 'tour not editable' });

  const { data: stops } = await sb.from('stops').select('id, name, subtitle, name_i18n, subtitle_i18n').eq('tour_id', tourId);
  const stopIds = (stops || []).map((s: any) => s.id);
  let pins: any[] = [];
  if (stopIds.length) { const { data: p } = await sb.from('pins').select('id, title, body, title_i18n, body_i18n').in('stop_id', stopIds); pins = p || []; }

  // A field needs (re)translating when there's source text and we don't yet
  // have a complete, current pair: the stored _src must equal the current
  // source AND both es + zh must be present. (Checking only _src — as the
  // previous version did — wrongly skipped fields whose _src matched but whose
  // es or zh value was missing, e.g. after an interrupted run or manual edit.)
  const need = (text: any, i18n: any) => {
    const s = (text || '').trim();
    if (!s) return false;
    return !(i18n && i18n._src === s && i18n.es && i18n.zh);
  };
  const fields: any[] = [];
  for (const s of (stops || [])) {
    if (need(s.name, s.name_i18n)) fields.push({ kind: 'stop', id: s.id, col: 'name_i18n', text: s.name.trim() });
    if (need(s.subtitle, s.subtitle_i18n)) fields.push({ kind: 'stop', id: s.id, col: 'subtitle_i18n', text: s.subtitle.trim() });
  }
  for (const p of pins) {
    if (need(p.title, p.title_i18n)) fields.push({ kind: 'pin', id: p.id, col: 'title_i18n', text: p.title.trim() });
    if (need(p.body, p.body_i18n)) fields.push({ kind: 'pin', id: p.id, col: 'body_i18n', text: p.body.trim() });
  }
  if (!fields.length) return json(200, { ok: true, translated: 0, note: 'nothing new to translate' });

  const uniq = [...new Set(fields.map((f) => f.text))];
  const map: Record<string, any> = {};
  try {
    for (const tgt of TARGETS) {
      const out = await deepl(uniq, tgt.deepl);
      uniq.forEach((src, i) => { (map[src] ||= {})[tgt.lang] = (out[i] != null ? out[i] : src); });
    }
  } catch (err) { return json(502, { error: String((err as any)?.message || err) }); }

  const rowUpdates: Record<string, any> = {};
  for (const f of fields) {
    const key = f.kind + ':' + f.id;
    (rowUpdates[key] ||= { kind: f.kind, id: f.id, cols: {} });
    rowUpdates[key].cols[f.col] = { _src: f.text, es: map[f.text].es, zh: map[f.text].zh };
  }
  let rows = 0;
  for (const key of Object.keys(rowUpdates)) {
    const u = rowUpdates[key];
    const { error } = await sb.from(u.kind === 'stop' ? 'stops' : 'pins').update(u.cols).eq('id', u.id);
    if (!error) rows++; else console.warn('[translate_tour] update failed', error);
  }
  return json(200, { ok: true, translated: fields.length, rows });
});
