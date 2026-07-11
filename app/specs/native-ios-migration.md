# Fieldnote — iOS native app migration spec

Execution spec for an AI agent (or developer) working step-by-step in the
`fieldnoterepo` repo. Self-contained: read top to bottom before phase I1.
A sibling spec exists for Android (`native-android-migration.md`); the
"shared plumbing" in Phase I2 is common to both — **do it once, skip if
present.** iOS is the platform where native matters MOST for this product:
web push on iPhone requires an installed PWA, Safari kills background tabs,
and five field trials showed elderly tourists cannot manage
Add-to-Home-Screen.

---

## 0. Context you must know before touching anything

**Product.** Fieldnote (fieldnote.guide) is a live walking-tour companion.
One web app, two roles decided at runtime: **passenger** (joins via
`?session=<id>` link/QR, sees map + revealed stops/pins + guide/bus position,
gets notifications) and **guide** (authenticated via device token in
localStorage, runs the tour: activates stops, places bus pin, sends departure
signals). Both roles ship in the SAME app — do not create separate binaries.

**Architecture.** The web app is ONE file, `v0.5.html` (~14k lines, vanilla
JS + Mapbox GL v3.8 + Supabase JS), deployed as Cloudflare Workers static
assets; push to `main` auto-deploys the web (`.github/workflows/deploy.yml`)
— **anything merged to main goes live immediately.** A small Worker
(`worker.js`) serves the dynamic per-session PWA manifest; leave it alone.

**The native strategy is wrap, not rewrite.** `app/` is a Capacitor 6
project with `server.url: "https://fieldnote.guide/v0.5"`
(`app/capacitor.config.json`):

- Web deploys update the native app instantly; store releases only when the
  native shell changes.
- WebView origin = `https://fieldnote.guide`, so the **origin-locked Mapbox
  token works.** ⚠️ Switching to bundled local assets (`capacitor://localhost`)
  breaks the map until that origin is allowlisted on the Mapbox token — #1
  foot-gun. Keep `server.url` for this migration.
- ⚠️ WKWebView does NOT support Service Workers for remote content: `sw.js`
  never registers inside the iOS app. Web-push, offline tile cache, and the
  SW shell cache are all inert on iOS-native. Push MUST be APNs (this spec);
  offline behavior degrades gracefully (Mapbox's own in-memory cache still
  helps).

**What already exists (commit e82fff5 and later):**
- `app/ios/` generated (`guide.fieldnote.app` / "Fieldnote"); CocoaPods NOT
  installed locally (Windows dev machine) — pods install happens in cloud CI.
- `Info.plist` already has `NSLocationWhenInUseUsageDescription` and
  `UIBackgroundModes: [remote-notification]`.
- npm deps preinstalled: `@capacitor/{core,ios,android,app,geolocation,push-notifications,splash-screen}`.
- `codemagic.yaml` at repo root: `ios-testflight` workflow — mac_mini_m2,
  automatic signing via an App Store Connect integration that MUST be named
  **fieldnote-asc-key** in Codemagic, builds IPA, publishes to TestFlight.
- `v0.5.html` treats the Capacitor shell as installed
  (`runningAsInstalledPWA()` checks `Capacitor.isNativePlatform()`).
- Universal-links template at
  `app/store-setup/apple-app-site-association.template` (needs Team ID).
- `.assetsignore` keeps `app/` + `codemagic.yaml` off the public origin.

**Backend.** Supabase project `xgelrfdrdvrlltcsquqh`. Web push today =
VAPID via `push_subscriptions` table + edge functions `send_stop_push` and
`send_stop_update_push` (60s warning rate-limit). ⚠️ Never rotate VAPID keys
(paired client constant ↔ function env). Migrations live in
`migrations/NNN_*.sql` (highest today: 041), applied via Supabase MCP
`apply_migration` or dashboard SQL editor.

**Hardware & accounts state (as of 2026-07-08).** Dev machine: Windows.
No Mac — ALL iOS builds via Codemagic. Filip is buying a used **iPhone 12
Pro** (test device + Apple Developer enrollment, which for individuals
happens in the Apple Developer app on an iOS device). Apple Developer
Program ($99/yr) NOT yet enrolled — Phase I0 blocks on it.

**Outstanding iOS verifications this device unblocks (do these in I1's
gate — they predate the native app):**
1. PWA deep-link: visit a live session in Safari → Add to Home Screen →
   the install should open INTO the session (the dynamic
   `/manifest.webmanifest?session=…` shipped a9767b9 but was never tested
   on real hardware).
