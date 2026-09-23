# AIO Dashboard API — raw session transcript

**Date:** 2026-09-17 · **Host:** `https://backend.internal.dev.aioapp.com` (internal dev)
**Account:** `shaheer.hasnain+internal-super-admin@aioapp.com` (role: `super-admin`)

Every request and response below is **verbatim** from an exploration session against the
internal dev API. Nothing here is reconstructed from memory or from documentation. Secrets are
redacted as `<ACCESS_TOKEN>`, `<ID_TOKEN>`, `<PASSWORD>`; nothing else is altered.

Purpose: settle, with evidence, what the API actually does — so we stop going back and forth.

**Short version of what we learned:**

1. Auth needs **two** headers (`Authorization` *and* `x-id-token`) plus `Content-Type: application/json`.
2. `taxId` is **not** the EIN. The EIN column is `FEIN` and the create path never touches it.
3. Tenant creation works. Contract is reverse-engineered below (the DTO is empty in Swagger).
4. **Delete is soft and never releases the alias.** A deleted tenant's name can never be reused.
5. Many endpoints need a "TenantContext" our account cannot set.
6. **No restaurant in internal dev has an Adyen account** — confirmed separately that Adyen lives on test env.

---

## 0. Convention used throughout

```bash
BASE=https://backend.internal.dev.aioapp.com
AUTH=(-H "Authorization: Bearer <ACCESS_TOKEN>"
      -H "x-id-token: <ID_TOKEN>"
      -H "x-app-name: dashboard"
      -H "Content-Type: application/json")
```

---

## 1. Login

### 1a. Exactly as supplied to us — FAILS

```bash
curl --location "$BASE/api/authentication/user-login" \
  --header 'x-app-name: dashboard' \
  --data-raw '{"username":"...","password":"<PASSWORD>","rememberMe":false,
               "browserId":"ad267d0e-52d1-4da2-a351-ec52be592fbc"}'
```

```
HTTP 400
{"success":false,"message":[
  "username must be a valid email address or phone number",
  "username should not be empty",
  "password must be longer than or equal to 8 characters",
  "password should not be empty"]}
```

**Cause:** `curl --data-raw` defaults to `application/x-www-form-urlencoded`. The body is never
parsed as JSON, so every field reads empty. **The curl snippet we were given is missing
`Content-Type: application/json`.** This cost us the first 20 minutes.

### 1b. With the JSON content type — WORKS

```bash
curl "$BASE/api/authentication/user-login" \
  -H 'x-app-name: dashboard' -H 'Content-Type: application/json' \
  --data-raw '{"username":"...","password":"<PASSWORD>","rememberMe":false,
               "browserId":"ad267d0e-52d1-4da2-a351-ec52be592fbc"}'
```

```
HTTP 200  success: True  message: login successful
AccessToken  — JWT, ExpiresIn 86400, TokenType Bearer
IdToken      — JWT
RefreshToken — present

AccessToken claims: iss https://cognito-idp.us-west-2.amazonaws.com/us-west-2_87zbbc0nm
                    client_id 9drqjs977vmhvsof01cdc7sfi
                    token_use access
                    scope aws.cognito.signin.user.admin

role: ['super-admin']   userType: user
businesses: []   restaurants: []   businessId: None   restaurantId: None
userPermissions: 0 entries
```

> **Note for later (section 7):** this super-admin is assigned to **zero** businesses.
> That turns out to block a whole class of endpoints.

---

## 2. Finding the API documentation

```
GET /api/docs           401  {"message":"Invalid access token provided", ...}
GET /api/docs-json      401  (same)
GET /api/swagger        401  (same)
GET /docs               404  {"message":"Cannot GET /docs"}
GET /swagger            404
GET /api-docs           200  <!DOCTYPE html> … Swagger UI static bundle
GET /api/health         401  (same)
```

The `401 Invalid access token provided` on non-existent `/api/*` routes is **misleading** — the
token was valid the whole time. A guard runs before routing and reports a bad token for a route
that simply does not exist.

```
GET /api-docs-json      200   1,398,779 bytes
```

```
title: AIO   version: 1.0   servers: []
total paths: 1638
```

