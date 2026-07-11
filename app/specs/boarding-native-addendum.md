# Addendum — native-app boarding & the app-first endgame

Shared design referenced by both platform specs. Decided by Filip
(2026-07-11): after native v1 lands, Fieldnote goes **app-first** — the
QR routes to an app-download landing page, and the browser webapp remains
only as the explicit rescue path. This document is the design of record
for that flow. Product rules are not negotiable without a human decision.

## The physics this encodes

Store installs take minutes; boarding gives seconds. What makes app-first
boarding viable for Fieldnote's audience (elderly tourists) is the
**welcome-talk-on-bus-Wi-Fi structure**: 5–10 minutes of captive audience
with working Wi-Fi, the guide narrating the install once while everyone
does it in parallel, and a guaranteed rescue floor for stragglers.

## The QR router page (the webapp's final passenger-facing form)

`fieldnote.guide/j/<sessionId>` behavior after the flip:

- **App already installed:** the OS intercepts the link (App Links /
  Universal Links, specs A3/I3) and opens the app straight into the
  session. The router page never appears. Returning passengers get
  zero-tap boarding (see below).
- **No app:** the browser opens a single small page (session id retained)
  with, in this order:
  0. **Header: whose tour this is.** One anon Supabase query by session
     id (sessions are world-readable): "You're joining {guide_name}'s
     tour — {tour name}". This is the scanned-the-right-QR confirmation.
     If the session has `ended_at` set, the page says "This tour has
     ended — ask your guide for a fresh code" instead of offering
     installs (the auto-end cron makes ended_at trustworthy). If the
     query fails (offline/captive portal), degrade to the generic page —
     never block on it.
  1. **"Open my tour in the app"** — primary button, shown always:
     a custom URL scheme link (`fieldnote://j/<id>`), registered by both
     shells. ⚠️ This MUST be the custom scheme, not the https link: iOS
     suppresses universal links tapped from a page on the SAME domain,
     so a fieldnote.guide page linking to fieldnote.guide/j/<id> opens
     the page again, not the app. The custom scheme opens the installed
     app straight into the session on both platforms and does nothing
     visible when the app is absent (the store buttons are right below).
     This one button is the universal post-install handoff — it covers
     referrer/clipboard failures and sideloads alike. Final fallback
     inside the app: the guide-name finder.
  2. **iPhone** → App Store listing (before navigating, copy the session
     id to the clipboard for the post-install paste handoff).
  3. **Android** → Play Store listing with
     `&referrer=session%3D<id>` (Install Referrer API handoff).
  4. **Direct APK** (label also in Chinese: 直接下载应用 — for
     Huawei/GMS-less phones) → downloads the signed APK from the site.
  5. Small, visually quiet: **"Doesn't work? Open in browser"** → the
     webapp session exactly as today (`/v0.5?session=<id>`). This is the
     rescue for forgotten Apple IDs, full storage, store outages, and
     anyone the stores fail. It is never removed — it costs nothing (the
     webapp IS the app's engine) and it guarantees no passenger is ever
     excluded.

  Shell requirement this creates (both platforms, add to A3/I3 work):
  register the `fieldnote://` custom scheme alongside App/Universal
  Links; the `appUrlOpen` handler parses BOTH `https://fieldnote.guide/j/<id>`
  and `fieldnote://j/<id>` to the same navigation.

The page is static, tiny, translated (EN/ES/ZH), platform-detected only
to HIGHLIGHT the right button (all three remain visible per Filip).
Implementation moment: the `_redirects` rule for `/j/*` flips from the
webapp to this page ONLY after native v1 gates pass on both platforms —
until then, today's browser boarding stays the default.

## Welcome-talk boarding sequence (guide script)

1. Passengers connect to bus Wi-Fi, tap through any captive portal.
2. Scan the QR → router page → install per platform → "I installed it —
   open my tour."
3. Boarding v2 inside the app: location (incl. background per the
   background-location addendum) + notifications, two taps.
4. Stragglers: "tap 'Doesn't work? Open in browser' — you're in anyway."

**Guide pre-flight (extends the trial-1 lesson):** before boarding,
install Fieldnote once yourself on the bus Wi-Fi. That 30-second test
catches captive portals, DNS problems, and store reachability — the
trial-1 class of failure — before 16 people hit it at once.

## Zero-tap boarding for returning passengers

When the app opens into a session and BOTH permissions are already
granted (location + notifications), skip the boarding overlay entirely —
straight to the map. Implement in `maybeShowIntro()`/`renderIntroSetup()`:
granted+granted → `markIntroSeen()` + return.

## Direct APK channel (Chinese/Huawei Android)

- CI publishes the signed release APK to the site as a static asset on
  each release (same artifact lineage as Play; well under the per-file
  asset limit at ~10–20 MB). Path: `/fieldnote.apk`.
- `assetlinks.json` lists BOTH SHA-256 fingerprints (Play App Signing key
  AND our upload key) so App Links work identically for sideloads —
  already specced in Phase A3; this is why.
- Session handoff for sideloads: no install referrer — the "I installed
  it — open my tour" button is the handoff.
- **Push caveat:** GMS-less phones cannot register FCM; registration
  fails gracefully (no background push; in-app realtime banners work).
  Track failed registrations; if the numbers justify it, add HMS Push
  Kit as its own later phase.
- **Huawei AppGallery** is the follow-up distribution step after v1
  (free-ish developer account + verification, same APK) — store
  presence removes the "unknown sources" prompt. Not a launch blocker;
  the direct APK covers those phones from day one.

## Transit upsell (interim only)

Until the QR flip, browser passengers see the app upsell during the first
bus leg ("While you ride — get the app so your phone buzzes at every
stop"), prioritized on iOS (no web push there). After the flip this
banner is dead code — remove it then.

## Rollout gate (before flipping /j/* to the router page)

1. Native v1 gates passed on BOTH platforms (push, deep links, branding).
2. One real mixed-device tour boarded app-first with the browser as
   silent fallback: join success rate and boarding minutes recorded, and
   not worse than the browser-only baseline.
3. Router page live and tested with all paths (App Store, Play with
   referrer, direct APK, browser rescue) + the guide-name header, the
   ended-session state, and the custom-scheme "Open my tour in the app"
   button verified on BOTH platforms (specifically: tapped from the
   router page itself on iOS — the same-domain case).
4. Booking-channel install ask (operator email/WhatsApp template: install
   before the tour) drafted — the night-before install is the real
   endgame; on-bus install is the recovery, not the plan.