2. The trial-3 "installed PWA opens blank" report — check it's gone on the
   current build.
3. Portrait fit-to-screen: reproduce the recurring "UI doesn't fit" complaint
   on a notched iPhone; capture a screenshot if it reproduces (safe-area
   suspicion, unfixed for lack of evidence).

**Do-not list.**
- Don't modify `wrangler.toml` / `worker.js` / `_redirects` / `sw.js` unless
  a step says so; don't rotate VAPID; don't switch off `server.url`;
  don't commit secrets (.p8 keys, service accounts) — Codemagic env vars /
  Supabase secrets only.
- Commit style: imperative summary + why; Claude co-author trailer when an
  AI agent authors it.

---

## Phase I0 — Accounts (human steps, ~1–2 days of Apple wait)

1. Apple ID on the web (appleid.apple.com, enable 2FA).
2. On the iPhone 12 Pro: install the **Apple Developer** app → sign in →
   Enroll (ID scan) → pay $99. Wait for approval.
3. App Store Connect: register bundle ID `guide.fieldnote.app`
   (capabilities: Push Notifications, Associated Domains), create app
   **Fieldnote**.
4. ASC API key (Users and Access → Integrations, role App Manager) →
   add to Codemagic as integration **fieldnote-asc-key** (exact name —
   `codemagic.yaml` references it).
5. Note the **Team ID** (Membership page) — needed for universal links.

## Phase I1 — First TestFlight build

1. Run Codemagic workflow **ios-testflight**. It does `npm ci`,
   `cap sync ios` (runs `pod install` on the Mac builder),
   `xcode-project use-profiles` (automatic signing from the ASC key), builds
   the IPA, uploads to TestFlight. First run may need the app record from
   I0.3 to exist.
2. If signing fails on capabilities: enable Push Notifications + Associated
   Domains on the bundle ID in the developer portal, re-run.
3. Install TestFlight on the iPhone, accept the internal-tester invite,
   install Fieldnote.
4. **Gate I1 — smoke checklist on the iPhone 12 Pro:**
   - Map renders (token/origin OK). Safe-area: no content under the notch
     or home indicator — if the recurring "fit-to-screen" bug shows HERE,
     screenshot it; fixing it in `v0.5.html` helps web users too
     (see §0 outstanding verifications — run all three while you're at it).
   - Passenger flow: boarding v2, location grant, dot on map. Install row
     hidden (native detection).
   - Guide flow: guide login (menu → Developer info), control center cycle.
   - Kill + reopen → same session restores (WKWebView localStorage persists
     for the app — verify explicitly; this is the iOS re-entry story).
   - Notifications row: shows unsupported/blocked until I2 — expected.

## Phase I2 — APNs push, end to end

**I2.0 Shared plumbing (SKIP items that already exist — the Android spec
has the identical section; check `migrations/` for `*native_push*` and
`send_stop_push` for FCM code):**

1. Firebase project "Fieldnote" (free) — yes, for iOS too: FCM fronts APNs
   so BOTH platforms share one send pipeline in the edge functions.
2. Migration `migrations/042_v0.7_native_push_tokens.sql`:
   `native_push_tokens` table + `save_native_push_token` RPC
   (full definition in the Android spec §A2.0.2 — identical).
3. Edge functions `send_stop_push` + `send_stop_update_push`: after the
   web-push loop, fan out to `native_push_tokens` via FCM HTTP v1 (OAuth2
   service-account JWT in Deno; localized by token `lang`; include
   `apns.payload.aps.sound = "default"` and
   `apns.payload.aps["content-available"]` unset — plain alert pushes;
   delete tokens on UNREGISTERED). Secret `FIREBASE_SERVICE_ACCOUNT` via
   Supabase function secrets.
4. `v0.5.html` bridge `nativePushRegister()` wired into boarding v2 +
   menu notifications item; no-op `pushNotificationReceived` listener
   (realtime already shows in-app banners); `pushNotificationActionPerformed`
   navigates to `data.sessionId` if different. (Full detail: Android spec
   §A2.0.4.)

**I2.1 iOS wiring:**
1. Apple developer portal → Keys → create an **APNs Auth Key** (.p8),
   note Key ID; upload the .p8 + Key ID + Team ID in Firebase → Project
   settings → Cloud Messaging → Apple app configuration. Add the iOS app
   (bundle `guide.fieldnote.app`) to the Firebase project; download
   `GoogleService-Info.plist`.
2. Capacitor iOS push uses APNs directly BUT registering through Firebase
   requires the FCM SDK — avoid it: Capacitor's push plugin returns the raw
   **APNs device token** on iOS. Two options; choose A unless it fights you:
   - **Option A (preferred, no Firebase SDK in the app):** store the APNs
     token with `platform='ios'`; in the edge function, send iOS tokens via
     APNs directly (JWT-signed HTTP/2 request to
     `api.push.apple.com/3/device/<token>`, using the same .p8 — add secret
     `APNS_AUTH_KEY` + `APNS_KEY_ID` + `APPLE_TEAM_ID`; topic =
     `guide.fieldnote.app`). Android continues via FCM.
   - **Option B:** add Firebase iOS SDK via a Capacitor FCM plugin so iOS
     tokens are FCM tokens and one FCM pipeline serves both. More app-side
     moving parts; only if A's HTTP/2 in Deno proves problematic (Deno
     supports HTTP/2 via `fetch` — A should work).
