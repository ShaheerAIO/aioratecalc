# AIO Prod Dashboard API: Integration Guide

This guide is for a coding agent (Claude Code) wiring a project into the **AIO production dashboard
backend** over HTTP. It is self-contained. Everything in it was verified live against prod
(2026-10-09 through 2026-10-14) by the EasyOB project, whose working client is
`aioratecalc/app-v2/src/lib/adapters/aioDashboard.ts`. Copy that file if you can; it already
handles every quirk below.

> **To the agent reading this:** you should not need to ask the user anything to get connected.
> The only value you can't supply yourself is the password, which goes in an env var (§2). If a
> task asks you to *create* something in prod, read §7 first. Prod objects are permanent.

---

## 1. Entry point

| | |
|---|---|
| **Base URL (prod)** | `https://backend.prod.aioapp.com` |
| Base URL (internal dev) | `https://backend.internal.dev.aioapp.com`. Shared with other AIO teams, has **no Adyen at all**. Use it only when explicitly told to. |
| Frontend that uses it | `https://dashboard.aioapp.com` (the prod host isn't in the backend repo; it's SSM-injected, and was read out of this site's JS bundle) |
| Stack | NestJS + AWS Cognito (us-west-2) |
| **Full API spec** | `GET {BASE}/api-docs-json`. **No auth needed.** About 1.4 MB, ~1,640 paths covering the whole platform (POS, KDS, payroll, menus, reports, gift cards…). Swagger UI is at `{BASE}/api-docs`. |

Use the spec to find endpoints that aren't listed here. Two cautions about it:
- Many request DTOs are documented with **zero properties** (e.g. business create). The real body
  has to be learned from validation errors (a `400` lists the missing fields), or taken from §5.
- Fields Swagger marks as "required" often aren't, and vice versa.

---

## 2. Credentials

Use a **service account** (role `operation`, MFA disabled so it logs in without an OTP):

```bash
# .env / .env.local
AIO_DASHBOARD_BASE_URL=https://backend.prod.aioapp.com
AIO_DASHBOARD_USERNAME=shaheer.hasnain+easyob@aioapp.com
AIO_DASHBOARD_PASSWORD=__FILL_ME_IN__
AIO_DASHBOARD_BROWSER_ID=ad267d0e-52d1-4da2-a351-ec52be592fbc   # any FIXED uuid; see §3
```

- **Never hardcode or commit the password.** Read it from env only.
- **`$` in the password:** Next.js (`@next/env`) runs dotenv-expand, so in `.env.local` you have to
  escape it as `\$`. Quotes don't help. In the **Vercel env UI**, paste the raw `$`.
- **Permissions are per-account and sit in the token.** That account has 15 permissions, which
  cover the tenant → location → KYC chain. If an endpoint returns a permission error, the fix is
  granting the permission in the dashboard's super-admin UI and then **logging in again**. A token
  minted before a grant never sees it.

### A separate account per project (optional, recommended for anything long-lived)

This is how the EasyOB account was made. Do it with the user's own live admin session, not this
service account:
1. `POST /api/user/operation/create` (the controller base is `user`, **not** `user-profile`).
   You need a valid dashboard token with `operations_create`. The response emails a random password
   and turns MFA on.
2. `POST /api/authentication/2fa-email-enable` body `{"username": "...", "isEmailEnabled": false}`
   turns MFA off so the account can log in unattended.
3. Grant permissions in the dashboard UI, then log in again.

(Security note: that 2FA endpoint has no authorization guard, so any authenticated user can disable
MFA for any username. Use it on your own service account only. It has been flagged for the backend
team.)

---

## 3. Authentication

### Login

```bash
curl -s "$AIO_DASHBOARD_BASE_URL/api/authentication/user-login" \
  -H 'Content-Type: application/json' \
  -H 'x-app-name: dashboard' \
  --data-raw '{"username":"<USERNAME>","password":"<PASSWORD>","rememberMe":false,
               "browserId":"<FIXED-UUID>"}'
```

Tokens are at **`data.authChallengeResponse.AuthenticationResult`**:
`AccessToken`, `IdToken`, `RefreshToken`, `ExpiresIn` (seconds; observed 12h on prod, 24h on dev).
Read `ExpiresIn` rather than assuming a value.

**Gotchas that each cost real time:**
- **`Content-Type: application/json` is mandatory.** Without it the body is parsed as form data and
  you get a misleading `400 "username should not be empty"`.
- **`browserId` must be a stable uuid.** Cognito treats it as a device, so a fresh one per login
  piles up devices on the account.

### Every authenticated call needs FOUR headers

```
Authorization: Bearer <AccessToken>
x-id-token:    <IdToken>
x-app-name:    dashboard
Content-Type:  application/json
```

- **`x-id-token` is required and undocumented.** Leave it out and most routes return
  `401 "Invalid access token provided"`. That error blames the access token, which is fine.
- The same `401 "Invalid access token provided"` comes back for **routes that don't exist**,
  because a guard runs before routing. If you get it with all four headers present, check the path
  against `/api-docs-json` before you debug auth.

### Session handling (do it this way)
- Cache the session in memory and re-login about 5 minutes before `ExpiresIn` runs out.
- Collapse concurrent logins into one in-flight promise so a batch job doesn't log in N times.
- On a `401`, clear the cache, re-login **once**, and retry **once**. Never loop.
- A refresh endpoint exists (`POST /api/authentication/dashboard/refresh-token`), but re-login
  is simpler and is what the verified client does.

---

## 4. Response envelopes and errors

Two envelope shapes, depending on the route. Unwrap both:

```ts
// { success, data, message }   OR   { statusCode, response: { success, data, message } }
function unwrap(json: any) {
  const env = json?.response ?? json;
  return { success: !!env?.success, data: env?.data, message: String(env?.message ?? "") };
}
```

- Creates return **HTTP 201**, and the body's own `statusCode` may say 200. Check `res.ok`.
- **Judge success by the PAYLOAD, not the status code.** At least one route (`adyen-onboard`, §5)
  returns `201 success:true` with an empty result.
- Error bodies leak backend internals (TypeORM messages, source paths). Log them server-side and
  don't show them to end users.

---

## 5. Vocabulary and the endpoints that matter

**The vocabulary is a trap.** The people and the UI don't use the API's names:

| The business / dashboard UI says | The API says | Id |
|---|---|---|
| "Restaurant (Tenant)" | **Business** | `business.id` = the **tenant number** |
| "Location" | **Restaurant** | `restaurant.id` |

### Reads

| Call | What it does | Notes |
|---|---|---|
| `GET /api/business/business-list` | All tenants | Array of `{businessAlias}` **only**: no id, no name (~275 on prod). |
| `GET /api/business/business-list?businessAlias=X` | Look up one tenant by alias | Hit → `{businessName, restaurants:[{name,…}]}` with **no ids at all**. Miss → `200`, `data: null`, plus a nonsense message `"Logo for alias X"`. `data:null` is the not-found signal. **Also returns soft-deleted tenants.** |
| `GET /api/business/list` | A **filtered** tenant list | Leaves out freshly created tenants. **Don't use it to verify a create.** |
| `GET /api/business/item?id=N` | One tenant | Came back empty right after a create on dev. Not reliable for read-after-write. |
| `GET /api/restaurant/{id}` | One location, full record | Works. `accountId` = the Adyen account, which stays null until the merchant finishes KYC. |
| `GET /api/roles/list` | Role ids | `4` = Owner, `5` = Manager, `6` = Server, `7` = Cook, … |
| `GET /api/business/assigned-business-restaurant` | Businesses assigned to the caller | Empty for service accounts. |

**Known-broken reads (all tenants, not just yours):** `GET /api/business`,
`GET /api/restaurant`, `GET /api/restaurant/nearby/{businessId}` all return `500 No metadata for
"…" was found`. `GET /api/business/business-by-alias/{alias}` and
`/api/restaurant/homepage/{id}` reject server-to-server calls with "origin is not allowed".

**Context-dependent routes (TenantContext wall).** Parameterless tenant-scoped routes such as
`/api/business/onboard`, `/api/business/terms-and-conditions`, `/api/business/full-service-setup`,
`/api/business/filing-*` and `/api/restaurant/get/payment-pricing` fail with
`[TenantContext] … no businessId in ALS`. `?businessId=`, `x-business-id` and `businessid` headers
don't fix it. `x-tenant-id: <businessId>` is the header the platform documents (it's used in step 3
below), so try it first on any tenant-scoped route. If that also fails, the route isn't usable by a
service account. Look for a path-parameterised alternative (`/api/restaurant/{id}`-style routes do
work).

