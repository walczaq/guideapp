# Fieldnote — Android native app migration spec

Execution spec for an AI agent (or developer) working step-by-step in the
`fieldnoterepo` repo. Self-contained: read this document top to bottom before
phase A1. A sibling spec exists for iOS (`native-ios-migration.md`); Phase A2's
"shared plumbing" section is common to both — **do it once, skip if present.**

---

## 0. Context you must know before touching anything

**Product.** Fieldnote (fieldnote.guide) is a live walking-tour companion.
One web app, two roles decided at runtime: **passenger** (joins via
`?session=<id>` link/QR, sees map + revealed stops/pins + guide/bus position,
gets notifications) and **guide** (authenticated via device token in
localStorage, runs the tour: activates stops, places bus pin, sends
departure signals). Both roles ship in the SAME app — do not create separate
binaries per role.

**Architecture.** The entire web app is ONE file, `v0.5.html` (~14k lines,
vanilla JS + Mapbox GL v3.8 + Supabase JS), deployed as Cloudflare Workers
static assets. Push to `main` auto-deploys via `.github/workflows/deploy.yml`
— **anything you merge to main goes live on the web immediately.**
A tiny Worker (`worker.js`) serves `/manifest.webmanifest?session=<id>`
(per-session PWA manifest); everything else is static.

**The native strategy is wrap, not rewrite.** `app/` contains a Capacitor 6
project whose `server.url` points at the LIVE site:

- `app/capacitor.config.json` → `server.url: "https://fieldnote.guide/v0.5"`.
- Web deploys therefore update the native app content instantly. Store
  releases are only needed when the native shell changes.
- Because the WebView origin is `https://fieldnote.guide`, the Mapbox token
  (which is **origin-locked to fieldnote.guide + the guideapp workers.dev
  origin**) works. ⚠️ If you ever switch to bundled local assets
  (`capacitor://localhost`), the map WILL break until that origin is added
  to the Mapbox token allowlist — this is the #1 foot-gun in this project.

**What already exists (commit e82fff5 and later):**
- `app/android/` generated, `appId: guide.fieldnote.app`, `appName: Fieldnote`.
- AndroidManifest: `ACCESS_FINE/COARSE_LOCATION`, `POST_NOTIFICATIONS`
  permissions; an `autoVerify` deep-link intent-filter for
  `https://fieldnote.guide/j/*` (App Links verification not yet possible —
  needs the Play signing SHA-256).
- npm deps preinstalled: `@capacitor/{core,android,ios,app,geolocation,push-notifications,splash-screen}` + CLI.
- `codemagic.yaml` at repo root: `android-debug` workflow (linux, builds
  `app-debug.apk` artifact) — works with zero store accounts.
- `v0.5.html` already treats the Capacitor shell as "installed"
  (`runningAsInstalledPWA()` checks `window.Capacitor.isNativePlatform()`),
  so install prompts self-hide inside the app.
- `.assetsignore` excludes `app/` and `codemagic.yaml` from the public origin
  — keep it that way for anything new you add outside `app/`.

**Backend.** Supabase project `xgelrfdrdvrlltcsquqh` (eu-central-1).
Tables in play here: `sessions` (text id, guide_name, ended_at…),
`session_passengers`, `push_subscriptions` (web-push: endpoint/p256dh/auth
per session+passenger, `lang` column). Edge functions:
`send_stop_push` (new stop activated → push all session subscribers) and
`send_stop_update_push` (warnings/departure changes; 60s rate-limit via
`stop_activations.last_warning_pushed_at`). Both currently speak **web-push
(VAPID) only**. ⚠️ The VAPID keypair is shared between the client constant in
v0.5.html and the edge function env — never rotate one side alone.
SQL migrations live in `migrations/NNN_*.sql` (highest today: 041) and are
applied via the Supabase MCP `apply_migration` (or dashboard SQL editor) —
there is no CLI migration pipeline; the files are the record.

**Environment.** Dev machine is Windows (no Android Studio assumed, no Mac).
Builds run on Codemagic (cloud). Filip's own phone is a Samsung (Samsung
Internet user); it's the primary Android test device via sideloaded APK.

**Do-not list.**
- Do not modify `wrangler.toml`, `worker.js`, `_redirects`, `_headers`, or
  `sw.js` unless a step explicitly says so — the web product is live and
  in active tour use.
- Do not rotate VAPID keys.
- Do not change `server.url` / switch to bundled assets in this migration.
- Do not commit secrets (Firebase service accounts, keystores) to the repo.
  Codemagic env vars / Supabase function secrets only.
