# HubSpot and billing — publish, acceptance, deals, company data

## The Phase E gate run (2026-08-24) — the reference evidence

The one human-run live publish, executed by clicking **Retry HubSpot sync** on the admin accounts
dashboard for `prospect_1787098151325` ("bob"). Read back from HubSpot, not from our own row. This is
the record to compare against when the publish path next changes:

| | |
|---|---|
| quote | `323970722493`, `hs_status: APPROVAL_NOT_NEEDED` (the published state, spec §181) |
| deal | `343689933538` — **created by the send itself**, see `sendQuoteAction` below |
| contact | `540176122579` |
| `hs_quote_amount` | `3811.00` = $3,712 one-time + $99 first weekly |
| `hs_quote_link` | `https://customers.aioapp.com/0f2hv0e1fjzk9q` (voided by hand afterwards, per `PAYMENT-TEST-PLAN.md` §2.2) |
| flags | `hs_payment_enabled: true`, `hs_esign_enabled: true`, `hs_allowed_payment_methods: ACH`, `hs_acceptance_method: esignature` |
| associations | **67** ×9 line items · **64/1393** deal (1393 added by HubSpot at publish, as documented) · **702/69** contact · **286** template `817263673055` (AIO Quote v3) · subscriptions **none** (correct until checkout) |

Confirmed by this run: the deliberate-NULL `hs_recurring_billing_period` behaviour, the template
fallback when `quote_template_policy` is empty, and that the whole association graph holds together
live. Surfaced by this run: the `hs_sender_email` blocker (closed 2026-09-25) and the
verbatim-`quoteLines` hazard, both constraints above.

## Constraints (do not reverse)

