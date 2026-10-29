# Provisioning — AIO dashboard (Adyen tenant + KYC), Check payroll, Foodbuy

## The AIO dashboard provisioning path (2026-09-23)

Prod base https://backend.prod.aioapp.com (internal dev was backend.internal.dev.aioapp.com; prod's host isn't in the Zeus repo — it's SSM-injected, read from the dashboard.aioapp.com bundle). Credential is the self-provisioned operation service account shaheer.hasnain+easyob@aioapp.com (MFA disabled → unattended login). **Auth is TWO headers**, not one:
`Authorization: Bearer <AccessToken>` AND `x-id-token: <IdToken>`, both from
`POST /api/authentication/user-login` (which also needs `Content-Type: application/json` — without
it the body parses as form-encoded and every field reads empty). Bearer alone fails most routes with
"Invalid access token provided", which blames the wrong token.

Vocabulary mismatch worth knowing, since it cost several rounds with AIO's developer: what they call
a **"Restaurant (Tenant)"** the API calls a `Business`, and what they call a **"Location"** the API
calls a `Restaurant`.

| Step | Call | Returns |
|---|---|---|
| 1 | `POST /api/business/create` | `data.id` — **the AIO tenant number** — and `data.companyId`, a **Check company the platform auto-creates** |
| 2 | `POST /api/restaurant/post/create` | `data.id` (location), `data.workplaceId` (a Check workplace) |
| 3 | `POST /api/restaurant/adyen-onboard` + header `x-tenant-id`, body `{restaurantId}` | `data.url` — the hosted KYC link |

Each call to step 3 mints a **different** URL for the **same** legal entity, so fresh-link-per-click
works (`/customer/applications/[id]/continue`). The `legalEntityId` is obtainable **only** by parsing
`/legalEntities/(LE\w+)` out of that URL: `accountDetails` comes back empty and `restaurant.accountId`
stays null.

Open asks, tracked in `app-v2/ADYEN-KYC-LINK-QUESTIONS.md` and
`app-v2/AIO-DASHBOARD-API-TRANSCRIPT.md`. **None of them block flag-on any more** — the flag went
on 2026-10-14, because v1 of this product is HubSpot plus the Adyen KYC link and nothing else
(product owner). Two were closed outright: the service account exists
(`shaheer.hasnain+easyob@aioapp.com`) and the production base URL is known. Three remain, all
downstream of provisioning rather than part of it, so a tenant is still created correctly while
they wait:
- **the store reference** — `prod-{businessId}` or `prod-{restaurantId}`? Phase G, DEFERRED.
  Verify against one real settlement row before anyone trusts the P&L; revenue attribution breaks
  silently with no alert if the guess is wrong.
- **a readable KYC status** — there is none, which is why `adyen_approved` needs a human or the
  settlement backstop.
- **who owns the Check company** — AIO creates one at tenant create and
  `startPayrollOnboardingAction` creates another. Payroll is "much later" (product owner,
  2026-10-14), so the two cannot yet collide in prod. Resolve before they run together.

## Constraints (do not reverse)

- **EasyOB must NEVER create an Adyen object directly.** No legal entity, no account holder, no
  business line, no balance account, no onboarding link. That was deleted on 2026-09-23 because it
  produced accounts misnamed and unlinked from AIO's tenant graph. Everything goes through
  `adapters/aioDashboard.ts`. Don't reintroduce `adapters/adyen.ts`. The one surviving direct call
  is `adyenReports.ts`, which only DOWNLOADS the settlement CSV.
- **Everything the AIO dashboard API creates is IRREVERSIBLE.** A business alias is globally unique,
  delete is soft and never frees it, and the database is shared with other AIO teams. Hence: a
  DETERMINISTIC alias (`easyob_{app.id}` — a random one would mint a second tenant on retry), a
  conditional-UPDATE lease, resume-from-persisted-ids, reconcile-by-alias before creating, and the
  `AIO_DASHBOARD_APP_ALLOWLIST` canary. Don't simplify any of those away.
