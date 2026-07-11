# Addendum — background location, done properly

Shared design for the post-v1 background-location phase referenced by
`native-android-migration.md` (Phase A6) and `native-ios-migration.md`
(Phase I7). Platform wiring lives in those phases; the PRODUCT DESIGN below
is identical for both and is not negotiable without a human decision —
it encodes the privacy promise the app makes to passengers.

## Why this exists

With screen locked or app backgrounded, both OSes suspend geolocation —
the passenger's dot freezes at last known position (rendered honestly with
the stale/dashed ring). Field evidence says this is the likely cause of
"phone in pocket, dot silent for stretches" (trial-2 "Dawn" case). Native
apps CAN keep location flowing when locked — but only with the most
review-scrutinized, trust-sensitive permission on both stores. Hence:
strictly opt-in, transparently worded, auto-expiring.

## Product rules (both platforms, exactly these)

1. **Default OFF.** Nothing about boarding changes — boarding stays two
   taps and requests only when-in-use location, as today.
2. **The ask happens at a moment of understood value, not at boarding:**
   a one-time, dismissible prompt AFTER the first stop activation
   (passengers now understand what the map does), plus a permanent
   passenger-menu toggle. Copy (EN; translate to ES/ZH like boarding v2):
   - Title: "Keep sharing while your screen is off?"
   - Body: "Your guide can see where you are even when your phone is in
     your pocket — useful when it's time to head back. Uses more battery.
     Turns off by itself when the tour ends."
   - Buttons: "Keep sharing" / "No thanks" (both remembered; never re-ask
     in the same session after a No).
3. **Auto-expiry, enforced in code, not policy:** the background watcher
   stops on (a) session ended (realtime `ended_at` event AND the auto-end
   cron path), (b) the existing "Stop sharing my location" menu toggle,
   (c) the opt-in toggle turned off. Verify in the gate: zero
   `passenger_locations` rows after `ended_at`.
4. **Existing promises stay true.** Boarding copy says location is
   "shared only during this tour" — background sharing is still only
   during the tour, so the promise holds; the opt-in copy adds the
   screen-off disclosure explicitly. Do not weaken either text.
5. **Guide UI: no changes.** Fewer stale rings is the whole feature.
6. **Battery discipline:** distance filter ≥ 25 m in background; feed
   fixes through the existing onGpsSuccess pipeline so the 5s queue
   throttle, transit sparse-heartbeat (R2-C), and store-and-forward
   offline queue all apply unchanged.

## Shared implementation shape

- Plugin: `@capacitor-community/background-geolocation` (maintained,
  supports both platforms; Android runs a foreground service with a
  persistent notification; iOS uses the Always authorization). If it
  fights Capacitor 6, the fallback is `@capgo/background-geolocation` —
  pick ONE, do not ship both.
- `v0.5.html` bridge: `bgShareStart()` / `bgShareStop()`, native-only
  (`Capacitor.isNativePlatform()`), storing the opt-in in localStorage
  per session. Watcher callback feeds `onGpsSuccess`-equivalent state so
  ALL existing throttling/queueing applies; do not build a second
  persistence path.
- The one-time prompt hooks the existing `onStopActivated` passenger
  branch (same place the headcount re-arm lives).

## Android wiring (Phase A6)

- Manifest: `ACCESS_BACKGROUND_LOCATION`.
- Runtime: request only on opt-in tap. Android 11+ routes the user to
  system settings for "Allow all the time" — the prompt copy must warn
  about that hop ("Android will ask you to choose 'Allow all the time'").
- Foreground-service notification text: "Fieldnote — sharing your
  location with your guide" (localized). This notification is mandatory
  and is a FEATURE: it is the passenger's visible kill switch.
- Play Console: background-location declaration + a short demo video of
  the opt-in flow (record the prompt → settings → notification sequence).
- Swipe-kill: the foreground service typically survives an app swipe;
  force-stop kills it — acceptable, document in the gate results.

## iOS wiring (Phase I7)

- `Info.plist`: `NSLocationAlwaysAndWhenInUseUsageDescription` ("Lets your
  guide see where you are during the tour even when your screen is off.
  Only while a tour is active."), add `location` to `UIBackgroundModes`.
- Authorization ladder: keep requesting When-In-Use at boarding as today;
  request the Always upgrade ONLY from the opt-in tap. iOS may grant
  provisional Always and confront the user later with a usage map — the
  auto-expiry rule (#3) is what makes that dialog survivable, keep it
  tight.
- App killed (swiped): background updates stop; relaunch-on-significant-
  change is explicitly OUT of scope for this phase.
- App Store review notes: explain opt-in + auto-expiry + the passenger
  benefit; expect extra scrutiny on this build.

## Gate (both platforms)

1. Opt in on a locked phone in a live session → the guide map shows the
   dot moving for ≥ 15 minutes of walking with the screen off.
2. Toggle off → fixes stop within seconds (watch `passenger_locations`).
3. End the session → watcher stops; ZERO location rows after `ended_at`
   (query it), and the OS location indicator goes away.
4. Battery: note %-drop over a 1h locked-screen walk; if it exceeds ~5-6%
   beyond baseline, raise the distance filter before shipping.
5. Android only: swipe-kill and force-stop behavior recorded.
6. Store declarations submitted (Play video / ASC review notes).