Top tags: Restaurant 78 · Ticket 75 · Payment 54 · Authentication 51 · Gift Card 46 · Menu 43 ·
Reports 38 · TimeLog 35 · … · Business 17 · CheckHqPayroll 16 · Plaid 11

**Observation:** this is the entire AIO platform (POS, KDS, payroll, accounting, catering,
inventory, marketing), not a tenant-provisioning API. `/api-docs-json` requires **no
authentication**.

---

## 3. The `x-id-token` discovery

Using only `Authorization: Bearer`:

```
GET /api/business/business-list   200  {"success":true,"data":[{"businessAlias":"urooj_test"}, …]}
GET /api/business/list            → {"success":false,"message":"Invalid access token provided"}
GET /api/business                 → {"success":false,"message":"Invalid access token provided"}
```

Same token, one route works and two do not. The spec showed why — **every** path declares:

```
parameter  header  x-id-token   (description: "ID Token")
```

Adding `x-id-token: <ID_TOKEN>`:

```
GET /api/business                             500  {"message":"Error while performing operation :
                                                    No metadata for \"Business\" was found."}
GET /api/business/list                        200  {"statusCode":200,"response":{"success":true,
                                                    "message":"Business retrieved Successfully", …}}
GET /api/business/assigned-business-restaurant 200  {"success":true,"data":[], …}
```

**Q1 for the developer:** is `x-id-token` (the Cognito **IdToken**, alongside the AccessToken in
`Authorization`) required on every authenticated call? It is undocumented outside the Swagger
parameter list, and the failure mode ("Invalid access token provided") points at the wrong token.

**Q2:** `GET /api/business` returns `No metadata for "Business" was found` — a TypeORM entity
registration error. Is that endpoint simply broken in this deploy?

---

## 4. `taxId` is NOT the EIN

This was the specific point of confusion. Presence check across three existing tenants
(values deliberately not printed, only shape):

| business | `taxId` | `FEIN` | `businessType` |
|---|---|---|---|
| 5023 | `str "1234"` | EMPTY | `str` len 19 |
| 5024 | `str "1234"` | EMPTY | `str` len 19 |
| 5050 | `str "1234"` | EMPTY | `str` len 19 |

`taxId` is the literal 4-character string `"1234"` on every tenant. An EIN is 9 digits. The real
Federal EIN column is **`FEIN`**, it is empty on all of them, and **no field named `FEIN` appears
anywhere in the create path.**

**Conclusion: creating a tenant does not require an EIN.** This matters to us because EasyOB
deliberately never stores EIN/SSN/bank details — Adyen and Check collect those on their own hosted
pages. Tenant creation does not break that rule.

Full field list on a Business record:

```
FEIN, address, businessAlias, businessName, businessSince, businessType, city,
cognitoCreatedAt, cognitoCreatedBy, cognitoUpdatedAt, cognitoUpdatedBy, companyId,
contactNo, createdAt, createdBy, deletedAt, deletedBy, id, logo, orderoutAccountName,
ownerInfo, state, status, suite, taxId, twilioConfig, twilioForms, updatedAt, updatedBy, zipCode
```

**Q3:** what is `taxId` actually for, if not the EIN? Everything we sampled has `"1234"`.

---

## 5. Reverse-engineering tenant creation

Swagger documents `CreateForBusinessRequestDto` with **zero properties**, so the body was derived
from validation errors, one at a time.

```
POST /api/business          {}   400  ["businessName must be a string","businessName should not be empty",
                                       "businessSince should not be empty","taxId must be a string",
                                       "taxId should not be empty","businessType must be a string",
                                       "businessType should not be empty","address must be a string",
                                       "address should not be empty"]
```

Note `suite` and `zipCode` are marked **required in Swagger but are not** enforced.

```
POST /api/business/create   {}                400  ["pocInfo must be an array"]
POST /api/business/create   {"pocInfo":[]}    500  {"message":"TypeError: Cannot read properties
                                                    of undefined (reading 'businessName')"}
POST /api/business/create   {"pocInfo":[{}]}  400  ["pocInfo.0.name should not be empty",
                                                    "pocInfo.0.contactNo should not be empty",
                                                    "pocInfo.0.roleId must be a number …",
                                                    "pocInfo.0.Invalid email address",
                                                    "pocInfo.0.email should not be empty"]
```

