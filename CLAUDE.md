# Fieldnote — notes for Claude

## People and access

- The repo owner (Filip) builds and guides with Fieldnote but has **no access to
  the operations/office side** of the tour company: the fleet GPS platform, the
  booking system, company accounts and billing (e.g. an SMS provider account).
- **Gísli** is the person the bosses designated to work with Filip on piloting.
  Anything that needs office/operations access — fleet tracker API details or
  keys, vehicle/tracker IDs, passenger phone lists from bookings, paid accounts —
  goes through Gísli. Don't ask Filip to fetch these himself; phrase them as
  questions or requests he can pass on to Gísli.
- **Maggi** decides policy questions Gísli can't — e.g. whether the company
  may text passengers at the numbers from their bookings.

## Company level (migration 051)

- Fieldnote has a company level above individual guides: shared bus list,
  per-company text + bus-GPS settings, tours shared with the company, and a
  live overview for admins. Screen: menu / My sessions → Company.
- Admins add each guide by their Fieldnote name (no join code); there can be
  several admins. Only admins edit buses and settings; members pick a bus.
- A guide in no company keeps personal buses and the server-wide settings.
- Once a company exists, its buses only move with the **company's** GPS key
  (shown on the Company screen), not the server-wide `BUS_GPS_KEY`.

## Pilot facts (Nov 2026)

- The bus GPS system has an API (confirmed by Gísli); its name and access
  details are still to come.
- The company has no SMS service. Pickup texts must go out **automatically**
  (an automated system, not the driver/guide tapping per passenger), sent
  through the company phone Filip carries — an Android — via the "SMS Gateway
  for Android" app and `send_pickup_sms`. Tap-to-send is only the fallback.
- Passenger phone lists reach Filip by email; he pastes them into the app.
- Volume: at most 38 pickup texts a day **per driver** — 19 passengers
  maximum, doubled as a safety margin. The pilot is one driver. If it works,
  rollout is 7–20 tours a day (roughly 270–760 texts a day), so anything
  built for the pilot should not assume a single phone or a single guide.
