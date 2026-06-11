// Fieldnote v0.5 — Service Worker.
//
// Responsibilities:
//   1. Offline app shell  — precache the HTML + the critical scripts (now
//      self-hosted same-origin under /vendor) so the app loads (and shows its
//      OWN reconnecting UI) when the device is offline, instead of the
//      browser's "you are offline" error page.
//   2. 'push'             — surface the Edge Function payload as a notification.
//   3. 'notificationclick'— focus an existing tab, else open the deep link.
//
// Caching strategy (deliberately conservative to avoid the classic "stuck on
// an old version" trap):
//   - Navigations: NETWORK-FIRST. When online the freshest HTML always wins
//     and is copied into the cache; the cache is only the offline fallback.
//   - Critical libs (mapbox-gl, supabase-js, idb, qrcode): SELF-HOSTED
//     same-origin under /vendor (versioned filenames) and precached as part
//     of the app shell — a successful first HTML load now guarantees the
//     libs are cached too, with no third-party CDN in the boot path.
//   - Fonts CSS (Google Fonts): CACHE-FIRST best-effort. Graceful
//     degradation only — a miss falls typography back to Georgia/monospace,
//     never blocks boot.
//   - Everything else (Supabase REST/realtime, Mapbox tiles, font binaries):
//     PASSTHROUGH — never cached; they just fail offline and the app copes.
//
// /sw.js itself is served no-cache (see /_headers), so SW updates propagate
// on next app open; bumping SHELL_CACHE purges the old shell on activate.

const SHELL_CACHE = 'fieldnote-shell-v8';   // bumped: icon set v2 (icon-192/512 changed under the same filenames)

// Same-origin shell assets — these MUST cache for the app to boot offline.
// Includes the /vendor libs: same origin as the HTML, so if the first page
// load succeeded, these fetches succeed too (same connection, same CDN edge),
// making first-open precache deterministic instead of best-effort.
const SHELL_URLS = [
  '/v0.5',
  '/beacon.css',
  '/beacon-theme.js',
  '/identification.css',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/badge-72.png',
  '/vendor/mapbox-gl-v3.8.0.css',
  '/vendor/mapbox-gl-v3.8.0.js',
  '/vendor/supabase-js-2.108.1.umd.js',
  '/vendor/idb-8.0.3.umd.js',
  '/vendor/qrcode-generator-1.4.4.min.js',
];

// Cross-origin extras — cached best-effort (a failure must not abort
// install). Only the fonts CSS remains since the libs moved to /vendor;
// fonts are pure graceful degradation (typography, never boot).
const CDN_URLS = [
  'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,700&family=JetBrains+Mono:wght@400;500;700&display=swap',
];

const NAV_FALLBACK = '/v0.5';

// Mapbox map data (style JSON, sprite, glyph fonts, vector tiles) gets its
// own cache so previously-viewed areas keep rendering when the signal drops.
// Stale-while-revalidate + a size cap (LRU-ish via insertion order). This is
// what makes "lost internet, zoom in, paths still show" work — for tiles the
// device fetched while it was online.
const TILE_CACHE = 'fieldnote-tiles-v1';
const TILE_CACHE_MAX = 1500;

const NOTIFICATION_DEFAULTS = {
  title: 'New stop activated',
  body: 'Tap to see the new pins.',
  icon: '/icon-192.png',
  badge: '/badge-72.png',
  tag: 'fieldnote-stop',
};

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Same-origin shell must succeed.
    try { await cache.addAll(SHELL_URLS); }
    catch (err) { console.warn('[sw] shell precache failed', err); }
    // Cross-origin extras (fonts CSS) best-effort, individually so one
    // failure doesn't abort.
    await Promise.allSettled(CDN_URLS.map((u) => cache.add(u).catch((e) => {
      console.warn('[sw] cdn precache failed', u, e);
    })));
    // Take over on next page load without requiring all tabs to close.
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop stale caches from prior versions, but KEEP the current shell +
    // tile caches (deleting the tile cache every activate would defeat
    // offline maps).
    const keep = new Set([SHELL_CACHE, TILE_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.map((n) => (keep.has(n) ? null : caches.delete(n))));
    await self.clients.claim();
  })());
});

