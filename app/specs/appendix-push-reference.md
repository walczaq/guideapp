# Appendix — native push reference implementation

Companion to `native-android-migration.md` (§A2.0) and
`native-ios-migration.md` (§I2). Two things live here because they must be
EXACT: the shared DB migration (a contract both platform sessions depend
on) and the token-crypto for the edge functions (fiddly, easy to burn a
session on). Everything else in the specs is intentionally descriptive —
derive it from the repo.

**Crypto status: the Web Crypto signing flows below (PKCS8 import → RS256
sign; PKCS8 EC P-256 import → ES256 sign) were executed and
sign+verify-round-tripped under Node 22's webcrypto, which is the same API
Deno exposes. Note: Web Crypto's ECDSA output is already the raw 64-byte
`r||s` JWT ES256 format — do NOT add DER conversion.**

---

## 1. Migration `migrations/042_v0.7_native_push_tokens.sql` — exact

```sql
-- ============================================================================
-- Fieldnote v0.7 — native push tokens (Capacitor app: FCM on Android,
-- APNs on iOS). Mirrors push_subscriptions' trust model: anon can WRITE
-- its own token via the RPC, nothing can read them back from the client;
-- only the service-role edge functions read.
-- ============================================================================

create table native_push_tokens (
  id           bigint generated always as identity primary key,
  session_id   text not null references sessions(id) on delete cascade,
  passenger_id text,
  platform     text not null check (platform in ('android', 'ios')),
  token        text not null,
  lang         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (session_id, token)
);

alter table native_push_tokens enable row level security;
-- No policies: client reads/writes go through the RPC below; edge
-- functions use the service role which bypasses RLS.

create or replace function save_native_push_token(
  p_session_id   text,
  p_passenger_id text,
  p_platform     text,
  p_token        text,
  p_lang         text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_platform not in ('android', 'ios') then
    raise exception 'Unknown platform: %', p_platform using errcode = '22023';
  end if;
  if not exists (select 1 from sessions where id = p_session_id) then
    raise exception 'Session not found: %', p_session_id using errcode = 'P0002';
  end if;
  insert into native_push_tokens (session_id, passenger_id, platform, token, lang)
  values (p_session_id, p_passenger_id, p_platform, p_token, p_lang)
  on conflict (session_id, token)
  do update set passenger_id = excluded.passenger_id,
                lang         = excluded.lang,
                updated_at   = now();
end;
$$;

grant execute on function save_native_push_token(text, text, text, text, text)
  to anon, authenticated;
```

## 2. Deno (edge function) — Google OAuth for FCM v1

Secrets: `FIREBASE_SERVICE_ACCOUNT` = the full service-account JSON string.

```ts
// Cache across warm invocations.
let _gToken: { token: string; exp: number } | null = null;

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (obj: unknown) =>
  b64url(new TextEncoder().encode(JSON.stringify(obj)));
const pemToDer = (pem: string) =>
  Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "")),
    (c) => c.charCodeAt(0));

async function googleAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (_gToken && _gToken.exp - 60 > now) return _gToken.token;
  const sa = JSON.parse(Deno.env.get("FIREBASE_SERVICE_ACCOUNT")!);
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const unsigned =
    b64urlJson({ alg: "RS256", typ: "JWT" }) + "." +
    b64urlJson({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now, exp: now + 3600,
    });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key,
    new TextEncoder().encode(unsigned));
  const assertion = unsigned + "." + b64url(sig);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) throw new Error("google token: " + res.status + " " + await res.text());
  const j = await res.json();
  _gToken = { token: j.access_token, exp: now + (j.expires_in ?? 3600) };
  return _gToken.token;
}

// project id comes from the same service-account JSON (sa.project_id)
async function sendFcm(saProjectId: string, token: string,
                       title: string, body: string,
                       data: Record<string, string>): Promise<"ok" | "gone" | "error"> {
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${saProjectId}/messages:send`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + await googleAccessToken(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: {
      token,
      notification: { title, body },
      data,                                   // string values ONLY
      android: { priority: "HIGH" },
    }}),
  });
  if (res.ok) return "ok";
  const txt = await res.text();
  // UNREGISTERED / NOT_FOUND → delete the token row.
  if (res.status === 404 || txt.includes("UNREGISTERED")) return "gone";
  console.warn("[fcm]", res.status, txt);
  return "error";
}
```

## 3. Deno — APNs direct (iOS tokens)

Secrets: `APNS_AUTH_KEY` (the .p8 file's full text), `APNS_KEY_ID`,
`APPLE_TEAM_ID`. Topic is the bundle id. APNs JWTs are valid 20–60 min;
cache and reuse for ~45.

```ts
let _apnsJwt: { jwt: string; iat: number } | null = null;

