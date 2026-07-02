# Fieldnote native app — one-time setup (no Mac required)

The native shell lives in `app/` (Capacitor). It loads the LIVE web app from
https://fieldnote.guide/v0.5, so every web deploy updates the native app
instantly — store releases are only needed when the native shell itself
changes. Cloud builds run on Codemagic (`codemagic.yaml` at the repo root).

## 0. Test on Android TODAY (free, no accounts)

1. Sign up at https://codemagic.io with the GitHub account and add this repo.
2. Run the **android-debug** workflow → download `app-debug.apk`.
3. On the phone: allow "install unknown apps" for your browser, open the APK.
   The app opens fieldnote.guide/v0.5 inside the native shell.

(Alternative without Codemagic: install Android Studio on Windows, open
`app/android`, press Run.)

## 1. Apple Developer Program ($99/yr) — for iOS

1. Enroll at https://developer.apple.com/programs/enroll/ (takes ~1–2 days).
2. In App Store Connect (https://appstoreconnect.apple.com):
   - Users and Access → Integrations → App Store Connect API → create a key
     with **App Manager** role. Download the .p8 file, note Key ID + Issuer ID.
   - Apps → "+" → New App: platform iOS, name **Fieldnote**, bundle ID
     **guide.fieldnote.app** (register the bundle ID when prompted).
3. In Codemagic: Teams → Integrations → App Store Connect → add the .p8 key
   as **fieldnote-asc-key** (the name `codemagic.yaml` expects).
4. Run the **ios-testflight** workflow. Codemagic creates signing certs and
   profiles automatically via the API key. Build lands in TestFlight;
   invite guide testers by email from App Store Connect → TestFlight.

## 2. Google Play ($25 once) — for Android store release

1. https://play.google.com/console → register, pay $25.
2. Create app "Fieldnote", package `guide.fieldnote.app`.
3. Release signing: let Play manage the signing key (recommended). A release
   workflow (assembleRelease + upload keystore) gets added when we're ready
   to publish — the debug workflow is enough for trial testing.

## 3. Deep links (QR codes open the app directly)

Once real identifiers exist, fill in and deploy the two templates in this
folder to the site's `/.well-known/` directory:

- `apple-app-site-association.template` → needs your **Team ID**
  (developer.apple.com → Membership). Deploy as
  `/.well-known/apple-app-site-association` (no file extension,
  Content-Type application/json).
- `assetlinks.json.template` → needs the **SHA-256 cert fingerprint** (from
  Play Console → App integrity → App signing, once Play signing is set up).
  Deploy as `/.well-known/assetlinks.json`.

Then a passenger who has the app and scans the bus QR
(fieldnote.guide/j/SESSION) lands inside the app, in the session,
with zero taps.

## 4. Native push (next work block — needs the accounts above)

Web push doesn't work inside the native WebViews, so the native app needs
APNs (iOS) + FCM (Android) delivery:
- Firebase project (free) → FCM for Android; APNs auth key (.p8 from the
  Apple developer account) uploaded to Firebase for iOS.
- App-side: @capacitor/push-notifications (already a dependency) registers
  and yields a device token; the web code detects the native bridge and
  saves that token instead of a web-push subscription.
- Server-side: a new column/table for native tokens + the send_stop_push
  edge function fans out via FCM's HTTP v1 API alongside web-push.

Ping Claude when the Apple + Firebase accounts exist and this block gets
built end-to-end.