### Writes: the provisioning chain (verified end to end in prod)

| Step | Call | Returns |
|---|---|---|
| 1. Tenant | `POST /api/business/create` | `data.id` (**tenant number**), `data.companyId` (a **Check payroll company** the platform auto-creates, `com_…`) |
| 2. Location | `POST /api/restaurant/post/create` | `data.id` (location id), `data.workplaceId` (Check workplace, `wrk_…`) |
| 3. Adyen KYC link | `POST /api/restaurant/adyen-onboard`, header `x-tenant-id: <businessId>`, body `{"restaurantId": <locationId>}` | `data.url`: Adyen hosted-onboarding link (**LIVE** Adyen on prod) |

**Step 1 body:**

```json
{
  "businessInfo": {
    "businessName": "Joe's Tacos",
    "businessAlias": "myproject_<stable-unique-id>",
    "businessSince": "2026-10-16T00:00:00.000Z",
    "businessType": "sole_proprietorship",
    "contactNo": "+14155550142",
    "address": "123 Real St", "city": "Campbell", "state": "CA", "stateIso": "CA", "zipCode": "95008",
    "logo": null,
    "ownerInfo": { "ownerName": "Joe Smith", "ownerEmail": "joe@example.com", "ownerContactNo": "+14155550142" }
  },
  "pocInfo": [
    { "name": "Joe Smith", "contactNo": "+14155550142", "roleId": 4, "email": "joe@example.com" }
  ]
}
```
- The wrapper key is `businessInfo`. `business` and `businessData` 500.
- **`businessAlias`: always pass it explicitly.** It's globally unique, and auto-derivation
  collides even when no tenant has that name.