// Fonts CSS, plus the OLD CDN lib URLs (api.mapbox.com/mapbox-gl-js/*,
// cdn.jsdelivr.net/npm/*). The lib prefixes are kept for the transition
// window: a client whose cached shell is still the pre-/vendor HTML keeps
// its CDN <script> tags served cache-first until the next online navigation
// replaces the shell.
function isCdnAsset(url) {
  return CDN_URLS.includes(url) ||
    url.startsWith('https://api.mapbox.com/mapbox-gl-js/') ||
    url.startsWith('https://cdn.jsdelivr.net/npm/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;   // never touch writes

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // 1. Navigations → network-first, cache fallback to the app shell.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const net = await fetch(req);
        // Refresh the canonical shell entry so the offline fallback stays
        // current. Keyed on /v0.5 (no query) so any ?session= hits it.
        try {
          const cache = await caches.open(SHELL_CACHE);
          cache.put(NAV_FALLBACK, net.clone());
        } catch (_e) { /* ignore */ }
        return net;
      } catch (_err) {
        const cache = await caches.open(SHELL_CACHE);
        const cached = await cache.match(NAV_FALLBACK, { ignoreSearch: true });
        if (cached) return cached;
        // Nothing cached yet — let the browser show its default.
        return Response.error();
      }
    })());
    return;
  }

  // 2. Same-origin static shell assets (incl. /vendor libs) → cache-first.
  //    /vendor/ filenames are versioned, so cache-first is safe to pin; a
  //    lib upgrade ships under a new filename + SHELL_CACHE bump.
  if (sameOrigin && (SHELL_URLS.includes(url.pathname) ||
      url.pathname.startsWith('/vendor/') ||
      url.pathname === '/icon-192.png' || url.pathname === '/icon-512.png' ||
      url.pathname === '/badge-72.png' || url.pathname === '/manifest.json')) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // 3. Fonts CSS + legacy CDN lib URLs → cache-first on versioned URLs.
  if (isCdnAsset(url.href.split('#')[0]) || isCdnAsset(url.origin + url.pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // 4. Mapbox map data — style JSON, sprite, glyph fonts, vector tiles
  //    (everything else on api.mapbox.com that isn't the gl-js library,
  //    which case 3 already handled). Stale-while-revalidate into the
  //    capped tile cache so viewed areas render offline. Telemetry
  //    (events.mapbox.com) is POST and was skipped above.
  if (url.hostname === 'api.mapbox.com' && !url.pathname.startsWith('/mapbox-gl-js/')) {
    event.respondWith(staleWhileRevalidate(req, TILE_CACHE, TILE_CACHE_MAX));
    return;
  }

  // 5. Everything else (Supabase REST/realtime, font binaries) —
  //    passthrough. Not cached; fails offline and the app handles it.
});

// Serve from cache immediately if present (revalidating in the background),
// else fall back to the network. Caps the cache by entry count, evicting
// the oldest entries (Cache Storage keys() preserves insertion order).
async function staleWhileRevalidate(req, cacheName, cap) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const networkFetch = fetch(req).then((net) => {
    if (net && (net.ok || net.type === 'opaque')) {
      cache.put(req, net.clone())
        .then(() => trimCache(cacheName, cap))
        .catch(() => { /* opaque/uncacheable — ignore */ });
    }
    return net;
  }).catch(() => null);
  if (cached) return cached;            // stale hit; networkFetch revalidates
  const net = await networkFetch;
  return net || Response.error();
}

async function trimCache(cacheName, cap) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    const over = keys.length - cap;
    for (let i = 0; i < over; i++) await cache.delete(keys[i]);
  } catch (_e) { /* ignore */ }
}

async function cacheFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req, { ignoreSearch: false });
  if (cached) return cached;
  try {
    const net = await fetch(req);
    if (net && (net.ok || net.type === 'opaque')) {
      try { cache.put(req, net.clone()); } catch (_e) { /* opaque/uncacheable */ }
    }
    return net;
  } catch (err) {
    // Last resort: maybe an ignoreSearch match exists.
    const loose = await cache.match(req, { ignoreSearch: true });
    if (loose) return loose;
    throw err;
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (_err) {
      data = { body: event.data.text() };
    }
  }
  const title = data.title || NOTIFICATION_DEFAULTS.title;
  const options = {
    body: data.body || NOTIFICATION_DEFAULTS.body,
    icon: data.icon || NOTIFICATION_DEFAULTS.icon,
    badge: data.badge || NOTIFICATION_DEFAULTS.badge,
    tag: data.tag || (data.stop_id != null ? `fieldnote-stop-${data.stop_id}` : NOTIFICATION_DEFAULTS.tag),
    renotify: true,
    data: {
      url: data.url || '/v0.5',
      stop_id: data.stop_id ?? null,
      session_id: data.session_id ?? null,
    },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  let targetUrl = data.url;
  const isBadUrl = !targetUrl
    || targetUrl === '/'
    || (typeof targetUrl === 'string' && !targetUrl.startsWith('/v0.5'));
  if (isBadUrl) {
    targetUrl = data.session_id
      ? `/v0.5?session=${encodeURIComponent(data.session_id)}`
      : '/v0.5';
  }
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      try {
        const sameOrigin = new URL(client.url).origin === self.location.origin;
        if (sameOrigin && 'focus' in client) {
          await client.focus();
          return;
        }
      } catch (_err) { /* malformed URL — ignore */ }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      client.postMessage({ type: 'pushsubscriptionchange' });
    }
  })());
});
