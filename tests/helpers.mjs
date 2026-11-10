// Shared plumbing: a static server for the repo root, a mocked Supabase, and
// a blocked Mapbox. Nothing here talks to a real backend.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SESSION_ID = 'abc123';
export const GUIDE_TOKEN_KEY = 'fieldnote_guide_token';

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// Serves the repo root the way Cloudflare does for the paths the app uses:
// /v0.5 and /j/<id> both resolve to v0.5.html.
export async function startServer() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/v0.5' || p.startsWith('/j/')) p = '/v0.5.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, r));
  return { base: `http://localhost:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

export function launch() { return chromium.launch(); }

export function makeSession(over = {}) {
  return {
    id: SESSION_ID, label: 'Test', tour_slug: 't1', guide_name: 'G',
    started_at: new Date().toISOString(), ended_at: null, chat_url: null, next_stop_id: null,
    tour_started_at: new Date().toISOString(), home_lng: null, home_lat: null, ...over,
  };
}
export const TOUR = {
  id: 1, slug: 't1', name: 'Tour', subtitle: '', home_lng: -21.9, home_lat: 64.1,
  stops: [{ id: 1, ordinal: 1, name: 'S1', subtitle: '', lng: -21.9, lat: 64.1, activation_radius_m: 100,
    drive_secs_from_prev: null, name_i18n: null, subtitle_i18n: null, pins: [] }],
};

// Routes every Supabase request to a mock and blocks Mapbox's API.
//   opts.session     session row (null → "no such session")
//   opts.offline     abort every backend request
//   opts.preFail     fail only the <head> early reads (plain fetch, no x-client-info)
//   opts.handlers    { '<last path segment>': (request, url) => body | undefined }
// Returns `calls`: [{ name, via: 'pre' | 'lib' }], in order.
export async function mockBackend(page, opts = {}) {
  const calls = [];
  const session = 'session' in opts ? opts.session : makeSession();
  await page.route(/supabase\.co/, (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const headers = req.headers();
    const name = url.pathname.split('/').pop();
    const via = headers['x-client-info'] ? 'lib' : 'pre';
    calls.push({ name, via });
    if (opts.offline) return route.abort();
    if (opts.preFail && via === 'pre') return route.fulfill({ status: 500, body: '{}' });
    const single = (headers.accept || '').includes('pgrst.object');
    const json = (v) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(v) });
    const custom = opts.handlers && opts.handlers[name] && opts.handlers[name](req, url);
    if (custom !== undefined) return json(custom);
    if (name === 'sessions') {
      if (single && !session) {
        return route.fulfill({ status: 406, contentType: 'application/json',
          body: JSON.stringify({ code: 'PGRST116', message: 'no rows' }) });
      }
      return json(single ? session : (session ? [session] : []));
    }
    if (name === 'tours') return json(single ? TOUR : [TOUR]);
    if (url.pathname.includes('/rpc/')) return json(null);
    return json([]);
  });
  await page.route(/mapbox\.com/, (route) => route.abort());
  return calls;
}

// A page with the language already chosen (skips the language gate) unless
// opts.lang === false, and optionally logged in as a guide.
export async function newAppPage(browser, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(([lang, guideKey]) => {
    if (lang) localStorage.setItem('fieldnote_lang', 'en');
    if (guideKey) localStorage.setItem(guideKey, 'tok');
  }, [opts.lang !== false, opts.guide ? GUIDE_TOKEN_KEY : null]);
  return { page, errors };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
