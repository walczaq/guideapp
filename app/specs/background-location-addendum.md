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
   ~~⚠️ Platform reality on Android 11+: "Allow all the time" cannot be
   granted in the runtime dialog — the OS routes the user to Settings…~~
   **SUPERSEDED — Filip's decision, 2026-08-13 (the "WhatsApp model"):**
   no settings hop at all. The plugin's foreground service + persistent
   notification keeps fixes flowing with only while-in-use permission,
   exactly like WhatsApp live sharing — so `ACCESS_BACKGROUND_LOCATION`
   is NOT requested, the Android boarding sequence is just the one
   permission dialog, and (major win) Play's sensitive-permission
   declaration + review video are NOT required. Reinstate the hop (and
   the manifest permission, and the Play declaration) only if field data
   shows fixes stopping with the screen locked on real devices — the
   Gate walk test is the check.
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

- Manifest: ~~`ACCESS_BACKGROUND_LOCATION`~~ **deliberately absent**
  (WhatsApp model, see rule 1's superseding decision). The plugin's
  merged manifest declares its own location foreground service.
- Runtime: foreground permission from the boarding tap. No settings
  hop.
- Foreground-service notification text: "Fieldnote — sharing your
  location with your guide" (localized). This notification is mandatory
  and is a FEATURE: it is the passenger's visible kill switch.
- Play Console: **no sensitive-permission declaration needed** under the
  WhatsApp model — the declaration (form + review video) is triggered
  solely by requesting ACCESS_BACKGROUND_LOCATION, which we don't. The
  in-app disclosure copy stays anyway (honest UX, and it future-proofs a
  reinstatement). If the permission ever comes back, the full
  declaration procedure is in this file's git history.
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

## Android field findings (2026-08-13, Samsung, Gate A6 testing)

What works locked-in-pocket: GPS fixes, the watcher's JS callbacks, the
IndexedDB offline queue — full cadence, correct timestamps. What does
NOT: network. The WebView's network stack suspends the moment the
screen locks; every in-flight/new request freezes until unlock, then
the store-and-forward queue flushes at once (verified via
passenger_locations.synced_at deltas growing linearly to 5.5min).
Ruled out by experiment: watcher arming (fixed in 127592b — arm on
first fix, permission race), the sync-worker's in-flight latch (made
stealable in 50f88a7 — needed anyway), Samsung battery optimization
(Unrestricted changed nothing), Play-level permissions (n/a).

Consequence: with the WebView approach, locked-screen behavior is
"path recorded + backfilled on unlock + stale-ring honesty", not live
streaming. LIVE locked-screen delivery requires a NATIVE upload path —
the foreground service posting fixes to Supabase directly (own
FusedLocation + HTTP client, replacing the community plugin), a
bounded but real piece of native work requiring build-per-iteration
development. Decision pending (Filip).

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
