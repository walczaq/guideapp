// Offline test rig for Fieldnote — runs the real app (v0.5.html from this
// working copy) in headless Chromium against the in-memory backend in
// backend.js, with the real Mapbox GL engine drawing a blank map + 100 m grid
// (no map tiles: this environment cannot reach Mapbox or Supabase).
//
//   const { Rig } = require('./rig');
//   const rig = await Rig.start();
//   const sessionId = rig.createSession();
//   const guide = await rig.openGuide(sessionId);
//   const pax = await rig.openPassenger(sessionId, { at: [64.3104, -20.3024] });
//
// See README.md for what it can and cannot tell you.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { Backend } = require('./backend');
const SEED = require('./seed');

const ROOT = path.resolve(__dirname, '..', '..');
const ORIGIN = 'https://fieldnote.guide';
const SB_HOST = 'xgelrfdrdvrlltcsquqh.supabase.co';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const M_PER_DEG = 111320;

function metersBetween(a, b) {
  const dLat = (b[0] - a[0]) * M_PER_DEG, dLng = (b[1] - a[1]) * M_PER_DEG * Math.cos(a[0] * Math.PI / 180);
  return Math.hypot(dLat, dLng);
}
// Points every `stepM` metres along a [lat,lng] polyline (ends included).
function densify(points, stepM) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], n = Math.max(1, Math.ceil(metersBetween(a, b) / stepM));
    for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}

// The app's three typefaces, from the @fontsource packages in node_modules
// (run `npm install` in this folder). Without them the rig still works, with
// fallback fonts — text widths in screenshots will then differ from the app.
const FONT_DIR = path.join(__dirname, 'fonts-cache');
function fontCss() {
  const fams = [['Atkinson Hyperlegible', 'atkinson-hyperlegible'], ['Fraunces', 'fraunces'], ['JetBrains Mono', 'jetbrains-mono']];
  let css = '';
  for (const [family, pkg] of fams) {
    const dir = path.join(__dirname, 'node_modules', '@fontsource', pkg, 'files');
    if (!fs.existsSync(dir)) continue;
    fs.mkdirSync(FONT_DIR, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      const m = new RegExp('^' + pkg + '-latin(-ext)?-(\\d+)-(normal|italic)\\.woff2$').exec(f);
      if (!m) continue;
      if (!fs.existsSync(path.join(FONT_DIR, f))) fs.copyFileSync(path.join(dir, f), path.join(FONT_DIR, f));
      const range = m[1] ? 'U+0100-02AF,U+0304,U+0308,U+0329,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF' : 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
      css += `@font-face{font-family:'${family}';font-style:${m[3]};font-weight:${m[2]};font-display:block;src:url(https://rig-fonts.invalid/${f}) format('woff2');unicode-range:${range};}\n`;
    }
  }
  return css;
}

class Rig {
  static async start(opts = {}) {
    const rig = new Rig();
    rig.outDir = opts.outDir || path.join(__dirname, 'out');
    fs.mkdirSync(rig.outDir, { recursive: true });
    rig.backend = new Backend();
    rig.guideAccount = rig.backend.seed(opts.seed || SEED);
    rig.seed = opts.seed || SEED;
    rig.browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    rig.pages = new Set();
    rig.errors = [];       // uncaught page errors, all windows
    rig.blocked = new Set(); // outside URLs the app tried and the rig refused
    rig.backend.listeners.add((ev) => {
      for (const p of rig.pages) { if (!p.isClosed()) p.evaluate((e) => window.__rigEvent && window.__rigEvent(e), ev).catch(() => {}); }
    });
    return rig;
  }

  async stop() { await this.browser.close(); }

  // ── data shortcuts ──
  tour(slug) { const t = this.backend.t.tours.find(x => x.slug === (slug || this.seed.tour.slug)); return this.backend.tourWithStops(t); }
  // Create a session the way the app's "Start session" does (a sessions row
  // owned by the rig guide). Returns its id.
  createSession(tourSlug) {
    const id = 'rig' + Math.random().toString(36).slice(2, 7);
    this.backend.insertRow('sessions', { id, label: 'Rig session', tour_slug: tourSlug || this.seed.tour.slug, guide_name: this.guideAccount.name, owner_guide_id: this.guideAccount.id });
    return id;
  }