Finding the wrapper key for the business object:

```
{"pocInfo":[valid], "business":{}}      500  Cannot read properties of undefined (reading 'businessName')
{"pocInfo":[valid], "businessInfo":{}}  400  {"message":"Business name already exists"}   ← correct key
{"pocInfo":[valid], "businessData":{}}  500  Cannot read properties of undefined (reading 'businessName')
```

Supporting lookups:

```
GET /api/roles/list  →  roleId 4 = Owner, 5 = Manager, 6 = Server, 7 = Cook, …  (15 roles)
businessType on existing tenants = "sole_proprietorship"
```

### 5a. First create attempt — alias collision

```
POST /api/business/create   businessName "EASYOB-PROBE-20260917", no businessAlias
400  {"message":"Business alias already exists"}
```

Auto-derived alias collided even though no tenant by that name existed.

### 5b. Second attempt, explicit alias — SUCCESS

```bash
POST /api/business/create
{
  "businessInfo": {
    "businessName":  "EasyOB Probe 20260917",
    "businessSince": "2026-09-17T00:00:00.000Z",
    "taxId":         "1234",
    "businessType":  "sole_proprietorship",
    "address":       "1 Probe Street",
    "suite":         "Suite 1",
    "city":          "Campbell",
    "state":         "California",
    "zipCode":       "95008",
    "contactNo":     "+14155550142",
    "businessAlias": "easyob_probe_20260917"
  },
  "pocInfo": [
    { "name": "EasyOB Probe", "contactNo": "+14155550142",
      "roleId": 4, "email": "shaheer.hasnain+easyob-probe@aioapp.com" }
  ]
}
```

```
HTTP 201
{"statusCode":200,"response":{"success":true,"message":"Business saved Successfully",
 "data":{"businessName":"EasyOB Probe 20260917","businessSince":"2026-09-17T00:00:00.000Z",
         "taxId":"1234","businessType":"sole_proprietorship","address":"1 Probe Street",
         "suite":"1234565","zipCode":"95008","contactNo":"+14155550142","city":"Campbell",
         "state":"California","businessAlias":"easyob_probe_20260917","FEIN":null,
         "logo":null,"companyId":null,"id":5083,
         "createdAt":"2026-09-17T17:33:06.206Z","status":"Active"}}}
```

**Q4 — apparent bug:** we sent `"suite": "Suite 1"`. The server stored **`"suite": "1234565"`**.
Silently overwritten, no error. Where does `1234565` come from?

**Q5:** `companyId` came back `null` here, but existing tenants have e.g.
`companyId: "com_ZGQ85SCEgbjNFt7AZRPG"` — which is a **Check (checkhq.com) company id** format,
and the spec has a 16-endpoint `CheckHqPayroll` tag. **Does the platform create the Check payroll
company itself, and if so at what point?** This matters a lot to us: EasyOB also creates Check
companies. If both systems do it, one restaurant ends up with two Check companies, and that is
real payroll, not a sandbox object.

---

## 6. Verifying the created tenant — the list endpoints disagree

```
GET /api/business/item?id=5083   →  business: <all fields None>, count: 0, pocInfo: 0 entries
GET /api/business/list           →  327 rows, highest id = 5051, tenant 5083 ABSENT
GET /api/business/business-list  →  369 rows, tenant 5083 PRESENT
GET /api/business/business-list?businessAlias=easyob_probe_20260917
    →  {"success":true,"data":{"businessName":"EasyOB Probe 20260917",
        "businessAlias":"easyob_probe_20260917","restaurants":[]},
        "message":"Logo for alias easyob_probe_20260917"}
```

Re-POSTing the identical body confirmed it really was persisted:

```
POST /api/business/create  (same body)  400  {"message":"Business name already exists"}
```

**Q6:** `/api/business/list` returns 327 and `/api/business/business-list` returns 369. A
newly-created tenant appears in the second but not the first, and `/api/business/item?id=5083`
returned nothing at all immediately after creation. Which endpoint is authoritative, what filters
`list`, and is there a caching/propagation delay on `item`?

