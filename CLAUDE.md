# ClearRate / AIO Rate Calculator

> **Active work is on the `v2` branch.** The `app-v2/` directory contains a Next.js rewrite with a canonical data model, a Postgres-backed multi-role (Customer/Rep/Admin) permission model with a pillowed margin system, server-side Anthropic API, and stubs for Adyen hosted onboarding and HubSpot sync. See the **v2 Architecture** section below. `main` branch / root HTML files are frozen as reference.

## Overview
ClearRate is a payment-processing proposal engine for AIO Payments. A sales rep uploads a merchant's current processing statement (PDF or image), Claude extracts the fees/volume/effective-rate, the app computes a competing AIO offer against AIO's margin floors, generates a branded proposal, and kicks off an Adyen merchant-onboarding application.

## Tech Stack
- **Language:** JavaScript (JSX transpiled in-browser via `@babel/standalone`)
- **UI:** React 18 + ReactDOM (UMD builds from `unpkg.com`), inline-style components (no CSS framework)
- **PDF export:** `html2pdf.js` 0.10.1 (from cdnjs) — only in `clearrate-main/index.html`
- **AI:** Anthropic Claude Messages API called directly from the browser (`https://api.anthropic.com/v1/messages`, header `anthropic-dangerous-direct-browser-access: true`). Models: `claude-sonnet-4-6` (root build) and `claude-sonnet-4-20250514` (clearrate-main build).
- **Payments onboarding:** Adyen LEM / Management / Balance Platform REST APIs, proxied through a CORS proxy (default `https://corsproxy.io/?`) — `clearrate-main/index.html` only.
- **Persistence:** `localStorage` only. No package manifest, no `node_modules`, no bundler.

## Architecture
Two parallel versions of the same app live in the repo:

- **`index.html` (root)** — older/simpler build. 4-step flow: `upload → analysis → pricing → proposal`. Has a `settings` page with processors + users.
- **`clearrate-main/`** — newer build, three cooperating pages:
  - `index.html` — the internal proposal engine. 5-step flow: `upload → analysis → pricing → proposal → apply`. Adds AIO margin tables, PDF export, and the Adyen onboarding "Apply" step. Saves submissions to `localStorage["aio_applications"]`.
  - `customer.html` — public-facing "Free Processing Analysis" lead-capture page (light theme). Customer uploads a statement; results + contact info are written to `localStorage["aio_submissions"]`.
  - `admin.html` — password-gated dashboard (dark theme) that reads `localStorage["aio_submissions"]` to review leads. Password is hardcoded as `aio2024` (`ADMIN_PASSWORD`).

Note: `localStorage` is per-origin, so `customer.html` and `admin.html` only share `aio_submissions` data when served from the same origin/host.

### Core pipeline (per page)
1. **Upload** — `FileReader.readAsDataURL` turns the statement into base64; sent to Claude as an `image` or `document` (PDF) content block.
2. **Analysis** — Claude returns strict JSON (merchant name, volume, fees, effective rate, card-present vs not-present splits, current pricing model, etc.). `parseJSON()` strips markdown fences and slices to the outer `{…}`.
3. **Pricing** — computed locally. `MARGIN_REQS` / `getMarginFloor(volume)` enforce AIO's tiered take-rate + minimum MRR floors. `INTERCHANGE_SCHEDULE` (root build) estimates true interchange for hidden-margin tiered statements. `calcAdyenCost` / `adyenRateOnVolume` model the AIO/Adyen cost basis.
4. **Proposal** — Claude generates proposal copy using the *already-computed* numbers (prompt explicitly forbids recalculating). Exported via `html2pdf` (clearrate-main).
5. **Apply** (clearrate-main only) — collects business/owner details and optionally calls Adyen LEM/Management APIs to create legal entities, ownership relationships, and onboarding.

## Key Files & Entry Points
- `/Users/shaheerhasnain/Documents/Projects - AIO/aioratecalc/index.html` — standalone older build (open directly in a browser).
- `/Users/shaheerhasnain/Documents/Projects - AIO/aioratecalc/clearrate-main/index.html` — main internal proposal + apply app.
- `/Users/shaheerhasnain/Documents/Projects - AIO/aioratecalc/clearrate-main/customer.html` — public lead-capture analysis page.
- `/Users/shaheerhasnain/Documents/Projects - AIO/aioratecalc/clearrate-main/admin.html` — admin dashboard for reviewing submissions.

There is no README, no `package.json`, and no source directory — each HTML file is the complete, self-contained application.

## Build / Run / Test
There is **no build, install, or test tooling** in this repo (no `package.json`, no scripts, no test files).

- **Run:** open any of the `.html` files directly in a browser, or serve the folder over a static server, e.g.:
  ```
  cd "/Users/shaheerhasnain/Documents/Projects - AIO/aioratecalc"
  python3 -m http.server 8000
  ```
  then visit `http://localhost:8000/index.html` or `http://localhost:8000/clearrate-main/index.html`.
