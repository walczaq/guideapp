// ============================================================================
// Cloudflare Worker entry (Workers Static Assets).
//
// Static files serve exactly as before via the ASSETS binding. The ONLY
// dynamic route is /manifest.webmanifest, which returns a copy of the
// canonical /manifest.json with a PER-SESSION start_url injected.
//
// Why this exists (iOS-only problem): an installed iOS PWA opens the
// manifest's start_url at launch and — unlike Android's Chrome WebAPK, which
// shares storage with the browser — gets its OWN storage container, so it
// cannot recover the session the passenger joined in Safari. The session must
// therefore travel in start_url itself. iOS bakes start_url at "Add to Home
// Screen" time, so when the page points its <link rel="manifest"> at
// /manifest.webmanifest?session=<id>, the install deep-links into that session.
//
// start_url stays PRESENT (Chrome's install prompt requires it), so Android is
// unaffected. The page only swaps to this manifest after a reachability check,
// so if this Worker is ever absent/broken the static /manifest.json remains the
// linked manifest and install behaves exactly as it did before.
// ============================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/manifest.webmanifest') {
      return buildSessionManifest(url, env);
    }
    // Everything else: serve the static asset (honors _redirects / _headers).
    return env.ASSETS.fetch(request);
  },
};

async function buildSessionManifest(url, env) {
  // Start from the canonical static manifest so the two never drift.
  let base = {};
  try {
    const res = await env.ASSETS.fetch(new URL('/manifest.json', url));
    if (res.ok) base = await res.json();
  } catch (_e) { /* fall through to the minimal manifest below */ }

  // Session ids are short alphanumerics (see sessions.id). Reject anything
  // else and fall back to the default start_url rather than reflecting junk.
  const raw = (url.searchParams.get('session') || '').slice(0, 64);
  const safe = /^[A-Za-z0-9_-]+$/.test(raw) ? raw : '';
  const startUrl = safe
    ? `/v0.5?session=${encodeURIComponent(safe)}`
    : (base.start_url || '/v0.5');

  const manifest = Object.assign({}, base, {
    start_url: startUrl,
    // Keep a STABLE id so every session is the SAME installed app, not a new
    // app per session. id resolves against scope, independent of start_url.
    id: base.id || '/v0.5',
  });

  return new Response(JSON.stringify(manifest), {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      // Per-session body — never let a shared cache serve one session's
      // manifest to another device.
      'Cache-Control': 'no-store',
    },
  });
}
