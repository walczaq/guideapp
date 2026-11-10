// Fieldnote v0.8 — bus_gps Edge Function.
//
// Brings the buses' own GPS trackers into Fieldnote, so passengers see the
// bus on their map during pickup and for the whole tour. Works with any fleet
// platform, in either direction:
//
//   PUSH  — the fleet platform (or the tracker) POSTs positions to this
//           function:  POST .../functions/v1/bus_gps?key=<key>
//           (or send the key in an `x-fieldnote-key` header). Body: one
//           vehicle, a list, or the platform's own wrapper — see normalize.ts.
//
//   PULL  — Fieldnote fetches the fleet platform's "current positions" API:
//           POST .../functions/v1/bus_gps?key=<key>&poll=1
//           fetches the feed every BUS_GPS_POLL_SECS for just under a minute,
//           so one cron call a minute gives a steady feed.
//
// Whose buses: the KEY decides (migration 051).
//   * A company's own key (Company screen → Bus GPS) — positions only ever
//     move that company's buses; `poll=1` pulls that company's feed address.
//   * The server-wide BUS_GPS_KEY — moves buses of guides who are in no
//     company; `poll=1` pulls the env feed AND every company that has set a
//     feed address. This is the key the once-a-minute cron uses.
//
// Each reported vehicle is matched to a bus by its "tracker ID" (= any id /
// name / plate the platform reports) and handed to ingest_bus_positions,
// which moves the bus icon in every live session that bus is attached to.
//
// `?debug=1` (key still required) returns the normalised vehicles instead of
// storing anything — use it to see which tracker IDs the feed offers.
//
// Env (Supabase function secrets):
//   BUS_GPS_KEY          — server-wide key (needed for the cron). Optional if
//                          every caller uses a company key.
//   BUS_GPS_FEED_URL     — PULL, no-company buses only: the fleet API URL.
//   BUS_GPS_FEED_HEADERS — PULL, as above: JSON object of request headers,
//                          e.g. {"Authorization":"Bearer abc123"}
//   BUS_GPS_POLL_SECS    — PULL: seconds between fetches (default 15, min 5).
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — auto-injected on Supabase.
//
// Deploy:
//   supabase functions deploy bus_gps --no-verify-jwt
//
// PULL schedule (run once in the SQL editor, with your project ref + key):
//   create extension if not exists pg_net;
//   select cron.schedule('bus-gps-poll', '* * * * *', $$
//     select net.http_post(
//       url := 'https://<project-ref>.supabase.co/functions/v1/bus_gps?poll=1',
//       headers := '{"x-fieldnote-key":"<BUS_GPS_KEY>","content-type":"application/json"}'::jsonb,
//       body := '{}'::jsonb, timeout_milliseconds := 58000);
//   $$);
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { normalizePositions } from './normalize.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const INGEST_KEY = Deno.env.get('BUS_GPS_KEY') || '';
const ENV_FEED_URL = Deno.env.get('BUS_GPS_FEED_URL') || '';
const ENV_FEED_HEADERS_RAW = Deno.env.get('BUS_GPS_FEED_HEADERS') || '';
const POLL_SECS = Math.max(5, Number(Deno.env.get('BUS_GPS_POLL_SECS')) || 15);
const POLL_WINDOW_MS = 52000;   // stay inside the once-a-minute cron slot

// One place positions are pulled from, and whose buses they may move
// (companyId null = buses of guides in no company).
interface Feed { companyId: string | null; url: string; headers: Record<string, string> }

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

// Constant-time compare so the key can't be guessed byte by byte.
function sameKey(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

// Header values must be plain strings; anything else is dropped.
function cleanHeaders(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (h && typeof h === 'object' && !Array.isArray(h)) {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
      if (typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(k)) out[k] = v;
    }
  }
  return out;
}

function envFeed(): Feed | null {
  if (!ENV_FEED_URL) return null;
  let headers: Record<string, string> = {};
  if (ENV_FEED_HEADERS_RAW) {
    try { headers = cleanHeaders(JSON.parse(ENV_FEED_HEADERS_RAW)); }
    catch (_e) { console.warn('[bus_gps] BUS_GPS_FEED_HEADERS is not valid JSON — ignored'); }
  }
  return { companyId: null, url: ENV_FEED_URL, headers };
}

