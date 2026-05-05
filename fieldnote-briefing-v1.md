# Project Briefing — Fieldnote v0

**Working codename:** Fieldnote *(final name TBD — dedicated naming session pending)*

**Last updated:** 28 April 2026

---

## Honest project state

- **v0.1 through v0.3 shipped, v0.4 partially built (chunks A–D of 7).** Real GPS app deployed to Cloudflare Pages, real Mapbox tiles, tour data + sessions + passenger locations all in Supabase. Guide can log in via invite code, create a session, see passengers' live dots and breadcrumb trails on a map updating in real time. Tested with two browsers in the same session.
- **Builder is a complete beginner at coding**, building part-time (evenings/weekends).
- **Building with AI tools** — switched to Claude (in chat + Cowork) earlier than briefing originally planned; Lovable not used.
- **No deadline.** Each milestone is a learning project. Product emerges as the skill grows.
- **Supabase + Cloudflare in active use.** Project provisioned in Frankfurt region. One `tours` table, two seed tours, RLS-protected.

---

## What it is

A coordination tool for independent tour guides running small-group tours. **Two halves of one product:**

1. **The content layer** — pinned content along the route so passengers don't miss the hidden gems.
2. **The safety layer** — live location and broadcast messages so nobody gets lost.

Without (1) it's just Find-My-Friends. Without (2) it's just Locatify. The combination is the product.

Delivered zero-install to passengers via the browser. Primary user (and buyer) is the working guide.

---

## Validated problem (from user's own 700 tours)

- **30–50%** of tours involve losing someone temporarily
- **90%** of tours involve at least one late passenger
- Occasional **"left someone behind"** incidents — traumatic, reputation-damaging
- Pattern is statistical, not exceptional: with 7 stops/day, the math guarantees problems
- Cross-validated informally with other guides — numbers similar or worse

---

## Positioning

> **"You can't stop humans from being late. You can stop tours from breaking when they are."**

Not a self-guided tour app. Not a tour audio recorder. **A coordination tool for live guided tours.** The guide is the star — the product gives them superpowers, not replaces them.

---

## v0 roadmap

