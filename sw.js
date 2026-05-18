// Fieldnote v0.5 chunk D — Service Worker.
//
// Two responsibilities:
//   1. 'push' event handler  — receives the encrypted payload from the
//      send_stop_push Edge Function and surfaces it as a system notification.
//   2. 'notificationclick'   — when the passenger taps the notification, focus
//      an existing tab if there is one, otherwise open the app URL.
//
// Critical: this file is served with no-cache headers (see /_headers) so
// updates propagate to phones on next app open instead of being stuck behind
// the browser's aggressive SW cache.
//
// Payload contract (Edge Function ↔ SW):
//   { title, body, tag, url, stop_id }
// Anything missing falls back to a sensible default so a malformed push still
// surfaces SOMETHING rather than going silent.

const NOTIFICATION_DEFAULTS = {
  title: 'New stop activated',
  body: 'Tap to see the new pins.',
  icon: '/icon-192.png',
  badge: '/badge-72.png',
  tag: 'fieldnote-stop',
};

self.addEventListener('install', (event) => {
  // No precache for v0.5 — chunk D is push-only, not offline shell.
  // skipWaiting so a new SW takes over on the next page load without
  // requiring the user to close all tabs.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (_err) {
      // If the payload isn't JSON, treat the raw text as the body.
      data = { body: event.data.text() };
    }
  }
  const title = data.title || NOTIFICATION_DEFAULTS.title;
  const options = {
    body: data.body || NOTIFICATION_DEFAULTS.body,
    icon: data.icon || NOTIFICATION_DEFAULTS.icon,
    badge: data.badge || NOTIFICATION_DEFAULTS.badge,
    // tag deduplicates: a second push with the same tag replaces the first
    // notification rather than stacking. Use stop_id when present so two
    // activations don't collapse but two pushes for the same activation do.
    tag: data.tag || (data.stop_id != null ? `fieldnote-stop-${data.stop_id}` : NOTIFICATION_DEFAULTS.tag),
    renotify: true,
    data: {
      // Fall back to /v0.5 (no session) rather than /, which 404s on this
      // Worker — happens only if the payload lacks `url`; the Edge Function
      // always provides a session-aware deep link.
      url: data.url || '/v0.5',
      stop_id: data.stop_id ?? null,
      session_id: data.session_id ?? null,
    },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Build the target URL defensively. Prefer constructing from session_id
  // (always present in our payloads) over trusting the `url` field, which
  // an out-of-date Edge Function might still send as bare '/' (the
  // Worker's root has no asset and 404s). If we can't reconstruct, fall
  // back to /v0.5 with no session — the app boot loop will then either
  // resume from last-session memo or show the join screen.
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
    // Prefer focusing an existing same-origin tab — preserves the user's
    // map state. Deliberately do NOT call client.navigate() even if the URL
    // differs; reloading the tab loses scroll position, GPS-follow mode,
    // any in-flight modals, and (on Android Chrome) sometimes drops the
    // SW-controlled state. The push fired because something changed in
    // the open session, and the app's realtime layer already surfaced
    // that change in the foregrounded view.
    for (const client of allClients) {
      try {
        const sameOrigin = new URL(client.url).origin === self.location.origin;
        if (sameOrigin && 'focus' in client) {
          await client.focus();
          return;
        }
      } catch (_err) { /* malformed URL — ignore */ }
    }
    // No existing tab — open the deep-linked URL fresh.
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});

// Optional: surface push-subscription churn so the client can re-subscribe.
// Fires when the browser invalidates the existing subscription (rare, but
// happens after long inactivity or token rotation). The client picks this up
// via a message listener and re-runs the subscription flow.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      client.postMessage({ type: 'pushsubscriptionchange' });
    }
  })());
});
