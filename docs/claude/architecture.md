# v2 architecture

## Stack
- **Next.js 15.1.2** (App Router, TypeScript, `src/` dir) in `app-v2/`. Note: the repo was originally scaffolded on 16.2.9/React 19.2.4; the working tree currently pins 15.1.2/React 19.0.0 — this downgrade predates Phase 1.5 and was never resolved with the user. Don't "fix" it without checking first.
- **No CSS framework** — inline styles, dark theme CSS variables (`--bg: #0a0f1e`, `--accent: #f9674e`, etc.)
- **AI:** Anthropic `claude-sonnet-4-6` called server-side via `ANTHROPIC_API_KEY` env var (never in localStorage)
- **Database:** Postgres via Vercel Marketplace (Neon integration), project `aioapp1/aioratecalc`. ORM: Drizzle (`drizzle-orm` + `@neondatabase/serverless`).
- **Auth:** NextAuth v5, JWT sessions. **Staff (rep/admin) sign in with Microsoft Entra ID** (`microsoft-entra-id`, OIDC) — see "Entra ID staff sign-in" below. Customers still use Credentials (magic link, or a password they set themselves); the only remaining staff password is the admin breakglass at `/login/breakglass`.
- **Storage:** all reads/writes go through Server Actions (`src/lib/actions/`) → `PostgresAdapter` (`src/lib/storage/postgresAdapter.ts`). `LocalStorageAdapter` was deleted in Phase 1.5 — nothing in the running app touches `localStorage` for application/settings data anymore.
- **Adyen:** EasyOB no longer creates Adyen accounts. As of 2026-09-23 the ONLY way a merchant gets one is through **AIO's own dashboard API** (`adapters/aioDashboard.ts`), which creates the tenant, the location, and mints an Adyen hosted-onboarding link already wired to the right tenant. EasyOB's own legal-entity/account-holder/business-line chain was deleted: it produced balance accounts that were misnamed and unlinked from AIO's tenant graph. The merchant still fills SSN/bank/EIN on Adyen's hosted page. EasyOB keeps ONE direct Adyen dependency — the read-only **settlement report** download that feeds the P&L (`adapters/adyenReports.ts`).
- **Check (checkhq.com):** embedded payroll. Hosted onboarding only, same posture as Adyen — AIO creates the Check *company* from details it already holds, Check collects EIN/bank/tax data on its own hosted pages. Wired & in sandbox testing (see the payroll module below).
- **HubSpot:** Private App Token (`HUBSPOT_PRIVATE_APP_TOKEN`), no OAuth. Still Phase 3, not started.

## Roles & the role-scoped margin model (Phase 1.5)
Three roles: **Customer** (no account — tokenized links only), **Rep**, **Admin**. `middleware.ts` guards `/rep/*` (rep or admin) and `/admin/*` (admin only) using NextAuth sessions. Roles live in `users.role` and are set by an admin at `/admin/users` — **not** derived from Entra groups or app roles (see "Entra ID staff sign-in").

The core trust boundary: **reps never see AIO's true Adyen cost, and the margin table never ships to a rep's browser.** `pricing.ts`'s `getMarginFloor()` (volume-tiered floor, admin-edited on `/admin/settings/rate-matrix`) and `calcAdyenCost`/`adyenRateOnVolume` (true per-transaction processing cost) are computed server-side; a rep gets yes/no booleans (`belowMarginFloor`, `belowCostFloor`) and, by default, no exact Adyen cost (`margin_policy.padding_adyen_cost_hide`). **The rep margin padding ("pillow") was REMOVED 2026-10-23** (product owner: "there is no need for padding if the admin can just adjust the min and max anyways"): reps and admins are judged against the same tier `minMargin`. `getPaddedFloorRate`, `updatePaddingPolicyAction` and the `paddingPct`/`paddingMinMrrAdd` fields of `PaddingConfig` are gone; `PaddingConfig` now only carries `paddingAdyenCostHide`. The DB columns `margin_policy.padding_bps` / `padding_min_mrr_add` are left in place and are neither read nor written (the live row had 20 bps, i.e. ×1.002). The one control on the old `/admin/settings/pillow` page that was NOT margin padding, the discount cap, moved to `/admin/settings/quote-limits`. This is enforced **server-side** in `derivePricingForRole()` (`pricing.ts`) via `src/lib/actions/pricing.ts`'s `getPricingPreviewAction()`. `PricingStep.tsx` has no client-side access to the true numbers at all; it only renders whatever the server decided this role gets to see. Don't move this computation back to the client.