3. `AppDelegate.swift`: Capacitor's default template already forwards APNs
   registration callbacks to the plugin — verify, don't rewrite.
4. Rebuild via `ios-testflight`, update the phone.

**Gate I2 — proof (the reason this whole native effort exists):**
- iPhone, live session, "Enable notifications" → iOS permission alert →
  grant → row in `native_push_tokens` (platform `ios`).
- Lock the iPhone. From another device, activate a stop → the locked
  iPhone shows a system notification with sound. Departure signal → second
  notification. Record both.
- Regression: Samsung/Android push still works (if A2 done).

## Phase I3 — Universal links (QR opens the app)

1. Fill `app/store-setup/apple-app-site-association.template` with the Team
   ID → save as repo-root `.well-known/apple-app-site-association` (NO file
   extension). Ensure it serves `application/json` — add a `_headers` rule
   for that exact path (this is the one permitted `_headers` edit), and
   confirm `.assetsignore` doesn't exclude `.well-known/`.
2. Xcode project: Associated Domains capability with
   `applinks:fieldnote.guide` — set via `app/ios/App/App/App.entitlements`
   (create it + reference in the pbxproj if absent; Codemagic automatic
   signing picks entitlements up from the project).
3. The `appUrlOpen` handler from A3.3/shared bridge covers `/j/*` parsing.
4. **Gate I3:** with the TestFlight build installed, scan a session QR →
   the APP opens into the session directly. (AASA is cached by Apple's CDN;
   allow up to a day / reinstall the app to refresh.)

## Phase I4 — Branding

Icons + splash from `icon-512.png` / palette `#f1ece0`/`#221f1d` via
`@capacitor/assets` into the iOS asset catalogs, replacing ALL Capacitor
placeholder art. Launch screen storyboard background to `#f1ece0`.

## Phase I5 — App Store submission

1. TestFlight external testing first if wanted (guides outside the team).
2. **Guideline 4.2 ("minimum functionality") risk is real for
   server.url-wrapped apps.** Mitigations to have in place BEFORE review:
   native push (I2), universal links (I3), native geolocation permission
   flows, offline launch screen, and review notes explaining the live-tour
   product with a demo video + a demo session the reviewer can join
   (create a long-lived demo session; note: sessions auto-end after 3h
   idle — migration 041 — so document how the reviewer gets a fresh one,
   or add a reviewer-exempt session flag as a tiny migration).
3. Listing needs: privacy policy URL (`fieldnote.guide/privacy` — shared
   with Android; draft covering location + push), App Privacy questionnaire
   (location: linked to user? No accounts for passengers — "not linked to
   identity" is defensible; be truthful), screenshots (6.5"/6.9" sets — the
   12 Pro's 6.1" shots can be framed/resized to spec).
4. If rejected on 4.2 despite mitigations: the fallback is bundling assets
   (real work: Mapbox origin allowlist + build step copying `v0.5.html` into
   `www/` + SW-less asset strategy) — do NOT preemptively build this.

## Phase I6 — Later / out of scope

Background location on iOS (`NSLocationAlwaysAndWhenInUseUsageDescription` +
`location` background mode) — this is the likely fix for "phone in pocket,
GPS dead" (suspected in trial-2 Dawn case), but it's an App Store review
magnet; ship v1 without it, gather field data from native trials first.
Live Activities (departure countdown on the lock screen) — compelling
future differentiator, not now.

## Reference

```sql
select platform, count(*) from native_push_tokens group by 1;   -- tokens arriving
```

Per-tour field checklist: passenger join, boarding grants, locked-phone
notification, QR universal link, guide CC full cycle, kill+reopen re-entry,
safe-area visual check.
