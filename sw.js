// Fieldnote v0.5 — Service Worker.
//
// Responsibilities:
//   1. Offline app shell  — precache the HTML + the critical CDN scripts so
//      the app loads (and shows its OWN reconnecting UI) when the device is
//      offline, instead of the browser's "you are offline" error page.
//   2. 'push'             — surface the Edge Function payload as a notification.
//   3. 'notificationclick'— focus an existing tab, else open the deep link.
//
// Caching strategy (deliberately conservative to avoid the classic "stuck on
// an old version" trap):
//   - Navigations: NETWORK-FIRST. When online the freshest HTML always wins
//     and is copied into the cache; the cache is only the offline fallback.
//   - Critical CDN libs (mapbox-gl, supabase-js, idb, qrcode, fonts CSS):
//     CACHE-FIRST on their versioned URLs (stable, safe to pin).
//   - Everything else (Supabase REST/realtime, Mapbox tiles, font binaries):
//     PASSTHROUGH — never cached; they just fail offline and the app copes.
//
// /sw.js itself is served no-cache (see /_headers), so SW updates propagate
// on next app open; bumping SHELL_CACHE purges the old shell on activate.

const SHELL_CACHE = 'fieldnote-shell-v2';

// Same-origin shell assets — these MUST cache for the app to boot offline.
const SHELL_URLS = [
  '/v0.5',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/badge-72.png',
];

// Cross-origin libraries the page <script>/<link> tags pull in. Versioned
// URLs, CORS-friendly CDNs — cached best-effort (a single failure must not
// abort install).
const CDN_URLS = [
  'https://api.mapbox.com/mapbox-gl-js/v3.8.0/mapbox-gl.css',
  'https://api.mapbox.com/mapbox-gl-js/v3.8.0/mapbox-gl.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/idb@8/build/umd.js',
  'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js',
  'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,700&family=JetBrains+Mono:wght@400;500;700&display=swap',
];

const NAV_FALLBACK = '/v0.5';

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
    // CDN libs best-effort, individually so one failure doesn't abort.
    await Promise.allSettled(CDN_URLS.map((u) => cache.add(u).catch((e) => {
      console.warn('[sw] cdn precache failed', u, e);
    })));
    // Take over on next page load without requiring all tabs to close.
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop stale shell caches from prior versions.
    const names = await caches.keys();
    await Promise.all(names.map((n) => (n !== SHELL_CACHE ? caches.delete(n) : null)));
    await self.clients.claim();
  })());
});

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

  // 2. Same-origin static shell assets → cache-first.
  if (sameOrigin && (SHELL_URLS.includes(url.pathname) ||
      url.pathname === '/icon-192.png' || url.pathname === '/icon-512.png' ||
      url.pathname === '/badge-72.png' || url.pathname === '/manifest.json')) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // 3. Critical CDN libs → cache-first on versioned URLs.
  if (isCdnAsset(url.href.split('#')[0]) || isCdnAsset(url.origin + url.pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // 4. Everything else (Supabase REST/realtime, Mapbox tiles, font files) —
  //    passthrough. Not cached; fails offline and the app handles it.
});

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