- **PASSING `validateOnboardingFields` IS THE PRECONDITION FOR PROVISIONING, and the gate runs that
  exact function** (2026-10-14). `isReadyForAioProvisioning` used to check a business name and an
  owner email and nothing else, while AIO's `business/create` validates the whole point-of-contact
  block server-side. So `prospect_1792016501714` was handed to AIO with a blank owner phone and came
  back `400 ["pocInfo.0.contactNo should not be empty"]` — and because `ownerContact.phone` was
  never required anywhere, nothing upstream could have caught it. Four things are load-bearing:
  - **A failed create is not a form error anyone sees.** It burns one of five attempts, backs off
    1h → 2h → 4h → 8h → 16h and then stops at `too_many_attempts` forever, while the merchant's
    checklist says "We're setting up your account — no action needed". Holding costs nothing by
    comparison: the row is re-examined every 15 minutes, free, with no attempt burned and no alias
    claimed. So **anything the merchant's own form would refuse, the cron refuses too** — one
    function, called from both, which is why `onboardingValidation.ts` is pure and importable from
    the gate, the Server Action and the browser alike. Before adding a field to AIO's payloads, add
    it there.
  - **The ORDERING is why a form rule alone can't fix this.** Provisioning triggers on PAYMENT, and
    the merchant fills their onboarding form AFTER they pay — so the cron routinely reaches a row
    the form has never seen. That is exactly what happened: accepted 22:33Z, attempted 22:45Z, form
    never opened.
  - **`business.phone` and `ownerContact.firstName`/`lastName`/`email`/`phone` are now REQUIRED**
    (`tenantFieldErrors`). Three were optional-if-given and one was unchecked entirely. Each has a
    destination: business phone → `businessInfo.contactNo` and the location's `phoneNo`; first+last
    → `ownerInfo.ownerName` and `pocInfo[0].name`, which AIO wants joined, so a missing surname is a
    half-named owner rather than a field AIO can report; owner phone → `ownerContactNo` and
    `pocInfo[0].contactNo`, the one that actually failed.
  - **A DBA STREET now requires its city, state and ZIP.** `locationAddress` keys on the street
    alone, so a half-filled DBA address silently becomes an AIO location with three blanks on it.
    It used to be tolerated as "the customer's to finish" and nothing downstream ever made them.
    The DBA address as a WHOLE stays optional — blank still means "same as the legal address".
  **Reps stay lenient, deliberately** (product-owner decision, 2026-10-14): `stripBlanks` carries a
  placeholder for every newly-required field, so `/rep/prospects/new` still blocks only on MALFORMED
  values and a rep working from a HubSpot deal with no owner phone on it can still create the
  prospect. The merchant's form requires them and the gate refuses to attempt without them — so
  nothing fails, it waits where somebody can see it. Which is the other half: `adyenModule` breaks
  out of its state sequence when the validator fails and sends the merchant to their form, because
  the gate's hold is otherwise indistinguishable from "we're working on it".
- **The merchant can repair a tenant-blocking blank from the PUBLIC lead link, with no account**
  (`lib/leadDetails.ts` + `lib/actions/leadDetails.ts` + `components/customer/MissingDetailsDialog.tsx`,
  2026-10-14). It should never fire — the form requires these fields and the gate holds rather than
  failing — but the gap it covers is real and was live: provisioning triggers on PAYMENT, the
  onboarding form is filled AFTER payment, and `prospect_1792016501714` had paid, had
  `customer_user_id` NULL (no account at all), and was holding on one empty phone. The authenticated
  form at `/customer/applications/[id]/edit` was unreachable for them, and the product owner's
  constraint was explicit: they are not re-entering payment details. Four rules:
  - **It is an allow-LIST, not a derivation.** `REPAIRABLE` names the eight paths a public token may
    write: business phone, the owner's name/email/phone, and the three DBA address parts. The legal
    name and legal address are required too and deliberately NOT on it — those are what AIO's records
    say the business IS, and a blank one is a rep-side data problem, not something to invite a
    merchant to type into a modal with no review.
  - **It applies only paths that are BOTH on the list AND currently in error**, so the token can never
    overwrite a value that is already good, whatever the form posts. The action then RE-VALIDATES the
    merged result before saving. A token holder is not necessarily the merchant.
  - **`canRepairFromLead` gates the offer**, so a row also missing something unrepairable falls through
    to the account path instead of getting a CTA that leaves it equally stuck.
  - **`OnboardingModule.publicCta` is what keeps the CTA alive.** `withSignInOverride` rewrites every
    unlocked non-`quote` CTA to "Sign in"/"Create account to continue"; this one flag exempts it, and
    the exemption is the entire point — the merchant it exists for has paid and has no account.
  The action deliberately does NOT push to HubSpot or kick provisioning: the 15-minute cron re-reads
  the row and the gate now passes it, and an unauthenticated route triggering the creation of objects
  AIO can never delete, to save fifteen minutes, is not a trade worth making.