  // ── windows ──
  async _context({ at, storage, viewport }) {
    const ctx = await this.browser.newContext({
      viewport: viewport || { width: 412, height: 870 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'Atlantic/Reykjavik',
      permissions: at ? ['geolocation'] : [],
      geolocation: at ? { latitude: at[0], longitude: at[1], accuracy: 6 } : undefined,
    });
    await ctx.addInitScript((kv) => { try { for (const k in kv) if (localStorage.getItem(k) == null) localStorage.setItem(k, kv[k]); } catch (_e) {} }, storage || {});
    await ctx.exposeBinding('__rig', (_src, msg) => this._handle(msg));
    await ctx.route('**/*', (route) => this._route(route));
    return ctx;
  }
  async _open(ctx, url, label) {
    const page = await ctx.newPage();
    page.rigLabel = label;
    page.on('pageerror', (e) => this.errors.push(`[${label}] ${e.message}`));
    page.on('console', (m) => { if (this.verbose && (m.type() === 'error' || m.type() === 'warning')) console.log(`[${label}] ${m.type()}: ${m.text().slice(0, 300)}`); });
    this.pages.add(page);
    page.on('close', () => this.pages.delete(page));
    await page.goto(ORIGIN + url, { waitUntil: 'load' });
    return page;
  }
  // Guide window, already signed in as the rig guide. No sessionId → the
  // guide's landing screen (start a session, tours, company…).
  async openGuide(sessionId, opts = {}) {
    const ctx = await this._context({ at: opts.at, viewport: opts.viewport, storage: { fieldnote_guide_token: this.guideAccount.token } });
    return this._open(ctx, sessionId ? `/v0.5?session=${sessionId}&role=guide` : '/v0.5?role=guide', opts.label || 'guide');
  }
  // Passenger window: a fresh phone that opened the invite link. `at` is its
  // GPS position [lat, lng]; omit it for a phone with location denied.
  async openPassenger(sessionId, opts = {}) {
    const ctx = await this._context({ at: opts.at, viewport: opts.viewport, storage: opts.storage });
    return this._open(ctx, `/v0.5?session=${sessionId}`, opts.label || 'passenger');
  }

  // ── driving the UI ──
  // What a person could tap right now: visible, un-covered buttons/links/inputs.
  async controls(page) {
    return page.evaluate(() => {
      const vis = (e) => {
        const r = e.getBoundingClientRect(), s = getComputedStyle(e);
        if (!(r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0')) return false;
        const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!t && (e.contains(t) || t.contains(e));
      };
      return [...document.querySelectorAll('button,a[href],input,select,textarea,[role=button]')].filter(vis).map(e => {
        const label = /INPUT|TEXTAREA|SELECT/.test(e.tagName) ? `<${e.tagName.toLowerCase()} ${e.placeholder || e.value || ''}>` : (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 48);
        return label + (e.id ? ' #' + e.id : '');
      });
    });
  }
  // Tap by CSS selector ('#id', '.class') or by exact visible text.
  async tap(page, what, { settle = 600 } = {}) {
    if (/^[#.\[]/.test(what)) await page.click(what, { timeout: 4000 });
    else await page.getByText(what, { exact: true }).first().click({ timeout: 4000 });
    await sleep(settle);
  }
  // Walk a fresh passenger window through language → name → intro to the map.
  async joinAsPassenger(page, name = 'Anna') {
    await this.tap(page, 'English');
    await page.fill('#name-gate-input', name);
    await this.tap(page, '#name-gate-submit', { settle: 2000 });
    const allow = page.locator('#intro-allow-location');   // disabled when location is already granted
    if (await allow.isVisible().catch(() => false) && await allow.isEnabled().catch(() => false)) await this.tap(page, '#intro-allow-location');
    await this.tap(page, '#intro-done', { settle: 1500 });
  }

  // Guide: leave boarding, optionally telling passengers which stop is next.
  async startTour(guide, nextStopName) {
    await this.tap(guide, '#boarding-start', { settle: 1200 });
    if (nextStopName) await guide.locator('.nsp-stop', { hasText: nextStopName }).click({ timeout: 4000 });
    else await this.tap(guide, '#nsp-skip');
    await sleep(800);
  }
  // Guide: activate a stop from the stop list (the manual route, not the geofence prompt).
  async activateStop(guide, stopName, { minutes } = {}) {
    if (!(await guide.locator('#stop-modal-backdrop.show, #stop-modal-backdrop.open').count())) {
      await guide.locator('.stop-row', { hasText: stopName }).locator('.stop-row-action').click({ timeout: 4000 });
      await sleep(500);
    }
    if (minutes != null) await guide.fill('#stop-modal-duration-input', String(minutes));
    await this.tap(guide, '#stop-modal-activate', { settle: 1500 });
  }

  // ── movement ──
  // Move a window's GPS along [lat,lng] waypoints. speed in m/s (1.4 = a walk);
  // one fix every `everyMs`. Runs in real time, because the app's own
  // throttles (5 s upload cadence, dwell timers) are real-time too.
  async walk(page, waypoints, { speed = 1.4, everyMs = 1000, accuracy = 6, onStep } = {}) {
    const pts = densify(waypoints, speed * everyMs / 1000);
    for (let i = 0; i < pts.length; i++) {
      await page.context().setGeolocation({ latitude: pts[i][0], longitude: pts[i][1], accuracy });
      if (onStep) await onStep(pts[i], i, pts.length);
      await sleep(everyMs);
    }
  }
  // Stand still for `ms`, re-reporting the position with ~1 m of jitter each
  // second — a real phone keeps producing fixes; a fixed fake one does not.
  async hold(page, at, ms, { everyMs = 1000, accuracy = 6 } = {}) {
    for (let t = 0; t < ms; t += everyMs) {
      const j = () => (Math.random() - 0.5) * 2e-5;
      await page.context().setGeolocation({ latitude: at[0] + j(), longitude: at[1] + j() * 2, accuracy });
      await sleep(everyMs);
    }
  }
  // Feed the session tracker fixes for the bus, as the bus_gps function would.
  async driveBus(sessionId, waypoints, { speed = 12, everyMs = 1000, onStep } = {}) {
    const pts = densify(waypoints, speed * everyMs / 1000);
    for (let i = 0; i < pts.length; i++) {
      this.backend.busFix(sessionId, pts[i][1], pts[i][0]);
      if (onStep) await onStep(pts[i], i, pts.length);
      await sleep(everyMs);
    }
  }
  // The guide's hand-placed bus pin ("the bus is parked here").
  placeBusPin(sessionId, [lat, lng]) { return this.backend.insertRow('guide_locations', { session_id: sessionId, source: 'bus_pin', lng, lat }); }
  async shot(page, name) {
    const file = path.join(this.outDir, name.endsWith('.png') ? name : name + '.png');
    await page.screenshot({ path: file });
    return file;
  }

  // ── plumbing ──
  _handle(msg) {
    if (msg.kind === 'query') return this.backend.query(msg.body);
    if (msg.kind === 'rpc') return this.backend.rpc(msg.body.fn, msg.body.args);
    if (msg.kind === 'broadcast') { this.backend.broadcast(msg.body.topic, msg.body.event, msg.body.payload, msg.clientId); return { data: null, error: null }; }
    return { data: null, error: { message: 'rig: unknown call' } };
  }
  mapStyle() {
    // Blank paper + a 100 m grid (bold every 500 m) around every stop, so
    // distances can be read off a map that has no tiles.
    const feats = [];
    for (const s of this.backend.t.stops) {
      const dLat = 100 / M_PER_DEG, dLng = 100 / (M_PER_DEG * Math.cos(s.lat * Math.PI / 180)), N = 25;
      for (let i = -N; i <= N; i++) {
        const major = i % 5 === 0;
        feats.push({ type: 'Feature', properties: { major }, geometry: { type: 'LineString', coordinates: [[s.lng - N * dLng, s.lat + i * dLat], [s.lng + N * dLng, s.lat + i * dLat]] } });
        feats.push({ type: 'Feature', properties: { major }, geometry: { type: 'LineString', coordinates: [[s.lng + i * dLng, s.lat - N * dLat], [s.lng + i * dLng, s.lat + N * dLat]] } });
      }
    }
    return {
      version: 8, name: 'rig-blank', sources: { grid: { type: 'geojson', data: { type: 'FeatureCollection', features: feats } } },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#e9e6da' } },
        { id: 'grid', type: 'line', source: 'grid', minzoom: 12, paint: { 'line-color': '#b9b4a3', 'line-width': ['case', ['get', 'major'], 1.2, 0.5], 'line-opacity': 0.8 } },
      ],
    };
  }
  async _route(route) {
    const req = route.request();
    const url = new URL(req.url());
    try {
      if (url.origin === ORIGIN) {
        let p = decodeURIComponent(url.pathname);
        if (p === '/' || p === '/v0.5') p = '/v0.5.html';
        if (p === '/manifest.webmanifest') p = '/manifest.json';
        let file = path.join(ROOT, p);
        if (/^\/vendor\/supabase-js-.*\.js$/.test(p)) file = path.join(__dirname, 'fake-supabase.js');
        if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: 'rig: not found' });
        return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
      }
      if (url.origin === ORIGIN.replace('fieldnote.guide', 'rig-fonts.invalid')) {
        const file = path.join(FONT_DIR, path.basename(url.pathname));
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ status: 200, contentType: 'font/woff2', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(file) });
      }
      if (url.hostname === 'fonts.googleapis.com') return route.fulfill({ status: 200, contentType: 'text/css', body: fontCss() });
      if (url.hostname === 'api.mapbox.com') {
        if (url.pathname.startsWith('/styles/v1/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(this.mapStyle()) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      if (url.hostname === 'events.mapbox.com') return route.fulfill({ status: 204, body: '' });
      if (url.hostname === SB_HOST && url.pathname === '/functions/v1/bus_gps') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      this.blocked.add(url.origin + url.pathname);
      return route.abort();
    } catch (e) { this.errors.push('[rig route] ' + e.message); return route.abort(); }
  }
}

module.exports = { Rig, sleep, densify, metersBetween };
