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

## Product rules (both platforms, exactly these — decided by Filip 2026-07-11)

1. **One consent moment: boarding.** Background sharing is part of the
   same "Allow location" agreement in boarding v2 — no second prompt
   later. The boarding location copy becomes (EN; translate ES/ZH):
   - "So you appear on the map and stops light up near you — even with
     your phone in your pocket. Shared only with your guide during this
     tour. Turns off by itself when the tour ends, after 12 hours at the
     latest, or whenever you switch it off."
   This wording doubles as Google Play's required **prominent in-app
   disclosure** (must name the background collection and its purpose
   BEFORE the runtime permission ask — keep "even with your phone in your
   pocket" and the auto-off sentence; they are the compliance load-bearing
   parts).
   ⚠️ Platform reality on Android 11+: "Allow all the time" cannot be
   granted in the runtime dialog — the OS routes the user to Settings.
   Sequence at boarding: request foreground location first (dialog), then
   immediately show one inline line: "Android: choose 'Allow all the
   time' in Settings so it works in your pocket" with a button that
   deep-links to the app's location settings. If the passenger skips the
   hop, they simply remain foreground-only — the app must work fine
   either way. If field data shows the hop hurts boarding, the fallback
   (pre-approved) is moving ONLY the settings-hop nudge to after the
   first stop activation.
2. **No battery talk in user copy.** The auto-off sentence is the whole
   reassurance. (Battery discipline still exists internally — see rule 6
   and the gate — we just don't advertise it.)
3. **Auto-expiry, enforced in code, not policy.** The background watcher
   stops on (a) session ended (realtime `ended_at` event AND the auto-end
   cron path), (b) a hard **12-hour cap** from tour start (client-side
   watchdog checked on every background fix — belt-and-suspenders on top
   of the 3h-idle auto-end), (c) the existing "Stop sharing my location"
   menu toggle. Verify in the gate: zero `passenger_locations` rows after
   `ended_at` and after the 12h mark.
4. **Existing promises stay true.** "Shared only during this tour" holds;
   the new copy adds the in-your-pocket disclosure explicitly. Do not
   weaken either text.
5. **Guide UI: no changes.** Fewer stale rings is the whole feature.
6. **Battery discipline (internal):** distance filter **15 m default,
   tunable within 10–15 m** in background; feed fixes through the
   existing onGpsSuccess pipeline so the 5s queue throttle, transit
   sparse-heartbeat (R2-C), and store-and-forward offline queue all apply
   unchanged.

## Shared implementation shape

- Plugin: `@capacitor-community/background-geolocation` (maintained,
  supports both platforms; Android runs a foreground service with a
  persistent notification; iOS uses the Always authorization). If it
  fights Capacitor 6, the fallback is `@capgo/background-geolocation` —
  pick ONE, do not ship both.
- `v0.5.html` bridge: `bgShareStart()` / `bgShareStop()`, native-only
  (`Capacitor.isNativePlatform()`), armed from the boarding "Allow
  location" tap; state in localStorage per session with a stored
  armed-at timestamp for the 12h cap. Watcher callback feeds
  `onGpsSuccess`-equivalent state so ALL existing throttling/queueing
  applies; do not build a second persistence path.

## Android wiring (Phase A6)

- Manifest: `ACCESS_BACKGROUND_LOCATION`.
- Runtime: foreground permission from the boarding tap, then the
  Settings deep-link nudge for "Allow all the time" (see product rule 1 —
  the app must remain fully functional if the passenger skips the hop).
- Foreground-service notification text: "Fieldnote — sharing your
  location with your guide" (localized). This notification is mandatory
  and is a FEATURE: it is the passenger's visible kill switch.
- Play Console: the **background-location sensitive-permission
  declaration**. This is a form in Play Console (App content → Sensitive
  app permissions) that every app requesting ACCESS_BACKGROUND_LOCATION
  must complete before release: you state the feature's purpose AND
  attach a short screen-recorded video (uploaded to YouTube, link pasted
  into the form) showing (1) the prominent in-app disclosure — our
  boarding copy — appearing BEFORE (2) the permission dialogs and (3) the
  feature working. Google reviewers watch it to approve the permission;
  without an accepted declaration the release is blocked. Record it on
  the Samsung once the flow works: boarding → disclosure visible →
  dialogs → locked phone → dot moving on a second device.
- Swipe-kill: the foreground service typically survives an app swipe;
  force-stop kills it — acceptable, document in the gate results.

## iOS wiring (Phase I7)

- `Info.plist`: `NSLocationAlwaysAndWhenInUseUsageDescription` ("Lets your
  guide see where you are during the tour even when your screen is off.
  Only while a tour is active."), add `location` to `UIBackgroundModes`.
- Authorization: request Always from the boarding "Allow location" tap
  (product rule 1). iOS shows the normal While-Using dialog and grants
  **provisional Always** — the user sees no extra step at boarding, and
  iOS itself asks for confirmation days later with a usage map. The
  auto-expiry rule (#3, incl. the 12h cap) is what makes that later
  dialog survivable — keep it tight.
- App killed (swiped): background updates stop; relaunch-on-significant-
  change is explicitly OUT of scope for this phase.
- App Store review notes: explain opt-in + auto-expiry + the passenger
  benefit; expect extra scrutiny on this build.

## Gate (both platforms)

1. Board normally (location agreed; Android: settings hop completed),
   lock the phone, walk → the guide map shows the dot moving for
   ≥ 15 minutes with the screen off.
2. Android: board but SKIP the settings hop → app fully functional as
   foreground-only, no errors, no nagging.
3. "Stop sharing my location" toggle → fixes stop within seconds
   (watch `passenger_locations`).
4. End the session → watcher stops; ZERO location rows after `ended_at`
   (query it), and the OS location indicator goes away. Repeat the check
   against the 12h cap (simulate by backdating the armed-at timestamp).
5. Battery (internal, not user-facing): note %-drop over a 1h
   locked-screen walk; if it exceeds ~5-6% beyond baseline, tune the
   10–15 m distance filter upward within its range before shipping.
6. Android only: swipe-kill and force-stop behavior recorded.
7. Store declarations submitted (Play declaration video / ASC review
   notes).