A **temporary, dev-only debug role switcher** (`src/lib/auth/debugRole.ts`, `src/components/dev/RoleSwitcher.tsx`) lets you click through Rep/Admin views without logging in/out, hard-gated on `ENABLE_DEBUG_ROLE_SWITCH` (must only ever be set in a local `.env.local`, never a Vercel project env — Preview deployments also run `NODE_ENV=production`, so that alone isn't a safe gate). It resolves to the real seeded `rep@aioapp.com`/`admin@aioapp.com` DB rows (not fake IDs) since `merchant_applications.owner_user_id` is a strict FK. Safe to delete later: that file, the component, `src/lib/actions/debugRole.ts`, and their two call sites in `middleware.ts`/`auth.config.ts` and `app/layout.tsx`.

## Key files
```
app-v2/src/
  types/merchant.ts          ← canonical MerchantApplication type (no PII fields), CustomerSafeQuote
  lib/pricing.ts             ← MARGIN_REQS, getMarginFloor, derivePricing (true numbers, untouched)
                                + derivePricingForRole (role-scoped view, additive)
  lib/rateMatrix.ts          ← the CARD-PRESENT RATE CARD: volume × average ticket → the rate a rep
                                is offered (pricing guide §10.3, the $0.15/txn option). Pure; the
                                live numbers are in `rate_matrix_policy`, admin-edited at
                                /admin/settings/rate-matrix. SUGGESTS only — see the constraint below.
  lib/billing/processingArr.ts ← paymentProcessingArr() — margin × monthly volume × 12, written to the
                                HubSpot deal's `payment_processing_arr` once the quote is PUBLISHED
  lib/claude.ts              ← analyzeStatement(), generateProposal() — server-side only
  lib/utils.ts               ← fmt$, fmtPct, fmtPct2, fmtBps, parseJSON
  lib/defaults.ts            ← DEFAULT_PROCESSOR (shared between client settings UI and server adapter)
  lib/db/
    schema.ts                ← Drizzle tables: users, margin_policy, rate_matrix_policy, app_settings, merchant_applications, customer_submissions
    client.ts                ← server-only Drizzle client (DATABASE_URL)
  lib/storage/
    storageInterface.ts      ← IStorage interface, scoped by { userId, role }
    postgresAdapter.ts       ← server-only IStorage impl (the only one — LocalStorageAdapter is gone)
  lib/auth.ts                ← NextAuth instance — Node-only. MicrosoftEntraID (staff) + Credentials
                                 (customer magic link / password, admin breakglass), DB-backed
  lib/auth.config.ts         ← edge-safe NextAuth config (no DB imports) — used by middleware.ts
  lib/auth/
    getEffectiveRole.ts      ← the one place that resolves "who's asking" (real session or debug
                                 role). Re-reads the users row every request — see the note below
                                 on why the JWT alone can't be trusted. cache()d, so once per request
    getCustomerSession.ts    ← the customer-side twin. Its own module because actions/customer.ts is
                                 "use server", where every export becomes a callable endpoint
    entra.ts                 ← server-only. Entra claims → the AIO staff row they own, linking the
                                 two on first sign-in. The provider's profile() calls this.
    entraDenial.ts           ← edge/client-safe half: provider id, refusal vocabulary, refusal copy
    debugRole.ts             ← DEBUG-ROLE-SWITCHER — see note above
  lib/actions/
    auth.ts                  ← entraSignInAction (staff), breakglassLoginAction (admin recovery),
                                 logoutAction. `loginAction` is GONE — there is no staff password form.
    applications.ts          ← list/get/save/delete application + settings/submissions Server Actions
    pricing.ts                ← getActivePaddingPolicy (Adyen-cost hiding only), getPricingPreviewAction
                                 (NB: named Padding*, not Pillow* — this doc's older "pillow" wording is drift)
    prospects.ts              ← createProspectAction — rep creates a prospect + tokenized customer link.
                                 Publishes NOTHING (publishAtSend deleted 2026-10-15) and hard-blocks
                                 a link with no quote on it.
    leadConfirm.ts            ← confirmLeadDetailsAction — the merchant's own confirmation, from the
                                 PUBLIC lead token. Saves + stamps detailsConfirmedAt; does NOT
                                 publish (the page then POSTs the checkout route, the one door)
    billing.ts                ← sendQuoteAction — the STAFF escape hatch ("Publish Quote Now"), and
                                 THE one-way door. NO LONGER the normal path: the merchant publishes
                                 from /api/lead/[token]/checkout. Kept for a rep sitting with them or
                                 finishing on the phone; nothing waits on it.
    quoteTemplates.ts         ← getQuoteTemplatePolicy, updateQuoteTemplatePolicyAction (admin-only),
                                 listQuoteTemplatesAction — quoteType → HubSpot quote template mapping.
                                 NO UI since 2026-10-12; the policy and the nightly audit still run
    debugRole.ts               ← setDebugRoleAction (no-ops unless ENABLE_DEBUG_ROLE_SWITCH=true)
  lib/adapters/
    aioDashboard.ts           ← THE way a merchant gets an Adyen account. createAioBusiness()
                                 (tenant), createAioLocation(), createAioAdyenOnboardingLink(),
                                 findAioBusinessByAlias() (reconcile). Absorbs two AIO bugs —
                                 location create 500s on the FIRST call, and adyen-onboard returns
                                 201 with url:"" on the FIRST call — with narrow predicated retries.
                                 adapters/adyen.ts is DELETED; don't reintroduce it.
    adyenReports.ts           ← the ONLY remaining direct Adyen call: read-only settlement CSV
    check.ts                  ← createCheckCompany(), createCheckOnboardLink(), getCheckOnboardStatus() — Check payroll onboarding, wired & in sandbox
    hubspot.ts                ← pushToHubSpot() (deals, repaired), listProducts(), company/contact reads,
                                 + Phase E billing: ensureQuoteContact, createQuoteLineItems,
                                 createDraftQuote, associateQuote, publishQuote, getQuoteSnapshot,
                                 findSubscriptionsForQuote, listQuotesModifiedSince, listQuoteTemplates.
                                 pullFromHubSpot() was DELETED — dead, and wrote phantom properties
    email.ts                  ← sendMagicLinkEmail() + sendLeadLinkEmail(), both through one
                                 branded render(). TWO transports: Microsoft
                                 Graph (app-only, AIO's own M365 tenant) preferred, Resend as fallback.
                                 Degrades gracefully (returns sent:false + the raw link) when neither is
                                 configured, unlike aioDashboard.ts/hubspot.ts. A Graph FAILURE also falls
                                 through to Resend — a duplicate email beats a merchant who paid and never
                                 got the link that creates their account.
    sms.ts                     ← sendLeadLinkSms() — Phase 4, Twilio HTTP API, no SDK. Same
                                 degrade-gracefully posture as email.ts; only called when a phone is given
  lib/foodbuyForm.ts            ← Foodbuy has NO API (it's a signed participation agreement,
                                 AIO_Foodbuy_Enrollment_Form_V1). Form defaults/pre-fill, the shared
                                 validator, and request-body parsing for the in-app agreement form.
  lib/foodbuyPdf.ts             ← renderFoodbuyPdf() — pdf-lib redraw of the 5-page form, server-side.
  lib/billing/                  ← Phase E
    ensureDeal.ts             ← ensureDealForPublish() — fills a MISSING hubspotDealId before the
                                 preconditions ask for one (rows accepted before 511e019 have no deal,
                                 and assoc 64 is a hard publish requirement, so they'd refuse `no_deal`
                                 forever). Only ever fills a missing id — never re-pushes an existing
                                 one, which would clobber a deal a rep has curated in the CRM. SHARED by
                                 both publish entry points, staff and merchant, so neither drifts.
    acceptance.ts             ← applyDetectedAcceptance() — see the acceptance constraint
    preconditions.ts          ← canPublishBillingQuote() — pure; the ONLY gate before an irreversible publish
    publishBillingQuote.ts    ← buildAndPublishBillingQuote() — builds the deal→line-items→quote graph
                                 and publishes it, persisting after every step that yields an id
  lib/leadConfirm.ts          ← pure. CONFIRMABLE_PATHS — what a PUBLIC lead token may rewrite on the
                                merchant's confirmation step, plus the merge and the strict re-validate.
                                WIDER than leadDetails.ts on purpose: it overwrites values that are
                                already valid, because correcting a rep's typo is the whole point.
                                Volume/avgTicket are deliberately absent — they are the pricing basis
  lib/billingView.ts          ← pure view-model for the rep/admin billing panel (frequency-grouped money)
  lib/revenueView.ts          ← Phase G — pure shaping for the admin money view over
                                 merchant_monthly_actuals (settled volume + AIO's commission). The
                                 ingest had been filling that table since the actuals cron shipped and
                                 NOTHING read it; /admin showed merchant volume and merchant savings
                                 and never a figure for what AIO earns. PROCESSING COMMISSION ONLY —
                                 platform fees, hardware and services bill through HubSpot and are not
                                 in this table, and the panel says so.
  middleware.ts               ← route protection for /rep/* and /admin/*
  app/
    login/                    ← staff login — a single "Sign in with Microsoft" button
    login/breakglass/         ← UNLISTED admin password recovery; linked from nowhere
    login/popup-complete/     ← where popup sign-in lands. Must NOT self-close — the opener
                                 closes it, and uses that to tell success from cancellation
    rep/proposals/new/        ← 5-step rep flow (upload→analysis→pricing→proposal→apply)
    rep/prospects/new/        ← rep sets a margin target + generates a customer self-serve link
    admin/                    ← dashboard, session-gated (no more hardcoded password)
    admin/settings/rate-matrix/ ← admin-only rate card: the §10.3 grid, every cell editable
    admin/settings/quote-limits/ ← admin-only: unit caps, the billing-delay ceiling, the DISCOUNT
                                 CAP (moved here 2026-10-12) and the tablet visibility switch
    admin/?view=revenue       ← Phase G money view — a tab on the one admin surface, not a route of
                                 its own (the nav is capped at 4 items). See RevenuePanel.
    lead/[token]/             ← PUBLIC customer checklist + quote (no auth, token-gated). NO statement
                                 upload since 2026-10-13 — see the constraint below
    lead/[token]/confirm/     ← PUBLIC. THE CONFIRMATION STEP (2026-10-15) — the merchant checks and
                                 corrects what AIO holds about them, and confirming is what BUILDS the
                                 HubSpot quote. Nothing publishes at link-send any more. Volume and
                                 average ticket are shown LOCKED (they are the pricing basis); the
                                 EIN is collected here and nowhere else.
    api/analyze/              ← POST — rep flow, calls analyzeStatement() server-side
    api/proposal/             ← POST — rep flow, calls generateProposal() server-side
    api/lead/[token]/checkout/ ← POST — PUBLIC. THE MERCHANT'S DOOR TO BILLING: builds + publishes the
                                 HubSpot quote on demand and returns hs_quote_link. Irreversible, and
                                 gated on detailsConfirmedAt — the confirmation IS the asking. Never
                                 leaks a precondition message.
    api/auth/[...nextauth]/   ← NextAuth route handlers
  components/rep/
    RateSuggestion.tsx         ← what the rate card says for this merchant, + "Use it". Auto-applies
                                 ONLY on the two surfaces that start a quote, never when reopening
                                 a saved one
    UploadStep.tsx            ← drag-drop, calls /api/analyze
    AnalysisStep.tsx          ← 3-way fee split display, two panes above 64rem
    PricingStep.tsx           ← model selector + margin slider; fetches role-scoped pricing from the server, never computes the true floor/cost itself
    ProposalStep.tsx          ← savings hero + PDF export via html2pdf in a new window
    ApplyStep.tsx             ← non-sensitive fields only (business, ownerContact, processing, agreement)
  components/customer/
  components/dev/
    RoleSwitcher.tsx           ← DEBUG-ROLE-SWITCHER UI, only mounted when the env flag is on
scripts/
  seed-users.ts                ← seeds admin@aioapp.com / rep@aioapp.com (see credentials below)
  db.ts                        ← standalone (non-"server-only") Drizzle client, for scripts run via tsx
  entra-app-registration.ps1   ← creates/updates the Entra app registration via Graph (pwsh +
                                 Microsoft.Graph.Authentication). Idempotent, so it's also the
                                 secret-rotation path. Writes the 3 env vars into .env.local.
  run-hubspot-links.ts         ← runs /api/cron/hubspot-links NOW, no dev server and no deploy:
                                 stamps every deal's easyob_link, empties the old company-level
                                 one. Calls the shipping adapter functions, so it IS the cron.
                                 Pins NEXT_PUBLIC_BASE_URL to the production alias, because
                                 .env.local says localhost and the backfill rightly refuses to
                                 write a link a rep couldn't click.
  provision-aio-tenant.ts      ← provisions ONE named application into AIO now, without waiting
                                 for the 15-minute cron. Calls the shipping provisionAioTenant,
                                 so the lease / resume / reconcile-by-alias guards all still
                                 apply. The ONLY gate it can skip is billing_not_paid (with
                                 --unpaid), because the chain is otherwise untestable without a
                                 real ACH payment — the debug billing bypass deliberately won't
                                 fabricate a subscription. Prints what it will create and makes
                                 you type the application id back: the alias is permanent.
```

## Constraints (do not reverse)

- **A storage write failure must never be handed to the caller verbatim.** Drizzle's
  `DrizzleQueryError` puts the whole statement AND every bound parameter in `message`, and the rep
  and customer UIs render a caught `err.message` directly — so one FK violation printed a merchant's
  legal name, address, phone and email onto a rep's screen. `postgresAdapter`'s `dbWrite` keeps the
  driver's `cause` (which names the constraint and carries no data) and logs the rest server-side.
- **There is NO demo gate, and there must not be one.** Removed 2026-09-24 (product-owner
  decision): the customer gets their link, sees and accepts their quote, and billing is what
  unlocks everything downstream. Nothing is withheld pending a demo. Deleted with it:
  `lib/demo.ts`, `lib/demoSync.ts`, `/api/cron/hubspot-demo-sync`, `/admin/settings/demo`,
  `markDemoHeldAction`/`clearDemoHeldAction`/`updateDemoBookingUrlAction`, the
  `merchant_applications.demo` and `app_settings.demo_booking_url` columns (migration `0015`),
  and HubSpot's `listMeetingsForDeal`/`listDemoMeetingsForCompany`/`advanceDealStage`.
  `stage_0` ("Demo Meeting") stays in `SALES_PIPELINE_STAGES` because it is a real live stage
  `dealStageRank` must be able to rank — nothing writes it. `onboardingModules.ts`'s single lock
  rule is now "everything except `quote` is locked until `quoteAcceptedAt`".
- **Three admin pages were deleted on 2026-10-12 and NONE of their policies were** — `/rep/settings`
  (processors & tiers), `/admin/settings/pillow` (margin padding, itself removed 2026-10-23) and `/admin/settings/quote-templates`.
  Product owner: "completely useless... we are gonna work on margin stuff later." Each policy still
  runs server-side on its saved row or its default, and each write action is kept with a comment
  saying it has no UI. Three consequences worth knowing before "cleaning up" the orphans:
  - `getSettingsAction` is still READ by the proposal wizard and `EditQuotePanel` for the active
    processor tier — that is what the internal panel prices AIO's own cost against. Only the editor
    is gone.
  - `updateQuoteTemplatePolicyAction` is the RECOVERY for `auditQuoteTemplatePolicy`'s nightly
    "template retired" alert, which still fires. Delete it and that recovery becomes editing
    `DEFAULT_TEMPLATE_IDS` and deploying — see the 2026-10-09 v3→v4 incident.
  - The DISCOUNT CAP was on the pillow page and is live policy, not margin padding: raising it is
    how a discount over 50% gets approved. It moved to `/admin/settings/quote-limits`, beside the
    billing-delay ceiling, which is the same kind of knob. Deleting the page without moving it
    would have silently removed the only way to grant one.
- `owner_user_id` (the rep who owns a deal, FK to `users.id`) and `ownerContact` (the merchant's own business contact person) are two different "owner" concepts — don't conflate them
- `customer_link_token`/`customer_link_purpose` is a **generalized, reusable** token slot: `"lead_upload"` (Phase 1.5, pre-analysis self-serve) and `"kyc_handoff"` (Phase 2, post-proposal Adyen KYC) are different moments in the deal lifecycle sharing the same field — don't assume a token is one or the other without checking `customer_link_purpose`
