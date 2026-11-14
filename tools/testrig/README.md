# Offline test rig

Runs the real app (`v0.5.html` from this working copy) in headless Chromium
with a guide window and passenger windows, without reaching Supabase or
Mapbox. Built because the cloud sessions Claude works in cannot reach either
host. It is a stand-in, not the real thing — see "What it cannot tell you".

```
cd tools/testrig
npm install                      # once: the app's fonts (optional)
node scenarios/geysir-walk.js    # ~4 min; screenshots in tools/testrig/out/
```

Playwright and Chromium come from the environment (`require('playwright')`).

## How it works

- **App code**: Playwright answers `https://fieldnote.guide/*` from the repo,
  so the page runs at the real origin with no local server. Service workers
  are blocked.
- **Backend**: `/vendor/supabase-js-*.js` is swapped for `fake-supabase.js`,
  which forwards every table query, RPC and realtime subscription to
  `backend.js` — one in-memory store in Node shared by all windows, so a
  guide's action reaches the passenger window as a realtime event.
- **Map**: the real Mapbox GL engine (camera, projection, overlays) with a
  blank style and a 100 m grid (bold every 500 m) around each stop. No tiles.
- **GPS**: each window gets real browser geolocation, moved by `rig.walk()`,
  so fixes go through the app's own `onGpsSuccess` path. The joystick
  simulator also works.
- **Bus**: `rig.driveBus()` inserts `guide_locations` rows with source
  `bus_gps` (what the `bus_gps` function does with tracker fixes);
  `rig.placeBusPin()` inserts the guide's hand-placed `bus_pin`.
- **Test data**: `seed.js` — one guide and a made-up Golden Circle tour with
  spots roughly at the real sights.

## Writing a scenario

Scenarios so far (each prints PASS/FAIL lines or a summary, and screenshots):

- `geysir-walk.js` — one stop start to finish, passenger loop walk, bus drives in.
- `thingvellir-day.js` — geofence prompt, extra spot, danger zone, late joiner,
  no-location passenger, reload mid-stop, end stop, end session.
- `pickup-bus.js` — before the tour: "your bus is on its way", arrival, stale tracker.
- `full-bus.js` — the guide's map with 19 passengers walking at once.

`geysir-walk.js` is the simplest pattern. The main calls:

| Call | Does |
| --- | --- |
| `Rig.start()` | browser + seeded backend |
| `rig.createSession()` | a session owned by the rig guide; returns its id |
| `rig.openGuide(id, { at })` / `rig.openPassenger(id, { at })` | a phone-sized window; `at` is `[lat, lng]` |
| `rig.joinAsPassenger(page, name)` | language → name → intro → map |
| `rig.startTour(guide, 'Geysir')`, `rig.activateStop(guide, 'Geysir')` | the guide's taps |
| `rig.walk(page, [[lat,lng]…], { speed })` | moves that phone's GPS in real time |
| `rig.driveBus(id, [[lat,lng]…])`, `rig.placeBusPin(id, [lat,lng])` | bus on the passenger map |
| `rig.controls(page)`, `rig.tap(page, '#id' or 'Text')`, `rig.shot(page, name)` | see what is tappable, tap, screenshot |
| `rig.backend.t.<table>` | the stored rows, for assertions |

After a run, check `rig.errors` (uncaught page errors) and
`rig.backend.missing` (server functions the app called that the rig does not
imitate — add them to `RPC` in `backend.js`).

## What it cannot tell you

- **The street map.** Spots and trails sit on a grid, not on terrain or paths.
- **The real database.** No row-level security, no SQL from `migrations/`;
  each function in `backend.js` is a hand-written imitation and can drift
  from the migration it copies. Pickup texts, push, chat photos, translation
  and the company screen's less-used calls are not imitated.
- **Real phones.** No background location, screen lock, weak signal, native
  shell, or iOS/Android browser differences.
- **Your tours.** Only the made-up tour in `seed.js`.

A pass here means the app's own drawing and logic behaved; it says nothing
about the backend or a phone in someone's pocket.
