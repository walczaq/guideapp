// Fieldnote v0.8 — bus_gps Edge Function.
//
// Brings the buses' own GPS trackers into Fieldnote, so passengers see the
// bus on their map during pickup and for the whole tour. Works with any fleet
// platform, in either direction:
//
//   PUSH  — the fleet platform (or the tracker) POSTs positions to this
//           function:  POST .../functions/v1/bus_gps?key=<BUS_GPS_KEY>
//           (or send the key in an `x-fieldnote-key` header). Body: one
//           vehicle, a list, or the platform's own wrapper — see normalize.ts.
//
//   PULL  — Fieldnote fetches the fleet platform's "current positions" API:
//           POST .../functions/v1/bus_gps?key=<BUS_GPS_KEY>&poll=1
//           fetches BUS_GPS_FEED_URL every BUS_GPS_POLL_SECS for just under a
//           minute, so one cron call a minute gives a steady feed.
//
// Either way each reported vehicle is matched to the buses guides added in
// the app (bus "tracker ID" = any id / name / plate the platform reports) and
// handed to ingest_bus_positions (migration 050), which moves the bus icon in
// every live session that bus is attached to.
//
// `?debug=1` (key still required) returns the normalised vehicles instead of
// storing anything — use it to see which tracker IDs the feed offers.
//
// Env (Supabase function secrets):
//   BUS_GPS_KEY          — shared secret callers must present. REQUIRED.
//   BUS_GPS_FEED_URL     — PULL only: the fleet API URL returning positions.
//   BUS_GPS_FEED_HEADERS — PULL only: JSON object of request headers, e.g.
//                          {"Authorization":"Bearer abc123"}
//   BUS_GPS_POLL_SECS    — PULL only: seconds between fetches (default 15, min 5).
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
const FEED_URL = Deno.env.get('BUS_GPS_FEED_URL') || '';
const FEED_HEADERS_RAW = Deno.env.get('BUS_GPS_FEED_HEADERS') || '';
const POLL_SECS = Math.max(5, Number(Deno.env.get('BUS_GPS_POLL_SECS')) || 15);
const POLL_WINDOW_MS = 52000;   // stay inside the once-a-minute cron slot

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

function feedHeaders(): Record<string, string> {
  if (!FEED_HEADERS_RAW) return {};
  try {
    const h = JSON.parse(FEED_HEADERS_RAW);
    return h && typeof h === 'object' ? h : {};
  } catch (_e) {
    console.warn('[bus_gps] BUS_GPS_FEED_HEADERS is not valid JSON — ignored');
    return {};
  }
}

async function store(sb: any, payload: unknown): Promise<{ vehicles: number; written: number }> {
  const positions = normalizePositions(payload);
  if (!positions.length) return { vehicles: 0, written: 0 };
  const { data, error } = await sb.rpc('ingest_bus_positions', { p_positions: positions });
  if (error) throw new Error(error.message);
  return { vehicles: positions.length, written: Number(data) || 0 };
}

async function fetchFeed(): Promise<unknown> {
  const res = await fetch(FEED_URL, {
    headers: { accept: 'application/json', ...feedHeaders() },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`fleet feed answered ${res.status}`);
  return await res.json();
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!INGEST_KEY) return json(503, { error: 'BUS_GPS_KEY is not set' });
  const given = req.headers.get('x-fieldnote-key') || url.searchParams.get('key') || '';
  if (!sameKey(given, INGEST_KEY)) return json(401, { error: 'bad key' });

  const debug = url.searchParams.get('debug') === '1';
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // ── PULL ──
  if (url.searchParams.get('poll') === '1') {
    if (!FEED_URL) return json(503, { error: 'BUS_GPS_FEED_URL is not set' });
    if (debug) {
      try { return json(200, { vehicles: normalizePositions(await fetchFeed()) }); }
      catch (e) { return json(502, { error: String((e as Error).message || e) }); }
    }
    const started = Date.now();
    let rounds = 0, vehicles = 0, written = 0;
    let lastError = '';
    while (true) {
      const roundStart = Date.now();
      try {
        const r = await store(sb, await fetchFeed());
        vehicles = r.vehicles;
        written += r.written;
        lastError = '';
      } catch (e) {
        lastError = String((e as Error).message || e);
        console.warn('[bus_gps] poll failed:', lastError);
      }
      rounds++;
      const next = roundStart + POLL_SECS * 1000;
      if (next - started > POLL_WINDOW_MS) break;
      await new Promise((r) => setTimeout(r, Math.max(0, next - Date.now())));
    }
    return json(lastError ? 502 : 200, { rounds, vehicles, written, ...(lastError ? { error: lastError } : {}) });
  }

  // ── PUSH ──
  if (req.method !== 'POST' && req.method !== 'PUT') return json(405, { error: 'method not allowed' });
  let payload: unknown;
  try { payload = await req.json(); } catch (_e) { return json(400, { error: 'invalid JSON' }); }
  if (debug) return json(200, { vehicles: normalizePositions(payload) });
  try {
    return json(200, await store(sb, payload));
  } catch (e) {
    return json(500, { error: String((e as Error).message || e) });
  }
});