async function apnsJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (_apnsJwt && now - _apnsJwt.iat < 45 * 60) return _apnsJwt.jwt;
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToDer(Deno.env.get("APNS_AUTH_KEY")!),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const unsigned =
    b64urlJson({ alg: "ES256", kid: Deno.env.get("APNS_KEY_ID")! }) + "." +
    b64urlJson({ iss: Deno.env.get("APPLE_TEAM_ID")!, iat: now });
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" },
    key, new TextEncoder().encode(unsigned));
  // Web Crypto ECDSA output is already raw r||s (64 bytes) — exactly what
  // JWT ES256 wants. No DER conversion.
  _apnsJwt = { jwt: unsigned + "." + b64url(sig), iat: now };
  return _apnsJwt.jwt;
}

const APNS_HOST = "https://api.push.apple.com";   // sandbox: api.sandbox.push.apple.com
// ⚠️ TestFlight + App Store builds use PRODUCTION APNs. Only Xcode
// development builds use the sandbox — with cloud-CI TestFlight builds you
// will likely never need the sandbox host.

async function sendApns(deviceToken: string, title: string, body: string,
                        data: Record<string, string>): Promise<"ok" | "gone" | "error"> {
  const res = await fetch(`${APNS_HOST}/3/device/${deviceToken}`, {
    method: "POST",
    headers: {
      Authorization: "bearer " + await apnsJwt(),
      "apns-topic": "guide.fieldnote.app",
      "apns-push-type": "alert",
      "apns-priority": "10",
    },
    body: JSON.stringify({
      aps: { alert: { title, body }, sound: "default" },
      ...data,                                  // custom keys at top level
    }),
  });
  if (res.ok) return "ok";
  const txt = await res.text();
  // 410 Unregistered / 400 BadDeviceToken → delete the token row.
  if (res.status === 410 || txt.includes("BadDeviceToken")) return "gone";
  console.warn("[apns]", res.status, txt);
  return "error";
}
```

Fan-out shape inside `send_stop_push` / `send_stop_update_push`, after the
existing web-push loop (localize per row's `lang` exactly as web-push does):

```ts
const { data: natives } = await admin.from("native_push_tokens")
  .select("id, platform, token, lang").eq("session_id", sessionId);
for (const t of natives ?? []) {
  const { title, body } = localized(t.lang);   // reuse the web-push copy
  const r = t.platform === "ios"
    ? await sendApns(t.token, title, body, { sessionId, stopId: String(stopId) })
    : await sendFcm(saProjectId, t.token, title, body, { sessionId, stopId: String(stopId) });
  if (r === "gone") await admin.from("native_push_tokens").delete().eq("id", t.id);
}
```

## 4. `v0.5.html` bridge — shape only (match surrounding conventions)

```js
// Native (Capacitor) push registration — replaces the web-push path when
// running inside the app. Wire into renderIntroSetup() + the
// intro-enable-notify click handler + the menu notifications item, branching
// BEFORE pushSupported() (web-push APIs don't exist in the WebViews).
async function nativePushRegister() {
  const P = window.Capacitor && window.Capacitor.Plugins
    && window.Capacitor.Plugins.PushNotifications;
  if (!P || !SESSION) return { error: 'Not available.' };
  const perm = await P.requestPermissions();
  if (perm.receive !== 'granted') return { error: t('intro_st_ntf_blocked_native') };
  return new Promise((resolve) => {
    P.addListener('registration', async ({ value: token }) => {
      const { error } = await supabaseClient.rpc('save_native_push_token', {
        p_session_id: SESSION.id,
        p_passenger_id: (typeof PASSENGER_ID !== 'undefined') ? PASSENGER_ID : null,
        p_platform: window.Capacitor.getPlatform(),   // 'android' | 'ios'
        p_token: token,
        p_lang: (typeof LANG !== 'undefined') ? LANG : null,
      });
      resolve(error ? { error: error.message } : { ok: true });
    });
    P.addListener('registrationError', (e) =>
      resolve({ error: (e && e.error) || 'Registration failed.' }));
    P.register();
  });
}
// Also: 'pushNotificationReceived' → intentionally NO-OP (realtime already
// shows in-app banners); 'pushNotificationActionPerformed' → if
// data.sessionId !== SESSION.id, location.href = '/v0.5?session=' + it.
```

Register the listeners once (idempotent flag), same pattern as
`wireStopModalHandlers`.
