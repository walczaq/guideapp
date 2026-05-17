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
      url: data.url || '/',
      stop_id: data.stop_id ?? null,
      session_id: data.session_id ?? null,
    },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Prefer focusing an existing tab on the same origin — keeps the user's
    // map state intact instead of starting fresh.
    for (const client of allClients) {
      try {
        const sameOrigin = new URL(client.url).origin === self.location.origin;
        if (sameOrigin && 'focus' in client) {
          await client.focus();
          // Best-effort: if the existing tab is on a different path, navigate it.
          if ('navigate' in client && client.url !== self.location.origin + targetUrl) {
            try { await client.navigate(targetUrl); } catch (_e) { /* navigate not always allowed */ }
          }
          return;
        }
      } catch (_err) { /* malformed URL — ignore */ }
    }
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