- Commit style: imperative summary + body explaining why; end with the
  Claude co-author trailer if an AI agent authors it.

---

## Phase A1 — First APK on a real phone (no accounts needed)

Goal: the native shell runs the live app on Filip's Samsung.

1. Codemagic: sign up (free) with the GitHub account, add the
  `walczaq/guideapp` repo, run workflow **android-debug**. It runs
   `npm ci` + `npx cap sync android` + `gradlew assembleDebug` and produces
   `app-debug.apk`.
2. Sideload on the Samsung (allow "install unknown apps"), open Fieldnote.
3. **Gate A1 — manual smoke checklist (record results):**
   - App opens the live map (Mapbox tiles render — confirms origin/token).
   - Passenger flow: open a live/test session URL in the shell? (No deep
     links yet — create a test session as guide, then in-app navigate by
     tapping through the landing screen's "Find my tour" using the guide
     name.) Boarding v2 appears; "install" row is HIDDEN (native detection).
   - Location: tap "Allow location" → OS permission dialog → dot appears.
   - Guide flow: log in as guide (menu → Developer info → Guide login),
     confirm control center, stop activate/deactivate, bus pin.
   - Notifications row: currently shows web-push unsupported message —
     EXPECTED until A2.
   - Kill app, reopen → returns to the same session (WebView localStorage
     persists — verify, this is the re-entry story).

## Phase A2 — Native push, end to end

**A2.0 Shared plumbing (SKIP each item if it already exists — check first;
the iOS spec contains the identical section):**

1. **Firebase project** (console.firebase.google.com, free): create project
   "Fieldnote", add Android app with package `guide.fieldnote.app`, download
   `google-services.json`.
2. **DB migration `migrations/042_v0.7_native_push_tokens.sql`** (skip if a
   file matching `*native_push*` exists in `migrations/`):
   - table `native_push_tokens(id bigserial pk, session_id text references
     sessions(id) on delete cascade, passenger_id text, platform text check
     (platform in ('android','ios')), token text, lang text,
     created_at timestamptz default now(), updated_at timestamptz default
     now(), unique(session_id, token))`.
   - RLS on; no select policy for anon (mirror `push_subscriptions`).
   - SECURITY DEFINER RPC `save_native_push_token(p_session_id text,
     p_passenger_id text, p_platform text, p_token text, p_lang text)` —
     upsert on (session_id, token); grant execute to anon.
   - Apply to the live DB AND commit the file.
3. **Edge function fan-out via FCM HTTP v1** (skip if `send_stop_push`
   already references FCM): extend BOTH `send_stop_push` and
   `send_stop_update_push` (source under `supabase/functions/`) to, after
   the existing web-push loop, fetch `native_push_tokens` for the session
   and POST to `https://fcm.googleapis.com/v1/projects/<project-id>/messages:send`
   with an OAuth2 token minted from a service account (JWT grant,
   `https://www.googleapis.com/auth/firebase.messaging` scope — implement in
   Deno, no heavy SDK). Message: `notification` {title, body} + `data`
   {sessionId, stopId, kind}. Localize title/body by the token's
   `lang` exactly as the web-push path does. Delete tokens on 404/410
   UNREGISTERED responses. **Branch by `platform`:** send `android` tokens
   via FCM as above; `ios` tokens are delivered per the iOS spec's Phase
   I2.1 (direct APNs preferred there) — if the iOS phase hasn't run yet,
   loop only `platform = 'android'` and leave an explicit `TODO(ios)` in
   the function. Secret: `FIREBASE_SERVICE_ACCOUNT` (full JSON) set
   via `supabase secrets` / dashboard — generate in Firebase console →
   Project settings → Service accounts.
4. **Web-bridge in `v0.5.html`** (skip if `nativePushRegister` exists):
   a function `nativePushRegister()` used by the boarding page and the
   menu's notifications item WHEN `window.Capacitor?.isNativePlatform()`:
   - `Capacitor.Plugins.PushNotifications.requestPermissions()` → if
     granted, `.register()`; on the `registration` event, call the
     `save_native_push_token` RPC with SESSION.id, PASSENGER_ID, platform
     (`Capacitor.getPlatform()`), token, current LANG.
   - Wire into boarding v2: in `renderIntroSetup()` and the
     `intro-enable-notify` click handler, branch BEFORE `pushSupported()`:
     native → `nativePushRegister()`, and the "unsupported on this browser"
     status must never show on native.
   - Foreground pushes: add a `pushNotificationReceived` listener that does
     NOTHING (the app's realtime channels already render in-app banners for
     every event that pushes; showing both would double-notify).
   - `pushNotificationActionPerformed` (tap on a notification): if
     `data.sessionId` differs from current SESSION, navigate to
     `/v0.5?session=<id>`.