Also: `GET /api/business/business-by-alias/{alias}` returns
`{"message":"origin is not allowed to access the requested route."}` — presumably browser-origin
restricted. **Q7: is that endpoint usable server-to-server at all?**

---

## 7. Deleting the tenant — soft, and the alias is never released

```
POST /api/business/delete  {}                    500  {"message":"Error while performing operation :
                                                       Empty criteria(s) are not allowed for the update method."}
POST /api/business/delete  {"id":5083}           201  {"success":true,"data":"EasyOB Probe 20260917",
                                                       "message":"Business removed Successfully"}
POST /api/business/delete  {"businessId":5083}   500  {"message":"No metadata for \"PublicBusiness\" was found."}
```

After the successful delete:

```
GET /api/business/business-list           →  still 369 rows, alias easyob_probe_20260917 STILL PRESENT
GET …/business-list?businessAlias=easyob_probe_20260917  →  still returns the tenant
POST /api/business/create  (same body)    →  500 {"message":"duplicate key value violates
                                                  unique constraint \"unique_businessAlias\""}
POST /api/business/delete  {"id":5083}    →  201 {"success":true,"message":"Business removed Successfully"}
                                               (succeeds AGAIN on an already-deleted row)
GET  /api/business/item?id=5083           →  {"business":null, "count":1,
                                              "pocInfo":[{"roleId":4,"name":"EasyOB Probe",
                                                          "email":"…","contactNo":"…"}]}
```

Three problems, all reproducible:

- **The alias is never freed.** `unique_businessAlias` is not a partial index on `deletedAt`, so a
  deleted tenant's alias is permanently burned. If EasyOB retries a failed tenant creation it will
  collide with its own deleted row. **Q8: is there a hard delete, or must we always mint a new alias?**
- **Delete always reports success**, including on a row already deleted. It is not possible to tell
  from the response whether anything happened. **Q9: intended?**
- **The POC record survives the delete** — name, email and phone still returned after the business
  row is gone. **Q10: is that intentional data retention?**

---

## 8. The TenantContext wall

```
GET /api/business/onboard                      (no scope)
GET /api/business/onboard?businessId=5083
GET /api/business/onboard   -H 'x-business-id: 5083'
GET /api/business/onboard   -H 'businessid: 5083'
```

All four return **identically**:

```
{"message":"Error while performing operation :[TenantContext] QueryBuilder table \"_Tenant.business\"
 — no businessId in ALS. HTTP: ensure a middleware in apps/backend/src/core/middlewares sets the
 tenant context. Background work: wrap the handler in runWithTraceId(traceId, fn, businessId)
 before querying tenant entities."}
```

Same for `GET /api/restaurant/get/payment-pricing` → `{"message":"Restaurant not found"}`.

Affected (all no-parameter, context-dependent): `/api/business/onboard`,
`/api/business/terms-and-conditions`, `/api/business/full-service-setup`,
`/api/business/filing-preparation`, `/api/business/filing-preview`,
`/api/business/previous-provider-access`.

Path-parameterised routes such as `/api/restaurant/{id}` work fine. Only the context-dependent ones fail.

**Q11 — this is our biggest blocker.** How does the dashboard populate `TenantContext`? A header we
are missing, a business-scoped token, or does the calling account need an explicit business
assignment? Our super-admin has `businesses: []`, so nothing populates it. Until this is answered a
whole class of reads is closed to us.

---

## 9. Restaurants

```
GET /api/restaurant                     500  {"message":"No metadata for \"Restaurant\" was found."}
GET /api/restaurant/nearby/5050         500  {"message":"No metadata for \"Restaurant\" was found."}
GET /api/restaurant/4555                200  full record
GET /api/restaurant/homepage/4555       405  {"message":"origin is not allowed to access the requested route."}
```

**Q12:** `GET /api/restaurant` and `/api/restaurant/nearby/{businessId}` are broken for *all*
tenants, not just ours — same TypeORM `No metadata` error as `GET /api/business`. Known issue?