- **API key:** root `index.html` `prompt()`s for an Anthropic API key on first load and stores it in `localStorage["cr_api_key"]`. The `clearrate-main` pages only *read* `cr_api_key` from `localStorage` — set it manually (e.g. via the root page or DevTools) before they can call Claude.
- **Test:** none. Verification is manual, by running the flow in a browser.

## Conventions & Gotchas
- **Secrets in the browser.** The Anthropic API key and all Adyen API keys (`lemApiKey`, `managementApiKey`, `balancePlatformApiKey`) are stored in `localStorage` and sent from the client. The code itself warns this is unsafe for live/production keys (see the security note in `clearrate-main/index.html`). The admin password `aio2024` is hardcoded in `admin.html`.
- **No server.** All "backend" state is `localStorage`. Keys in use: `cr_api_key`, `clearrate:settings`, `clearrate:adyen_config`, `aio_applications`, `aio_submissions`.
- **Two diverging copies.** Root `index.html` and `clearrate-main/index.html` share most logic but differ (Claude model id, the `apply`/Adyen step, `MARGIN_REQS`, PDF export, a `users` array in settings). Changes to shared logic must be made in both if you want parity.
- **Model ids differ between builds** — `claude-sonnet-4-6` vs `claude-sonnet-4-20250514`. Keep this in mind when editing prompts/models.
- **Pricing is computed locally, not by the LLM.** Claude is used only for statement extraction and proposal prose; it is explicitly instructed not to change numbers. Keep money math in JS (`MARGIN_REQS`, `getMarginFloor`, `calcAdyenCost`, `INTERCHANGE_SCHEDULE`).
- **LLM JSON parsing is defensive** via `parseJSON()` (strips ```` ```json ```` fences, slices outer braces). Preserve that when changing prompts.
- **CDN-dependent.** React, Babel, and html2pdf load from public CDNs at runtime, so the app needs internet access to run at all. JSX is transpiled on every page load via `<script type="text/babel">` (slow first paint; not a production setup).
- **Adyen calls go through a public CORS proxy** (`corsproxy.io` by default, configurable via `clearrate:adyen_config.corsProxy`).
- `.gitignore` lists `node_modules/`, `.env`, `__pycache__/`, etc. — generic boilerplate; none of those toolchains are actually present.

---

## v2 Architecture (`app-v2/` on branch `v2`)

### Stack
- **Next.js 15.1.2** (App Router, TypeScript, `src/` dir) in `app-v2/`. Note: the repo was originally scaffolded on 16.2.9/React 19.2.4; the working tree currently pins 15.1.2/React 19.0.0 — this downgrade predates Phase 1.5 and was never resolved with the user. Don't "fix" it without checking first.
- **No CSS framework** — inline styles, dark theme CSS variables (`--bg: #0a0f1e`, `--accent: #f9674e`, etc.)
- **AI:** Anthropic `claude-sonnet-4-6` called server-side via `ANTHROPIC_API_KEY` env var (never in localStorage)
- **Database:** Postgres via Vercel Marketplace (Neon integration), project `aioapp1/aioratecalc`. ORM: Drizzle (`drizzle-orm` + `@neondatabase/serverless`).
- **Auth:** NextAuth v5 (Credentials provider, bcrypt, JWT sessions). No OAuth yet — AIO uses Microsoft 365, so Entra ID (Azure AD) is a plausible fast-follow, not built.
- **Storage:** all reads/writes go through Server Actions (`src/lib/actions/`) → `PostgresAdapter` (`src/lib/storage/postgresAdapter.ts`). `LocalStorageAdapter` was deleted in Phase 1.5 — nothing in the running app touches `localStorage` for application/settings data anymore.
- **Adyen:** hosted onboarding only — AIO creates a legal entity skeleton, Adyen returns a URL, merchant fills SSN/bank/EIN directly on Adyen's hosted page. Phase 2 is **built and in testing** (see phase table) — legal-entity graph + on-demand onboarding-link regeneration are wired; keys must be `\$`-escaped in `.env.local` (see gotcha above).
- **Check (checkhq.com):** embedded payroll. Hosted onboarding only, same posture as Adyen — AIO creates the Check *company* from details it already holds, Check collects EIN/bank/tax data on its own hosted pages. Wired & in sandbox testing (see the payroll module below).
- **HubSpot:** Private App Token (`HUBSPOT_PRIVATE_APP_TOKEN`), no OAuth. Still Phase 3, not started.

### Roles & the pillowed margin model (Phase 1.5)
Three roles: **Customer** (no account — tokenized links only), **Rep**, **Admin**. `middleware.ts` guards `/rep/*` (rep or admin) and `/admin/*` (admin only) using NextAuth sessions.

The core trust boundary: **reps must never see or derive AIO's true minimum profitable margin.** `pricing.ts`'s `getMarginFloor()` (true volume-tiered floor) and `calcAdyenCost`/`adyenRateOnVolume` (true per-transaction processing cost) are real numbers computed correctly everywhere internally, but a rep's UI/API responses only ever see a **pillowed** (padded) floor and, by default, no exact Adyen cost at all — controlled by an admin-editable global policy (`margin_policy` table, `/admin/settings/pillow`). This is enforced **server-side** in `derivePricingForRole()` (`pricing.ts`) via `src/lib/actions/pricing.ts`'s `getPricingPreviewAction()` — `PricingStep.tsx` has no client-side access to the true numbers at all, it only renders whatever the server decided this role gets to see. Don't move this computation back to the client.

A **temporary, dev-only debug role switcher** (`src/lib/auth/debugRole.ts`, `src/components/dev/RoleSwitcher.tsx`) lets you click through Rep/Admin views without logging in/out, hard-gated on `ENABLE_DEBUG_ROLE_SWITCH` (must only ever be set in a local `.env.local`, never a Vercel project env — Preview deployments also run `NODE_ENV=production`, so that alone isn't a safe gate). It resolves to the real seeded `rep@aioapp.com`/`admin@aioapp.com` DB rows (not fake IDs) since `merchant_applications.owner_user_id` is a strict FK. Safe to delete later: that file, the component, `src/lib/actions/debugRole.ts`, and their two call sites in `middleware.ts`/`auth.config.ts` and `app/layout.tsx`.

### Key files
```
app-v2/src/
  types/merchant.ts          ← canonical MerchantApplication type (no PII fields), CustomerSafeQuote
  lib/pricing.ts             ← MARGIN_REQS, getMarginFloor, derivePricing (true numbers, untouched)
                                + getPillowedFloor/derivePricingForRole (role-scoped view, additive)
  lib/claude.ts              ← analyzeStatement(), generateProposal() — server-side only
  lib/utils.ts               ← fmt$, fmtPct, fmtPct2, fmtBps, parseJSON
  lib/defaults.ts            ← DEFAULT_PROCESSOR (shared between client settings UI and server adapter)
  lib/db/
    schema.ts                ← Drizzle tables: users, margin_policy, app_settings, merchant_applications, customer_submissions
    client.ts                ← server-only Drizzle client (DATABASE_URL)
  lib/storage/
    storageInterface.ts      ← IStorage interface, scoped by { userId, role }
    postgresAdapter.ts       ← server-only IStorage impl (the only one — LocalStorageAdapter is gone)
  lib/auth.ts                ← NextAuth instance (Credentials provider, DB-backed) — Node-only
  lib/auth.config.ts         ← edge-safe NextAuth config (no DB imports) — used by middleware.ts
  lib/auth/
    getEffectiveRole.ts      ← the one place that resolves "who's asking" (real session or debug role)
    debugRole.ts             ← DEBUG-ROLE-SWITCHER — see note above
  lib/actions/
    auth.ts                  ← loginAction, logoutAction (Server Actions wrapping signIn/signOut)
    applications.ts          ← list/get/save/delete application + settings/submissions Server Actions
    pricing.ts                ← getActivePaddingPolicy, updatePaddingPolicyAction (admin-only), getPricingPreviewAction
                                 (NB: named Padding*, not Pillow* — this doc's older "pillow" wording is drift)
    prospects.ts              ← createProspectAction — rep creates a prospect + tokenized customer link
    billing.ts                ← retryBillingQuoteAction — rep/admin retry for a failed or refused auto-publish.
                                 Backfills a MISSING hubspotDealId via pushToHubSpot first (rows accepted
                                 before 511e019 have no deal, and assoc 64 is a hard publish requirement,
                                 so they'd refuse `no_deal` forever). Only ever fills a missing id — never
                                 re-pushes an existing one, since pushToHubSpot PATCHes and would clobber
                                 a deal a rep has since curated in the CRM.
    quoteTemplates.ts         ← getQuoteTemplatePolicy, updateQuoteTemplatePolicyAction (admin-only),
                                 listQuoteTemplatesAction — quoteType → HubSpot quote template mapping
    debugRole.ts               ← setDebugRoleAction (no-ops unless ENABLE_DEBUG_ROLE_SWITCH=true)
  lib/adapters/
    adyen.ts                 ← createLegalEntityAndGetOnboardingUrl(), createOnboardingLink(), updateLegalEntity() — Phase 2, wired & in testing
    check.ts                  ← createCheckCompany(), createCheckOnboardLink(), getCheckOnboardStatus() — Check payroll onboarding, wired & in sandbox
    hubspot.ts                ← pushToHubSpot() (deals, repaired), listProducts(), company/contact reads,
                                 + Phase E billing: ensureQuoteContact, createQuoteLineItems,
                                 createDraftQuote, associateQuote, publishQuote, getQuoteSnapshot,
                                 findSubscriptionsForQuote, listQuotesModifiedSince, listQuoteTemplates.
                                 pullFromHubSpot() was DELETED — dead, and wrote phantom properties
    email.ts                  ← sendMagicLinkEmail() (KYC-handoff resend) + sendLeadLinkEmail() (Phase 4,
                                 prospect creation) via Resend's HTTP API — no SDK. Degrades gracefully
                                 (returns sent:false) when RESEND_API_KEY is unset, unlike adyen.ts/hubspot.ts
    sms.ts                     ← sendLeadLinkSms() — Phase 4, Twilio HTTP API, no SDK. Same
                                 degrade-gracefully posture as email.ts; only called when a phone is given
  lib/foodbuyForm.ts            ← buildFoodbuyFormHtml() — Foodbuy has NO API (it's a paper participation
                                 agreement, AIO_Foodbuy_Enrollment_Form_V1). Pre-fills business/contact
                                 fields into a printable HTML doc, exported client-side via html2pdf —
                                 same pattern as ProposalStep.tsx's proposal PDF, no adapter/no HTTP call.
  lib/billing/                  ← Phase E
    preconditions.ts          ← canPublishBillingQuote() — pure; the ONLY gate before an irreversible publish
    publishBillingQuote.ts    ← buildAndPublishBillingQuote() — builds the deal→line-items→quote graph
                                 and publishes it, persisting after every step that yields an id
  lib/billingView.ts          ← pure view-model for the rep/admin billing panel (frequency-grouped money)
  middleware.ts               ← route protection for /rep/* and /admin/*
  app/
    login/                    ← real login (Credentials)
    rep/proposals/new/        ← 5-step rep flow (upload→analysis→pricing→proposal→apply)
    rep/prospects/new/        ← rep sets a margin target + generates a customer self-serve link
    rep/settings/             ← processor/tier config (rep-editable; pillow policy is admin-only, separate)
    admin/                    ← dashboard, session-gated (no more hardcoded password)
    admin/settings/pillow/    ← admin-only margin pillow policy editor
    lead/[token]/             ← PUBLIC customer self-serve upload + instant quote (no auth, token-gated)
    api/analyze/              ← POST — rep flow, calls analyzeStatement() server-side
    api/proposal/             ← POST — rep flow, calls generateProposal() server-side
    api/lead/[token]/analyze/ ← POST — PUBLIC, dedicated route, returns ONLY CustomerSafeQuote
    api/auth/[...nextauth]/   ← NextAuth route handlers
  components/rep/
    UploadStep.tsx            ← drag-drop, calls /api/analyze
    AnalysisStep.tsx          ← 3-way fee split display
    PricingStep.tsx           ← model selector + margin slider; fetches role-scoped pricing from the server, never computes the true floor/cost itself
    ProposalStep.tsx          ← savings hero + PDF export via html2pdf in a new window
    ApplyStep.tsx             ← non-sensitive fields only (business, ownerContact, processing, agreement)
  components/customer/
    LeadUploadStep.tsx         ← public self-serve upload + CustomerSafeQuote result display
  components/dev/
    RoleSwitcher.tsx           ← DEBUG-ROLE-SWITCHER UI, only mounted when the env flag is on
scripts/
  seed-users.ts                ← seeds admin@aioapp.com / rep@aioapp.com (see credentials below)
  db.ts                        ← standalone (non-"server-only") Drizzle client, for scripts run via tsx
```

### To run v2
```bash
git checkout v2
cd app-v2
npm install
npx vercel link --scope aioapp1 --project aioeasyob     # if not already linked (Vercel project is "aioeasyob", NOT "aioratecalc")
npx vercel env pull .env.local                            # pulls DATABASE_URL etc.
# then add ANTHROPIC_API_KEY and AUTH_SECRET to .env.local by hand — vercel env pull
# only restores vars actually stored in the Vercel project, not local-only secrets
npx tsx scripts/seed-users.ts   # seeds admin@aioapp.com / rep@aioapp.com — see dev credentials below
npm run dev
```

**Dev login credentials** (seeded, not production-safe — rotate before this ever ships):
- Admin: `admin@aioapp.com` / `admin123`
- Rep: `rep@aioapp.com` / `rep123`
- Customer: `customer@aioapp.com` / `customer123`

**⚠️ `vercel integration add` / `vercel env pull` will overwrite `.env.local` wholesale**, wiping any local-only vars (like `ANTHROPIC_API_KEY`) that aren't stored in the Vercel project's env. Back up `.env.local` before running Vercel CLI commands that touch env vars.

**⚠️ Adyen (and any) API keys containing `$` MUST be `\$`-escaped in `.env.local`.** Next's `@next/env` runs `dotenv-expand`, so a raw `$AB` in a key value is silently expanded away (treated as a `${AB}` reference), corrupting the key and producing Adyen `401 Unauthorized`. Single/double quotes do NOT prevent this in `@next/env` — only backslash-escaping (`\$`) does. **In the Vercel project env UI, do the opposite: paste the RAW `$`** (Vercel stores values literally and does not run dotenv-expand; a `\$` there becomes part of the key and 401s). The Adyen LEM/Config keys map as: LEM test key → `ADYEN_LEM_API_KEY`, platform web service key → `ADYEN_CONFIG_API_KEY`, HMAC → `ADYEN_WEBHOOK_HMAC_KEY`.

### Phase status
| Phase | What | Status |
|---|---|---|
| 1 | Next.js scaffold + 5-step rep flow + localStorage | **DONE** (committed 2026-07-06) |
| 1.5 | Multi-role (Customer/Rep/Admin), Postgres, NextAuth, pillowed margin, customer self-serve lead flow | **DONE** (2026-07-06) |
| 2 | Adyen hosted onboarding (wire `adyen.ts` stub + webhook route) | **BUILT / in testing** — `adyen.ts` creates the legal-entity graph + mints onboarding links; webhook route exists; customer self-serve onboarding flow (`CustomerOnboardStep`, `saveMyApplicationOnboardingAction`) wired end-to-end. Onboarding links are single-use / ~4-min expiry, so `/customer/applications/[id]/continue` regenerates a fresh link per click via `createOnboardingLink()` — never re-serve a stored `adyenOnboardingUrl`. MCC→Adyen-industry-code mapping still a go-live TODO. |
| 2.5 | Check payroll onboarding (the `payroll` module on the customer checklist) | **BUILT / sandbox** — opt-in, not auto-chained like Adyen: nothing reaches Check until the customer clicks "Set Up Payroll" at `/customer/applications/[id]/payroll`, which collects the two things AIO can't derive (first payday + authorized signer) and calls `startPayrollOnboardingAction`. Onboard links are one-time use / 24h, so `/customer/applications/[id]/payroll/continue` mints a fresh one per click — never store and re-serve one. Check has **no redirect-back URL**, so completion is detected by re-reading `company.onboard.status` when the customer views the application (`getMyApplicationWithPayrollSyncAction`), cached on `checkIds.onboardStatus` so list/dashboard views don't fan out one API call per app. Production base URL is a go-live TODO (`CHECK_API_BASE_URL`; Check doesn't publish it). |
| 3 | HubSpot bidirectional sync (wire `hubspot.ts` stub) | **SUPERSEDED / partly done.** There is no bidirectional sync and there must not be: authority **hands off at quote publish** — EasyOB → HubSpot while the quote is a draft, HubSpot → EasyOB (read-only) forever after. Deal sync is repaired and live (it had never once succeeded before commit `9aafa5d`). Billing is E2E-PLAN **Phase E**, below. `getMyApplicationWithPayrollSyncAction` was folded into `getMyApplicationWithSyncAction` (refreshes Check + HubSpot independently). |
| E (E2E-PLAN) | **Billing through HubSpot** — quote → hosted checkout → subscription read-back, plus the `schedule_demo` checklist shell | **PUBLISH PATH LIVE-VERIFIED 2026-08-24** — the one human-run publish `PHASE-E-SPEC.md`:777 called for is DONE; see "The Phase E gate run" below. Checkout → subscription read-back remains unverified **on purpose** (`PAYMENT-TEST-PLAN.md` §2.1 recommends against a live payment test; §1's 46 live paid quotes cover it instead). **Auto-publishes on merchant acceptance** — no rep confirmation gate (user's decision, 2026-08-21), so `canPublishBillingQuote` is the *only* thing between a bad quote and a live ACH mandate. Migration `0008` (`quote_template_policy`) **IS applied** — the policy table is empty, which is harmless: `getQuoteTemplatePolicy()` falls back to `DEFAULT_TEMPLATE_IDS`, so an unseeded table can never block a publish. Wants `NEXT_PUBLIC_HUBSPOT_PORTAL_ID=244508708` (cosmetic: CRM record links). **⚠️ One go-live blocker remains: `hs_sender_email` — see the constraint below.** |
| 4 | Merchant magic link email + SMS delivery on prospect creation (Resend + Twilio) | **BUILT / awaiting Resend domain + Twilio account** — `createProspectAction` now auto-sends the lead link via `sendLeadLinkEmail` (always attempted) and `sendLeadLinkSms` (only if the rep entered a phone), right after the prospect row is saved; a send failure never blocks prospect creation, and the rep always sees the raw link with a copy button as fallback (same pattern as the existing `sendMerchantOnboardingLinkAction`/"Send Onboarding Link" KYC-handoff button, which is unchanged). Both degrade gracefully — with `RESEND_API_KEY`/`TWILIO_*` unset, sends just no-op and the UI shows "delivery isn't configured yet." Still needed before this reaches a real merchant: a verified Resend sending domain (`RESEND_FROM_EMAIL`, e.g. a `send.aioapp.com` subdomain — needs SPF/DKIM/DMARC DNS records) and a Twilio account + number (`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_FROM_NUMBER`). Phone is optional on the prospect form — no phone means no SMS attempt. |
| 5 | Real OAuth (Entra ID?) as a fast-follow to Credentials; optional DB session strategy | **NOT STARTED** |
| F | Foodbuy enrollment (the `foodbuy` checklist module — graduated off the `coming_soon` shell) | **DONE** — Foodbuy turned out to have **no API at all**: enrollment is a paper "Foodbuy Foodservice Enrollment" participation agreement (source form: `AIO_Foodbuy_Enrollment_Form_V1`) that asks for the Federal ID # (EIN), a wet/e-signature, GPO-affiliation disclosure, and per-location distributor account numbers — none of which AIO collects, matching the no-EIN/no-bank-details posture already enforced for Adyen/Check. So the Phase 2/2.5-style hosted-onboarding-API scaffold built for this module first was wrong and was torn out. What's built instead: `lib/foodbuyForm.ts` renders a pre-filled copy of the real form as printable HTML (business identity/address + main contact only — everything requiring a legal attestation or Foodbuy-side data stays a blank line), exported client-side via the same `html2pdf`-in-a-new-window pattern `ProposalStep.tsx` already uses for proposal PDFs — no new dependency, no server-side PDF lib. `foodbuyModule()` just tracks `foodbuyIds.generatedAt` (has the customer downloaded their copy yet) since there's no remote status to poll; the CTA stays available even once "complete" so they can re-download. The customer signs the printed/downloaded copy and hands it to their AIO rep or a Foodbuy account executive themselves — AIO's system never transmits or receives it. |

### Critical constraints (do not reverse)
- `MerchantApplication` has **no SSN, bank account, routing number, or EIN fields** — Adyen collects those on their hosted page
- Pricing math (`MARGIN_REQS`, `derivePricing`) lives in `pricing.ts`, **not** in Claude prompts
- `generateProposal()` force-overrides any AI-returned numbers with locally computed `exactRates`/`exactProjected`
- HubSpot uses Private App Token — **no OAuth**
- All v2 work in `app-v2/` — **do not touch the root HTML files**
- **Reps never see the true margin floor or true Adyen cost** — always go through `derivePricingForRole`/`getPricingPreviewAction`, never `derivePricing` directly from a rep-facing client component
- `owner_user_id` (the rep who owns a deal, FK to `users.id`) and `ownerContact` (the merchant's own business contact person) are two different "owner" concepts — don't conflate them
- `customer_link_token`/`customer_link_purpose` is a **generalized, reusable** token slot: `"lead_upload"` (Phase 1.5, pre-analysis self-serve) and `"kyc_handoff"` (Phase 2, post-proposal Adyen KYC) are different moments in the deal lifecycle sharing the same field — don't assume a token is one or the other without checking `customer_link_purpose`
- `MerchantApplication` has **no EIN, bank account, or payroll tax fields** for Check either — Check collects those on its hosted pages, same rule as Adyen
- Check's `industry_type` is **its own enum, not an MCC/SIC code** (`restaurant`, `food_and_beverage_retail_or_wholesale`, …) — `check.ts` maps `processing.mcc` onto it, defaulting to `restaurant`. Don't pass a raw MCC through.
- `/api/lead/[token]/analyze` must only ever return `CustomerSafeQuote` — never the raw `StatementAnalysis` or any cost/margin field
- **A quote's `quoteType` (`full_pos` | `food_truck` | `marketing_only`) drives every selection rule** and is chosen before anything is picked — never inferred from the picks, because the derived lines land on an empty quote. Null on pre-existing rows means `full_pos` (`quoteTypeOf`). Matrix in E2E-PLAN.md, "Quote types and selection rules".
- **Derived quote lines are never pickable**: all three platform products and the three always-included services (AIO WiFi Network Package, Onsite Installation, System Onboarding and Training) are hidden from the picker and re-derived server-side. A rep able to add one by hand is a double platform fee or a second $999 install. Reopening a saved quote strips them via `picksFromQuoteLines()`.
- The three install services attach to the **picked products**, not to the quote type alone — an empty picker is a rate-only quote and carries none of them. Declared ordering channels don't pull them in (a website-ordering merchant has nothing on site to install), though they do still drive the platform fee.
- `buildQuote()` in `quoting.ts` is the **one** derivation — the configurator's live preview and the server's authoritative write both call it. Don't reintroduce a second copy in the client. Its `blockers[]` gates both the submit button and the server action.
- A `marketing_only` quote has **no processing rate at all** — `CustomerSafeQuote` is a discriminated union whose `basis: "products"` variant carries no volume/rate/savings fields. Don't flatten that back to nullable numbers; zeros there render as a real 0.00% quote.
- `ENABLE_DEBUG_ROLE_SWITCH` must never be set in a Vercel project environment — local `.env.local` only
- **Publishing a HubSpot quote is a one-way door.** No API edit (400 `LOCKED`), no delete (`PUBLISHED_QUOTE_CANNOT_BE_DELETED`), and no void — setting `hs_status: VOID` is itself an edit, so voiding is HubSpot-UI-only. Never build an "unpublish", "edit published quote", or "re-publish" affordance; `retryBillingQuoteAction` refuses once `publishedAt` is set. A `400 LOCKED` from `publishQuote` means **already published** and must be treated as success, or a crash between HubSpot's ack and the DB write wedges the account forever.
- **`hs_recurring_billing_period` is DELIBERATELY never written.** It is a contract *term*, not the billing cycle — HubSpot derives `hs_recurring_billing_number_of_payments` from it, so `P7D` on a weekly line takes one $99 charge and then silently stops collecting. 935 of AIO's 1,200 live weekly line items leave it NULL. `PHASE-E-SPEC.md` §3.3 says to send `P7D`; the spec is wrong. Product-owner decision, 2026-08-21. **LIVE-VERIFIED 2026-08-24** on quote `323970722493`: the weekly platform line came back `hs_recurring_billing_period: NULL` / `hs_recurring_billing_number_of_payments: NULL`, while all eight one-time lines got `nPayments: 1`. That is HubSpot deriving the payment count from the period, observed directly — the mechanism is no longer inferred.
- **`hs_sender_email` is NOT validated by HubSpot — GO-LIVE BLOCKER.** It is written from the owning rep's `users.email` (`resolveSender`, `publishBillingQuote.ts:147`). The 2026-08-24 gate run published with `rep@aioapp.com`, a seeded dev user that is not a portal owner, and HubSpot **accepted it silently** — no 400, no warning. So nothing anywhere will catch a wrong sender, and a real merchant would receive their quote "from" whatever junk address sits on the owning `users` row. Before the first real customer: seeded/dev users need real addresses, or `resolveSender` needs to resolve a HubSpot owner and refuse when it can't. O-1 (`PAYMENT-TEST-PLAN.md`:249) is explicit that all 46 live paid quotes use a real rep address.
- **A published quote carries `app.quoteLines` VERBATIM — `publishBillingQuote.ts:211` never calls `buildQuote()`.** Derivation happens at *save* time in the configurator. So a row saved before a change to the derivation rules publishes under the OLD rules, silently. Two rows accepted 2026-08-18 are $1,498 short each (no Onsite Installation, no System Onboarding and Training) because they predate `272f58b`/`c65b4b1`, and `canPublishBillingQuote` does not catch it — it verifies the *platform* line resolves, never that the included services are present. Any backfill of pre-existing accepted rows must re-derive through `buildQuote()` first, or it publishes an under-priced quote onto a document nobody can amend.
- **Billing completion is gated on the SUBSCRIPTION, never on the quote's `hs_payment_status`.** The subscription appears 1–9 minutes after checkout; `PAID` lags it by a median of **5.7 days** (daily ~12:00 UTC ACH batch). Gating on `PAID` tells a merchant who already paid to "Review & Pay" for most of a week. Same reason the nightly cron's lookback is **10 days**, not 3.
- One quote yields **one subscription per distinct billing frequency**, so AIO's weekly-platform + monthly-add-on mix routinely produces two. Hence `hubspotIds.subscriptions[]` and `findSubscriptionsForQuote` (association **304**), never a single id, and never a deal-keyed lookup — a reused deal carries subscriptions from earlier quotes.
- `hs_quote_link` is **not** a one-time-use link, unlike the Adyen and Check ones — the slug exists at create, the URL is predictable, and auth is `public_access`. `/customer/applications/[id]/billing` is **read-or-refresh, not mint-per-click**. Don't "fix" it to match its two `/continue` siblings.
- A **rate-only quote** (empty `quoteLines`) creates no HubSpot billing objects at all and its checklist module is **omitted**, not shown pending — processing margin comes out of Adyen settlement and the catalog's processing products are $0 placeholders. Discriminate on `quoteAcceptedAt`: empty lines *before* acceptance just means the rep hasn't configured it yet.
- **No HubSpot Company linked → no deal, no billing quote, nothing.** A deal's company association (341) is only settable on the deal CREATE — the v3 PATCH takes properties only — so a deal pushed before `tenantLink.hubspotCompanyId` exists is orphaned off the Company record permanently. Every push site gates on `canPushToHubSpot()` (accept route, both customer-side saves, `retryBillingQuoteAction`), `pushToHubSpot` itself throws as the backstop, and `buildAndPublishBillingQuote` short-circuits `awaiting_tenant_link` **before the build claim** so waiting leaves no `lastSyncError` — an unlinked account is normal, not a failure, and counting it as one floods the admin sync-error tripwire. `canPublishBillingQuote` restates it as `no_tenant_company` because that reason names the fix. The resume is `linkTenantCompanyAction`, which creates the held-back deal and, if the merchant already accepted, publishes the quote right there — **so linking a company can open the one-way door**. That is intended (user's decision, 2026-09-10), same posture as auto-publish-on-acceptance.
- **Re-opening an accepted lead link creates nothing.** "Email Me a New Link" POSTs the same `/api/lead/[token]/accept` route as the first acceptance; only `firstAcceptance` (`!row.quoteAcceptedAt`) runs the deal push and the billing build. It used to run both every time, which minted a second deal on any row whose first push was deferred or failed. Recovery from a failed first push is `retryBillingQuoteAction`, never a merchant asking for a login link.
- `hubspotDealId` (the flat column) is the canonical deal id. `HubspotIds` deliberately has **no** `dealId` — two homes would create a second deal per application.
- **Foodbuy has no API — don't reintroduce an `adapters/foodbuy.ts`, an onboarding-status enum, or a mint-fresh-link `/continue` route for it.** Enrollment is a signed paper agreement (`AIO_Foodbuy_Enrollment_Form_V1`) that the customer completes and hands off themselves; `lib/foodbuyForm.ts` only pre-fills what AIO already knows into a printable document. It asks for the Federal ID # (EIN) — never collect that field on AIO's side, same rule as Adyen/Check's EIN/bank/SSN prohibition.

### The Phase E gate run (2026-08-24) — the reference evidence

The one human-run live publish, executed by clicking **Retry HubSpot sync** on the admin accounts
dashboard for `prospect_1787098151325` ("bob"). Read back from HubSpot, not from our own row. This is
the record to compare against when the publish path next changes:

| | |
|---|---|
| quote | `323970722493`, `hs_status: APPROVAL_NOT_NEEDED` (the published state, spec §181) |
| deal | `343689933538` — **created by the retry itself**, see `retryBillingQuoteAction` below |
| contact | `540176122579` |
| `hs_quote_amount` | `3811.00` = $3,712 one-time + $99 first weekly |
| `hs_quote_link` | `https://customers.aioapp.com/0f2hv0e1fjzk9q` (voided by hand afterwards, per `PAYMENT-TEST-PLAN.md` §2.2) |
| flags | `hs_payment_enabled: true`, `hs_esign_enabled: true`, `hs_allowed_payment_methods: ACH`, `hs_acceptance_method: esignature` |
| associations | **67** ×9 line items · **64/1393** deal (1393 added by HubSpot at publish, as documented) · **702/69** contact · **286** template `817263673055` (AIO Quote v3) · subscriptions **none** (correct until checkout) |

Confirmed by this run: the deliberate-NULL `hs_recurring_billing_period` behaviour, the template
fallback when `quote_template_policy` is empty, and that the whole association graph holds together
live. Surfaced by this run: the `hs_sender_email` blocker and the verbatim-`quoteLines` hazard, both
constraints above.

### Env vars needed (per phase)
```
ANTHROPIC_API_KEY           # Phase 1 — required now
DATABASE_URL                # Phase 1.5 — Neon Postgres (+ several other PG*/POSTGRES_* vars, all Vercel-managed)
AUTH_SECRET                 # Phase 1.5 — NextAuth
ENABLE_DEBUG_ROLE_SWITCH    # Phase 1.5 — local dev only, never in Vercel project env
ADYEN_LEM_API_KEY           # Phase 2
ADYEN_COMPANY_ID            # Phase 2
ADYEN_ENVIRONMENT           # Phase 2 (test|live)
ADYEN_WEBHOOK_HMAC_KEY      # Phase 2
CHECK_API_KEY               # Check payroll — bearer token
CHECK_API_BASE_URL          # Check payroll — defaults to https://sandbox.checkhq.com; set for production
NEXT_PUBLIC_HUBSPOT_PORTAL_ID  # Phase E — 244508708. Cosmetic only: turns deal/quote ids in the
                            # rep+admin billing panel into clickable CRM record links. Absent, they
                            # render as copyable text rather than broken links. NOT a secret.
CRON_SECRET                 # bearer for /api/cron/* (adyen-actuals, hubspot-links, hubspot-billing-sync)
HUBSPOT_PRIVATE_APP_TOKEN   # Phase 3 — general CRM app: companies (tenant linkage), deal sync
HUBSPOT_BILLING_PRIVATE_APP_TOKEN  # separate "EasyOB Billing" app: products (needs the
                            # `e-commerce` scope), quotes, line items, contacts, subscriptions
                            # + invoices read. Deliberately a second token so billing write
                            # scopes don't widen what the sync path can reach.
RESEND_API_KEY              # Phase 4
RESEND_FROM_EMAIL           # Phase 4 — "Name <local@subdomain>"; requires that subdomain verified in Resend
                            # (SPF/DKIM/DMARC DNS records). Unset falls back to the shared resend.dev test
                            # domain, which only delivers to the API key's own account owner — not real merchants.
TWILIO_ACCOUNT_SID          # Phase 4 — SMS lead link, optional (only sent when the rep enters a phone)
TWILIO_AUTH_TOKEN           # Phase 4
TWILIO_FROM_NUMBER          # Phase 4 — E.164, e.g. +15551234567
NEXT_PUBLIC_BASE_URL        # Phase 1.5 — used to build the customer lead-link URL; keep in sync with actual dev port
```
(Phase F — Foodbuy — needs no env vars: it has no API, see lib/foodbuyForm.ts.)