- **Two AIO endpoints are buggy on their FIRST call, and they need OPPOSITE handling.**
  `restaurant/adyen-onboard` returns HTTP 201 `success:true` with `url: ""`, so **success is the
  PAYLOAD, never the status code** — a status-only client hands the merchant a blank KYC link, and
  retrying it is free because it mints a fresh link for the same legal entity.
  `restaurant/post/create` is the opposite and **MUST NOT BE RETRIED AT ALL** (2026-10-14).
  - **A schema-not-ready 500 is NOT a no-op, and the earlier rule assumed it was.** The restaurant
    row IS inserted; AIO just hasn't built the tenant's Postgres schema yet (`relation
    "tenant_N.state" does not exist`). What it leaves is a HALF-CREATED restaurant that shows in the
    tenant's list forever and answers `404 Restaurant not found` on `GET /api/restaurant/{id}`
    permanently. Proven live on tenant 2047: three attempts left 2080, 2081 and 2082; the first two
    still 404'd fifteen minutes later. Nothing can delete them.
  - **So the retry-once-after-2s was a machine for manufacturing undeletable junk.** It is deleted.
    `createAioLocation` makes exactly ONE attempt and throws `AioTenantSchemaNotReadyError` for that
    signature, which exists so the PROVISIONER can tell "too early" from "broken".
  - **The wait moved to `provisionAioTenant`, which can defer across cron ticks for free.**
    `AioTenantIds.locationNotBefore` gates step 2; creating the business sets it to
    `now + SCHEMA_WARMUP_MS` (5 min — observed ~100s once, and the asymmetry favours waiting), and a
    schema-not-ready 500 pushes it out by `SCHEMA_RETRY_MS` (15 min). **A business create therefore
    ENDS the pass** — the location is never attempted in the same run that minted the tenant.
  - **Deferring is NOT failing, and `defer` vs `fail` is load-bearing in three places.** A deferral
    restores `attempts` and `lastAttemptAt` to their pre-claim values, so waiting cannot consume one
    of the five attempts, cannot start an exponential backoff, and leaves `lastError` null so the
    admin sync tripwire doesn't light up for an account that is merely mid-flight. On 2026-10-14 the
    equivalent moment cost one attempt and a ONE-HOUR backoff, and the tenant sat unfinished through
    all of it. The cron reports these as `waiting`, its own counter, never as a failure.
  - **The provisioning cron runs every 5 minutes** (was 15) so that a deferral is cheap: pay →
    tenant on the next tick → location + KYC link ~5 minutes later, one location, no junk.
  - **Do not "fix" this by scanning for the created location and adopting it.** It was designed and
    rejected: `business-list?businessAlias=` embeds restaurants with `name`/`address` and **no id**,
    `GET /api/restaurant` and `/api/restaurant/nearby/{businessId}` are 500 for every tenant, and
    `GET /api/restaurant/{id}` answers `400 "Business not found"` for both a nonexistent id and an
    id whose business is missing — so there is no sound way to enumerate or binary-search them. A
    half-created row is unusable anyway, so there would be nothing worth adopting.
- **`adyenIds.tenantNumber` is the AIO business id, and the settlement ingest builds `prod-{n}` from
  it.** If AIO's store reference is not literally `prod-{businessId}`, the Phase G P&L silently
  stops attributing revenue and nothing alerts. Verify against one real settlement row before
  enabling the flag anywhere real.
- **There is no automatic Adyen KYC completion signal any more.** The webhook went with the rest of
  the integration and AIO exposes no status we can read. A deal reaches `adyen_approved` via a human
  (`markAdyenKycCompleteAction`) or via the settlement backstop (a tenant that settles money is
  demonstrably approved). Don't assume `stage` advances on its own.
- **Marketing-only merchants never get an Adyen module.** They pay us but sell nothing, so KYC would
  sit permanently incomplete. Gated on the existing `isProcessingQuote` — don't invent a second notion.