- **Publishing a HubSpot quote is a one-way door.** No API edit (400 `LOCKED`), no delete (`PUBLISHED_QUOTE_CANNOT_BE_DELETED`), and no void — setting `hs_status: VOID` is itself an edit, so voiding is HubSpot-UI-only. **The void half is LIVE-VERIFIED 2026-10-14** (it had only ever been asserted): `PATCH hs_status: VOID` on published quote `333972700885` answered `400 Validation Error: Published Quote cannot be edited`, `subCategory: LOCKED`, `context.lockReason: ["Published"]`, and left the quote untouched. The refusal is about the object's published state, not scopes — a different token or a wider scope changes nothing. Never build an "unpublish", "edit published quote", or "re-publish" affordance; `sendQuoteAction` refuses once `publishedAt` is set, and BOTH `saveQuoteConfigurationAction` and `EditQuotePanel` freeze on `publishedAt` as well as on `quoteAcceptedAt` — publishing now happens first, so there is a window where the document is live and unamendable but nothing is accepted yet. A `400 LOCKED` from `publishQuote` means **already published** and must be treated as success, or a crash between HubSpot's ack and the DB write wedges the account forever.
- **A quote template that AIO deactivates stops working IMMEDIATELY, and HubSpot only says so at the association.** `POST`ing association 286 to an inactive `quote_template` is a 400 `ASSOCIATION_TYPE_SPECIFIC_VALIDATION_FAILED` — "Quote template is not active" — which is step 4 of 5, *after* the contact, the line items and the draft quote exist. Found live 2026-10-09, when "AIO Quote v3" (`817263673055`) was retired for **v4 (`854670598854`)** and the next build stranded 13 line items and draft quote `333345545954` behind it. So: `DEFAULT_TEMPLATE_IDS` is now v4, `resolveQuoteTemplate()` resolves the id **and its `active` flag** together off a live list (not the admin page's TTL cache — the flag changes exactly when a stale cache would be wrong), `canPublishBillingQuote` refuses `template_inactive` before the first write, and `updateQuoteTemplatePolicyAction` refuses to SAVE an inactive one — which **reverses** the earlier rule that an inactive template was still selectable. The list still *shows* inactive templates, so an admin can see what their policy is pointing at. A stranded build is recoverable: the persisted ids are reused and the association re-run, so re-pointing the policy and retrying publishes the same draft rather than a second one. Nobody tells EasyOB when a template is retired, so `auditQuoteTemplatePolicy()` runs as a third pass of the nightly `/api/cron/hubspot-links` and reports a stale policy as a **failed cron run** (a quiet field in a 200 is a field nobody reads). It alerts and never heals — which template replaces a retired one is a human's call, and the region-split marketing pair is the proof. `marketing_term` defaults to **BAY AREA ONLY** (`854671277804`); HubSpot carries an equally active OUTSIDE BAY AREA twin (`850518393534`) and EasyOB has no region to choose between them with. **Superseded 2026-10-27:** `marketing_term` is retired, and every plan defaults to **AIO Quote v4** (`854670598854`) — Elizabeth Phillips: "easy OB should use quote template v 4 for everything and it should just be a blank quote". The `quote_template_policy` table was empty when this changed, so the defaults are what publishes.
- **`hs_recurring_billing_period` is DELIBERATELY never written.** It is a contract *term*, not the billing cycle — HubSpot derives `hs_recurring_billing_number_of_payments` from it, so `P7D` on a weekly line takes one $99 charge and then silently stops collecting. 935 of AIO's 1,200 live weekly line items leave it NULL. `PHASE-E-SPEC.md` §3.3 says to send `P7D`; the spec is wrong. Product-owner decision, 2026-08-21. **LIVE-VERIFIED 2026-08-24** on quote `323970722493`: the weekly platform line came back `hs_recurring_billing_period: NULL` / `hs_recurring_billing_number_of_payments: NULL`, while all eight one-time lines got `nPayments: 1`. That is HubSpot deriving the payment count from the period, observed directly — the mechanism is no longer inferred.
- **`hs_sender_email` is NOT validated by HubSpot, so EasyOB validates it — CLOSED 2026-09-25.** HubSpot accepts any string: the 2026-08-24 gate run published with `rep@aioapp.com`, a seeded dev row that is not a portal user, not a mailbox, not anything, and there was **no 400 and no warning**. A wrong value is therefore invisible until a real merchant receives their quote "from" an address nobody owns, on a document that cannot be edited, voided or re-sent. Entra sign-in (Phase 5) narrowed it — a rep who signs in through Entra necessarily has a real tenant address — but never closed it, because `rep@aioapp.com` remains a valid `owner_user_id` and the debug role switcher writes as that row. The fix: `resolveSender` (`publishBillingQuote.ts`) now takes `users.email` only as a CANDIDATE and resolves it against the portal's own user list via `findOwnerByEmail` (`adapters/hubspot.ts`, `GET /crm/v3/owners?email=`), and **HubSpot's spelling of the address and name wins** over ours, so the two cannot disagree. Three distinct refusals, because they need three different people to fix them: `no_sender_email` (no address on the `users` row), `sender_not_hubspot_user` (an address the portal has never seen), `sender_unverified` (the lookup itself failed). **"Could not check" is refused exactly like "wrong"** — the door is one-way, so there is no fall-through to publishing unverified. O-1 (`PAYMENT-TEST-PLAN.md`:249) is explicit that all 46 live paid quotes use a real rep address, and archived owners are excluded for the same reason.
  **This needs the `crm.objects.owners.read` scope on the `EasyOB Billing` private app. GRANTED and VERIFIED 2026-09-25** — before that both apps 403'd `MISSING_SCOPES` and every send refused `sender_unverified`. Checked through the shipping `findOwnerByEmail`, not a curl: `shaheer.hasnain@aioapp.com` → owner `161790722`, `joe@aioapp.com` → owner `166240618`, while `rep@aioapp.com` and `admin@aioapp.com` come back a clean null. That last pair is the point — the lookup DISCRIMINATES rather than passing everything, so the seeded dev rows would still be refused `sender_not_hubspot_user`. Which is now the practical constraint on local testing: the **debug role switcher writes as `rep@aioapp.com`**, so a deal configured under it refuses at checkout. Test the merchant checkout path on a deal owned by a real Entra-linked row.
- **A published quote carries `app.quoteLines` VERBATIM — `publishBillingQuote.ts:211` never calls `buildQuote()`.** Derivation happens at *save* time in the configurator. So a row saved before a change to the derivation rules publishes under the OLD rules, silently. Two rows accepted 2026-08-18 are $1,498 short each (no Onsite Installation, no System Onboarding and Training) because they predate `272f58b`/`c65b4b1`, and `canPublishBillingQuote` does not catch it — it verifies the *platform* line resolves, never that the included services are present. Any backfill of pre-existing accepted rows must re-derive through `buildQuote()` first, or it publishes an under-priced quote onto a document nobody can amend.
- **Billing completion is gated on the SUBSCRIPTION, never on the quote's `hs_payment_status`.** The subscription appears 1–9 minutes after checkout; `PAID` lags it by a median of **5.7 days** (daily ~12:00 UTC ACH batch). Gating on `PAID` tells a merchant who already paid to "Review & Pay" for most of a week. Same reason the nightly cron's lookback is **10 days**, not 3.
- One quote yields **one subscription per distinct billing frequency**, so AIO's weekly-platform + monthly-add-on mix routinely produces two. Hence `hubspotIds.subscriptions[]` and `findSubscriptionsForQuote` (association **304**), never a single id, and never a deal-keyed lookup — a reused deal carries subscriptions from earlier quotes.
- `hs_quote_link` is **not** a one-time-use link, unlike the Adyen and Check ones — the slug exists at create, the URL is predictable, and auth is `public_access`. `/customer/applications/[id]/billing` is **read-or-refresh, not mint-per-click**. Don't "fix" it to match its two `/continue` siblings.
- `hs_quote_link` can lag the publish by **far more than** `publishQuote`'s one 3s settle wait — 18s seen live on 2026-10-29, leaving `publishedAt` set with `quoteLink: null`. `/api/lead/[token]/checkout` re-reads the link for a published row instead of falling through to the orchestrator (which only answers `already_published`), and `ConfirmDetailsForm` treats `link_pending` as a redirect to the quote page, not an error.
- A **rate-only quote** (empty `quoteLines`) creates no HubSpot billing objects at all and its checklist module is **omitted**, not shown pending — processing margin comes out of Adyen settlement and the catalog's processing products are $0 placeholders. Discriminate on `quoteAcceptedAt`: empty lines *before* acceptance just means the rep hasn't configured it yet.
- **No HubSpot Company linked → no deal, no billing quote, nothing.** A deal's company association (341) is only settable on the deal CREATE — the v3 PATCH takes properties only — so a deal pushed before `tenantLink.hubspotCompanyId` exists is orphaned off the Company record permanently. Every push site gates on `canPushToHubSpot()` (accept route, both customer-side saves, `sendQuoteAction`), `pushToHubSpot` itself throws as the backstop, and `buildAndPublishBillingQuote` short-circuits `awaiting_tenant_link` **before the build claim** so waiting leaves no `lastSyncError` — an unlinked account is normal, not a failure, and counting it as one floods the admin sync-error tripwire. `canPublishBillingQuote` restates it as `no_tenant_company` because that reason names the fix. The resume is `linkTenantCompanyAction`, which creates the held-back deal and publishes the quote right there — **so linking a company can open the one-way door**. That is intended (user's decision, 2026-09-10).
- **THERE IS EXACTLY ONE ACCEPTANCE, and EasyOB does not own it.** Changed 2026-09-24 (product-owner decision). The merchant used to accept in EasyOB ("Accept & Create Account") and then accept *again* on HubSpot's hosted quote, which is where the e-signature and the ACH mandate are actually collected. Entering billing details IS accepting the quote, so:
  - **THE MERCHANT OPENS THE DOOR, BY CONFIRMING THEIR OWN DETAILS — 2026-10-15, product owner, and this reverses the 2026-10-13 publish-at-send bullet (quoted below for the history).** `publishAtSend` is **DELETED** from `createProspectAction`: a rep sending a lead link now publishes **nothing**. The merchant lands on their quote summary, goes to `/lead/[token]/confirm`, checks and corrects what AIO holds about them, and **confirming** is what builds and publishes. The reason is the one-way door itself — the rep typed the billing contact and the addresses from a HubSpot deal, and publishing at send time froze their typo onto a document that cannot be edited, replaced or voided, while locking the rep out of their own quote at the same moment. Six things are load-bearing:
    - **`merchant_applications.detailsConfirmedAt` IS THE LOCK**, and it is the EARLIEST of the three freeze markers: confirm → `hubspotIds.publishedAt` (seconds later) → `quoteAcceptedAt` (days later, when they sign and pay). `saveQuoteConfigurationAction` and `EditQuotePanel` check it FIRST and refuse on it; `AccountsDashboard` hides "Edit Quote" on it. The older two markers stay beneath it rather than being replaced — rows published under the 10/13 rule have no confirmation at all and never will.
    - **BOTH public doors gate on it** — `/api/lead/[token]/checkout` (`not_confirmed`, 409) and `/api/lead/[token]/accept`. The accept gate is NOT inherited reasoning: a rate-only quote builds no HubSpot document, but accepting starts that merchant's onboarding and AIO's tenant create 400s outright on a blank phone, and those merchants never pass through a HubSpot checkout that would have collected anything. In both routes the gate sits BELOW the idempotent already-published / already-accepted return, so legacy rows are still served.
    - **EVERY BOX ON THE CONFIRMATION FORM IS REQUIRED, and those rules live in `leadConfirm.ts` ALONE** (2026-10-15, product owner). `confirmationOnlyErrors` adds the DBA, the entity type, the EIN (nine digits, shape-checked — nothing downstream verifies this one, since Adyen and Check each collect and verify their own), the owner's title, and the whole billing contact ON TOP of `validateOnboardingFields`. **They must never migrate into that function**: it is what `isReadyForAioProvisioning` runs, so a field added there is a field every ALREADY-PAID row is suddenly missing, held at `missing_business_details` forever for want of an EIN nobody had ever been asked for — and it is what the rep form checks through `stripBlanks`, where reps stay lenient by standing decision. These are requirements of the MOMENT: the merchant is in front of the form with every box on screen. Two consequences: ticking "same as the owner above" posts an all-blank billing contact, which reads as null and IS an answer (demanding four more boxes for a person already named would be asking them to type it twice); and the submit button is DISABLED until the form is complete, so `missingConfirmationFields` renders the outstanding list beneath it — a dead button on a form that cannot be submitted to find out why is the standing failure of submit-only validation. That list qualifies by panel (`SECTION_OF`) because the form asks for a city twice and a first name twice, while the boxes themselves keep the short label their heading already disambiguates.
    - **Confirm-details panel order (2026-10-29, product owner: "billing contact first"):** Billing Contact is the FIRST panel, ahead of Your Business / Legal Address / Owner & Signer. Pure reorder; the checkbox copy now reads "Same as the owner below". No focus/scroll logic exists in `ConfirmDetailsForm.tsx` to keep in step.
  - **`lib/leadConfirm.ts` WIDENS what a public token may write, deliberately.** `applyLeadConfirmation` applies every allow-listed path **whatever its current value**, where `leadDetails.ts`'s `applyLeadDetails` applies only paths currently IN ERROR. That rule is right for a repair dialog and would make this step useless — a rep's typo of a billing email looks perfectly valid. So `CONFIRMABLE_PATHS` is the ONLY fence, and what it leaves out is the whole of the protection. Both modules survive: `leadDetails.ts` still covers rows that paid under the old rule and are holding on a blank.
    - **COPY IS A PLAIN "Continue" (2026-10-21, product owner).** The confirm form's old two-step "Ready to lock this in?" panel and the quote page's "Accept & Create Account" / "Review & Confirm Details" wording read as negotiable, so the form now has one "Continue" button that saves, builds and redirects; the "Creating your quote... 10-30 seconds" overlay is KEPT. The rep form calls the operating address "DBA address" too (one concept, still `business.dba*`). Entity labels come from `bizTypeLabel` (`LLC`, never `Llc`).
    - **VOLUME AND AVERAGE TICKET ARE SHOWN LOCKED, never editable.** They are the pricing basis — `/rep/prospects/new` derives `quoteConfig` straight from them — so they drive the rate matrix, `getMarginFloor` and `MIN_MONTHLY_PROCESSING_REVENUE`. A merchant who could move them would re-price a quote the rep had already cleared both floors on, seconds before an irreversible publish. Showing them is the point: the rep can still change them, because nothing is published until confirmation. Card rates, margin and products are absent entirely.
    - **Confirmation runs the STRICT `validateOnboardingFields`**, so a confirmed row is a provisionable row. This closes the ordering that broke `prospect_1792016501714` by construction: the form now comes BEFORE the payment, not after it.
    - **A LINK WITHOUT A QUOTE IS NOT SENDABLE** ("there is no situation where the rep hasnt made the quote because they cant send the initial link without making it"). That was the intent all along and nothing enforced it — an `all_in_one` quote with nothing picked, no channels and no volume resolves `none_needed`, derives zero lines, and sailed through every block, so the merchant got a link to "your quote is on its way". `createProspectAction` now hard-blocks on `hasQuoteBasis`, mirrored client-side on the rep form (restated, not called — `leadQuote.ts` imports `pricing.ts`, and bundling `MARGIN_REQS` into a client page is the hazard the margin-floor block is written the long way to avoid). The lead page's "still preparing" branch is KEPT despite being unreachable for new rows, because older rows can still be in that state.
    The "go straight to billing" CTA on the lead email is **gone** with the publish that produced its `hs_quote_link`, and so is `Template.secondary` in `adapters/email.ts`. The 2026-10-13 bullet, kept for the history: "THE REP OPENS THE DOOR AGAIN, at link-send time — reversed 2026-10-13, product owner. `createProspectAction` attempts the same build-and-publish the instant a rep creates a prospect and its lead link goes out — via `publishAtSend` — before the merchant has opened anything. Best-effort and silent; a real refusal or HubSpot error lands on `hubspotIds.lastSyncError`. 'Continue to Billing' remains the fallback for whatever wasn't publishable at send time." And the 2026-09-25 bullet beneath it: "THE MERCHANT OPENS THE DOOR, not the rep. The rep used to publish first with 'Send Quote to Customer', and until they clicked it a merchant who opened the link *the same rep had just emailed them* saw 'your quote is being finalised' and could do nothing. 'Continue to Billing' on `/lead/[token]/quote` POSTs `/api/lead/[token]/checkout`, which builds and publishes the quote on the spot and returns `hs_quote_link` to redirect to."
  - **Nothing from `canPublishBillingQuote` is ever shown to a merchant.** Those messages name AIO's internals and address a rep. The route answers one neutral code (`not_ready` / `link_pending` / `rate_only` / `no_quote`) and writes the real reason to `hubspotIds.lastSyncError`. It records refusals that the orchestrator deliberately does not — see the note under `buildAndPublishBillingQuote` below: an account waiting on a company link is normal, but an account waiting on one *with a merchant standing at the door* is not, and only the customer-triggered entry point persists it.
  - `sendQuoteAction` **survives as the staff escape hatch** ("Publish Quote Now" on the billing panel), for a rep sitting with the merchant or finishing on the phone. With the 2026-10-13 reversal above it is now the THIRD possible path to a publish (after link-send and the merchant's own checkout), not the first — unchanged in every other respect, because the one-way door and `publishQuote`'s `400 LOCKED`-means-already-published rule make a second or third attempt on an already-published quote a no-op, not a risk. Its deal-backfill moved out to `lib/billing/ensureDeal.ts` so both entry points share one copy — a legacy row with no `hubspotDealId` would otherwise be recoverable from the rep's side only, and refuse the merchant `no_deal` forever.
  - `/lead/[token]/quote` links **straight to `hs_quote_link`** once published. It never surfaces a draft's link — `publishedAt` is the gate, same rule as the authenticated billing route — but an unpublished quote is no longer a *wait*, it is simply one nobody has pressed the button on.
  - **SIGNING AND PAYING ARE SEPARATE ACTS on the same HubSpot page, and only the second one accepts.** A merchant can sign and abandon the checkout, leaving them convinced they are done in front of a checklist where every row is locked. `hs_quote_esign_status` is therefore read into `hubspotIds.esignStatus` at every snapshot write, and `hasSignedWithoutPaying()` (`onboardingModules.ts`, expressed over `hasBillingCompleted` so the two can never disagree) drives: a warning banner above the checklist on both hosts (`checklistNotice`), a lock message that says "billing details" rather than "sign your quote", and its own panel on the quote page. Observed live 2026-09-25 on quote `330655913691`: `SIGNED` / `hs_payment_status: PENDING` / no subscription.
  - acceptance is **detected** in `lib/billing/acceptance.ts` from `hasBillingCompleted()` — the SAME predicate the checklist and AIO provisioning use, deliberately reused so they can never disagree. It sets `quoteAcceptedAt`, advances the deal, and emails the account-creation link. Idempotent on `quoteAcceptedAt` and it **never throws** (it runs inside a billing refresh whose try/catch means "the HubSpot read failed").
  - three observers call it: the nightly cron, `/lead/[token]` (via `lib/billing/leadRefresh.ts` — the only way a merchant with no account yet gets noticed promptly), and the authenticated dashboard refresh.
  - **`/api/lead/[token]/accept` survives for RATE-ONLY quotes only** and refuses everything else with `409 billed_quote`. A rate-only quote builds no HubSpot document, so there is nothing to sign, no checkout and no subscription that could ever signal acceptance — that button is those merchants' only one, not a duplicate. "Email Me a New Link" still POSTs the same route and still creates no CRM state (`firstAcceptance`).
  - `PublishBillingQuoteOptions.acceptedByEmail` is **GONE**. The signer is `ownerContact.email` only; a row without one refuses `no_signer_email`, which names the fix. There is no "whoever opened the link" fallback, and the 2026-09-25 change does not bring one back: the merchant clicking "Continue to Billing" is not necessarily the authorized signer, and on a financial mandate the contact of record beats whoever opened the link.
- `hubspotDealId` (the flat column) is the canonical deal id. `HubspotIds` deliberately has **no** `dealId` — two homes would create a second deal per application.
- **A QUOTE STARTS AT THE DEAL, and the company is read OFF it** (2026-10-01, product owner). Every HubSpot deal carries an `easyob_link` property pointing at `/rep/prospects/new?hubspotCompanyId={id}&hubspotDealId={id}`; `openProspectFromDealAction` takes the deal id, derives the company from the deal's own association, and returns deal + company + prefill in one call. So **`/rep/prospects/new` no longer has a company search or a `DealPicker`** — there is nothing left to pick, and every pick was a chance to hang a merchant's quote off a stranger's record. The only thing left is a paste-a-deal-link field, which is NOT a picker: `getDealById` is a direct GET, so it can neither lag nor offer another company's deal. It exists for the window between a rep creating a deal in HubSpot and the nightly cron stamping its link. Two refusals are specific to this entry point: a deal with NO company can't start a quote at all (the company IS the tenant link, and association 341 is only settable at deal create), and a deal on TWO companies is ambiguous about which merchant this is. Everything else is `resolveDealForCompany`'s existing validation, re-run rather than reimplemented.
  - The link moved from the Company to the Deal in `f8c676d`, and the backfill was run on 2026-10-01: **603 of 615 deals** stamped, **30,714 companies** cleared of the old company-level link. The 12 unstamped deals have no company on them.
  - `DealPicker` still exists and is still used by `AccountsDashboard`, where the job is ADOPTING a deal onto an application that already exists. Its name search is scoped to ONE company, and `searchDealsByName` requires a `companyId` for that reason: it was once portal-wide, sitting directly under a list of the company's own deals, so typing a name there offered other restaurants' deals. It is NOT the escape hatch for a deal the index hasn't caught up with — it runs on the same lagging `deals/search` index the list does; `getDealById` is that escape hatch.
- **HubSpot's `processing_volume` IS read into `processing.monthlyVolume` — and since 2026-10-18 also WRITTEN BACK (`COMPANY_WRITE_PROPS.processingVolume`, beside `average_ticket`), so a rep's typed volume replaces HubSpot's. Restored 2026-10-14, after one day out (product owner: "pull the monthly volume and avg ticket from hubspot. (ik i undid this before)").** This has now been reversed twice, so both sides are recorded. The DATA was never in doubt: `processing_volume` ("Processing Volume $") is real and genuinely populated — 27 companies on 2026-10-14, 24 on 2026-09-25, both checked against the live portal — and its near-namesake `monthly_card_volume` is the empty one (0 rows) and remains deliberately NOT read, because an empty property is worse than no property: it looks authoritative. The argument for removing it on 2026-10-13 also still stands on its own terms and is the thing to weigh if this comes up a third time: a prefilled figure is indistinguishable from an answer the rep actually gave, and `monthlyVolume` feeds both the rate matrix (picks the card-present rate) and the margin floor (can refuse the quote), so a stale value silently prices the deal. What makes it a prefill rather than a silent seed is `prefillMerge.ts`'s rule — the field is HubSpot's until the rep types in it, and the Review section badges it "from HubSpot" only while the value is still HubSpot's — so `processing.monthlyVolume` must stay in `REVIEW_FIELD_PATHS` and out of `UNKNOWABLE_REVIEW_FIELDS` (which would claim HubSpot has nothing, and that is false).
- **SUPERSEDED 2026-10-18: average ticket now lives on the Company as `average_ticket`** (number, `companyinformation`, created by hand by the product owner). It is REQUIRED with monthly volume on every processing quote at prospect creation (form hard block + `createProspectAction`), written back by `syncCompanyDetails` via `COMPANY_WRITE_PROPS.averageTicket` (digits only — one bad value fails the whole PATCH), and prefilled from it on the next quote. History follows: **AVERAGE TICKET CANNOT BE PULLED FROM HUBSPOT — there is no such property.** Asked for alongside monthly volume on 2026-10-14 and checked live: no average-ticket property exists on COMPANY or on DEAL in portal 244508708, and the nearest candidate, "Average Orders per Day" (`migrated_00nfi000009tl34uaa`), is populated on **zero** companies — so deriving a ticket as volume ÷ orders would never produce a value either. Average ticket therefore still comes from the statement analysis or the rep's own entry, and stays in `UNKNOWABLE_REVIEW_FIELDS`. Closing this needs a new custom HubSpot property that somebody then fills in; it is not a code change.
- **EVERY HubSpot deal write lands when the quote is PUBLISHED (product owner, 2026-10-30: acceptance
  was "too late", "it should be uniform").** Right after the publish is persisted,
  `buildAndPublishBillingQuote` runs `syncDealFromApplication(app, { dealstage: QUOTE_SENT_DEAL_STAGE })`
  (name/amount on EasyOB-created deals, stage → HubSpot's **"Quote Sent"** `3634617027`, still
  forward-only, `payment_processing_arr`, `modules_used`, hardware commission), then
  `writeCommissionToDeal` and `attachQuoteSummaryToDeal`. All of it fire-and-log: a failed deal sync
  goes to `lastSyncError` and the publish still reports `published`. Acceptance still runs the deal
  sync (moves the stage on to Signed/Awaiting Payment Info and refreshes the rest) but no longer
  files the PDF. `STAGE_MAP.quote_sent` deliberately still says Discovery Meeting: EasyOB's
  `quote_sent` is set when the lead link goes out, before any HubSpot quote exists. Rate-only
  quotes never publish, so they keep the acceptance-time writes. Quotes published before this
  change get nothing until acceptance.
  - **The stage ALSO moves to "Quote Sent" when the rep's lead link goes out with a quote on it
    (product owner, 2026-10-30: "When quote gets sent, move deal stage to 'Quote Sent' (if deal is
    in sales meeting 1 or 2)").** "Sent" = the lead link reaches the merchant; "sales meeting 1 or 2"
    = Discovery Meeting `2717103849` and Demo Meeting `stage_0`. `moveDealToQuoteSentAtSend` reads
    the live stage and PATCHes `pipeline` + `dealstage` ONLY when `shouldMoveToQuoteSentAtSend` says
    the deal is at exactly one of those two — stricter than the forward-only guard, so a blank,
    unknown, Quote Sent or later stage is never touched, and a failed read writes nothing. Called
    from `createProspectAction` and `resendLeadLinkAction` right after `deliverLeadLink`, only when
    the email or SMS reported `sent` and the row has a `hubspotDealId` (resend: also only when
    `hasQuoteBasis`, i.e. the `quote_sent` case). Fire-and-log, same as the billing-notes push.
    `issueCustomerQuoteLinkAction` (the proposal wizard's copy-the-link terminus) delivers nothing,
    so it moves nothing. `STAGE_MAP.quote_sent` is unchanged; a later deal sync mapping it to
    Discovery is dropped by the forward-only guard, so it can't drag Quote Sent back.
- **Hardware Revenue / Total Hardware Discount / Hardware Cal are HubSpot CALCULATED deal properties**
  (`hardware_revenue`, `total_hardware_discount` = rollups; `hardware_cal` = `hardware_revenue`), read-only
  through the API. Verified 2026-10-30 against a pre-split deal: they sum the `amount` / discount of the
  deal's `hs_product_type = inventory` line items. Split billing (2026-10-23) moved one-time lines onto the
  one-time invoice, so HubSpot's quote→deal line copy stopped carrying hardware and the rollups went empty.
  Fix (product owner, 2026-10-30): at publish, `createDealLineItems` creates copies of the invoiced lines
  directly on the deal (association **20**, line item → deal). Once per row, fire-and-log. A product with no
  `hs_product_type` (Customer Facing Display, 2026-10-30) is invisible to the rollups — that is HubSpot data.
  Backfilled on the three split-billed deals published before the change.
- **Hardware commission (`rep_commission` / `rsm_commission`, deal, dollars) defaults to 60% / 10% of
  the MARGIN** for a one-time hardware line whose product has no rate on file (product owner,
  2026-10-30). `DEFAULT_HARDWARE_*_BPS` in `commission.ts`; "hardware" = productType not Software or
  Service. A product's own rate still wins, services with no rate still earn nothing, and a line
  with no `cost_to_rep` still earns nothing (`no_cost`) — POS Unit and Customer Facing Display had
  no cost on 2026-10-30. Written only when `HARDWARE_COMMISSION_WRITEBACK_ENABLED` is exactly
  `"true"`; the product owner asked for it on every deal on 2026-10-30, but the prod var (it exists,
  value hidden) has to be set to `true` by hand.
- **`payment_processing_arr` is written once the quote is PUBLISHED** (gated on
  `hubspotIds.publishedAt`; was acceptance until 2026-10-30, product owner chose this knowing
  `total_arr` will now include quotes that never close), re-written at acceptance, and kept true by a
  NIGHTLY BACKSTOP in `/api/cron/hubspot-billing-sync` (`syncProcessingArr` → `planProcessingArrWrites`):
  every published deal whose HubSpot value is missing or differs from EasyOB's figure is batch-written
  (product owner, 2026-10-30: "this needs to be standard"). Added because the two "Shaheer's 3rd Test"
  deals had been accepted via the debug bypass, which never syncs the deal, and so never got it. It is
  `appliedTargetMargin × monthly volume × 12` (product owner, 2026-10-12), computed from the TRUE
  margin — this is AIO's own forecast of AIO's own revenue on a record reps already read, and
  padding it would make the number wrong rather than make a secret safe; the FLOOR is the secret and
  is not derivable from it. Marketing-only quotes and quotes with no volume are OMITTED, not zeroed:
  this property feeds HubSpot's calculated `total_arr`, and a 0 there reads as a measured zero. `saas_revenue` is deliberately not written.
- **`modules_used` ("Modules Used", deal checkbox) is OVERWRITTEN on every deal sync** (product
  owner, 2026-10-29) from `buildDealProperties`: Marketing = All-in-One, Marketing Only, or Partial
  Ordering with the marketing line; Website / Payroll = that line is on the quote; POS/Payments =
  every processing plan, Partial Ordering included (no POS, but it takes payments). Full replace, so
  a rep's hand ticks the quote doesn't back are cleared. Omitted while `quoteType` is null. The
  older `moduels__cloned_` ("Modules (Deals)", 11 options) is deliberately not written.
- **"Is this deal closed?" is NOT "is this deal past Closed Won?"** AIO's Sales pipeline runs
  Onboarding, Onboarding Delayed, Configuration, Deployment/Training and Deal Active AFTER
  `closedwon`, and HubSpot flags every one of them `closed: false` — so until 2026-10-12 a rep could
  start a quote on a merchant already signed, implemented and being billed. `isAtOrPastClosedWon`
  (rank-based, so a stage inserted later is picked up automatically) refuses those;
  `allowClosedWon` still excuses a deal sitting at exactly Closed Won, and must not be widened to
  excuse the ones past it. An unrecognised stage ranks -1 and passes, which is `dealStageRank`'s
  standing convention — a new stage must not lock reps out of quoting until someone redeploys.
- **HubSpot's Company `address` is the OPERATING address, and it seeds nothing else** (product
  owner, 2026-10-12). The HubSpot Company IS the restaurant. It used to seed the legal address as
  well, on the grounds that the portal has no separate one — which passed the restaurant's own
  address off as the registered one, on the form whose whole purpose is to state what the state has
  on file and which Adyen and Check then verify. The merchant supplies the legal address on their
  onboarding form (`validateOnboardingFields` requires it) and
  `saveMyApplicationOnboardingAction` writes it back. Three consequences:
  - **The portal has a legal STREET and a legal CITY and no legal state or ZIP**
    (`legal_street_address_as_registered_with_government`, `legal_city_...`). EasyOB holds all four;
    it writes the two that exist rather than cramming the others into a property labelled otherwise.
  - **The legal address is PUSHED from both sides and READ BACK from the legal properties only**
    (2026-10-12). The merchant's onboarding form sits behind a customer account, which only exists
    after they have paid — so until a rep could send it too, those properties stayed empty through
    the entire pre-sale. `syncCompanyDetails` (prospects.ts) now sends `legalStreet`/`legalCity`
    alongside the legal name, processor and MCC, at prospect creation and at quote save; blanks are
    left out by `updateCompanyMerchantDetails`, so the usual case — the rep leaving those fields to
    the customer — writes nothing and erases nothing, and whoever answers later wins.
    `buildProspectPrefill` then reads them back, so a SECOND quote on the same company doesn't ask
    again. **This does not relax the rule above**: the prefill reaches `legalStreet`/`legalCity` and
    never `company.address`. Street-gated like the operating address, and state and ZIP stay blank
    for the onboarding form to collect, since the portal has nowhere to keep them.
  - **`createAioBusiness` reads `locationAddress(biz)`, not `biz.address`.** It read the legal one
    directly, which only worked because HubSpot used to seed both. A merchant who pays before
    filling in their onboarding form has no legal address yet and
    `isEligibleForAioProvisioning` does not require one — so that would have created an AIO tenant
    with a blank address, on an alias that is globally unique and never freed.

- **WHAT THE MERCHANT CONFIRMS OVERRULES HUBSPOT — ALL OF IT** (product owner, 2026-10-28: "everything
  that the customer confirms at the end of their journey must overrule whats already in hubspot. All of it").
  Before this, the confirm step only wrote legal name/street/city, processor, MCC and EIN; the operating
  address, phone, website, entity type and both contacts never reached HubSpot. `pushConfirmationToHubSpot`
  (`actions/leadConfirm.ts`) now writes, best-effort and each write caught on its own:
  - **Company** (`updateCompanyConfirmedDetails` / `buildConfirmedCompanyProperties`): `name` ← DBA, operating
    `address`/`city`/`state`/`zip` via `locationAddress` (blank DBA address → the legal one), `phone`, `website`,
    "Business Type" `migrated_00nfi00000pf0i3ual` (non-profit has no option and is left out), the legal trio,
    `mcc_code`, `previous_processor`. EIN stays in its own PATCH. **This reverses "Company `address` seeds
    nothing" only in the write direction** — the prefill still never seeds the legal address from it.
  - **Contacts**: owner and billing are found-or-created by email, their name/title/phone overwritten, and
    labelled on the Company — "Business Owner" (USER_DEFINED 3) / "Billing Contact" (HUBSPOT_DEFINED 931).
    No billing contact (or the same email) → the owner carries both labels. Sequential so the same person
    isn't created twice.
  - Blanks are still left out (an empty box is not an answer). Previously-terminated and bankruptcy have no
    HubSpot property and are not written.
  - Live-verified 2026-10-28 on company `357159545548`: the Company PATCH and the Business Owner association
    both landed. The Billing Contact label and the contact overwrite were not run live (they would have
    rewritten real staff contacts).

## Quote summary: print button + PDF on the deal (2026-10-29)

Product owner, 2026-10-29: "print summary, add it to deal attachment" (confirmed: a print button AND an
automatic attachment).

- **Print.** `/lead/[token]/quote` has a "Print summary" button under the business name
  (`LeadQuoteView.tsx`, `window.print()`). `@media print` rules in `LeadQuoteView.module.css` and
  `quote/quote.module.css` drop the button, the next-step panel, the document links, the footnote and
  the back link, so the paper copy is the heading plus `QuoteSummary`. No route, no server code.
- **PDF on the deal, at PUBLISH since 2026-10-30 (was acceptance).** `attachQuoteSummaryToDeal` (`lib/billing/quoteSummaryAttachment.ts`)
  builds `buildCustomerSafeQuote(app)`, the same projection the quote page renders, so there is nothing
  internal to leak: no Adyen cost, margin, floor or commission is in that shape. It renders it with
  `lib/quoteSummaryPdf.ts`, uploads it PRIVATE to `/EasyOB/Quote Summaries` and notes it onto the deal
  (`hs_attachment_ids`, note→deal association **214**) via `lib/adapters/hubspotFiles.ts`. Called from
  exactly two places:
  - `buildAndPublishBillingQuote`, once the publish is persisted; a re-run skips as
    `already_published`, so it files once. The note reads "as sent to" (vs "as accepted by" for
    the rate-only route below). `recordAcceptance` no longer files it.
  - `/api/lead/[token]/accept` (rate-only quotes), on `firstAcceptance` only, so "Email Me a New Link"
    never files a second copy.
  So the one-shot acceptance guards are the dedupe. Nothing is persisted (no file id or note id on the
  row, no migration), and a failed attachment is **not retried**: it is logged
  (`[quote-summary] <appId>: ...`) and acceptance carries on. It is not written to `lastSyncError`
  either, because a missing PDF should not trip the admin sync-error alarm.
- **PDF library: `pdf-lib`.** Pure JS, no native binary, no font files (it uses the built-in Helvetica),
  so it runs as-is in a Vercel Node function and in vitest. Headless Chromium was rejected: a ~50MB
  binary and cold-start cost just to print a list of lines. The trade-off is that the PDF is laid out in
  code rather than rendered from `QuoteSummary.tsx`. The sections match the screen (configuration,
  software, payroll in its own box, due at checkout, one-time with package-covered items grouped,
  payment details with card present and card not present at equal weight). The parts that could drift
  (the payroll split and each box's totals, and `displayName`, which shows "Additional Software License"
  as "Additional Ordering Point") are in `lib/quoteSummarySections.ts`, and both renderings call it.
  **Any other change to what `QuoteSummary` shows will not reach the PDF on its own.** Standard fonts are WinAnsi-only, so unsupported characters (arrows, emoji) are mapped
  or dropped rather than failing the document.
- **Scopes. NOT live-tested.** The upload reuses `uploadHubspotFile`, which uses the general CRM token
  and needs the **`files`** scope. As of 2026-10-21 neither private app had that scope (see the
  Foodbuy note in `phase-status.md`), so until someone grants it, every attachment fails with a 403 and
  is logged. The note uses the BILLING token, because the general app has no deals scope, and needs
  `crm.objects.notes.write`. That scope worked on the billing app on 2026-10-13, when the old
  `createDealNote` was live.

## The one-time invoice

Product owner, 2026-10-22/23: **one-time lines (hardware, install, training, packages, kit swaps) go
on a HubSpot INVOICE, not on the quote.** Since 2026-10-23 EasyOB builds it **and opens it** the
moment the quote is published (at the merchant's confirm), so the merchant has both links side by
side: the subscription to sign and pay, and the invoice to look at. **AIO staff charge it in HubSpot
whenever they choose**, against the payment method stored at the quote's checkout ("their payment
info gets saved and we can use it whenever we want"). **Nothing is emailed** — opening through the
API sends nothing, and EasyOB sends nothing. The link is real, so the merchant *can* pay it
themselves; that is accepted. **Onboarding still gates on the subscription alone.**

**UNVERIFIED: that HubSpot will charge an invoice against the ACH method stored at quote checkout.**
The quote stores it (`hs_store_payment_method_at_checkout`), and the invoice schema has
`hs_invoice_payment_collection_method: automatic` and `hs_payment_collection_option: pmof`. But
nobody has charged one yet. The first real charge is the test.

How it works:
- **The split.** `splitQuoteLines` in `quoting.ts`. Every one-time line is invoiced EXCEPT the
  $0.50 pre-auth and the $0 rate disclosure, which stay on the quote. `app.quoteLines` still holds
  every line, so totals, commission and ARR are unchanged.
- **Publish.** `buildAndPublishBillingQuote` creates line items for the quote portion only. It
  writes `hubspotIds.splitBilling: true` at the build claim. A draft left half-built before split
  billing shipped is reconciled against ALL its lines, which deletes its one-time line items off
  the draft.
- **The `splitBilling` marker is the double-billing guard.** A quote published without it carries
  its one-time lines on the quote, so the merchant paid them at checkout. `buildOneTimeInvoice`
  skips those rows (`not_split`), and must keep skipping them.
- **Build** (`lib/billing/oneTimeInvoice.ts`).
  - It uses a conditional claim, a 2-minute lease, a persist after every id, and resume from
    persisted ids.
  - Guard: the quote must be published (`not_published`) and split (`not_split`).
  - It creates its own line items (a line item has one parent), then a draft invoice (ACH only:
    `hs_allowed_payment_methods: ach`, `hs_allowed_commerce_payment_methods: ACH`), then the
    associations: contact 177 (the quote's signer), company 179, deal 175, line items 409.
  - Then it **opens** it (`openInvoice`, `hs_invoice_status: open`), reads back `hs_invoice_link`,
    and persists `openedAt` + `invoiceLink`. "Done" is `builtAt` AND `openedAt`; a draft built
    before 2026-10-23 (`builtAt`, no `openedAt`) is opened by the next run, not rebuilt.
  - It never sends or charges. An open invoice is still editable (probe below), so this path
    opens no one-way door.
  - `amount` is computed by EasyOB, because a draft's own `hs_balance_due` reads $0.00.
- **Storage.** The invoice lives in its own column, `merchant_applications.hubspot_invoice`
  (migration **0028**). It is deliberately absent from `appToRow`: `saveApplication` writes the
  whole row, and several paths rewrite `hubspot_ids` from a copy read earlier. If either could erase
  an invoice id, a retry would build a second invoice.
- **Triggers.**
  - `/api/lead/[token]/checkout` **awaits** `buildOneTimeInvoiceForId` once the publish succeeds,
    inside the confirm form's loading prompt, so the invoice link is there when the merchant lands.
    The idempotent already-published return retries an unfinished one in `after()`.
  - The lead pages (`refreshLeadInvoice` in `leadRefresh.ts`) build an unfinished one after the
    response, and re-read a built, unpaid one on a 60s TTL — so a staff charge clears the
    checklist without waiting for the cron.
  - `applyDetectedAcceptance` calls `buildOneTimeInvoiceSafely` as a fallback. The DEBUG billing
    bypass calls `recordAcceptance` directly, so it never writes to HubSpot.
  - `/api/cron/hubspot-billing-sync` retries rows that are published, split, and not yet built and
    opened (this also covers quotes a rep published). It also reads back built, unpaid invoices
    (`mergeInvoiceSnapshot`, which never erases the link).
  - Staff can press "Retry Invoice" on the billing panel, which also shows the merchant link.
- **Display.**
  - The customer `QuoteSummary` shows "One-Time — invoiced separately" with its own "Invoice
    total", plus a "Due at checkout" section for the pre-auth.
  - Under the quote, once published, `LeadQuoteView` shows two cards — "View Subscription →" (left)
    and "View Invoice →" (right) — each opening in a new tab. `CustomerSafeQuote.invoice` carries
    only `{ link, paid }`.
  - **After confirm, the merchant lands on the quote's two documents** (`/lead/[token]/quote#documents`)
    in the same tab, with the loading prompt up until then. Nothing opens a tab on its own
    (product owner, 2026-10-23: a surprise second tab was confusing). The redundant "Ready to move
    forward? / Continue" panel is hidden once those cards show.
  - The checklist's **Quote & Billing row stays "In Progress"** after the subscription is in, with
    the invoice in its description and a "View Invoice" CTA, and only completes when HubSpot reports
    the invoice paid (`withOpenInvoice` in `onboardingModules.ts`). Display only — the lock pass and
    provisioning are unchanged. There is no separate invoice row any more.
  - Rep builder: the One-time group is labelled "invoiced separately", and the bottom totals grid has
    an "Invoiced separately" figure (`amountInvoiced`) beside "Due at checkout" and "Per month".

### Probe evidence `scripts/probe-invoice.ts`, **draft run 2026-10-22**, on Shaheer's
Second test company / Deal - 8 — draft invoice `878578016996`, line items `352679875300`
(printer $249) and `352631196408` (printer, 100% off), contact `549681496822`. Not yet deleted.

- **The `EasyOB Billing` app can already write invoices.** The create succeeded, so
  `crm.objects.invoices.write` is granted (E2E-PLAN.md's scope list is out of date).
- **Association type ids, read from the labels endpoint (HUBSPOT_DEFINED):** invoice → contact
  **177**, → company **179**, → deal **175**, → line item **409**.
- **A bare create gets HubSpot's defaults, and they are wrong for AIO:**
  - `hs_allowed_payment_methods` defaults to `ach;credit_or_debit_card` (and
    `hs_allowed_commerce_payment_methods` to `ACH;CARD`). The quote is ACH-only, so the invoice
    must set these explicitly.
  - `hs_invoice_payment_collection_method` defaults to `manual`.
  - `hs_store_payment_method_at_checkout` defaults to `false`.
- **`hs_invoice_link` already exists on the DRAFT** (`customers.aioapp.com/...`), the same host as
  `hs_quote_link`. Whether it can be paid before the invoice is opened is not tested.
- **The draft reads `hs_balance_due: 0.00`** with a $249 line on it. Like the quote draft's
  `hs_quote_amount`, don't trust a draft's totals; read them after it is opened.
- **Auto-charge looks possible.** `hs_invoice_payment_collection_method` has an `automatic` value
  and `hs_payment_collection_option` has a `pmof` value (payment method on file). Together they may
  debit the ACH mandate from the quote checkout without the merchant clicking anything. This is
  untested. The current decision is that staff charge it manually in HubSpot.

### Probe evidence, **`--open` run 2026-10-23**, same draft `878578016996`

- **ACH-only took on the draft:** `hs_allowed_payment_methods: ach`,
  `hs_allowed_commerce_payment_methods: ACH`.
- **`hs_invoice_status: open` is accepted.** Once ACH-only was set, `hs_balance_due` and
  `hs_amount_billed` read **249.00**, which is correct with the 100% line at $0. The link did not
  change.
- **An OPEN invoice is still editable through the API** (a `hs_due_date` PATCH succeeded), so
  opening is not a one-way door.
- **The link works signed out.** `hs_invoice_link` returned 200 and rendered the invoice, the $249
  line and a "Pay now" button. The page also contains the strings "This is a test invoice, so it
  can't collect real payments" and "details are updating". These may only be template text; no
  one has checked whether they are visible.
- No email was observed. Opening through the API sends nothing.
- **Still untested:** whether $0 or under-$0.50 invoices are refused (EasyOB never builds one, see
  `nothing_to_invoice`), and charging the stored ACH method.

## Card surcharge: a portal setting, not code (researched 2026-10-29)

Product owner, 2026-10-29: "5% cc charge ... a setting in hubspot invoice and quote creation." What a read-only
probe of the portal found:
- **The surcharge already exists, at 4%.** It is a HubSpot default checkout fee, "Credit Card Surcharge" (PERCENT, 4,
  `hs_fee_type: checkout`). It is configured under Settings > Revenue > Payments > **Fees and policies**, with
  "Apply fee to: credit or debit card purchases". HubSpot adds it at checkout on card payments only. ACH-paid quotes
  carry no fee. Paid examples: invoice `883454721751` ($199.00 + $7.96) and invoice `880547367650` ($0.50 + $0.02).
  Each card payment creates a CRM `fees` object (0-85) that snapshots the fee and is associated with the invoice or quote.
- **EasyOB writes no fee property.** HubSpot stamps `hs_allowed_checkout_fee_ids: 30291358` onto new quotes and
  invoices by itself. Every EasyOB quote since about 2026-10-15 has it. Invoices are inconsistent: one-time invoices
  `884089230052` (10-28) and `883365392080` (10-27) have it, but `886167657159` (10-29) does not. The cause is unknown.
- **The rate can't be set per object through the API.** `hs_card_fee_percentage`, `hs_card_fee_name`,
  `hs_all_transactions_fee_*` and `hs_direct_debit_fee_*` on invoices are read-only snapshots. `hs_allowed_checkout_fee_ids`
  (invoices and quotes) is writable, but it only references a fee defined in settings, and that definition has no
  CRM endpoint. The CRM fees API creates "regular" fees, which apply whatever the payment method is, so they would
  also charge ACH payers.
- **Moving to 5% is an admin edit of that fee in settings.** HubSpot: "Changes to the fee only apply to future
  transactions." See knowledge.hubspot.com/payment-processing/configure-your-buyer-checkout-experience.

## Payment plan: removed (2026-10-28)

Product owner, 2026-10-28: "Remove the UI for 'how would you like to pay' because the payment plans for the
invoice come through Klarna at checkout." The `/lead/[token]/payment` step (added 2026-10-26, commit 19f14b0) is
gone: the quote preview's Continue goes straight to `/confirm` again, and the `no_payment_plan` checkout gate,
`savePaymentPlanAction`, `PaymentPlanForm` and `lib/paymentPlan.ts` are deleted.

- **Every** one-time invoice now behaves like the old "pay over time": billed at list (the 5% pay-in-full discount
  is gone), `hs_payment_collection_option: request_payment`, `hs_allowed_commerce_payment_methods:
  CARD;ACH;AFFIRM` (`draftInvoiceProperties(date, { installments: true })`). Affirm does the splitting at
  HubSpot checkout (verified 2026-10-27). **Klarna is off** (product owner, 2026-10-29: "turn off klarna keep
  affirm"); invoices built 2026-10-27..29 still offer it. Quotes never offered either: they are ACH-only and
  never write `hs_allowed_commerce_payment_methods`. HubSpot rejects BNPL with `hs_allow_partial_payments`, so that stays off.
  Payroll invoices (`checkPayroll.ts`) still use the ACH-only default.
- **DB:** `merchant_applications.payment_plan` / `payment_plan_at` and migration 0031 are left in place, unread and
  unwritten (no drop; local DATABASE_URL is production). The `MerchantApplication.paymentPlan` mapping was removed
  from `types/merchant.ts` / `applicationRow.ts`; the Drizzle schema fields remain. Old values are ignored.
