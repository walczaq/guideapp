# Map overlay performance — the camera fast path (2026-07-14)

Record of the "map stutters when zoomed in" investigation and fix, for any
session touching `v0.5.html`'s map overlay. Written after commit `a16d0ea`.

## The bug (and the wrong turns, so nobody repeats them)

Symptom: map zoom/pan stutter, growing with zoom depth. First reported on
the Android Capacitor shell during Gate A4, which sent the investigation
down a native rabbit hole — WebView update, GPU-layer CSS hints
(`d6976dd`, reverted), suspending the dark-theme `--map-filter` during
gestures (`0c0e8ff`, reverted: ugly AND didn't help), a shell-only
pixelRatio cap (`87c7867`, reverted: blurry AND didn't help). A perf HUD
(`d304f86`, still in — remove after field confirmation of this fix)
measured 4–5 fps zoomed-in on a Samsung whose
browser did 60 at identical dpr/canvas/GPU. The native theories all died
when the stutter reproduced in desktop browsers and on other phones —
it was platform-independent and content-dependent all along.

**Root cause:** `map.on('move'|'zoom')` ran `renderAll()`, and
`renderPins()`/`renderPassengers()`/`renderYou()` tear down their SVG
layers (`innerHTML = ''`) and rebuild every node — zones, amenities,
side/content pins, labels, route legs, dotted trails, passenger dots —
with fresh elements and listeners, up to 60×/s during a pinch, exactly
while Mapbox's own per-frame tile work peaks at deep zoom. Light test
sessions (few pins, no trails) never showed it; content-rich live tours
did.

## The fix (commit `a16d0ea`)

Split camera frames from data changes:

- **Data changes** → `renderAll()` full rebuild, unchanged.
- **Camera frames** (`move`/`zoom`) → `repositionOverlay()`: updates
  `transform` on `[data-lng]` nodes, recomputes meter-scaled radii on
  `circle[data-radius-m]` (same clamps as the builders: zones 14–220 px,
  pin trigger radii 8–60 px, accuracy halo unclamped), and rewrites
  geometry of `[data-geo]` route legs (`__geoA`/`__geoB`) and trail paths
  (`__geoPts` → `trailSmoothPath`). No node creation, no listeners, no
  layout thrash.

Builders stamp their nodes via `geoStamp(el, lng, lat)` and
`meterStamp(circle, meters, minPx, maxPx)`.

## ⚠️ The rule this creates

**Anything `renderAll` builds that is positioned by lng/lat MUST stamp
itself** (`geoStamp`, plus `meterStamp` for meter-scaled circles, plus
`data-geo` + JS-prop geometry for multi-point shapes). An unstamped node
renders correctly at build time but FREEZES in place during pan/zoom
until the next data rebuild — a subtle, easy-to-miss regression. Test any
new overlay element by panning the map after it appears.

The tour-builder editor map (`_tbEditorMap`) never had the per-frame
rebuild (only a zoom-readout listener) — nothing to do there.

## Measuring

The temporary perf HUD from the hunt is gone; to re-measure, browser
devtools (Performance tab) on a content-rich session is the way. If a
HUD is ever needed again: fps + worst-frame-ms + dpr + canvas size +
`WEBGL_debug_renderer_info`, gated behind `?fps=1`, proved to be the
right feature set (it caught the software-rendering and resolution
theories quickly).

## Still open / adjacent

- WebViews are genuinely somewhat slower than full browsers at the same
  WebGL work — after this fix the shell should be close to browser-smooth,
  not necessarily identical.
- If deep-zoom cost ever needs another pass, next candidates (in order):
  POI/label density from `loosenPoiLayers`, the `fog` atmosphere effect,
  and only then Mapbox style surgery.