**A2.1 Android wiring:**
1. Place `google-services.json` at `app/android/app/google-services.json`
   — ⚠️ do NOT commit it (add to `app/.gitignore`); in Codemagic provide it
   as an env var (`GOOGLE_SERVICES_JSON`, base64) written to that path in a
   pre-build script step added to the `android-debug` workflow.
2. Capacitor's push plugin needs Firebase Messaging: verify
   `npx cap sync android` wires the plugin; add the
   `com.google.gms.google-services` Gradle plugin to
   `app/android/build.gradle`/`app.gradle` per Capacitor push docs.
3. Rebuild APK, sideload.

**Gate A2 — proof:**
- On the Samsung, in a live session, tap "Enable notifications" → OS prompt
  → grant → a row appears in `native_push_tokens` (verify via SQL).
- As guide (second device or desktop), activate a stop → the Samsung gets a
  system notification with the phone LOCKED. Send a departure signal →
  second notification. This is the moment native beats the PWA — record it.

## Phase A3 — App Links (QR opens the app)

1. Play Console ($25, web-only) → create app `guide.fieldnote.app` →
   set up **Play App Signing** (Google-managed key) → copy the SHA-256
   from App integrity → App signing.
2. Fill `app/store-setup/assetlinks.json.template` with that fingerprint
   (plus the upload key's SHA-256 — include BOTH), save as
   `.well-known/assetlinks.json` **in the repo root** (create the
   `.well-known/` directory; it will deploy as a static asset — verify it
   is NOT matched by `.assetsignore`), push, then verify
   `https://fieldnote.guide/.well-known/assetlinks.json` serves JSON.
3. In `v0.5.html`'s native bridge: listen to `Capacitor.Plugins.App`
   `appUrlOpen` → parse `/j/<sessionId>` → `location.href =
   '/v0.5?session=' + id`.
4. **Gate A3:** with a release-signed build installed (internal testing
   track — see A4), scanning a session QR (`fieldnote.guide/j/<id>`) opens
   the APP into that session, not the browser. (Debug builds won't verify
   App Links — test on the Play-signed build.)

## Phase A4 — Release build + Play internal testing

1. Add an `android-release` workflow to `codemagic.yaml`: `bundleRelease`
   (AAB), signed with an upload keystore generated once (Codemagic can
   generate/store it; record the SHA-256 for assetlinks). Auto-increment
   `versionCode` from `$BUILD_NUMBER`; `versionName` starts `0.7.0`.
2. App icons + splash: source art exists (`icon-512.png`,
   `icon-maskable-512.png`, paper/ink palette `#f1ece0`/`#221f1d`). Use
   `@capacitor/assets` to generate Android adaptive icons + splash into
   `app/android/.../res`. Replace ALL the default Capacitor placeholder art.
3. Upload AAB to Play internal testing; add Filip + the guide colleagues
   (Sammi, Kristof, Becky, Marla — emails in the `guides` DB table) as
   testers.
4. **Gate A4:** installed from Play (internal track), full checklist from
   Gate A1 + A2 + A3 passes.
5. Production rollout is a business decision — store listing (privacy
   policy URL required: draft one, host at `fieldnote.guide/privacy`,
   covering location + push data), content rating, data-safety form
   (declares location collection, shared with guide during tour).

## Phase A5 — Later / explicitly out of scope now

- Background location (survives screen-lock) — battery + Play policy
  implications ("location in background" declaration + review). Decide only
  after field data shows lock-screen GPS loss on Android matters
  (trial evidence so far: Android tracked fine through 6.5h tours).
- Bundled-assets mode (offline-first shell) — requires the Mapbox token
  origin fix noted in §0.
- In-app update prompts, crash reporting (Sentry), analytics.

## Reference — verification queries

```sql
-- native tokens arriving?
select platform, count(*) from native_push_tokens group by 1;
-- sessions live now
select id, guide_name, started_at from sessions where ended_at is null;
```

Field checklist template per test tour: passenger join, boarding grants,
notification received locked, QR deep link, guide CC full cycle
(activate → note/time push → departure → end), kill+reopen re-entry.