async function store(sb: any, payload: unknown, companyId: string | null): Promise<{ vehicles: number; written: number }> {
  const positions = normalizePositions(payload);
  if (!positions.length) return { vehicles: 0, written: 0 };
  const { data, error } = await sb.rpc('ingest_bus_positions', { p_positions: positions, p_company_id: companyId });
  if (error) throw new Error(error.message);
  return { vehicles: positions.length, written: Number(data) || 0 };
}

async function fetchFeed(feed: Feed): Promise<unknown> {
  // Company feed addresses are admin-entered: https only, never followed
  // through a redirect to somewhere else.
  if (!/^https:\/\//i.test(feed.url)) throw new Error('fleet feed address must be https');
  const res = await fetch(feed.url, {
    headers: { accept: 'application/json', ...feed.headers },
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`fleet feed answered ${res.status}`);
  return await res.json();
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const given = req.headers.get('x-fieldnote-key') || url.searchParams.get('key') || '';
  if (!given) return json(401, { error: 'missing key' });

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Who is calling? The server-wide key, or one company's key.
  const isGlobal = !!INGEST_KEY && sameKey(given, INGEST_KEY);
  let company: { id: string; bus_feed_url: string | null; bus_feed_headers: unknown } | null = null;
  if (!isGlobal) {
    // Tolerant: before migration 051 the table doesn't exist → just "bad key".
    const { data } = await sb.from('companies')
      .select('id, bus_feed_url, bus_feed_headers').eq('bus_gps_key', given).maybeSingle();
    company = data || null;
    if (!company) return json(401, { error: 'bad key' });
  }
  const callerCompanyId = company ? company.id : null;
  const debug = url.searchParams.get('debug') === '1';

  // ── PULL ──
  if (url.searchParams.get('poll') === '1') {
    const feeds: Feed[] = [];
    if (company) {
      if (company.bus_feed_url) feeds.push({ companyId: company.id, url: company.bus_feed_url, headers: cleanHeaders(company.bus_feed_headers) });
    } else {
      const e = envFeed();
      if (e) feeds.push(e);
      const { data } = await sb.from('companies')
        .select('id, bus_feed_url, bus_feed_headers').not('bus_feed_url', 'is', null).limit(200);
      for (const c of data || []) {
        feeds.push({ companyId: c.id, url: c.bus_feed_url, headers: cleanHeaders(c.bus_feed_headers) });
      }
    }
    if (!feeds.length) return json(200, { rounds: 0, feeds: 0, note: 'no fleet feed address is set' });

    if (debug) {
      // A company key sees its own feed; the server key sees only the env feed
      // (never another company's vehicles).
      const f = company ? feeds[0] : envFeed();
      if (!f) return json(200, { vehicles: [] });
      try { return json(200, { vehicles: normalizePositions(await fetchFeed(f)) }); }
      catch (e) { return json(502, { error: String((e as Error).message || e) }); }
    }

    const started = Date.now();
    let rounds = 0, written = 0, failed = 0;
    let lastError = '';
    while (true) {
      const roundStart = Date.now();
      failed = 0;
      // Feeds are independent: one company's fleet API being down must not
      // stall the others.
      await Promise.all(feeds.map(async (f) => {
        try {
          const r = await store(sb, await fetchFeed(f), f.companyId);
          written += r.written;
        } catch (e) {
          failed++;
          lastError = String((e as Error).message || e);
          console.warn('[bus_gps] poll failed', f.companyId || 'env', lastError);
        }
      }));
      rounds++;
      const next = roundStart + POLL_SECS * 1000;
      if (next - started > POLL_WINDOW_MS) break;
      await new Promise((r) => setTimeout(r, Math.max(0, next - Date.now())));
    }
    const allFailed = failed === feeds.length;
    return json(allFailed ? 502 : 200, {
      rounds, feeds: feeds.length, written,
      ...(failed ? { failed, error: company || feeds.length === 1 ? lastError : 'some feeds failed' } : {}),
    });
  }

  // ── PUSH ──
  if (req.method !== 'POST' && req.method !== 'PUT') return json(405, { error: 'method not allowed' });
  let payload: unknown;
  try { payload = await req.json(); } catch (_e) { return json(400, { error: 'invalid JSON' }); }
  if (debug) return json(200, { vehicles: normalizePositions(payload) });
  try {
    return json(200, await store(sb, payload, callerCompanyId));
  } catch (e) {
    return json(500, { error: String((e as Error).message || e) });
  }
});
