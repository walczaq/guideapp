# Project Briefing — Fieldnote v0

**Working codename:** Fieldnote *(final name TBD — dedicated naming session pending)*

**Last updated:** 27 April 2026

---

## Honest project state

- **v0.1 and v0.2 shipped.** Real GPS app deployed to Cloudflare Pages, real Mapbox tiles, tour data fetched live from Supabase. Tested on phone in the wild — pin-radius triggers fire correctly, chime plays, popup shows.
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
| GUI-26 | v0.4 — Live guide view (consumes v0.3's data pipeline) | Designed 27 Apr 2026, not built — see "v0.4 design" below |
| GUI-27 | v0.5 — Broadcast messages from guide to passengers | |
| GUI-29 | v0.5.5 — Offline app shell (Service Worker + PWA manifest) | |
| GUI-28 | v0.6 — In-app tour authoring | |

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

### Passenger "I need help" button

**What:** a button in the passenger UI that flips their dot red on the guide's overview map.

**Why deferred:** v0.4 introduces the dot color states (green / dimmed green / orange / grey) where red represents "call for help." Red is a real state in the visual language, but without a trigger it's a placeholder. The button would make red real.

**Why not now:** the help-button UX has details that matter — confirmation flow, cancel/undo, what the button text says, whether the guide gets a separate notification beyond a color change, what happens if the passenger just keeps walking after pressing it. These deserve dedicated design attention rather than being tacked onto v0.4.

**For v0.4:** red exists as a dot state but no in-app way to enter it. The guide can manually flag a passenger as needing help (long-press a dot → "mark for follow-up"), which is the minimal interaction to validate the visual language.

**For post-v0.6:** real help button on the passenger side, with a notification path on the guide's side (sound + persistent banner, not just a color change). Probably deserves its own milestone or sits inside a "safety layer polish" milestone.

### Lost (auto-flagged) state

**What:** an automatic alert when a passenger meets some combination of conditions — no updates for X minutes + last-known position far from the group + bus is supposed to leave soon.

**Why deferred:** triggers and thresholds need real-tour data to design well. Setting them now is guessing. The current grey ("disconnected") and orange ("stationary 15+ min with connection") states cover the *visible* part of the problem. The *alerting* part (push notifications, bus-leaving countdowns) is a v1 product layer.

### Multiple sessions per guide (two interpretations, two phases)

**The product use case:** a guide runs different tours simultaneously or across time. Example: 8 passengers in the bus, 4 want the foodie tour and 4 want the architecture tour — they each get their own session/link with the right tour.

This breaks into two distinct features that should land in separate phases:

**Phase 1 — Sessions list (slated for v0.6):** the guide can have many sessions over time. A "my sessions" home screen shows all sessions they've ever started (active and past); tapping one enters its guide view. Only one session is "actively monitored" at a time per device. Schema-wise this works today — sessions are already independent rows in the `sessions` table, owned by `owner_guide_id`. The work is purely UI: a list page, sort by recency, "create new session" button, tap to enter. Slots cleanly into v0.6 alongside authoring and tour management because both are guide-side meta-UI.

**Phase 2 — Concurrent multi-session monitoring (post-v0.6, pre-v1):** a guide watches several active sessions *simultaneously*. Real product complexity — the guide's UI needs to either show multiple maps, aggregate passengers from N sessions onto one map (with session-color indicators), or provide a fast switcher. Plus alerting: a help-flag in session B should still reach the guide while they're looking at session A. This is its own UX problem and deserves dedicated focus after one real-tour test informs what guides actually need.

**Why this sequencing:** designing concurrent multi-session monitoring before any real tours have been run is guessing about a use case that may not look the way we imagine. Phase 1 is small and safe; phase 2 benefits enormously from real-tour feedback first.

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