| ID | Milestone | Status |
|---|---|---|
| GUI-23 | v0.1 — One hardcoded tour with GPS triggers | ✅ Shipped 26 Apr 2026 |
| GUI-24 | v0.2 — Tour fetched from Supabase, URL-routed | ✅ Shipped 26 Apr 2026 |
| GUI-25 | v0.3 — Offline-first location capture with sync | ✅ Shipped 27 Apr 2026 |
| GUI-26 | v0.4 — Live guide view (consumes v0.3's data pipeline) | ✅ Shipped 29 Apr 2026 |
| — | v0.4.5 — Visual polish pass (no new features) | Next |
| GUI-27 | v0.5 — Broadcast messages, passenger alerts, WhatsApp link | |
| GUI-29 | v0.5.5 — Offline app shell (Service Worker + PWA manifest) | |
| GUI-28 | v0.6 — In-app tour authoring + library-wide zones + transit view | |

After v0.6: run a real low-stakes tour, gather real feedback, decide v1. **v1 is expected to include native apps for both guide and passenger (two separate apps, not one).**

### Working principles for v0

1. Each milestone is a learning project, *and* a step toward a real tour with real people.
2. Don't move on until you understand what you built.
3. One concept per milestone.
4. AI tools are tutors, not contractors. Always ask "explain this, line by line."
5. Allowed to stop and just play.

---

## What's actually built

### v0.1 (single-file static app)
- Single HTML file, deployed to Cloudflare Pages
- Mapbox GL JS for map rendering, restricted to Iceland tour bounds
- Browser geolocation via `watchPosition` for continuous GPS
- SVG overlay for pins and walker dot, synced with Mapbox projection on every map move/zoom
- Trigger logic: haversine distance walker→pin, fire chime + popup when inside radius, fire-once-per-session
- Tap-pin-to-reread, visited-pin styling, follow-me toggle
- Field-notebook visual aesthetic (Fraunces serif + JetBrains Mono, paper/ink palette)

### v0.2 (Supabase-backed)
- Supabase JS client added via CDN
- `tours` table with `slug`, `name`, `subtitle`, `home_lng`, `home_lat`, `pins` (jsonb)
- Row Level Security on, public-read policy only — anon key cannot write
- Boot is now async: load `?tour=<slug>` from URL → fetch from Supabase → render
- Loading and error screens
- Two seed tours: `fossvogsdalur-001` (the original Fossvogsdalur walk) and `gautland-block` (a tiny 2-pin test loop south of home)

### v0.3 (offline-first capture + sync)
- `sessions` table; URL routing now `?session=<id>` for join, `?tour=<slug>` legacy still works
- Persistent passenger ID (16-char nanoid in localStorage)
- IndexedDB queue (`fieldnote.pending_locations`) — every GPS fix throttled to 5s, persisted locally first
- Sync worker drains queue to Supabase: 10s tick + `online` event + opportunistic post-write nudge. Strict ordering (Supabase insert succeeds before local delete). Idempotent on retry.
- Tested online/offline transitions on real phone — queue grows offline, drains on reconnect
- Known gap: app shell still requires network on cold reload (Service Worker / PWA in v0.5.5)

### v0.4 (live guide view) — SHIPPED 29 Apr 2026
- **A** — Custom auth via `guides` + `invite_codes` tables, two security-definer RPCs (`redeem_invite_code`, `recover_guide_access`). Recovery is two-factor: name + original invite code. Device tokens (32-char nanoid) in localStorage.
- **B** — Guide view shell: bottom sheet with three drag-snap states (collapsed/half/full), passenger-only HUD elements hidden, beacon-blue YOU dot for guide. Sticky last-session resume on bare-URL revisit. Friendly landing screen for unauthenticated bare-URL visitors.
- **C** — Catch-up query pulls full session history, populates `PASSENGERS` map with current position + breadcrumb trail per passenger.
- **D** — Realtime subscription on `passenger_locations` filtered by session_id. Catch-up runs first, then subscribe. Reconnection re-runs catch-up in merge mode (no state wipe). Dedupe on `(passenger_id, client_recorded_at)` against double-counting.
- **E** — Disconnected-state indicator on passenger dots (no fix in 60s+ → grey ring + grey pulsing halo). 5-second state tick re-evaluates by absence. **Stationary detection deferred to v1** — phones lock screens during tours which throttles JS, making "stationary" indistinguishable from "screen off"; this needs native background GPS to work. Dropped from web prototype rather than ship a feature that's right ~30% of the time.
- **F** — Guide visibility, two independent pills in bottom sheet:
  - **Share my location** — phone GPS broadcasts to `guide_locations` every 5s with `source='phone'`. Toggle off inserts `is_off=true` sentinel row.
  - **Bus pin** — tap pill → next map tap places pin (auto-exits placement mode so panning doesn't move it). Tap pin → popup with Move / Remove. Move re-enters placement mode for one tap. Remove kills pin AND turns off the pill.
  - Both can be on simultaneously: passenger sees both blue dot + BUS square at distinct positions.
  - Top "broadcasting" banner with status copy: "Guide location live", "Bus location live", "Guide location live · Bus location live", "Tap the map to place the bus" depending on combination state.
  - Passenger-side: catch-up + subscription on `guide_locations`, latest row per source wins, `is_off=true` hides source. **No freshness timeout** — earlier we had 30s, but it false-positived for stationary guides; better to keep last-known position than to lie by hiding it.
  - All map labels (guide name, "Bus") rendered as plain pure-black text with pure-white 8-direction text-shadow halo. No pill backgrounds — too heavy at low zoom.
- **G** — Passenger names + `session_passengers` table:
  - **First-join name gate** — passenger opens session URL → mandatory full-screen prompt "What's your name? So [guide] can recognize you on the map" → submit inserts row → reload → map appears.
  - **Edit name** — burger menu shows "Your name · [name]" for passengers. Tap → independent overlay (NOT a `.screen` — that screen system uses persistent DOM with `.visible` toggle, conflicts with overlay-style modals) with back arrow header.
  - **Map labels above passenger dots** — pure SVG `<text>` with `paint-order=stroke` + 3px white stroke + black fill. Same look as guide/bus labels in F, but native SVG inside the passenger group.
  - **Names-on-map toggle** in bottom sheet, default ON. When OFF, name shows only above the currently-selected passenger.
  - **Bottom-sheet passenger list** — rows with half-half identity dot (CSS `linear-gradient(to right, A 50%, B 50%)`), name, status text ("live" / "no signal" / "no fix yet"). Tap row → selects passenger, same as tapping their map dot. Sorted: located passengers first (alpha by name), name-only joiners after.
  - Realtime subscription on `session_passengers` for both INSERT (new joiners) and UPDATE (renames). Names update live across all guide views.

#### Significant decisions and lessons from the build
- Build version constant in About is essential. Real-world test of "did this deploy land on the phone" is verifying `BUILD_VERSION` matches. Cloudflare edge cache had real lag (~1–2 min for new builds to show up).
- Independent overlay vs `.screen` class — the existing screen-stack system uses persistent DOM elements that toggle a `.visible` class. Trying to inject new modals as `class="screen"` conflicts with this; cleaner to use independent overlay (z-index 90+) and `el.remove()` on close.
- HTML duplicates trap — the file accumulated two `<div id="screen-share">` elements over iterations. Both got `.visible` class on openScreen; the second (later in DOM) drew on top with empty content, masking the populated first one. Caused the "empty Share invite" bug that took two diagnostic rounds to root-cause. Lesson: when iterating, search for duplicate IDs.
- Inline SVG attribute opacity vs CSS animation — inline attrs beat CSS animations the same way they beat CSS rules. When pulsing a halo, must NOT set inline `opacity`; let CSS drive it.
- "Stationary 15min" was a feature we *wanted* but couldn't deliver honestly in a web prototype. Documenting the reasoning matters; otherwise it'd come back in v0.5 planning.
- Bus pin UX iteration: started with map-tap = move (annoying — accidental moves while panning) → locked pin in place but no move path → tap-on-marker popup with Move/Remove (Google Maps pattern). The right answer was the third one; iteration was fast because the changes were small.

#### Schema additions in v0.4
```sql
-- Chunk A
create table guides (id uuid pk, name text, device_token text unique, created_at);
create table invite_codes (code text pk, note text, redeemed_by uuid, redeemed_at);

-- Chunk F
create table guide_locations (
  id bigserial pk, session_id text fk→sessions, source text check(source in ('phone','bus_pin')),
  lng float8, lat float8, set_at timestamptz default now(), is_off boolean default false
);

-- Chunk G
create table session_passengers (
  session_id text fk, passenger_id text, name text, joined_at timestamptz,
  primary key (session_id, passenger_id)
);
```
All v0.4 tables use v0.3-style permissive RLS (anon read/insert/update). Hardening pass deferred to chunk H or v0.5.

---

## v0.3 design (decided 26 Apr 2026, not yet built)

**The big shift:** v0.3 was originally scoped as "live two-way location with realtime broadcasts." That plan died once we honestly examined connectivity reality.

### What changed and why

Three facts forced a redesign:

1. **Browsers can't do GPS while the screen is locked.** Wake Lock helps, but not for "phone in pocket." A pure web realtime stream goes silent the moment a passenger pockets their phone.
2. **90% of passengers are abroad without cellular data.** They use bus WiFi only. The moment they step off the bus to walk around a stop, they're offline — exactly when the safety layer is supposed to be most useful.
3. **Bus WiFi is the sync point**, not a continuous connection. Connectivity follows a predictable bus-near-bus-far pattern, not random outages.

These together mean: a "live realtime broadcast" model **only works when nobody needs it.** When the safety layer should be doing real work, the passenger is offline.

So v0.3 is reframed as **the foundation milestone**: the offline-capable data pipeline that every later feature inherits.

### v0.3 milestone goal

> **Phone logs and syncs reliably.** Every GPS fix is captured locally and queued; when network returns, the queue flushes to Supabase. Works the same online or offline — the difference is invisible to the user. **No live guide view yet** — that's v0.4.

The visible product change is small ("the app records your tracks"). The architectural change is huge — every milestone after v0.3 inherits an offline-capable foundation. Doing this later means rewriting everything that touches data.

### End-of-milestone test

- Open the app on a phone, walk around with WiFi on. Tracks land in Supabase within seconds, queue stays empty.
- Turn off WiFi mid-walk. Phone keeps GPS-fixing (visible: dot keeps moving). Queue grows in localStorage / IndexedDB.
- Turn WiFi back on. Within ~10 seconds, the queue flushes. Supabase has the full track including the offline portion.
- Lock phone for a minute, then unlock. Whatever the browser allowed during that minute is captured; the rest is gracefully missing without errors.

### Design decisions

**Session ID format:** 8-character nanoid (e.g. `7Xk2mPq9`). About 218 trillion possible values. Short enough to feel like a code, long enough that random people can't guess one and walk into a session uninvited. Stored as the primary key of `sessions`.

**Session label (for humans):** alongside the nanoid id, each session gets an auto-generated readable label like `2026-04-26-FW-foss`, built from `tour_slug` + date + guide initials. Label appears in dashboards, logs, Linear comments — never in URLs.

**Location storage architecture:** every GPS fix → one row in `passenger_locations` (eventually). Full history retained. Justification: the location data isn't only for "where are they right now" — it's a research-grade asset for stop planning, dwell-time analysis, route refinement, and a future operator-tier sellable feature. You can't reconstruct history later; every minute not stored is data lost forever.

**Online vs offline data path (the core of v0.3):**
- Phone always GPS-fixes locally (`watchPosition`)
- Every fix → write to a local queue (IndexedDB)
- A separate process tries to flush the queue to Supabase whenever network is available
- When online: fixes hit Supabase within ~1 second → looks like realtime
- When offline: queue grows → flushes the moment connectivity returns
- Same code path either way; the realtime/offline distinction is invisible at the application level — it's just "how full is the queue right now"

**Update frequency:** every 5 seconds, throttled from native GPS rate. Phone polls at native rate (1-3s typical); we gate writes to the queue. Adaptive ("less often when stationary") deferred to v1.

**Wake Lock:** request screen-wake-lock when in the tour. Helps keep the screen on while the app is in the foreground (extends time before auto-lock kicks in). Does not solve the manual-lock case — that's a real limitation, named in the lobby copy.

**Guide UI:** *deferred to v0.4.* v0.3 has no guide view. The data is being captured and synced; consuming it visually is the next milestone's job.

**Single file, `?role=guide` URL toggle (locked for v0.4):** when v0.4 adds the guide view, it lives in the same `index.html`. Function-level split in the JS (`runPassenger()` vs `runGuide()`).

**Lobby (passenger-side, v0.3):** click link → permission prompt → tour map. Lobby copy explicitly states: *"This app records your location to share with your guide. Keep the screen on while walking, and reconnect to bus WiFi when you return so your data syncs."* Real waiting-room features wait for v0.5.

### New schema for v0.3

```sql
-- Sessions: one row per "tour being run right now or recently"
create table sessions (
  id           text primary key,           -- 8-char nanoid
  label        text not null,              -- "2026-04-26-FW-foss"
  tour_slug    text not null references tours(slug),
  guide_name   text not null,
  started_at   timestamptz default now(),
  ended_at     timestamptz
);

-- Passenger locations: every update is a row, full history retained.
-- The `client_recorded_at` is when the phone got the fix; `synced_at` is when the row hit Supabase.
-- The two timestamps differ on offline-then-synced rows — useful for both debugging and analytics.
create table passenger_locations (
  id                  bigserial primary key,
  session_id          text not null references sessions(id),
  passenger_id        text not null,              -- client-generated, persists in localStorage
  lng                 float8 not null,
  lat                 float8 not null,
  accuracy            float8,
  client_recorded_at  timestamptz not null,       -- when the phone got the fix
  synced_at           timestamptz default now()   -- when Supabase received the row
);
create index on passenger_locations (session_id, passenger_id, client_recorded_at desc);
```

RLS policies needed (to be drafted before coding):
- `sessions`: authenticated guide can insert their own sessions; anyone with a session id can read it
- `passenger_locations`: anyone can insert with a valid session id; reads restricted (TBD with auth model in v0.4)

### Browser storage for the offline queue

IndexedDB, not localStorage. localStorage is synchronous (blocks UI) and capped at ~5MB. IndexedDB is async, can hold hundreds of MB, and survives across reloads. Each queued row is a small object; tens of thousands fit comfortably.

Library: probably `idb` (Jake Archibald's wrapper). Avoids the raw IndexedDB API which is genuinely awful. ~3KB.

### Privacy & data retention notes

Persistent location history of paying customers' clients = real GDPR surface. Mitigations to plan for *before* taking on real users:

- Auto-purge sessions older than N days (suggest 30 for v0.3 testing; 90 for production)
- Passenger view should clearly disclose data collection in the lobby
- Provide a "leave session" / "stop sharing" button in passenger view
- Document the data flow in a tiny privacy note before any real-user testing

These are "must" before v0.6's real-tour test, not optional polish.

### What v0.3 explicitly does NOT include

- **Live guide view** — that's v0.4
- Authoring (v0.6)
- Broadcast messages (v0.5)
- Authentication for guides (probably v0.4 — v0.3 uses `guide_name` label only)
- Operator/admin dashboard
- Heatmap / movement-pattern visualization (post-v0)
- Mapbox offline tile pre-caching — separate concern, comes when the *map itself* needs to work offline
- Service Worker / full PWA install — v0.3 only handles the data-pipeline half of offline-first; full app-shell offline waits

### Connectivity model (the real picture)

Established in this design session, important enough to call out separately:

- **Guide:** assumed online. Has bus WiFi or operator equipment. Connection is reliable enough to support a live dashboard view (in v0.4).
- **Passenger:** assumed intermittent. 90% have no cellular data abroad; they connect only via bus WiFi. The pattern is *predictable* (on bus = connected, off bus = disconnected) not random.
- **Bus WiFi is the sync point.** Data flows in bursts when passengers reboard.
- **The product must look the same to the user regardless of connection state.** The realtime/offline distinction is plumbing; users see "the app works."

### Native app strategy (decided 26 Apr 2026, refined 27 Apr 2026)

Web prototype through v0.6, then a native rebuild.

- **v0 web:** prototype the whole product as one codebase with a `?role=guide` URL toggle. Fast iteration, zero install, real-tour testing on web with documented limitations (screen lock, no background GPS).
- **v1 native:** **two separate apps**, both for iOS and Android. Probably React Native or Flutter for cross-platform code sharing. Realistic estimate of v0.6 → v1 port: ~60-70% UI rewrite, ~30-40% logic reuse (Supabase calls, distance math, trigger logic, data shapes survive; UI components, navigation, styling all rebuild).
- **Why two apps for native:** the roles have very different requirements:
  - **Guide app** — heavy: background GPS (broadcast while screen locked), push notifications (help requests, late passengers), persistent login, tour management UI, analytics. Used daily by professionals.
  - **Passenger app** — light: should be near-invisible to passengers when not in active use. Zero-install in v0; if native, tiny, no login, ephemeral. Used once per tour.
  - Combined into one app, every passenger would download guide-only code they'll never use → bigger download, more friction at install, lower conversion. Apple/Google also penalize "two products in one app."
  - Standard industry pattern: Vox, Cabify, Deliveroo, DoorDash, Lyft, Airbnb all ship separate apps for the two sides.
- **Why web first:** designing in native is 10x slower per UI iteration. Web prototyping is the cheaper way to discover *what to build*. Native is the cheaper way to *ship it for real* once it's known.
- **Open question deferred to v0.6:** does the passenger ever need to be native at all, or do they stay on web indefinitely? Decision waits until v0.6 real-tour testing reveals what passengers actually need (push notifications? offline beyond v0.5.5? camera access?).

---

## v0.4 design (decided 27 Apr 2026, not yet built)

**Milestone goal:** a guide opens a session with `?role=guide`, sees a map of all passengers in that session, watches them move in roughly real time. Passengers can see the guide's location too if the guide opts in to "visible." Real per-guide auth (invite codes) lands here, replacing v0.3's "anyone can do anything" RLS.

### End-of-milestone test

1. Guide visits the app for the first time → sees invite-code form → pastes code → lands on create-session form
2. Guide creates a session → automatically lands in guide view at `?session=<id>&role=guide` → sees their tour pins on a map
3. Open passenger URL on a second device → join session, walk → guide watches the dot move within seconds
4. Open a third device, second passenger joins → both visible on guide's map, labeled by name
5. Toggle "Visible to passengers" → passengers now see a guide dot on their own map
6. Refresh guide page → both passenger dots still visible (catch-up query, then live subscription)
7. Disconnect a passenger phone (WiFi off + close tab) → their dot fades to grey within 2 minutes
8. Long-press a dot on the guide view → option to "mark for follow-up" turns the dot red

### Design decisions

**Realtime mechanism:** Subscribe to inserts on `passenger_locations` filtered by `session_id`. Every time a passenger's queue flushes a row, Supabase pushes that row to all connected guide views. Bursts (passenger reconnecting after offline) arrive as multiple events, which matches reality ("they were missing, now they're back, and here's their track").

**Catch-up query on first load:** before subscribing, the guide view runs one query that pulls **all** rows in the session (oldest first), so each passenger's full breadcrumb trail can be reconstructed. The most recent fix per passenger drives the dot position. Then subscribes for live updates. (Earlier draft scoped this as "most recent per passenger" only — expanded once breadcrumb trails became part of v0.4.)

**Breadcrumb trails:** every passenger's full path through the session is rendered as a permanent polyline behind their dot. Doesn't fade — the whole tour history stays on screen. Each passenger gets a stable color derived deterministically from their `passenger_id` (so refreshes / different guide devices show the same color). Palette is curated to avoid utility colors (state green/orange/red/grey, guide blue). Single SVG `<polyline>` per passenger keeps render cost bounded even at thousand-point trails.

**Dot color states (locked):**
- **Green** — fresh, last update <30s ago
- **Dimmed green** — 30–120s ago, brief gap
- **Orange** — has connection (still receiving updates), but **hasn't moved meaningfully in 15+ minutes**. Stuck somewhere — café, viewpoint, lost?
- **Grey** — disconnected, no recent updates (regardless of movement)
- **Red** — guide-flagged via long-press → "mark for follow-up" (the actual passenger-triggered "I need help" button is deferred — see Deferred Features section)

Hierarchy when multiple states could apply: red > grey > orange > dimmed green > green. Red is always shown; otherwise newer info wins.

**Guide visibility to passengers:** the guide also broadcasts location through the same v0.3 pipeline, but gated by a "Visible to passengers" toggle in the guide UI. Default OFF (privacy). When ON, passengers see a single guide dot (visually distinct from passenger dots) showing where the guide is. Useful for "follow me back" or "I'm at the cafe."

**Passenger names (locked):** passengers type a name on first join, stored in localStorage so they never re-type. Stored in a new `session_passengers` table, one row per (session, passenger). Guide view shows name labels next to dots and as the primary list view identifier.

**Guide UI layout (locked):** map on top, hideable bottom sheet with passenger list below. Drag handle always visible. List shows name + dot color + "last seen Xm ago" + tap-to-pan-map. Standard Google Maps / Uber pattern — familiar to phone users.

**Auth (locked: option C — invite codes):**
- Custom auth, NOT Supabase Auth. Their built-in is built around email/phone; we'd be fighting it.
- New `guides` and `invite_codes` tables.
- Beta flow: Filip generates an invite code via SQL (e.g. `iceland-2026-filip`), sends it to the guide via WhatsApp/email manually. Guide pastes once, redeems, gets a device token in localStorage. Persists across visits.
- Each invite code redeems exactly once. Multiple devices = multiple codes per guide.
- Revocation: delete the code's row → token stops being accepted on next request.

**`?role=guide` requires auth.** Passenger join (`?session=xxx` without role) stays open. Anonymous session creation (v0.3 behavior) is removed.

**Guide home (logged-in, no session):** v0.4 is minimal — first thing they see is the create-session form. Past sessions list / tour management area comes in v0.6.

### New schema for v0.4

```sql
-- Guides: one row per beta-onboarded guide
create table guides (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  device_token  text unique,           -- nanoid, persists in client localStorage
  created_at    timestamptz default now()
);

-- Invite codes: short, readable strings Filip generates and shares manually
create table invite_codes (
  code          text primary key,      -- e.g. "iceland-2026-filip"
  note          text,                  -- Filip's notes about who this code is for
  redeemed_by   uuid references guides(id),
  redeemed_at   timestamptz
);

-- Sessions get an owner now
alter table sessions
  add column owner_guide_id uuid references guides(id);

-- Optional: guide visibility flag, set when "Visible to passengers" toggle is on.
-- Could also live on passenger_locations as a boolean per-row, but simpler here.
alter table sessions
  add column guide_visible boolean default false;

-- New: per-passenger metadata for a session
create table session_passengers (
  session_id    text not null references sessions(id),
  passenger_id  text not null,
  name          text not null,
  joined_at     timestamptz default now(),
  primary key (session_id, passenger_id)
);
```

### RLS policy changes (replacing v0.3's permissive policies)

- `sessions`: read = anyone with id; insert = authenticated guide; update/delete = owning guide only
- `passenger_locations`: insert = anyone with valid session id (passengers); read = owning guide of session OR the passenger themselves
- `session_passengers`: insert = anyone with valid session id; read = owning guide of session OR the passenger themselves
- `guides` and `invite_codes`: write = service-role only (i.e. via SQL editor); read of own row = authenticated guide

Drafting these properly is real work. Custom auth means we can't just use `auth.uid()` everywhere — we have to validate the device token via a custom Postgres function or similar. **This is the hardest part of v0.4.**

### What v0.4 explicitly does NOT include

- Real broadcast messages (guide → passenger text) — that's v0.5
- Passenger-triggered "I need help" button — deferred (see Deferred Features)
- Auto-flagged "lost" state with notifications — deferred
- Past-sessions list / replay UI — v0.6
- Heatmap / dwell-time analytics — post-v0
- Sound alerts on the guide side
- Authoring (still v0.6)
- Two-way chat
- Per-passenger DMs

### Risks

- **First time we deal with realtime subscriptions** — connection lifecycle, reconnection, message ordering, all new mental models.
- **Custom auth is more work than expected.** Device token validation in RLS is fiddly. Likely the slowest part.
- **Guide UI design.** Bottom-sheet + map layout is well-trodden but easy to get wrong on first try. Lots of tiny details (drag affordances, list-tap-vs-map-tap, edge cases when list is huge).
- **Stale-state computation.** "Hasn't moved in 15+ min with connection" requires sliding-window analysis on the location stream. Cheaper than it sounds (just check the last N rows for displacement) but easy to get wrong.

---

## v0.4.5 design (decided 29 Apr 2026) — visual polish pass

**Milestone goal:** make what already exists in v0.4 look and feel better, before adding more features. No new functionality, no new schema, no new tables. A deliberate pause to clean up what shipped fast.

**Why this comes between v0.4 and v0.5:** v0.4 was built feature-by-feature with real-device testing exposing rough edges along the way (the empty-share-screen bug, label sizes, banner copy iterations, bus-pin UX rounds, etc.). Polish work is hard to do alongside feature work — it gets compromised every time something else needs shipping. Carving out a dedicated milestone for it means the visual quality bar gets to be raised properly without anything competing for attention.

**Areas likely to be touched** (specifics defined as we go, this list is illustrative):

- **Typography rhythm.** Fraunces italic + JetBrains Mono is the locked pair, but spacing, weight, and size choices were ad-hoc. Pass through and tighten.
- **Animation and transitions.** Bottom sheet drag, screen open/close, name gate entrance, broadcasting banner appearance, halo pulse rhythm. Most are abrupt right now.
- **Empty states and loading states.** "No passengers yet" works but is bland. Loading screens are mostly utilitarian. The cream paper aesthetic earns more thoughtful treatment here.
- **Error and edge-case states.** Bad invite code, expired session, GPS denied, network offline — present but visually generic.
- **The bottom sheet at all three snap states.** Half is the most-used; full and collapsed need design love.
- **Map dot rendering refinements.** Halo brightness, ring weights, label positioning at extreme zoom levels.
- **Color palette tuning.** The 12-color passenger palette works; some pairs read better than others, would be worth auditing.
- **Iconography pass.** Some icons (back arrow, burger, etc.) work, some are placeholder-ish.

**Process for v0.4.5:**

- No schema changes, no new tables, no new realtime channels.
- Each polish change ships individually, build version bumps, real-device test.
- Document the locked aesthetic decisions in this section as they get made — so future Filip and future AI assistant don't undo them.

**What v0.4.5 does NOT include:**

- New features (those are v0.5)
- Performance optimization (separate concern, no current pain)
- Accessibility audit (deferred — important but its own milestone)
- Browser/device compatibility hardening beyond what already works

---

## v0.5 design (decided 29 Apr 2026)

**Milestone goal:** small structured signals between guide and passengers, plus an external chat hand-off. v0.5 deliberately does NOT build an in-app chat — that's a fight Fieldnote can't win and shouldn't try (see the Skipped-features section). What it does build:

### 1. Broadcast messages (guide → all passengers)

Guide types a short message in the bottom sheet, all passengers in the session see it appear at the top of their map. Use cases: "Bus leaves in 5 minutes," "Storm coming, head back," "Photo opportunity at the next stop."

- New table `broadcast_messages (id, session_id, body, sent_at)`. Realtime subscription on the passenger side filtered by `session_id`.
- Messages are ephemeral in display: appear, stay 60s, auto-fade. Persist in DB for replay/debug, not displayed in feed-form.
- Guide sees a small history pane in the bottom sheet so they remember what they've sent.

### 2. Passenger alerts (passenger → guide only)

A small set of pre-canned structured alerts a passenger can send. Reaches the guide only (not other passengers). Guide gets a notification on their map with the passenger's name attached.

Initial alert set (start small, expand only with real-tour feedback):
- "I need help"
- "Running late, wait for me"
- "Found you" (acknowledgment when guide previously sent a "where are you")

Each alert is a single tap. Guide's bottom-sheet passenger row gets a colored badge until the guide explicitly acknowledges it.

- New table `passenger_alerts (id, session_id, passenger_id, kind, sent_at, acknowledged_at)`.
- Realtime subscription on guide side. Sound + visual indicator on new alert.
- **Spam protection** is necessary even at v0.5 — limit one alert per passenger per kind per minute, server-side. Kids will press buttons.

### 3. WhatsApp group chat link (external chat hand-off)

Guides almost universally already use WhatsApp groups for tours. Fieldnote integrates with that, doesn't replace it.

- New column `tours.chat_link text` — guide creates a WhatsApp group on their phone, copies the invite link, pastes it once per tour (not per session — link is sticky across all sessions of that tour).
- Passengers see a "Join group chat" button in their bottom sheet (or burger menu) that opens the link. Mobile browsers open WhatsApp directly.
- WhatsApp's API does NOT support programmatic group creation for our use case — guide-created-and-pasted is the only realistic path.

### What v0.5 explicitly does NOT include
- In-app chat (skipped, see Skipped-features section)
- Photo / video sharing (skipped)
- Per-passenger DMs from guide (would invert the safety-layer principle — guide shouldn't be in 1:1 conversations while leading)
- Push notifications when app is closed (needs PWA + service worker; lands in v0.5.5 or v1)

---

## v0.6 design (decided 29 Apr 2026) — zones, transit, authoring

**The big shift:** the tour data model changes meaningfully. v0.5 still uses v0.4's "tour = flat list of pins." v0.6 introduces **zones**, which is the right model for what real tours actually do.

### Why zones (the real-tour reason)

Real tours are 10-12 hours of: pickup → drive → attraction A → drive → attraction B → drive → attraction C → … → dropoff. Three hard problems with the v0.4 flat-pins model:

1. **Same tour runs differently on different days.** Today's tour might do A → B → D, tomorrow's might do A → C → D depending on weather, traffic, group preference. Defining the *route* is wrong; defining the *zones* is right.
2. **Different guides do the same stop differently.** The zone defines "we're at Geysir," not the guide's storytelling. Same zone, infinite delivery variations.
3. **The "we're on the bus between stops" question.** When the guide is in no zone, what does the passenger see? With zones we can answer this cleanly: a transit view.

### The model: library-wide zones

Zones live in a library, not per-tour. Each zone is a reusable unit:

```sql
create table zones (
  id            text primary key,            -- e.g. 'geysir'
  name          text not null,
  center_lng    float8 not null,
  center_lat    float8 not null,
  radius_m      int default 200,             -- circle for v0.6, polygon later
  pins          jsonb,                       -- pin set scoped to this zone
  description   text,                        -- optional: what's at this zone
  created_at    timestamptz default now()
);

-- A tour declares which zones it CAN visit. Order is a default suggestion;
-- actual order in a session can vary.
create table tour_zones (
  tour_id       uuid references tours(id),
  zone_id       text references zones(id),
  display_order int,
  primary key (tour_id, zone_id)
);

-- Sessions track which zone is currently active. NULL = transit / between stops.
alter table sessions add column active_zone_id text references zones(id);
```

The Geysir zone is one row. "South Coast Tour" includes Geysir. "Golden Circle Tour" also includes Geysir. Same zone row, two tours that both can visit it. Future tour we haven't built yet can also include Geysir without recreating it.

### Migration path for existing tours

v0.4's `tours.pins` jsonb stays. Tours can OPTIONALLY have zones. If a tour has no `tour_zones` rows, sessions of that tour use the legacy flat-pins model (same as v0.4). If a tour has zones, sessions use the zone model. No forced migration — old tours keep working.

### Zone activation: manual first, semi-auto later

**v0.6 (manual switching):**
- Guide picks the active zone from a list/dropdown in the bottom sheet.
- Updates `sessions.active_zone_id`.
- Passenger view subscribes to session changes; when active_zone_id changes, fetches the zone's pins and re-renders the map.
- Switching to NULL = transit view.

**v0.7+ (semi-auto suggestions):**
- Guide GPS detects they're inside (or near) a zone's radius.
- Prompts the guide: "Start *Geysir*?" with Yes / Not now buttons.
- Guide taps Yes → activates the zone.
- Guide taps Not now → no activation, prompt doesn't re-fire for this zone for the next N minutes (so we don't nag).

The semi-auto layer is purely a *write* to the same `active_zone_id`. It doesn't change the data model or passenger view — only changes who's making the decision (algorithm vs guide). Build manual first, real-tour test, then add detection on top.

**Why not full auto:** we sometimes drive through a zone without stopping (passing by Þingvellir on the way to Geysir). Full auto would activate every drive-through. The prompt model lets the guide say "no, just passing through" without losing the convenience of suggestion.

### Transit view (when active_zone_id is NULL)

Passenger sees a deliberately quiet view between zones:

- Map zoomed out to show the bus location (if the guide is sharing it) and the next planned zone (if known)
- A small "On the road again" animation — cute, not noisy. Maybe a subtle pulsing route line.
- No pins (since we're not at a stop)
- The expected travel time / next zone name as a small caption, if available

The animation is a small joy moment — passengers spend a lot of time on the bus, and a sleepy "we're moving" indicator beats a blank map.

### In-app authoring (the original v0.6 scope)

Authoring extends to zones, not just tours:
- Guides can create new zones on the map (set name, drop center pin, draw radius)
- Add pins inside the zone
- Add the zone to one or more tours
- Edit zone metadata across all tours that include it (so updating "Geysir parking moved to the south side" propagates to every tour)

### What v0.6 explicitly does NOT include
- Polygon zones (circles only — simpler math, good enough for parking-area definition)
- Auto-zone-detection (deferred to v0.7+)
- Cross-zone navigation hints ("Geysir → Gullfoss is 12 minutes")
- Public zone library (every guide's zones are private to them for now)
- Zone history / replay
- Stop-level timing / "leave by X" countdowns

---

## Tooling decisions

- **Backend:** Supabase, Frankfurt region ✅ in use
- **Hosting:** Cloudflare Pages ✅ in use
- **AI coding tool:** Claude (chat + Cowork). *Original briefing said Lovable until v0.3 — that didn't happen, switched directly to Claude.*
- **Map tiles:** Mapbox ✅ in use, free tier holding fine
- **No backend infrastructure to manage** — Cloudflare static + Supabase managed = zero servers

---

## Key decisions (preserved from product thinking)

### Product

- Mobile-first; desktop is a prototype frame only
- Navigation-first over commentary; audio is chime SFX, not narration
- **Hybrid authoring** — desk design + walk-and-record. Walk-and-record is the distinctive feature, but both modes ship eventually.
- Pins live at lat/lng permanently
- Passenger experience: zero install, no account. QR/link → location permission → in the lobby in under 10 seconds
- Guide is the star; product is a tool, not a substitute
- Combines Locatify's content-at-pin model with Vox's live-lobby model. The combination is the differentiator.
- **Generic data model** — roles are `leader` / `member` / `operator`, not `guide` / `passenger`. Free decision now, expensive later. *(Note: not yet enforced in code — v0.2 has no role concept yet. Comes in v0.4.)*
- Three-tier user model long-term: passenger client / guide admin / operator dashboard. v0 only needs the first two; operator dashboard architected for, exposed in v2/v3.

### Architecture (long-term, not all in v0)

- **Offline-first PWA** is the eventual architecture, not optional. Driven by Icelandic reality (passengers without data plans outside bus WiFi).
- Service Worker, IndexedDB, Mapbox offline tile caching, message queue, sync conflict handling — all later, not in v0.
- Asymmetric connectivity model: guide assumed online, passengers assumed intermittent.
- This is a real moat — competitors (Vox, Locatify, audio-tour apps) are online-first.

### Three-layer tour model (long-term, not v0)

For v0: a tour is just a tour.

For v1+: separate **tour template** (org-owned, reusable IP), **tour plan** (guide's daily variant), and **session** (what actually happened — captures plan vs. reality divergence). Supports skip-a-stop, add-live-stop, reorder mid-tour without corrupting the template.

### Market & GTM (long-term)

- Target user: independent guides + small operators. Not enterprise tour companies.
- Distribution wedge: self-serve credit-card signup. Incumbents (Vox, mTrip) require sales calls.
- Verification via GetYourGuide / TripAdvisor partner status, employer vouching, or manual review for first 100 guides.
- Pricing: 15 free tours, then subscription. Trial counter starts on first real-use tour with at least one passenger in lobby. Guide pays; passenger never does.
- Pricing anchor: less than the tip from one tour pays for the year. Frame as "less than a tip," not "SaaS subscription."
- B2B operator tier (multi-guide companies) is the upgrade path — better LTV than individual guides.

---

## Lessons learned in v0.1 / v0.2

Things that took longer than expected and shouldn't again:

- **SVG overlay sync with Mapbox projection.** Got bitten by an `opacity:0` popup creating an invisible-but-painted rectangle that occluded the overlay. Lesson: use `visibility: hidden` for hidden-but-positioned elements.
- **Token / API key handling.** Briefly went down a path of "hide the token" before remembering that public tokens with URL restrictions are *meant* to be in client code. Spent time on theatre instead of the actual security mechanism (URL allowlist on the Mapbox token; RLS on Supabase).
- **Variable shadowing on UMD global.** Naming a `const supabase` collided with the CDN-injected `window.supabase`. Now using `supabaseClient` to avoid the clash.
- **Local dev without GPS is a dead end** for a GPS app. Cloudflare Pages → real phone is the actual dev loop.
- **Chrome DevTools Sensors panel** is the right way to fake GPS for desktop testing. Free, built in, doesn't touch code.

---

## Competitive landscape (researched, preserved)

### Direct competitor

- **Vox Connect** — closest match (live lobby, web-link join, broadcast messaging, multi-language). Enterprise sales motion, hardware-tied origins, poor UX, invisible to independent guides. Their structural mis-aim at our niche IS our wedge.

### Adjacent enterprise

- **mTrip** — white-label for tour agencies, GDS integrations. Different market.

### Wrong-paradigm competitors (self-guided, no live guide)

- Locatify, VoiceMap, GPSmyCity, PocketSights, SmartGuide — all audio-tour-first. Different product thesis. Not real competition for this use case.

### Why we haven't been crushed yet

Vox sells to your employers, not to you. Their go-to-market doesn't bend to credit-card-and-go. Realistic threat: Vox launches a self-serve tier in 2–3 years. By then, if we're loved by working guides, we have a brand and community they can't buy.

---

## Addressable adjacencies (long-term, not v0)

In rough order of fit, all sharing the core mechanic of *leader coordinating dispersed group in real space*:

1. School field trips (closest mechanic, hardest procurement)
2. Wedding day logistics (good fit, bad LTV — one-shot users)
3. Corporate offsites & team-building
4. Running / cycling / hiking clubs
5. Scout / youth / church groups
6. Festivals, protests, organized walks
7. Tour operator tier (multi-guide companies — B2B upgrade path)

**Stance:** narrow positioning publicly (tour guides only), broad architecture privately, sequential expansion. First likely expansion candidate is school field trips.

---

## Naming status

Working codename **Fieldnote** is not the final name. SEO and trademark research killed it (notebook brand, multiple existing apps).

**Names explored and ruled out:** Cairn, Varða, Leida, Leitha, Leidu, Styra/Stýri, LedMe, Herd, Herder, Guido, Guida.

**Decided criteria:** short & punchy, Icelandic/Nordic flavor, confident & commanding tone for the leader audience.

**Worth reconsidering in a fresh session:** Stika (Icelandic trail-marker stake — closest to original cairn metaphor), Jarl (Old Norse chieftain), Viti (lighthouse/beacon), and a wider longlist generated cold.

**Process commitment:** no domain purchase, logo work, or public commitment to any name until a dedicated naming session produces a winner that survives full domain + trademark + app-store screening.

---

## Out of scope for v0

Will come back to these after v0.5 ships and is tested:

- Multi-tour management UI (some basic version sneaks into v0.5)
- Photos and media attachments
- Payments, subscriptions, paywall
- Verification (GetYourGuide / TripAdvisor integration)
- Offline-first hardening (Service Worker, message queues, conflict resolution)
- Operator dashboard
- Multi-language pin variants
- Native iOS / Android apps
- AI features (translation, summarization, route optimization)
- Marketing site / landing page
- Three-layer tour model (template / plan / session)
- Branding, custom domains, polish

---

## Deferred features (decided during planning, slotted post-v0.6)

Specific feature ideas that came up during milestone design and were intentionally pushed to post-v0 polish or a later version. Captured here so they're not lost.

### Passenger "I need help" button — moved into v0.5 scope

**Status:** previously deferred, now part of v0.5 (decided 29 Apr 2026). See "v0.5 design" → "Passenger alerts" section above. Initial alert set is small ("I need help," "Running late," "Found you") and structured rather than free text. Spam protection (one alert per kind per minute) is part of the v0.5 build.

The visual-language question (red dot state vs persistent banner) is now resolved: alerts get a colored badge on the bottom-sheet passenger row + a sound, separate from the dot-state colors which remain reserved for connection state.

### Lost (auto-flagged) state

**What:** an automatic alert when a passenger meets some combination of conditions — no updates for X minutes + last-known position far from the group + bus is supposed to leave soon.

**Why deferred:** triggers and thresholds need real-tour data to design well. Setting them now is guessing. The current grey ("disconnected") and orange ("stationary 15+ min with connection") states cover the *visible* part of the problem. The *alerting* part (push notifications, bus-leaving countdowns) is a v1 product layer.

### Multiple sessions per guide (two interpretations, two phases)

**The product use case:** a guide runs different tours simultaneously or across time. Example: 8 passengers in the bus, 4 want the foodie tour and 4 want the architecture tour — they each get their own session/link with the right tour.

This breaks into two distinct features that should land in separate phases:

**Phase 1 — Sessions list (slated for v0.6):** the guide can have many sessions over time. A "my sessions" home screen shows all sessions they've ever started (active and past); tapping one enters its guide view. Only one session is "actively monitored" at a time per device. Schema-wise this works today — sessions are already independent rows in the `sessions` table, owned by `owner_guide_id`. The work is purely UI: a list page, sort by recency, "create new session" button, tap to enter. Slots cleanly into v0.6 alongside authoring and tour management because both are guide-side meta-UI.

**Phase 2 — Concurrent multi-session monitoring (post-v0.6, pre-v1):** a guide watches several active sessions *simultaneously*. Real product complexity — the guide's UI needs to either show multiple maps, aggregate passengers from N sessions onto one map (with session-color indicators), or provide a fast switcher. Plus alerting: a help-flag in session B should still reach the guide while they're looking at session A. This is its own UX problem and deserves dedicated focus after one real-tour test informs what guides actually need.

**Why this sequencing:** designing concurrent multi-session monitoring before any real tours have been run is guessing about a use case that may not look the way we imagine. Phase 1 is small and safe; phase 2 benefits enormously from real-tour feedback first.

### Multi-stop tour structure — designed as zones, lands in v0.6

**Status:** moved from deferred to v0.6 design (decided 29 Apr 2026). See "v0.6 design — zones, transit, authoring" section above. The architecture answer is library-wide reusable zones with a session-level `active_zone_id` pointer, not nested stops inside tours. Manual zone activation in v0.6, semi-auto (GPS-suggests-guide-confirms) in v0.7+.

### Stationary-passenger detection (true v1, not v0.x)

**What:** flag a passenger orange when they haven't moved in 15+ minutes despite still being connected. Useful for "X is sitting at the cafe and we're about to leave."

**Why deferred to v1:** doesn't work in a web prototype. Phone screens lock during tours, which throttles or kills JavaScript timers and `watchPosition`. From the data side, "screen locked" looks identical to "stationary" — we'd flag every passenger constantly and the signal would lose all meaning. This needs proper background-GPS support, which only a native app (v1) can provide. v0.4 chunk E ships **disconnected-only** — disconnected fires for the same screen-off reason but is honestly named: the guide just needs to know contact is lost, not the cause.

---

## Explicitly skipped (not deferred — not building, period)

These are things that *seem* like they belong in Fieldnote but on examination shouldn't. Captured here so the reasoning doesn't get re-litigated every two weeks.

### Native in-app chat (passenger-passenger or guide-passenger)

**Why not:** three reasons compounding.

1. **Cognitive load.** A core design principle of Fieldnote is that the guide shouldn't have to monitor a chat stream while leading a tour. Adding chat inverts that — every passenger message becomes something the guide feels pressure to read while walking, talking, navigating, counting heads.
2. **Existing alternatives win.** Tour groups already use WhatsApp, Signal, or Telegram. Those tools are already on people's phones, already familiar, already battle-tested. Fieldnote isn't going to win that fight.
3. **It dilutes what Fieldnote does well.** The live map is the value. Chat would shift Fieldnote from "glance at dots" to "read text," which is the wrong direction.

**What we build instead:**
- **Structured passenger alerts** in v0.5 (see above) — the legitimate "I need to tell my guide something" use case, but as a button-press not free text.
- **External chat hand-off via WhatsApp link** in v0.5 — the legitimate group-chat use case, but as a link to WhatsApp not a built-in chat.

### Native photo / video sharing

**Why not:** different product, larger scope, weaker case.

1. **Existing alternatives are dominant.** WhatsApp groups, iCloud Shared Albums, Google Photos shared albums — all free, all already on people's phones, all far more featureful than anything we'd build in v0.x.
2. **Real implementation is huge.** Gallery UI, permissions model, storage costs, EXIF scrubbing for privacy, video transcoding, bandwidth on bad cellular, moderation (kids' photos, inappropriate content). Two-month feature, not two-week.
3. **No tour-specific advantage.** Unlike the live map (which is fundamentally a tour problem), photo sharing isn't tour-specific. There's no insight or interaction we'd unlock that WhatsApp doesn't already deliver.

**Possible narrow exception (kept on the table, not building yet):** *operational* photos — e.g. a "this is what the bus looks like" photo attached to a meeting-point pin so passengers can find it, or "this is what the entrance looks like" attached to an attraction pin. Guide-uploaded only, no gallery, no passenger uploads. Would land in v0.6 authoring at earliest, and only if real-tour testing shows guides actually want it. Most operational needs are probably solved by good pin descriptions.

---

## Open questions

- Final product name
- Mapbox usage cost as v0 scales to a few real users (free tier holding fine through v0.2 testing — ~50 loads total)
- Where to test v0 with real passengers (Reykjavík neighborhoods? known guide route?)
- Whether to keep the project private or share progress publicly (build-in-public has tradeoffs)
- v0.3 RLS policies for `sessions` and `passenger_locations` need drafting once auth model is decided
- Privacy disclosure copy and "stop sharing" UX before any real-user testing

---

## How to use this briefing

Paste this at the top of new conversations to give context fast. Update it whenever something changes meaningfully — milestone shipped, decision made, direction pivoted. The briefing serves you, not the other way around — trim or restructure as needed.

After v0.5 ships and gets real-tour feedback, this briefing should be substantially rewritten to reflect what was learned, what to keep, and what v1 should be.