- `MerchantApplication` has **no SSN, bank account or routing number fields** — Adyen collects those on their hosted page. **The EIN is the ONE exception, added 2026-10-15** (`BusinessInfo.ein`, product owner): the merchant types it on their confirmation step and it is written to the HubSpot Company and nowhere else. It is deliberately NOT forwarded to Adyen, to Check, or onto the Foodbuy form — each of those asks for it themselves and verifies what they are given, and the Foodbuy line sits above an attestation the merchant signs (the merchant types it into the Foodbuy form themselves; see below). The HubSpot write is its OWN PATCH (`updateCompanyEin`), never a sixth entry in `COMPANY_WRITE_PROPS`: v3 rejects the whole request on one unknown property name, so folding it in would take the legal name, legal address, processor and MCC down with it. Property internal name `ein` — **created by hand in the portal and the write VERIFIED live 2026-10-15** (`string`/`text`, group `companyinformation`, matching its four siblings); if it is ever renamed, that constant is the only code change. It had to be made in the HubSpot UI: **neither private app holds `crm.schemas.companies.write`**, so EasyOB can create and archive no property definitions at all, only set values on them. That is worth keeping — schema-write is portal-wide and this was a one-time need.
- `MerchantApplication` has **no bank account or payroll tax fields** for Check either — Check collects those on its hosted pages, same rule as Adyen. EasyOB's own `business.ein` is NOT sent to Check for the same reason it isn't sent to Adyen: Check verifies the one it collects.
- Check's `industry_type` is **its own enum, not an MCC/SIC code** (`restaurant`, `food_and_beverage_retail_or_wholesale`, …) — `check.ts` maps `processing.mcc` onto it, defaulting to `restaurant`. Don't pass a raw MCC through.
- **Foodbuy has no API — don't reintroduce an `adapters/foodbuy.ts`, an onboarding-status enum, or a mint-fresh-link `/continue` route for it.** Enrollment is Foodbuy's signed participation agreement (`AIO_Foodbuy_Enrollment_Form_V1`, 5 pages: participation agreement, acknowledgement & signature, direct manufacturer agreements, locations & distributor accounts, and Sysco's "Limited Liability Controls" letter).
- **The agreement is an in-app form, rendered on the server (2026-10-29, replacing the html2pdf popup, whose screenshot export came out half-blank and cut off).** `FoodbuyOnboardStep.tsx` collects every field: business info, up to 2 contacts, GPO affiliation, one row per distributor per location with the account number, optional direct manufacturer agreements, the customer's Sysco rep, acceptance, print name/title, and a signature drawn on `SignaturePad.tsx`. `lib/foodbuyForm.ts` pre-fills what AIO holds and holds the one validator the browser and both routes share. `lib/foodbuyPdf.ts` (pdf-lib) redraws the original form at coordinates measured from its content streams; the coral logo is inlined from the original (`lib/foodbuyLogo.ts`). Page 4 repeats every 22 locations. Page 5 always prints; the Sysco contact is required only when a distributor row names Sysco. Its Provider block is Foodbuy's fixed contact. **Account Number = `aioTenant.businessId`** (blank until provisioned); Program Effective Date, LoP Agreement Date and Effective Date for Data Exchange = the signing date; Office Use Only stays blank.
- **The EIN on the Foodbuy form is typed by the merchant, every time.** It is never pre-filled from `business.ein` (it sits above an attestation the merchant signs) and never saved: `foodbuyIds.form` keeps the last send's answers to pre-fill a corrected copy, minus the EIN and the signature (`FoodbuySavedForm`).
- **Flow: Review, then Send (2026-10-29).** "Review Agreement" POSTs the answers to `…/foodbuy/preview`, which renders the PDF for the customer to check and download (and sets `foodbuyIds.generatedAt`). "Send to Foodbuy" POSTs the SAME answers to `…/foodbuy/send`, which re-renders on the server (the browser never supplies the PDF) and emails it to the Foodbuy rep set in the drawer at `/admin/users` (table `foodbuy_policy`, migration `0030`) through the existing Graph/Resend bot (`sendFoodbuyEnrollmentEmail`), with Reply-To set to the merchant's contact. Then it files the sent PDF on the HubSpot Company (Files API + note, best-effort, silent). Drafts are no longer filed. The renderer is deterministic (no dates or ids in the file), so `foodbuyIds.sentSha256` makes an unchanged resend do nothing. The PDF is capped at 3MB for sending (Graph's inline-attachment limit). No address set, or migration 0030 not run, means the customer is told to download it and send it to their AIO rep. The address is read via `lib/foodbuyPolicy.ts`, which is deliberately not a `"use server"` file so customers can't call it. The checklist marks Foodbuy in progress once previewed, and complete once sent.
