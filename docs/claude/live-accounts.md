# Live accounts — `/admin/live-accounts` (hidden)

Admin-only, read-only dashboard of which merchants are actually live. **Reachable by URL only**: it is
in no nav, menu or link. `admin/layout.tsx` redirects non-admins and `loadLiveAccounts()` re-checks
the role (`getEffectiveRole`). Rendered on every request (`dynamic = "force-dynamic"`); nothing is
cached. Built 2026-11-19.

## Definition (product owner, 2026-11-19)
- **Ordering is live** when the AIO tenant ran Adyen card transactions in the last 30 days.
  **Billing doesn't decide it** (product owner, 2026-11-19: "if someone is transacting but not paying
  that still counts as live"; originally it also required an active platform subscription). With an
  active (`hs_status` active | past_due) platform subscription it's "Live – ordering, billed";
  without one it's "Live – not billed" (bucket `transacting_not_paying`), still listed under "Needs
  attention" as a billing follow-up. The headline counts both. Paying without transactions is not live.
- **Marketing is live** when the company has an active `AIO Marketing Platform…` subscription **and**
  a COMPLETED post-sale marketing session on the company (`marketingDiscovery`): activity type
  "Marketing Discovery" or "Marketing Catchup", or an untyped meeting titled Marketing Onboarding /
  Marketing Meeting / Marketing Catchup / Brandbook. **Broadened 2026-11-19** (product owner) from
  "Marketing Discovery only": a review of all 26 marketing subscribers found the team rarely uses that
  type, and logs the post-sale work under those titles, with catchups only after discovery (5 → 13
  live). Never counted: the pre-sale `"Discovery Meeting"` (even titled "marketing"), a generic
  "Onboarding Call", a "Marketing Suite" pitch, or a "Declined: …" calendar copy.
- Subscription `hs_name` classification (`classifySubscription`): "Marketing Partial Ordering" →
  ordering; "AIO Marketing Platform" → marketing; names starting "Payroll" → other;
  /Platform|All.in.One|Order & Pay|Pre Auth|Food Truck|Billing Migration/i → ordering; else other.

## Buckets and layout
Buckets: Live – ordering, billed · Live – marketing · Live – not billed (tenant-level; incl. ambiguous,
name-only and unmatched tenants) · Paying, no transactions in 30 days · Paying, no tenant ID in
HubSpot · Marketing paid, discovery not done · Other subscription only. A company paying for both
ordering and marketing appears once on each side.

The page (simplified 2026-11-19, "too many tables") shows the two live counts as headline numbers
(ordering = billed + not billed), then ONE "Needs attention" table (Live – not billed plus the three
non-live ordering/marketing buckets, with a Reason column, largest volume first). The live lists and the suggested HubSpot fixes are collapsed `<details>`.
"Other subscription only" (payroll, hardware, investor) isn't listed.

## Data sources (all READ-ONLY)
- **Adyen activity:** `merchant_daily_actuals`, summed per `tenant_number` for `sale_date` in the
  window (same "sum across report files" convention as `actualsIngest.recomputeMonths`).
- **HubSpot** (reads at the end of `adapters/hubspot.ts`): `listAllSubscriptions` (billing token),
  `searchCompaniesWithProperty` / `batchReadCompanies` / `searchCompaniesByText` /
  `listCompanyMeetings` (general token — it reads 403 on deals, the billing token is needed for
  subscriptions). Meetings are read only for companies with a marketing subscription.
- **AIO dashboard:** `listAioBusinesses()` → `GET /api/business/list`, for tenant **names only**
  (display and name matching). That list is filtered and omits very new tenants, so it must never
  decide whether a tenant exists.
- One source failing renders as a warning banner; the rest of the page still loads.

## Matching tenant → company (`lib/liveAccounts.ts`, pure, unit-tested)
1. `TENANT_COMPANY_OVERRIDES` (tenant → company id), applied first. Seeded 2026-11-19 with 11 pairs
   verified by restaurant address. **Exists only until the HubSpot Tenant Id fixes are made** —
   delete an entry once its company carries the right tenant id.
2. Tenant id: the company's `tenant_id`, **falling back to** `migrated_00nfi00000bnezluan` only when
   `tenant_id` is blank or a `(Stage)` value. Formats `prod-1024`, `1024`; `4 (Stage)` is ignored.
   Two companies with the same number → "ambiguous", candidates listed.
3. Name match, only when 1–2 found nothing: Dice token overlap ≥ 0.6 between the AIO business /
   restaurant names and HubSpot company names (lowercased, accents and punctuation stripped, filler
   words like the/inc/llc/co/restaurant/cafe/and/of/kitchen/grill dropped), same city ranked first.
   Always shown as **"name match — suggested"** and never makes an account live.

**Why `tenant_id` beats the migrated property (found 2026-11-19).** 43 companies had both set; 20
disagreed, and in those the `tenant_id` value was the one AIO's business list names after the
company, while the migrated value mostly matched no AIO business (an old Salesforce-era number,
often the Adyen store number). Matching on both produced backwards fixes such as Lajevard
"prod-1297 → should be 1252".

**Store ≠ tenant.** An Adyen store number is a different number space from the AIO tenant id and is
never compared. On 2026-11-19, 23 of the 81 `tenant_number` values in the 30-day window were not in
AIO's business list — several (46, 397, 1167, 1223, 1249, 1252, 1253, 1260) are the same numbers
held in the migrated property, i.e. store-style numbers, not tenants (the rest may be tenants too
new for the filtered list). A parallel ingest fix makes `tenant_number` the true tenant id; until
it lands those merchants show as "Transacting, not paying" plus "Paying, no transactions".

## Suggested fixes
For each company confirmed by override or tenant id whose stored tenant number isn't the matched one:
"Tenant Id is X → should be T", or "Set Tenant Id = T" when blank. Name-matched companies get the
same line suffixed "(name match — verify first)". Nothing is written; fixes are made by hand.

## First run (2026-11-19, real data, ~16s)
Live ordering 21 · live marketing 5 · transacting not paying 60 (25 name-suggested, 25 unmatched,
9 company not paying for the platform, 1 override) · paying no tx 41 · paying no tenant 11 ·
marketing sales-type discovery 5 · marketing no discovery 16 · other only 2 · fixes 29. (Before the
ingest fix and re-ingest; after them, the HubSpot Tenant Id fixes and the broadened marketing rule
the same day: ordering 62 billed + 19 not billed = 81 (every transacting tenant), marketing 13.)

## Files
`lib/liveAccounts.ts` (pure) · `lib/liveAccountsData.ts` (server-only loader) ·
`app/admin/live-accounts/` · `lib/__tests__/liveAccounts.test.ts` · reads appended to
`adapters/hubspot.ts` and `listAioBusinesses` in `adapters/aioDashboard.ts`.
