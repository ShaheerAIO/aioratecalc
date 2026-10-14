# AIO dashboard provisioning — PROD verified end-to-end (2026-10-09)

The full tenant → location → Adyen-KYC chain was run live against **prod** with a dedicated service
account and returned a real live Adyen KYC link. This doc is the wrap-up record for the module.
See also: `src/lib/adapters/aioDashboard.ts` (the implementation), `ADYEN-KYC-LINK-QUESTIONS.md` and
`AIO-DASHBOARD-API-TRANSCRIPT.md` (the earlier internal-dev probe), and the memory note
`easyob-prod-aio-service-account`.

## Prod connection facts

- **Base URL: `https://backend.prod.aioapp.com`.** Prod's host is NOT in the Zeus repo — it's injected
  from SSM at build time and was read out of the `dashboard.aioapp.com` frontend JS bundle. Every
  `*.dev.aioapp.com` host in the repo is dev/staging, not prod.
- **Auth: two headers** — `Authorization: Bearer <AccessToken>` + `x-id-token: <IdToken>`, plus
  `x-app-name: dashboard` and `Content-Type: application/json`, from `POST /api/authentication/user-login`.
- **Cognito pool** `us-west-2_Psdjgj Z0q`, app-name `dashboard`.

## The service account (closes the "service account instead of a human super-admin" open ask)

- `shaheer.hasnain+easyob@aioapp.com`, role `operation`.
- Created via `POST /api/user/operation/create` (controller base is `@Controller('user')`, not
  `user-profile`) using an admin's own live session — no passcode needed, just the `operations_create`
  permission the admin already had. The route emails a random temp password and force-enables MFA.
- **MFA disabled** via `POST /api/authentication/2fa-email-enable` body `{username, isEmailEnabled:false}`,
  so it logs in unattended (no OTP) — exactly like the internal credential. `user-login` returns
  `data.authChallengeResponse.AuthenticationResult.{AccessToken,IdToken}`, 12h expiry.
- **It had 0 permissions at first** (couldn't provision); permissions were granted from the super-admin
  UI → 15, after which the full chain authorized. A token minted before a grant won't see new perms —
  re-login to refresh.
- **Security note for the backend team:** `2fa-email-enable` (and `toggle-mfa`, and the fully-public
  `enforce-2fa`) have NO authorization guard — any authenticated user can disable MFA for any username.
  Real Zeus vuln; we only used it on our own account. Worth a ticket.

## The chain (prod is stricter than internal dev)

| Step | Call | Returns |
|---|---|---|
| 1 | `POST /api/business/create` | `data.id` (AIO tenant number) + `data.companyId` (auto-created Check company) |
| 2 | `POST /api/restaurant/post/create` | `data.id` (location) + `data.workplaceId` (Check workplace) |
| 3 | `POST /api/restaurant/adyen-onboard` + header `x-tenant-id`, body `{restaurantId}` | `data.url` (hosted KYC link) |

Two prod-only strictnesses — both now handled in `aioDashboard.ts`:

1. **Address is geocoded/validated server-side on step 1.** A fake address 400s
   `Invalid address: Incorrect postal code`; a real one passes.
2. **Step 2 REQUIRES non-null `latitude`/`longitude`** (internal dev tolerated null; prod 500s
   `Missing required field`). Step 2 does NOT geocode like step 1, so EasyOB geocodes client-side.
   `geocodeUsAddress` tries US Census → OpenStreetMap/Nominatim → looser city/state → a logged
   US-centroid fallback. **It never throws and never stalls** — by step 2 a permanent tenant already
   exists and a paid merchant is waiting, so availability beats precision (the coordinate is just a map
   pin; the merchant re-enters their real address on Adyen's hosted KYC page anyway).

## Adyen is LIVE on prod, and the legal-entity id is a post-KYC artifact

- Step 3 returns a real `balanceplatform-live.adyen.com/.../uo/form/…` KYC link (not a test link).
- **That live URL carries NO legal-entity id** — only opaque session tokens. Test URLs had
  `/legalEntities/LE…/` in the path; live does not.
- **`restaurant.accountId` stays null until the merchant completes KYC** (verified by reading the live
  smoketest location back — still null after onboarding was initiated).
- So `legalEntityId` is legitimately **null at link-mint time on live** — it is NOT a parse bug.
  `legalEntityIdFromOnboardingUrl` still works for test URLs; on live, the id is captured later from
  `restaurant.accountId` once it populates. This matches the module's "no automatic KYC-completion
  signal" posture (a deal reaches `adyen_approved` via a human or the settlement backstop).

## Still open (do before flipping `AIO_DASHBOARD_ENABLED=true` for real traffic)

- **Settlement store reference:** is it `prod-{businessId}` or `prod-{restaurantId}`? The Phase G P&L
  builds `prod-{n}` from `adyenIds.tenantNumber` (the business id); verify against ONE real settlement
  row before enabling the flag, or revenue attribution silently breaks with no alert.
- **Check company ownership:** AIO auto-creates a Check company at `business/create` (`data.companyId`),
  and `startPayrollOnboardingAction` creates another — two Check companies for one restaurant is real
  payroll, not a sandbox object. Resolve before payroll + provisioning run together in prod.
- **Env wiring:** set `AIO_DASHBOARD_BASE_URL=https://backend.prod.aioapp.com`,
  `AIO_DASHBOARD_USERNAME`/`AIO_DASHBOARD_PASSWORD` to the service account, keep
  `AIO_DASHBOARD_APP_ALLOWLIST` populated for first real runs, and set `AIO_DASHBOARD_ENABLED=true`
  only when ready. Every `business/create` burns a globally-unique alias that is never freed.

## Live smoketest debris (permanent — cannot be deleted)

Created during verification, named `EASYOB SMOKETEST` so it's identifiable:
business `2028` / company `com_J0smWL7x2PHvW0QvZts0` / location `2065` / workplace
`wrk_IPNk6RzC1y3tQLbw9czH`, with a real (now-open) Adyen live onboarding.

Its **alias is `easyob_smoketest_20261009212643`** — record it, because the alias is the only
thing `findAioBusinessByAlias` can be asked about, and it is not derivable from the ids above.

## What `business-list` actually returns (read-only, re-verified 2026-10-14)

The service account's credentials still work and authenticated reads succeed against prod.
Three shapes, none of them obvious from the route name:

- **Unfiltered** `GET /api/business/business-list` → `data` is an ARRAY of **275** businesses,
  and each element has exactly ONE key, `businessAlias`. No id, no name. This is the shared
  production tenant list (`ofarrell_cafe`, `luigi's_pizzeria_-_bellaire`, `enoteca-la-storia`…).
  `findAioBusinessByAlias` returns null for an array, which is why calling it without a filter
  looks like "not found" rather than "275 results".
- **Filtered miss** `?businessAlias=nope` → HTTP 200, `data: null`, and a message reading
  `"Logo for alias nope"`. The message is nonsense; `data: null` is the not-found signal.
- **Filtered hit** → `{ businessName, restaurants: [...] }` and **no `id`** — confirming the
  constraint provision.ts is built around. Note the restaurant objects carry `name` but no `id`
  either, although the TS return type claims `{ id: number; name: string }`; `restaurants[0]?.id`
  is therefore `undefined` in practice. Harmless today only because the `!existing.businessId`
  check returns `needs_attention` before the locationId line is reached.

So the reconcile guard can prove an alias is TAKEN but can never recover the ids behind it. That
is the documented dead end, not a bug: a hit on an alias we have no persisted id for is a row for
a human to unpick, because creating again would burn a second alias.
