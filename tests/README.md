# Smoke tests

Headless-Chromium tests for `v0.5.html` and `sw.js`. They serve the repo
root from a throwaway local server and replace Supabase and Mapbox with
mocks, so they need no credentials and never touch the real backend.

    cd tests
    npm ci
    npx playwright install chromium
    npm test

What they cover: every boot path, the background-timer cadences, chat
pokes, the service worker's tile cache, the build-stamp script, and that the
deploy-time comment stripper leaves the page's code and styles unchanged.

What they cannot cover: anything that depends on the real services — live
realtime delivery, real map rendering, push notifications, the native shell.
Supabase realtime is unreachable under the mock, so tests that need a
"connected" channel force that state.
