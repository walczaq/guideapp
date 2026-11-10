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

## Pilot facts (Nov 2026)

- The bus GPS system has an API (confirmed by Gísli); its name and access
  details are still to come.
- The company has no SMS service. Pickup texts must go out **automatically**
  (an automated system, not the driver/guide tapping per passenger), sent
  through the company phone Filip carries — an Android — via the "SMS Gateway
  for Android" app and `send_pickup_sms`. Tap-to-send is only the fallback.
- Passenger phone lists reach Filip by email; he pastes them into the app.
- Volume: at most 38 pickup texts a day — 19 passengers maximum, doubled
  as a safety margin.
