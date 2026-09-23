# Adyen KYC link — pre-read

**EasyOB team · 2026-09-22 · for the call with Adil**

Adil confirmed: *"yes you can use the API to generate the link! To use this API, prerequisites are
to create Restaurant(Tenant) and Location."* That answers the main question. This page is just the
remaining detail, so the call can be short.

---

## 1. Terminology — we have been using opposite words

This is almost certainly what has been causing the back-and-forth:

| Adil says | The API calls it | Create endpoint |
|---|---|---|
| **Restaurant (Tenant)** | `Business` | `POST /api/business/create` |
| **Location** | `Restaurant` | `POST /api/restaurant` |

So "restaurant" means the *brand/tenant* to Adil and the *physical site* in the API. Worth agreeing
out loud at the start of the call. Below, we use **Tenant** and **Location**.

---

## 2. Where we got to

We created a **Tenant** successfully on internal dev:

```
POST /api/business/create
{ "businessInfo": { "businessName","businessSince","taxId","businessType",
                    "address","businessAlias", … },
  "pocInfo": [ { "name","contactNo","roleId":4,"email" } ] }
→ HTTP 201, id 5083
```

We did **not** create a Location — which is exactly the prerequisite Adil named. So when we called
the onboarding endpoint it failed, and the error says the same thing he did:

```
POST /api/restaurant/adyen-onboard   {}
→ HTTP 500
  {"message":"Business Id OR Restaurant Id not provided in cache service method
    getCachedRestaurant, restaurantId: 0, businessId: undefined"}
```

`restaurantId: 0` = no Location. Our error and Adil's answer agree.

*(Note: internal dev has no Adyen accounts at all — Adyen is on test env — so there was nothing
there for us to read either. Of the 60 most recently created Locations, 0 had a non-null
`accountId`.)*

---

## 3. What we need, in one sentence

EasyOB must generate the merchant's Adyen KYC link **from the API, with no dashboard UI
navigation** — that is the whole point of automating it — and be able to regenerate it later,
because Adyen's hosted onboarding links are single-use and expire in about 4 minutes.

For reference, this is the shape EasyOB produces today talking to Adyen directly:

```
POST kyc-test.adyen.com/lem/v3/legalEntities/{id}/onboardingLinks
  → { "url": "https://onboarding-test.adyen.com/..." }   ← "the KYC link"
```

---

## 4. Agenda — four questions

**1. What is the request body for `POST /api/restaurant/adyen-onboard`?**
One example JSON. The error names both ids, so we assume something like
`{ "businessId": …, "restaurantId": … }` — body or query string?

**2. What does it return?**
The onboarding URL directly, or an id we exchange for a URL? Is the link single-use / does it
expire? If it expires, what do we call to mint a fresh one?

**3. Which field stores the Adyen identifiers afterwards?**
Is `restaurant.accountId` the Adyen account holder, or something unrelated? We need whatever id
lets us regenerate the link later rather than storing a dead URL. We cannot see any
`legalEntityId` / `accountHolderId` / `merchantAccount` / `storeId` field on the endpoints
available to us.

**4. How is `TenantContext` populated?**
Not Adyen-specific, but it blocks a lot of reads for us. Several endpoints return:

```
[TenantContext] QueryBuilder table "_Tenant.business" — no businessId in ALS.
```

We tried `?businessId=`, `x-business-id:` and `businessid:` — all identical. Our super-admin login
returns `businesses: []` / `businessId: null`. Is it a header we are missing, a business-scoped
token, or does the account need an explicit business assignment?

---

## 5. If there is time

**Who owns the Adyen relationship for a new merchant — the AIO platform, or EasyOB?**
Both systems can create Adyen objects today. If both do it for the same merchant, they end up with
two separate Adyen account holders, and the merchant would be asked to complete KYC twice. Better
to agree the boundary now.

**Test environment access**, ideally with **one Location that is already Adyen-onboarded.**
Credentials alone are not enough — if nothing there has been through onboarding, there is still no
link for us to look at. One onboarded Location answers questions 2 and 3 by itself.