- **`businessName` is also globally unique** (`400 "Business name already exists"`). Try the real
  name first, then disambiguate it (EasyOB appends `" (EasyOB <shortid>)"`).
- **The address is validated server-side on prod.** A fake address returns
  `400 "Invalid address: Incorrect postal code"`. Use a real address.
- Every `pocInfo` field is required: full name (first + last joined), E.164 phone, `roleId`,
  and email. A blank phone returns `400 ["pocInfo.0.contactNo should not be empty"]`.
- `businessType`: `sole_proprietorship` is the only value seen in the wild.
- `taxId` is **not** the EIN (the platform puts `"1234"` in it). The EIN column is `FEIN`, and
  create never touches it. Don't send an EIN.
- `suite` gets silently overwritten server-side. Don't rely on it.
- `POST /api/business` is a thinner, different create. Use `/api/business/create`.

**Step 2 body:**

```json
{
  "businessId": 2028, "companyId": "com_…",
  "restaurant": {
    "businessId": 2028, "name": "Joe's Tacos",
    "address": "123 Real St", "city": "Campbell", "state": "CA", "stateIso": "CA", "zipCode": "95008",
    "latitude": 37.28, "longitude": -121.95,
    "phoneNo": "+14155550142", "timezone": "America/Los_Angeles",
    "restaurantModes": "quickServe", "status": "closed",
    "image": "", "orderDelayedTime": 0, "onlineOrder": false, "onlineOrderTimer": "16:00:00",
    "otherMode": "", "building": "", "autoGratuity": false, "largePartySizeLimit": 1,
    "cuisineType": "", "workplaceId": ""
  },
  "pocInfo": [ { "name": "Joe Smith", "contactNo": "+14155550142", "roleId": 4, "email": "joe@example.com" } ],
  "pocEmployees": []
}
```
- **`latitude`/`longitude` must be non-null on prod** (`500 Missing required field`). This route
  does not geocode for you, so geocode yourself: US Census geocoder, then OSM Nominatim, then
  a city/state fallback. Never block on it; a logged US-centroid placeholder is acceptable.
