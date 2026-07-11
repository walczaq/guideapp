# Fieldnote native migration — start here

This folder is the complete handoff package for executing the native-app
migration in a fresh AI session (or by hand). One platform per session.

## Files & reading order

1. **This README** — orientation + the cross-platform model.
2. **`native-android-migration.md`** — Android execution spec (phases A1–A5
   with verification gates). Can start immediately, zero store accounts.
3. **`native-ios-migration.md`** — iOS execution spec (phases I0–I6 with
   gates). Blocked on Apple Developer enrollment (done on an iPhone via the
   Apple Developer app) — see its Phase I0.
4. **`appendix-push-reference.md`** — EXACT code for the shared push
   plumbing: the `native_push_tokens` migration SQL verbatim, verified Deno
   crypto for Google/FCM OAuth (RS256) and direct APNs (ES256), the fan-out
   loop, and the `nativePushRegister()` web-bridge shape. Referenced from
   both specs' push phases. Use it; do not re-derive the crypto.

Also relevant, one level up: `../store-setup/SETUP.md` (account signup
walkthroughs: Codemagic, Apple, Play) and the universal-link/App-Links
templates in `../store-setup/`.

## How to run a session

Prompt: *"Read app/specs/native-<platform>-migration.md and execute it
phase by phase. Stop at every gate and report results before continuing."*
Each spec is self-contained (full context in its §0, including the
do-not list and the project's known foot-guns). The **shared plumbing**
(DB migration 042, edge-function fan-out, web bridge) appears in both
specs marked skip-if-done — whichever platform runs first builds it;
the second session must check for its existence exactly as the spec says.

## The cross-platform model (why iOS ↔ Android just works)

Phones never talk to each other — every device (iOS app, Android app, or
plain mobile browser) talks only to Supabase. A session is a Postgres row;
everything live (passenger dots, stop activations, bus pin, headcount,
next-stop) fans out over Supabase realtime channels that are
platform-blind. The native apps are Capacitor shells around the SAME web
app loaded from the same URL — one codebase everywhere.

Consequences you can rely on:
- An Android guide runs a tour for iOS + Android + browser passengers in
  one session, identically — and vice versa. Guide-ness is a login token
  in storage, not a platform feature.
- Sessions, QR codes, and invite links are platform-agnostic.
- The ONLY platform-aware hop is push **delivery**: the edge functions
  route each stored token by its `platform` column — `android` → FCM,
  `ios` → APNs, web-push subscriptions → VAPID. Same event, three
  channels, same notification. This is what the shared plumbing builds.
- Therefore the platform migrations are order-independent: whichever ships
  first, the other platform's users continue as web/PWA users meanwhile.

Mandatory once both apps exist: a mixed-device field test — Android guide
+ iPhone passenger + one browser passenger in one session; all three must
receive the same stop push (the iOS spec's Gate I2 includes the Android
regression half of this).

## Project status snapshot (2026-07-08)

- Web app live at fieldnote.guide (v0.5.html, Cloudflare Workers static
  assets; push to `main` auto-deploys — careful).
- Capacitor scaffold committed (`app/`), both platforms generated,
  `codemagic.yaml` workflows ready (`android-debug` runnable today;
  `ios-testflight` needs the ASC integration named `fieldnote-asc-key`).
- Accounts: Codemagic not yet created; Apple Developer NOT enrolled
  (iPhone 12 Pro being purchased for enrollment + testing); Play Console
  not yet registered; Firebase project not yet created.
- Supabase project `xgelrfdrdvrlltcsquqh`; latest migration: 041
  (session auto-end via pg_cron). Native push migration will be 042.
- Outstanding real-iPhone verifications folded into iOS Gate I1: PWA
  deep-link manifest, the old "installed PWA opens blank" report, and the
  recurring portrait fit-to-screen complaint (screenshot wanted).