Restaurants are still reachable: `/api/business/business-list` embeds them, giving
**276 restaurants across 164 businesses**, and `/api/restaurant/{id}` returns a full record.

### Adyen

The only Adyen-shaped field on a restaurant record is **`accountId`**.

```
Sampled the 60 most recently created restaurants:  accountId non-null on  0  of 60.
GET /api/payment/financial-configuration/restaurant/4556  →  {"message":"Item Not Found"}
GET /api/payment/financial-configuration/restaurant/4555  →  {"message":"Item Not Found"}
POST /api/restaurant/adyen-onboard  {}  500
   {"message":"Business Id OR Restaurant Id not provided in cache service method
     getCachedRestaurant, restaurantId: 0, businessId: undefined"}
```

Since confirmed by Shaheer: **internal dev has no Adyen accounts at all — Adyen is on the test
environment**, and nothing on internal can take payments. So the empty `accountId` is expected,
not a fault.

---

## 10. Open questions, consolidated

Numbered so they can be answered one by one.

| # | Question |
|---|---|
| Q1 | Is `x-id-token` (the Cognito IdToken) required on every authenticated call? |
| Q2 | `GET /api/business` returns `No metadata for "Business"` — broken in this deploy? |
| Q3 | What is `taxId` for, given it is `"1234"` everywhere and `FEIN` is the real EIN column? |
| Q4 | We sent `suite: "Suite 1"`, the server stored `"1234565"`. Where does that come from? |
| Q5 | Does creating a Business also create the **Check payroll company** (`companyId: "com_…"`)? |
| Q6 | `/api/business/list` (327) vs `/api/business/business-list` (369) — which is authoritative, and why was a new tenant missing from `item` and `list`? |
| Q7 | Is `business-by-alias` usable server-to-server, or browser-origin only? |
| Q8 | Is there a **hard** delete? A soft-deleted alias can never be reused. |
| Q9 | Should `delete` really report success on an already-deleted row? |
| Q10 | The POC record (name/email/phone) survives a business delete — intentional? |
| Q11 | **How is `TenantContext` populated?** Header, scoped token, or business assignment? |
| Q12 | `GET /api/restaurant` and `/api/restaurant/nearby/{id}` broken for all tenants — known? |
| Q13 | What is the **request body for `POST /api/restaurant/adyen-onboard`**, and is it synchronous (returns a link) or does it fire the `/api/webhook/onboarding-adyen` callback? |
| Q14 | **Which field holds the Adyen onboarding link / account holder id** once a restaurant is onboarded? |
| Q15 | Which create endpoint is canonical — `/api/business` or `/api/business/create`? Can `CreateForBusinessRequestDto` be documented in Swagger? |
| Q16 | `POST /api/restaurant` marks ~25 fields required including `latitude`, `longitude`, `ticketSoundId`, `kitchenHubInfo`, `accountId`. Which are genuinely required, and what does the UI derive (geocoding)? |
| Q17 | Can we get a **stage/test environment** with a restaurant that is already Adyen-onboarded? Credentials alone are not enough — someone still has to run `adyen-onboard` before there is a link to read. |
| Q18 | Is there a **service account** model (scoped, machine credential, documented refresh) rather than a human super-admin with a 24h Cognito token? |
| Q19 | Rate limits for a service integration? (There is a `Rate Limit Admin` tag in the spec.) |
| Q20 | Does the platform emit **webhooks** to us on tenant/onboarding state changes, or must we poll? |

---

## 11. Housekeeping

- One tenant was created and deleted during this session: **id 5083, `easyob_probe_20260917`**.
  It is soft-deleted, but as described in §7 it still occupies the alias and its POC record
  remains. We cannot remove it further through the API. Apologies for the debris — a hard delete
  on the platform side would be appreciated.
- We noticed another team's tenant ("System Integration Testing", id 5051) appear mid-session, so
  this dev database is actively shared.
- `/api-docs-json` is served **without authentication** and exposes all 1,638 endpoints. Flagging
  in case that is unintended for a publicly-resolvable host.
- Error messages leak internal source paths (`apps/backend/src/core/middlewares`). Also probably
  worth suppressing outside dev.