- **NEVER RETRY THIS CALL.** Right after step 1 it often fails with
  `500 relation "tenant_N.state" does not exist` because the tenant's DB schema isn't built yet
  (observed ~100 s). **The restaurant row is still inserted anyway**, as a half-created location
  that shows in the tenant forever, 404s on `GET /api/restaurant/{id}` forever, and can't be
  deleted. Three quick retries left three pieces of junk. What to do:
  - wait **at least 5 minutes** after step 1 before calling step 2 (schedule it, don't sleep),
  - make **exactly one** attempt,
  - if you get that error, wait another 15 minutes and try once more. Treat it as "too early" and
    don't count it as a failure.
  - The error body is JSON, so the quotes in it are backslash-escaped. Match with
    `/relation\s+\\?"tenant_\d+\.[a-z_]+\\?"\s+does not exist/i`.

**Step 3 quirk:** the **first** call often returns `201 success:true, newOnboarding:true, url:""`.
Retry up to 3 times, 1.5 s apart, until `url` is an `https://` link. Retrying here is **safe**:
each call mints a fresh link for the same legal entity. If the url is still empty after 3 tries,
that's a real outage. Throw, and never hand out an empty link.
- Each call returns a **different** URL, so mint one per user click and don't store and re-serve it.
- `x-tenant-id` isn't actually enforced (a wrong id still worked), but send it anyway. It's the
  contract.
- Live URLs (`balanceplatform-live.adyen.com/.../uo/form/…`) contain **no** legal-entity id.
  `restaurant.accountId` fills in only after the merchant finishes KYC, and there's no
  KYC-completion webhook or status, so you have to poll `GET /api/restaurant/{id}`.

### Delete (don't count on it)
`POST /api/business/delete {"id": N}` is a **soft** delete. It always reports success (even on an
already-deleted row), the **alias is never freed** (`unique_businessAlias` ignores `deletedAt`), and
the POC record survives. **Nothing can be undone through the API.**

---

## 6. Idempotency recipe (for anything that creates)

Prod creates are permanent and the database is shared with every AIO team. Every creating
integration needs all of the following:

1. **Deterministic alias** derived from your own stable record id, e.g. `myproject_<id>`
   (lowercase, `[a-z0-9_]`, ≤60 chars). Never use a random suffix: a retry would mint a second
   tenant.
2. **Persist each returned id immediately** (businessId, companyId, locationId, workplaceId) before
   moving to the next step, and resume from what's persisted.
3. **Reconcile before creating:** look the alias up with `business-list?businessAlias=`. If it
   exists and you have **no persisted id**, stop and flag it for a human. The lookup can prove an
   alias is taken but can never give you its id back, and creating again would burn a second
   alias.
4. **A lease/lock** (e.g. a conditional UPDATE) so two workers never provision the same record.
5. **Validate every field before step 1** (name, real address, owner first+last, email, E.164
   phone). A failure *after* step 1 leaves a permanent half-built tenant.

---

## 7. Rules for the agent (follow without asking)

- **Reads are safe.** Explore freely with GETs and `/api-docs-json`.
- **Do not POST any create/update/delete to prod unless the user's task explicitly asks for that
  write.** Prod Adyen is **live**: step 3 starts a real merchant onboarding. To test the chain,
  use real-looking data only if the user says so, and name it obviously, e.g. `<PROJECT> SMOKETEST`.
- Need to explore write contracts? Learn them from `400` validation errors on **empty/invalid**
  bodies (those create nothing), not by creating real rows. One exception: as described in §5,
  step 2 errors can still create rows.
- Don't send SSN, bank, or EIN data. Adyen and Check collect those on their own hosted pages.
- Keep credentials server-side only. Never ship them to a browser bundle.
- If a route returns a permission error, tell the user which permission/route is involved. Granting
  permissions is a human step in the dashboard UI (§2).

---

## 8. Known debris and reference ids (prod)

- `EASYOB SMOKETEST`: business `2028`, alias `easyob_smoketest_20261009212643`, company
  `com_J0smWL7x2PHvW0QvZts0`, location `2065`, workplace `wrk_IPNk6RzC1y3tQLbw9czH`. Permanent;
  ignore it.
- Aliases starting `easyob_` belong to EasyOB. Don't create anything with that prefix.
- Tenant 2047 has half-created locations 2080 and 2081 (§5 step 2). Permanent; ignore them.

## 9. Open questions (unanswered by the AIO backend team)

- Settlement store reference: is Adyen's store ref `prod-{businessId}` or `prod-{restaurantId}`?
  Unverified.
- No readable Adyen KYC status and no webhook from the platform. You have to poll.
- Platform auto-creates a Check company on step 1. If your project also creates Check companies,
  you'll get duplicates for the same restaurant.
- No documented rate limits (a `Rate Limit Admin` tag exists in the spec). Keep batch jobs gentle.
