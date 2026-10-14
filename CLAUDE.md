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
- **Auth:** NextAuth v5, JWT sessions. **Staff (rep/admin) sign in with Microsoft Entra ID** (`microsoft-entra-id`, OIDC) — see "Entra ID staff sign-in" below. Customers still use Credentials (magic link, or a password they set themselves); the only remaining staff password is the admin breakglass at `/login/breakglass`.
- **Storage:** all reads/writes go through Server Actions (`src/lib/actions/`) → `PostgresAdapter` (`src/lib/storage/postgresAdapter.ts`). `LocalStorageAdapter` was deleted in Phase 1.5 — nothing in the running app touches `localStorage` for application/settings data anymore.
- **Adyen:** EasyOB no longer creates Adyen accounts. As of 2026-09-23 the ONLY way a merchant gets one is through **AIO's own dashboard API** (`adapters/aioDashboard.ts`), which creates the tenant, the location, and mints an Adyen hosted-onboarding link already wired to the right tenant. EasyOB's own legal-entity/account-holder/business-line chain was deleted: it produced balance accounts that were misnamed and unlinked from AIO's tenant graph. The merchant still fills SSN/bank/EIN on Adyen's hosted page. EasyOB keeps ONE direct Adyen dependency — the read-only **settlement report** download that feeds the P&L (`adapters/adyenReports.ts`).
- **Check (checkhq.com):** embedded payroll. Hosted onboarding only, same posture as Adyen — AIO creates the Check *company* from details it already holds, Check collects EIN/bank/tax data on its own hosted pages. Wired & in sandbox testing (see the payroll module below).
- **HubSpot:** Private App Token (`HUBSPOT_PRIVATE_APP_TOKEN`), no OAuth. Still Phase 3, not started.

### Roles & the pillowed margin model (Phase 1.5)
Three roles: **Customer** (no account — tokenized links only), **Rep**, **Admin**. `middleware.ts` guards `/rep/*` (rep or admin) and `/admin/*` (admin only) using NextAuth sessions. Roles live in `users.role` and are set by an admin at `/admin/users` — **not** derived from Entra groups or app roles (see "Entra ID staff sign-in").

The core trust boundary: **reps must never see or derive AIO's true minimum profitable margin.** `pricing.ts`'s `getMarginFloor()` (true volume-tiered floor) and `calcAdyenCost`/`adyenRateOnVolume` (true per-transaction processing cost) are real numbers computed correctly everywhere internally, but a rep's UI/API responses only ever see a **pillowed** (padded) floor and, by default, no exact Adyen cost at all — controlled by a global policy (`margin_policy` table). **Its editor was deleted on 2026-10-12** (`/admin/settings/pillow` — "we are gonna work on margin stuff later"); the policy itself is untouched and still applied on every rep-facing price, reading whatever row is saved or `DEFAULT_PADDING`, and `updatePaddingPolicyAction` is kept for when the editor returns. The one control on that page that was NOT margin padding — the discount cap — moved to `/admin/settings/quote-limits`. This is enforced **server-side** in `derivePricingForRole()` (`pricing.ts`) via `src/lib/actions/pricing.ts`'s `getPricingPreviewAction()` — `PricingStep.tsx` has no client-side access to the true numbers at all, it only renders whatever the server decided this role gets to see. Don't move this computation back to the client.

A **temporary, dev-only debug role switcher** (`src/lib/auth/debugRole.ts`, `src/components/dev/RoleSwitcher.tsx`) lets you click through Rep/Admin views without logging in/out, hard-gated on `ENABLE_DEBUG_ROLE_SWITCH` (must only ever be set in a local `.env.local`, never a Vercel project env — Preview deployments also run `NODE_ENV=production`, so that alone isn't a safe gate). It resolves to the real seeded `rep@aioapp.com`/`admin@aioapp.com` DB rows (not fake IDs) since `merchant_applications.owner_user_id` is a strict FK. Safe to delete later: that file, the component, `src/lib/actions/debugRole.ts`, and their two call sites in `middleware.ts`/`auth.config.ts` and `app/layout.tsx`.

### Entra ID staff sign-in

Staff authenticate against AIO's Microsoft 365 (Entra) tenant. **Entra proves identity; `users.role`
grants authority.** There is deliberately no groups/appRoles claim plumbing — a rep is a rep because an
admin said so at `/admin/users`, not because of directory membership. Don't add group-driven roles
without raising it: it would make `/admin/users`' role editor a lie.

**Nothing is auto-provisioned.** A tenant member with no `users` row is refused (`not_provisioned`).
A rep account can read pillowed margins, configure quotes and open the one-way HubSpot publish door,
so that access is granted deliberately, never inherited from being an AIO employee.

**The merge.** Old password logins were joined to Entra lazily, on first sign-in, in
`resolveEntraStaffUser` (`lib/auth/entra.ts`): match `entra_oid` first, then `users.email`
(lowercased) — and on an email hit, stamp `entra_oid`/`entra_linked_at` onto the row. From then on
the immutable `oid` is authoritative, so a rep who changes their surname (and therefore their UPN)
keeps their account and their deals. Refusals: `not_provisioned`, `not_staff` (a customer row reached
by a colliding address — never silently upgraded), `disabled`, `oid_conflict` (a second Entra identity
claiming a linked row; recovery is "Unlink Microsoft account" at `/admin/users`), `wrong_tenant`,
`no_email`, `no_identity`. Copy for each lives in `entraDenial.ts`.

**Why the lookup is inside the provider's `profile()`** and not the `signIn` callback: it is the only
hook that gets the raw claims, and it is what decides which AIO row becomes the session. A refusal
can't throw from there without becoming an opaque OAuth error, so it's carried on the user object as
`denied` and turned into a message by the `signIn` callback in `auth.config.ts` (edge-safe: it only
reads the marker, never the DB). A refused identity is returned with **no `role`**, so even a session
that escaped the gate fails every check in `authorized`.

**`profile()` returns the AIO user id TWICE, as `id` and as `aioUserId`, and that is not
redundancy.** `@auth/core` (0.41.2, under `next-auth` 5.0.0-beta.31) **discards** an OAuth provider's
returned `id` and substitutes `crypto.randomUUID()` — deliberately, so the user stays independent of
the provider (`lib/actions/callback/oauth/callback.js`). That random id then seeds the token's `sub`,
and `sub` becomes `session.user.id`, which is written to `merchant_applications.owner_user_id`, a
strict FK. So the `jwt` callback in `auth.config.ts` restores `token.sub = user.aioUserId`; everything
`profile()` returns other than `id` survives, because the clobber spreads it first. **Delete
`aioUserId` and every staff session silently names a user that does not exist** — reads come back
empty and the first write dies on the foreign key. This is not hypothetical: it shipped that way, and
between the Entra cutover and 2026-09-23 no rep could create a prospect at all. An earlier version of
this document asserted the opposite (that `sub` came from `profile()`'s `id`) as the *reason* the
lookup lives there; it was true of some older `@auth/core` and is not true now. The credentials
provider is unaffected — it keeps `authorize()`'s `id` (`callback/index.js:238`), which is why
customer magic-link and admin breakglass sessions were always correct.

Regression cover is `sessionValidation.test.ts`, and it works by **modelling the clobber**
(`{ ...profileResult, id: randomUUID() }`) rather than asserting on `profile()`'s return — an
assertion on `profile()` alone passes happily while every session is broken.

**The `email` claim is not reliable.** Entra emits it only when the user has a `mail` attribute or the
app registration requests it as an optional claim, so `readEntraIdentity` falls back to
`preferred_username` (the UPN) and then `upn`. Don't remove the fallback — a tenant whose users lack
`mail` would match nobody. The email **on file** is what's returned, not the claim's: it feeds
`hs_sender_email` on published HubSpot quotes, which can't be amended.

**Tenant pinning** comes from `AUTH_MICROSOFT_ENTRA_ID_ISSUER`; `expectedTenantId()` parses the tenant
out of it and the `tid` claim is checked against it. `common`/`organizations` are treated as
unconfigured (they mean "any Microsoft account"), which makes the `tid` check a no-op rather than a
false guarantee — so **pin the issuer to the real tenant id**.

**Passwords.** Reps have no password path at all. `credentials` now requires a `scope`
(`"customer"` | `"breakglass"`) and refuses a role that doesn't match it — the two surfaces post the
same email+password shape, so without it a customer password would open a staff session. `scope`
missing → refused, so no stale bare-credentials caller can slip through. The admin breakglass
(`/login/breakglass`, unlisted) is the only staff password and exists solely so a broken or
unreachable Entra tenant can't lock everyone out of `/admin`.

**The app registration exists.** `EasyOB Staff Sign-In`, created 2026-09-17 in the AIO tenant
`e951f5b3-da6a-4b3d-9f40-993a88995573`, single-tenant (`signInAudience: AzureADMyOrg`). It carries
both redirect URIs, `email` + `upn` as optional ID-token claims, implicit flows off, and tenant-wide
admin consent for `openid profile email` so staff never see a consent prompt. It was created by
`scripts/entra-app-registration.ps1`, which is idempotent — re-running it is also the
**secret-rotation** path. **The client secret expires 2028-09-17**; rotating means re-running that
script (it rewrites `.env.local`, `\$`-escaped) and then replacing
`AUTH_MICROSOFT_ENTRA_ID_SECRET` in the Vercel project by hand, with the RAW `$`.

Requested scopes are just `openid profile email`; the provider's default adds Graph `User.Read`
purely to fetch a profile photo and base64 it into the session JWT, which `auth.ts` overrides away.

A registration created through Graph rather than the portal needs its **service principal created
explicitly** (`POST /servicePrincipals { appId }`) — the portal does that implicitly, Graph does not,
and without it sign-in fails with "application not found in the directory."

**Entra allows no wildcard redirect URIs**, and Auth.js builds `redirect_uri` from the request's own
Host header (`trustHost` is auto-true on Vercel, and `AUTH_URL` is deliberately unset so local dev
and production can share one config). So **only `http://localhost:5001` and the stable production
alias `https://aioeasyob.vercel.app` can complete an Entra sign-in** — per-deployment and preview
hostnames get a `redirect_uri` mismatch from Microsoft. Previews use `/login/breakglass`. Adding a
custom domain means adding its callback URI to the registration too.

**The sign-in button opens a popup, except on Safari.** `/login` POSTs to Auth.js's REST signin
endpoint into a named popup and watches it from the opener; success lands on
`/login/popup-complete` — a stub page that exists only so `/rep` never renders inside the popup —
and the opener then navigates the top window.

Two things there are load-bearing and easy to "simplify" wrongly:

- The outcome is read by **polling the popup's URL from the opener**, not by `postMessage`. Chrome
  clears `window.name` across a cross-origin navigation, so a page loaded inside the popup cannot
  reliably tell that it *is* the popup. The opener always can, and a cross-origin read simply throws
  while the popup is still on `login.microsoftonline.com` — that throw is the "keep waiting" signal.
- `/login/popup-complete` **must not call `window.close()`**. The opener tells "signed in" from
  "user cancelled" by whether the window closed before reaching that path, so self-closing would
  make every success look like a cancellation.

Safari and every iOS browser (all WebKit) keep the plain top-level redirect: popup blocking plus
storage partitioning that can drop the PKCE/state cookies the callback needs. The same redirect is
the fallback when JS hasn't hydrated, the CSRF fetch fails, or the popup is blocked — the form's
`entraSignInAction` server action is the no-JS path, so the button degrades instead of breaking.

### Key files
```
app-v2/src/
  types/merchant.ts          ← canonical MerchantApplication type (no PII fields), CustomerSafeQuote
  lib/pricing.ts             ← MARGIN_REQS, getMarginFloor, derivePricing (true numbers, untouched)
                                + getPillowedFloor/derivePricingForRole (role-scoped view, additive)
  lib/rateMatrix.ts          ← the CARD-PRESENT RATE CARD: volume × average ticket → the rate a rep
                                is offered (pricing guide §10.3, the $0.15/txn option). Pure; the
                                live numbers are in `rate_matrix_policy`, admin-edited at
                                /admin/settings/rate-matrix. SUGGESTS only — see the constraint below.
  lib/billing/processingArr.ts ← paymentProcessingArr() — margin × monthly volume × 12, written to the
                                HubSpot deal's `payment_processing_arr` at ACCEPTANCE only
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
    pricing.ts                ← getActivePaddingPolicy, updatePaddingPolicyAction (admin-only), getPricingPreviewAction
                                 (NB: named Padding*, not Pillow* — this doc's older "pillow" wording is drift)
    prospects.ts              ← createProspectAction — rep creates a prospect + tokenized customer link
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
  lib/foodbuyForm.ts            ← buildFoodbuyFormHtml() — Foodbuy has NO API (it's a paper participation
                                 agreement, AIO_Foodbuy_Enrollment_Form_V1). Pre-fills business/contact
                                 fields into a printable HTML doc, exported client-side via html2pdf —
                                 same pattern as ProposalStep.tsx's proposal PDF, no adapter/no HTTP call.
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
    api/analyze/              ← POST — rep flow, calls analyzeStatement() server-side
    api/proposal/             ← POST — rep flow, calls generateProposal() server-side
    api/lead/[token]/checkout/ ← POST — PUBLIC. THE MERCHANT'S DOOR TO BILLING: builds + publishes the
                                 HubSpot quote on demand and returns hs_quote_link. Irreversible, so
                                 the page confirms first. Never leaks a precondition message.
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

**Dev login credentials** (seeded, not production-safe):
- Admin: `admin@aioapp.com` / `admin123` — at `/login/breakglass`, **not** `/login`. This is the
  breakglass credential now, so it is load-bearing: override it with `SEED_ADMIN_PASSWORD` anywhere
  that isn't a local machine, or change it from `/admin/users` → "Change breakglass password".
- Rep: `rep@aioapp.com` — **no password** (reps sign in with Entra). Exists for the debug role switcher.
- Customer: `customer@aioapp.com` / `customer123` — at `/customer/login`.

**Bootstrapping a real staff roster:** sign in at `/login/breakglass` as the admin, then add each
person at `/admin/users` using their Microsoft work-account address. Their first "Sign in with
Microsoft" links the row. `admin@aioapp.com`/`rep@aioapp.com` are fake and have no Entra counterpart
— they will never link, which is fine.

**⚠️ `vercel integration add` / `vercel env pull` will overwrite `.env.local` wholesale**, wiping any local-only vars (like `ANTHROPIC_API_KEY`) that aren't stored in the Vercel project's env. Back up `.env.local` before running Vercel CLI commands that touch env vars.

**⚠️ The Entra vars are stored in Vercel as type `Sensitive`, i.e. write-only** — `vercel env pull`
cannot read them back. So a pull doesn't just fail to restore `AUTH_MICROSOFT_ENTRA_ID_SECRET`, it
*destroys* the local copy along with everything else in `.env.local`. If that happens, recover from
the `.env.local.bak-*` the registration script leaves behind, or re-run
`scripts/entra-app-registration.ps1` to mint a fresh secret (then update Vercel, since the old
secret stays valid but you no longer have it).

**⚠️ Adyen (and any) API keys containing `$` MUST be `\$`-escaped in `.env.local`.** Next's `@next/env` runs `dotenv-expand`, so a raw `$AB` in a key value is silently expanded away (treated as a `${AB}` reference), corrupting the key and producing Adyen `401 Unauthorized`. Single/double quotes do NOT prevent this in `@next/env` — only backslash-escaping (`\$`) does. **In the Vercel project env UI, do the opposite: paste the RAW `$`** (Vercel stores values literally and does not run dotenv-expand; a `\$` there becomes part of the key and 401s). (The Adyen LEM/Config/HMAC keys this originally described are gone — EasyOB no longer creates Adyen objects — but the rule still applies to any key containing `$`, including `AIO_DASHBOARD_PASSWORD`.)

### Phase status
| Phase | What | Status |
|---|---|---|
| 1 | Next.js scaffold + 5-step rep flow + localStorage | **DONE** (committed 2026-07-06) |
| 1.5 | Multi-role (Customer/Rep/Admin), Postgres, NextAuth, pillowed margin, customer self-serve lead flow | **DONE** (2026-07-06) |
| 2 | Adyen onboarding | **REPLACED 2026-09-23 — EasyOB no longer creates Adyen accounts.** Product-owner decision: our own integration was "harmful and redundant", producing balance accounts that were misnamed and unlinked from the AIO tenant graph. `adapters/adyen.ts`, `adapters/adyenWebhook.ts` and `/api/adyen/webhook` are DELETED. A merchant now gets a tenant + location + KYC link from **AIO's dashboard API**, triggered when their **billing is paid** (the HubSpot subscription appears), by `/api/cron/aio-provisioning` → `lib/aio/provision.ts`. Behind AIO_DASHBOARD_ENABLED, **ON IN PRODUCTION since 2026-10-14** with an EMPTY allowlist — the paid-subscription gate is the canary, so no fake application can reach it. Verified by calling the prod cron, which is the only check that proves every env var resolved. PROD-verified end-to-end 2026-10-09 with a dedicated service account — see app-v2/AIO-DASHBOARD-PROD-VERIFIED.md. See "The AIO dashboard provisioning path" below. |
| 2.5 | Check payroll onboarding (the `payroll` module on the customer checklist) | **BUILT / sandbox** — opt-in, not auto-chained like Adyen: nothing reaches Check until the customer clicks "Set Up Payroll" at `/customer/applications/[id]/payroll`, which collects the two things AIO can't derive (first payday + authorized signer) and calls `startPayrollOnboardingAction`. Onboard links are one-time use / 24h, so `/customer/applications/[id]/payroll/continue` mints a fresh one per click — never store and re-serve one. Check has **no redirect-back URL**, so completion is detected by re-reading `company.onboard.status` when the customer views the application (`getMyApplicationWithPayrollSyncAction`), cached on `checkIds.onboardStatus` so list/dashboard views don't fan out one API call per app. Production base URL is a go-live TODO (`CHECK_API_BASE_URL`; Check doesn't publish it). |
| 3 | HubSpot bidirectional sync (wire `hubspot.ts` stub) | **SUPERSEDED / partly done.** There is no bidirectional sync and there must not be: authority **hands off at quote publish** — EasyOB → HubSpot while the quote is a draft, HubSpot → EasyOB (read-only) forever after. Deal sync is repaired and live (it had never once succeeded before commit `9aafa5d`). Billing is E2E-PLAN **Phase E**, below. `getMyApplicationWithPayrollSyncAction` was folded into `getMyApplicationWithSyncAction` (refreshes Check + HubSpot independently). |
| E (E2E-PLAN) | **Billing through HubSpot** — quote → hosted checkout → subscription read-back | **PUBLISH PATH LIVE-VERIFIED 2026-08-24** — the one human-run publish `PHASE-E-SPEC.md`:777 called for is DONE; see "The Phase E gate run" below. **The TRIGGER changed 2026-09-25**: the merchant publishes it themselves from their own quote link, not the rep. Same build, same preconditions, same one-way door — see the acceptance constraint. Checkout → subscription read-back remains unverified **on purpose** (`PAYMENT-TEST-PLAN.md` §2.1 recommends against a live payment test; §1's 46 live paid quotes cover it instead). **The rep sends the quote (`sendQuoteAction`); acceptance is then DETECTED, not asserted** — see the constraint below. `canPublishBillingQuote` still applies strictly before the first write. Migration `0008` (`quote_template_policy`) **IS applied** — the policy table is empty, which is harmless: `getQuoteTemplatePolicy()` falls back to `DEFAULT_TEMPLATE_IDS`, so an unseeded table can never block a publish. Wants `NEXT_PUBLIC_HUBSPOT_PORTAL_ID=244508708` (cosmetic: CRM record links). The `hs_sender_email` go-live blocker is **CLOSED** (2026-09-25) — the sender is verified against the portal's own user list before the door opens, and the `crm.objects.owners.read` scope it needs is granted and verified live; see the constraint below. |
| 4 | Merchant magic link email + SMS delivery on prospect creation (Graph/Resend + Twilio) | **EMAIL LIVE-VERIFIED 2026-09-24 locally; env pushed to Vercel Production, awaiting a deploy to take effect. SMS still awaiting a Twilio account.** Email prefers **Microsoft Graph** over Resend — see "Transactional email" below, which also records why the Resend-domain blocker is moot. Original Resend note follows: — `createProspectAction` now auto-sends the lead link via `sendLeadLinkEmail` (always attempted) and `sendLeadLinkSms` (only if the rep entered a phone), right after the prospect row is saved; a send failure never blocks prospect creation, and the rep always sees the raw link with a copy button as fallback (same pattern as the existing `sendMerchantOnboardingLinkAction`/"Send Onboarding Link" KYC-handoff button, which is unchanged). Both degrade gracefully — with `RESEND_API_KEY`/`TWILIO_*` unset, sends just no-op and the UI shows "delivery isn't configured yet." Still needed before this reaches a real merchant: a verified Resend sending domain (`RESEND_FROM_EMAIL`, e.g. a `send.aioapp.com` subdomain — needs SPF/DKIM/DMARC DNS records) and a Twilio account + number (`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_FROM_NUMBER`). Phone is optional on the prospect form — no phone means no SMS attempt. |
| 5 | Entra ID (Microsoft 365) staff sign-in, replacing staff passwords | **SIGN-IN LIVE-VERIFIED 2026-09-18; THE SESSION IT ISSUED WAS BROKEN UNTIL 2026-09-23.** `@auth/core` replaced the AIO user id with a random uuid on every sign-in, so `session.user.id` named a user that did not exist and every rep write died on the `owner_user_id` FK — see "`profile()` returns the AIO user id TWICE" above. The 2026-09-18 check only proved the *link* (`entra_oid` is stamped inside `profile()`, before the id is discarded), which is exactly why it looked green. Fixed by `user.aioUserId` + the `jwt` callback, and `getEffectiveRole`/`getCustomerSession` now resolve the session against `users` on every request so the next mismatch of any kind is "sign in again", not a foreign-key violation. `microsoft-entra-id` provider wired, old logins merge to their Entra identity lazily on first sign-in (`lib/auth/entra.ts`, migration `0010` adds `users.entra_oid`/`entra_linked_at`). Roles stay in `users.role`; nothing is auto-provisioned; admin breakglass at `/login/breakglass`. App registration done 2026-09-17 (see "Entra ID staff sign-in"); the three env vars are in `.env.local` **and** the Vercel project (Production, type Sensitive). A real staff sign-in has now run end to end: `shaheer.hasnain@aioapp.com` (admin, created at `/admin/users`) signed in with Microsoft and `resolveEntraStaffUser` stamped its `entra_oid`/`entra_linked_at`. `joe@aioapp.com` is still unlinked and will link on his own first sign-in; `admin@aioapp.com`/`rep@aioapp.com` are fake and will never link. **Not yet deployed** — the whole change is still uncommitted. Optional DB session strategy still NOT STARTED. |
| F | Foodbuy enrollment (the `foodbuy` checklist module — graduated off the `coming_soon` shell) | **DONE** — Foodbuy turned out to have **no API at all**: enrollment is a paper "Foodbuy Foodservice Enrollment" participation agreement (source form: `AIO_Foodbuy_Enrollment_Form_V1`) that asks for the Federal ID # (EIN), a wet/e-signature, GPO-affiliation disclosure, and per-location distributor account numbers — none of which AIO collects, matching the no-EIN/no-bank-details posture already enforced for Adyen/Check. So the Phase 2/2.5-style hosted-onboarding-API scaffold built for this module first was wrong and was torn out. What's built instead: `lib/foodbuyForm.ts` renders a pre-filled copy of the real form as printable HTML (business identity/address + main contact only — everything requiring a legal attestation or Foodbuy-side data stays a blank line), exported client-side via the same `html2pdf`-in-a-new-window pattern `ProposalStep.tsx` already uses for proposal PDFs — no new dependency, no server-side PDF lib. `foodbuyModule()` just tracks `foodbuyIds.generatedAt` (has the customer downloaded their copy yet) since there's no remote status to poll; the CTA stays available even once "complete" so they can re-download. The customer signs the printed/downloaded copy and hands it to their AIO rep or a Foodbuy account executive themselves — AIO's system never transmits or receives it. |

### Critical constraints (do not reverse)
- **The session is resolved against `users` on every request, and that is load-bearing.** Auth.js
  never revalidates a JWT, so `sub` and `role` in the cookie are just claims: an account deleted,
  disabled or demoted after sign-in keeps satisfying `middleware.ts` (edge-side, no DB) and fails
  only at the first write, as an FK violation on `owner_user_id`. `getEffectiveRole` and
  `getCustomerSession` load the row, refuse a missing/disabled one, and take **`role` from the
  database, not the token** — so `/admin/users` disable and demote take effect immediately instead
  of at JWT expiry. Both are `cache()`d (one indexed PK read per request) and both reject a
  non-uuid `sub` before querying, because a refused Entra identity carries `entra:denied:<reason>`
  and a uuid column throws on it. The rep/admin layouts turn a null into
  `/login?error=session_stale`; middleware can't, because it can't reach Postgres.
- **A storage write failure must never be handed to the caller verbatim.** Drizzle's
  `DrizzleQueryError` puts the whole statement AND every bound parameter in `message`, and the rep
  and customer UIs render a caught `err.message` directly — so one FK violation printed a merchant's
  legal name, address, phone and email onto a rep's screen. `postgresAdapter`'s `dbWrite` keeps the
  driver's `cause` (which names the constraint and carries no data) and logs the rest server-side.
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
- **Two AIO endpoints are buggy on their FIRST call and the handling is narrow on purpose.**
  `restaurant/post/create` 500s with `relation "tenant_N.state" does not exist`;
  `restaurant/adyen-onboard` returns HTTP 201 `success:true` with `url: ""`. So **success is the
  PAYLOAD, never the status code** — a status-only client hands the merchant a blank KYC link.
  Never widen these to a blanket retry: there is no idempotency key, so retrying the wrong error
  creates a duplicate nobody can delete.
- **`adyenIds.tenantNumber` is the AIO business id, and the settlement ingest builds `prod-{n}` from
  it.** If AIO's store reference is not literally `prod-{businessId}`, the Phase G P&L silently
  stops attributing revenue and nothing alerts. Verify against one real settlement row before
  enabling the flag anywhere real.
- **There is no automatic Adyen KYC completion signal any more.** The webhook went with the rest of
  the integration and AIO exposes no status we can read. A deal reaches `adyen_approved` via a human
  (`markAdyenKycCompleteAction`) or via the settlement backstop (a tenant that settles money is
  demonstrably approved). Don't assume `stage` advances on its own.
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
- **Marketing-only merchants never get an Adyen module.** They pay us but sell nothing, so KYC would
  sit permanently incomplete. Gated on the existing `isProcessingQuote` — don't invent a second notion.
- `MerchantApplication` has **no SSN, bank account, routing number, or EIN fields** — Adyen collects those on their hosted page
- Pricing math (`MARGIN_REQS`, `derivePricing`) lives in `pricing.ts`, **not** in Claude prompts
- `generateProposal()` force-overrides any AI-returned numbers with locally computed `exactRates`/`exactProjected`
- HubSpot uses Private App Token — **no OAuth**
- All v2 work in `app-v2/` — **do not touch the root HTML files**
- **Staff roles are NOT derived from Entra groups or app roles.** Entra authenticates; `users.role`
  authorizes. And **nothing is auto-provisioned** — an AIO tenant member with no `users` row is
  refused. Both are deliberate (2026-09-15): rep access reads pillowed margins and can open the
  one-way HubSpot publish door, so it's granted at `/admin/users`, never inherited from employment.
- **`credentials` requires a `scope` (`"customer"` | `"breakglass"`).** Customer password login and
  the admin breakglass post the identical email+password shape, so the scope is the only thing keeping
  them apart — without it a customer password opens a staff session. A call with no scope is refused,
  which is what stops a stale bare-credentials caller. Reps have no password path at all.
- **Don't delete the `preferred_username`/`upn` fallback in `readEntraIdentity`.** Entra emits the
  `email` claim only when the user has a `mail` attribute or the app requests it as an optional claim;
  without the fallback an AIO tenant whose users lack `mail` would match nobody.
- **Three admin pages were deleted on 2026-10-12 and NONE of their policies were** — `/rep/settings`
  (processors & tiers), `/admin/settings/pillow` (margin padding) and `/admin/settings/quote-templates`.
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
- **Reps never see the true margin floor or true Adyen cost** — always go through `derivePricingForRole`/`getPricingPreviewAction`, never `derivePricing` directly from a rep-facing client component
- `owner_user_id` (the rep who owns a deal, FK to `users.id`) and `ownerContact` (the merchant's own business contact person) are two different "owner" concepts — don't conflate them
- `customer_link_token`/`customer_link_purpose` is a **generalized, reusable** token slot: `"lead_upload"` (Phase 1.5, pre-analysis self-serve) and `"kyc_handoff"` (Phase 2, post-proposal Adyen KYC) are different moments in the deal lifecycle sharing the same field — don't assume a token is one or the other without checking `customer_link_purpose`
- `MerchantApplication` has **no EIN, bank account, or payroll tax fields** for Check either — Check collects those on its hosted pages, same rule as Adyen
- Check's `industry_type` is **its own enum, not an MCC/SIC code** (`restaurant`, `food_and_beverage_retail_or_wholesale`, …) — `check.ts` maps `processing.mcc` onto it, defaulting to `restaurant`. Don't pass a raw MCC through.
- **THE CUSTOMER IS NEVER ASKED FOR A STATEMENT** (2026-10-13, product owner). `/lead/[token]/quote`
  used to render a dropzone whenever `buildCustomerSafeQuote` came back null, and `/api/lead/[token]/analyze`
  turned the upload into a `CustomerSafeQuote`. Both are DELETED, along with `LeadUploadStep.tsx` —
  don't reintroduce a customer-facing analyze route or a customer upload. `/api/analyze` (rep-only,
  returns the raw `StatementAnalysis`) is the only statement analyzer left.
  The state that actually fired was never "a lead with no quote": it was a merchant whose rep HAD
  built a quote — 13 lines, a published HubSpot document, a live checkout — but had entered no
  volume, so the page asked them to upload a statement instead of showing them the quote they came
  to sign. Hence the paired change: `buildCustomerSafeQuote`'s lines-only (`basis: "products"`)
  fallback now applies to EVERY quote type, not just marketing — a processing plan with priced lines
  and no rate basis shows the hardware and holds the rate back, where it used to return null. With
  no lines AND no rate basis it is still null, and the quote page says the rep is still preparing it.
- **A quote's `quoteType` IS the plan, and it drives every selection rule.** Chosen before anything is picked — never inferred from the picks, because the derived lines land on an empty quote. Three values since 2026-10-05, each naming exactly one monthly HubSpot platform product (`PLATFORM_PRODUCTS` in `quoting.ts`): `order_pay_only` → All-in-One (Order & Pay only) $299/mo, `all_in_one` → All-in-One Platform $399/mo, `marketing_only` → AIO Marketing Platform $199/mo. Matrix in E2E-PLAN.md, "Quote types and selection rules". Five things about it:
  - **`full_pos` and `food_truck` are RETIRED, and `quoteTypeOf` maps both (and null) to `all_in_one`.** This REVERSES the old "null means full_pos" rule. They are kept in `StoredQuoteType` — not `QuoteType` — because existing rows carry them and must still parse; nothing may write one. The mapping is not a preference, it is forced: AIO deactivated all three weekly platform SKUs in HubSpot, so a row left on one resolves no platform line at all and refuses to save. It re-prices an unpublished legacy row ($99/wk ≈ $429/mo, or the food truck's $75/wk ≈ $325/mo, both → $399/mo); when this shipped there were **zero** unpublished rows carrying quote lines, and a PUBLISHED row is untouched because `publishBillingQuote` sends `quoteLines` verbatim.
  - **ORDER POINTS NO LONGER PRICE ANYTHING.** `PLATFORM_TIER_BOUNDARY`, `platformTierNameFor` and `isPlatformTierProduct` are GONE, and with them the 1–5 / 6+ split and its ~$433/mo swing. `ORDER_POINT_RULES`, `deriveOrderPoints` and the channel checkboxes all stay — the count is reported on the deal, feeds the later quoted-vs-deployed comparison, and still decides which products can fill a package's `order_point` slot. It just doesn't select a product any more. The customer quote no longer prints "Based on N ordering points" next to the platform line, because that sentence claimed a causal link that no longer exists.
  - **A RATE-ONLY quote still gets no platform line**, and that is the one thing the plan alone doesn't decide: `resolvePlatformLine` returns `none_needed` for a processing quote with no picks AND no declared channels. Without it every rate-only quote would acquire a $399/mo line and stop being rate-only, which breaks the "empty `quoteLines` → no HubSpot billing objects, checklist module omitted" rule below. Channels count here even though they don't pull in the install services — a website-ordering merchant with no hardware is on the platform, but has nothing on site to install.
  - **A marketing-only quote now HAS a platform line** ($199/mo, derived, never pickable), where it used to have none — so it is never rate-only, and an empty one still charges. The one exception is the **2-year term**: picking it returns `term_replaced` and the monthly line is omitted, because both are the same subscription and charging both bills $498/mo for one platform. HubSpot holds **two identical active records** for that SKU (`332927902454`, `334139877086`), so `MARKETING_TERM_PRODUCT_IDS` lists both — recognising only one would double-charge half the 2-year quotes. Deduplicating them is a HubSpot-side cleanup.
  - **`isPlatformProduct` must keep matching the RETIRED products** (`RETIRED_PLATFORM_PRODUCTS`). It is what keeps a saved quote's old platform line out of the picks it reopens as; drop one and reopening a 2026-era quote offers that fee back as a rep-pickable product, next to the new plan's.
- **Derived quote lines are never pickable**: all three platform products and the three always-included services (AIO WiFi Network Package, Onsite Installation, System Onboarding and Training) are hidden from the picker and re-derived server-side. A rep able to add one by hand is a double platform fee or a second $999 install. Reopening a saved quote strips them via `picksFromQuoteLines()`.
- **Onsite Installation ($999) and System Onboarding and Training ($499) are quoted at MSRP and COMPED TO $0.** Steve's AE price sheet (`AE_Hardware_SaaS_Price_Sheet.pdf`, effective 2026-09-18) is the source of truth for what a merchant is charged, and it is explicit: they "will still appear on customer quotes at their listed MSRP, automatically discounted to $0 — this is expected, not an error." Until 2026-09-25 EasyOB put both on at full price, so **every quote it built was $1,498 too high**. `COMPED_SERVICE_PRODUCT_IDS` in `quoting.ts` holds the two ids; emptying that array ends the promotion and nothing else has to change. Three things are load-bearing about how it is applied:
  - **The WiFi package is NOT comped.** It is the third always-included service and it is not on that sheet at all — the sheet prices the network as separate hardware (Unifi Router, 8 Port Switch, Access Point, U-LTE Backup Pro). Comping its $999 would be inventing a discount nobody authorized.
  - **It is a DEFAULT, not an override.** A rep who deliberately types a discount on that line keeps it; silently turning their 50% into 100% would be the tool disagreeing with the person using it. But `applyServiceComp` runs AFTER `applyLineAdjustment`, which clears `discountPercent` whenever an adjustment carries none — so a rep who only delayed the billing start on the install line would otherwise have silently put $999 back on. Don't collapse the two passes.
  - **It is exempt from the discount cap, but only at exactly 100%.** `DEFAULT_MAX_DISCOUNT_PERCENT` is 50, so an un-exempted policy comp would make `adjustmentBlockers` refuse every quote — and `canPublishBillingQuote` re-runs that check at publish. Any other figure on the line is a rep's choice and is capped like anything else.
- **A discount can be scoped to part of a line's quantity (`LineAdjustment.discountQty`), and that SPLITS the line.** "One of the three POS units is free" becomes a 1-unit line at 100% plus a 2-unit line at list — not 33.3333% across the whole line, which bills $1,498.07 instead of $1,498.00 at two decimals on a document nobody can amend. `splitPartialDiscount` runs LAST in `buildQuote`, after both comps, and never touches a package-covered line (already wholly paid for). `discountQty` never reaches HubSpot — there is no such property; the split is the representation. A stale value larger than the line is CLAMPED (the rep set it and then lowered the quantity); a non-integer or non-positive one is refused by `discountQtyBlockers`. `adjustmentsFromQuoteLines` recovers it by comparing the discounted line's quantity against the product's total CHARGEABLE quantity — without that, "1 of 3 free" reopens as "all 3 free". Note that a 100% scoped discount is **not** exempt from `DEFAULT_MAX_DISCOUNT_PERCENT`: only the policy comps are, so giving a unit away needs an admin to raise the cap, which is the discretion the cap exists to bound.
- **A discount is CLAMPED to 0–100 in the configurator, as well as refused in the engine.** `adjustmentBlockers` has always refused anything outside that range and still does — but a `type="number"` input accepts typed values past its own `max`, so without the clamp a rep types 150, watches the preview go negative, and has to work out what they did wrong from a blocker. Both halves stay: the clamp is a UI courtesy and the blocker is the authority, since the server re-derives from the picks and never trusts the browser's copy.
- **`quoteSanityBlockers` is the arithmetic floor under every quote, separate from policy and from catalog completeness.** It refuses a negative or unreadable unit price, a quantity that isn't a whole number ≥ 1, a quote whose totals come out negative on either side, and a quote with lines on it that nets to $0. The first two are only reachable through bad CATALOG data — a price nobody in this codebase chose — which is exactly why they're asserted: the discount cap bounds a *percentage*, and a negative list price turns any percentage into money owed the wrong way. A quote with NO lines is left alone: that's a rate-only quote, which is a real thing to send. It runs inside `buildQuote`, so it gates the submit button, `saveQuoteConfigurationAction` and the publish alike.
- **A few quantities are counted against ANOTHER product's, not against a flat cap** (`RELATIVE_CEILINGS`, 2026-10-12, Elizabeth Phillips). A Customer Facing Display and a Cash Drawer may not outnumber the POS units; an AMS1 may not outnumber POS units **plus kiosks**. `unitCaps` cannot express this — it caps each product at a number an admin typed, which catches a typo, not "four drawers for two tills". It REPORTS and never clamps: `resolveRequiredAms1` still tops a quote up to the floor (a POS without a terminal can't take a card), but nothing takes a line off a quote a rep is reading out loud. The AMS1 ceiling MUST include kiosks, or a kiosk-only quote blocks itself on the terminal a rep added by hand. Both POS SKUs count, the one with a display in the box included — a merchant buying that plus a loose display is more likely adding a second screen than making a mistake.
- **A `marketing_term` quote carries EXACTLY ONE kiosk** — a Mega or a 27", never both and never two (Elizabeth Phillips, 2026-10-12). It is a refusal, not a comp on the extra: the plan hands over one, and whether a second may be sold on the same document is a price nobody has set. `applyPlanIncludedKiosk` still comps the dearer line while the rep fixes it, so a refused quote isn't also showing the wrong money. The two Marketing Kits also entered `DEFAULT_UNIT_CAPS` at 6 (they were the one uncapped family) — that cap is about how many fit in a restaurant; this rule is about what the plan includes.
- **The two tablets are hidden by an admin SWITCH, not deleted** (`TABLET_PRODUCT_IDS` + `quote_limit_policy.show_tablets`, default OFF). Elizabeth Phillips asked for them gone "unless we can think of a use case" and named one in the same breath (marketing-only with online ordering), so it is a switch. **Visibility only** — deliberately not in `isAllowedForQuoteType` or `buildQuote`: those say what may never be SOLD, this says what is worth offering this month, and making it a refusal would strand a quote configured ten minutes before an admin flipped it. The picker keeps showing a tablet already ON a quote, however the switch is set, so a rep is never left looking at a price with no row to change it on.
- **A first charge held past 60 days requires a note, and the note is an ASSIGNMENT, not an @mention.** `quoteNoteBlockers` refuses the save (and the submit button) when the longest `billingStart` exceeds `DELAY_NOTE_THRESHOLD_DAYS` and `merchant_applications.quote_note` is under 10 characters — Elizabeth Phillips, 2026-10-12: "force them to leave a note explaining why and tagging me automatically". Distinct from the delay CEILING (`maxBillingDelayDays`, 90), which refuses outright and is raised by an admin: this one doesn't refuse the delay, it refuses the silence, so 61–90 days costs a sentence and nothing more. `mirrorQuoteNote` posts it to the HubSpot deal through `createDealNote` (association **214**), **authored by the REP and @-mentioning `QUOTE_NOTE_WATCHER`** (Elizabeth Phillips, owner `161690499`) — this reverses the earlier wording, which had the note owned by AND mentioning her, which is exactly why the mention never fired: HubSpot does not notify you about your own note. A real mention in this portal (note `406503541481` and others, all identical in shape) needs **both halves**: the `hs_at_mentioned_owner_ids` property (confirmed live 2026-10-13: it exists on this portal's NOTE object, enumeration/checkbox, writable, persists on read-back) **and** a `<span data-mention-id="…" data-mention-name="…" style="color: #425b76;font-weight: 600;">@Name</span>` chip inside `hs_note_body` — the property alone renders no chip and notifies nobody. `createDealNote` now takes structured mentions (id + name) and builds that span itself, prepended ahead of the heading text; `mirrorQuoteNote` resolves the rep's own HubSpot owner id via `resolveSender` (the same `findOwnerByEmail` lookup `publishBillingQuote.ts` uses for `hs_sender_email`) and omits `hubspot_owner_id` entirely — never falling back to Elizabeth — when the rep doesn't resolve to one (the seeded dev rows deliberately don't). **The earlier-suggested backstop of a HubSpot workflow on "note created, owner = her" no longer matches and must not be relied on** — she is never the owner of this note now, so that workflow would never fire; the mention markup is the delivery mechanism, not a note-owner trigger. The push is best-effort and only on CHANGE (notes are append-only, so re-posting buries the deal in copies), and it needs `crm.objects.notes.write` on the **EasyOB Billing** app (confirmed granted, live 2026-10-13) — without it every push logs a 403 and the quote still saves.
- **A quote-wide "Billing Start" control sets `billingStart` on RECURRING lines only, and that is not a shortcut.** A one-time charge has no billing schedule to move: `applyLineAdjustment` strips the property off one, HubSpot has nothing to apply it to, and the charge lands at checkout either way. Sweeping across everything would write adjustments that change nothing and then read back as edits the rep never made. The per-line drawers still win for exceptions — the global control writes the same `billingStart` they do, and shows "Mixed" rather than claiming a shared start the lines don't have.
- **EVERY quote AIO processes money for carries the $0 rate-disclosure line — but ONLY once something on it is charged** (2026-10-14, product owner). `resolveProcessingDisclosure` used to gate on `isMarketingQuote && websiteTakesOrders`, on the reasoning that a POS merchant obviously knows they're buying payments; the consequence was that on an `all_in_one` / `order_pay_only` quote the card rates appeared **nowhere on the document the merchant signs**. It now gates on `quoteHasProcessing`. Four things are load-bearing:
  - **The `hasChargedLines` guard is what keeps a RATE-ONLY quote rate-only**, and removing it breaks three rules at once: `quoteSanityBlockers` refuses the quote ("every line nets to $0", so no rate-only quote could be SAVED), `publishBillingQuote`'s `lines.length === 0` short-circuit stops firing, and `resolvePreAuthLine` then adds fifty cents to a quote that was never meant to charge anything. Hence it is resolved AFTER the adjustment pass, beside the pre-auth, and `quoteSanityBlockers` still runs on `chargedLines` without it.
  - **The rates on the line come from the QUOTE, not from the product.** HubSpot's own description on `260559288040` is static text reading 2.49% / 3.50% plus an AMEX pair retired on 2026-10-13 — it would have told a merchant quoted 2.75% that they pay 2.49%. `processingDisclosureText` (quoting.ts) composes the real text and `lineItemDescriptions` (publishBillingQuote.ts) hands it to `toLineItemProperties`, which now takes an optional `description` that wins over `coveredLineDescription`. Composed at PUBLISH, not baked onto the QuoteLine, so `buildQuote` keeps its signature; rates are frozen at `publishedAt`, so the two can't drift.
  - **`adjustmentsFromQuoteLines` reads the disclosure line back as the online-ordering toggle, and that is now gated on `isMarketingQuote`.** Ungated, reopening any `all_in_one` quote would tick "online ordering" on its Website line.
  - **A quote now hard-blocks if that product leaves the catalog.** It already did for the marketing case; it is every processing quote's problem now. AIO has deactivated SKUs without warning three times — if `AIO Processing Two Tiered Rate` is archived, no quote saves until someone re-points it. Blocking is the deliberate posture: publishing a quote with the rates stated nowhere is worse.
- **A line discount may be typed in DOLLARS, and the dollars ARE the stored figure** (`LineAdjustment.discountAmount` / `QuoteLine.discountAmount`, 2026-10-14). It was built the other way first — converting to `discountPercent` on the belief that `hs_discount_percentage` was the only discount HubSpot takes — and that was wrong: $100 off a $749 line became 13.4% and charged $100.37. A cash discount that cannot hit a price is not a cash discount. Five things are load-bearing:
  - **HubSpot's `discount` is PER UNIT, and the portal cannot tell you that.** All 166 live line items carrying one have `quantity: 1`, where per-unit and per-line agree — the same trap as the one-time-delay question. Proven by `scripts/probe-cash-discount.ts`: price 100 × qty 3 with `discount: 10` reads back `amount 270.00` / `hs_total_discount 30.00`. So `discountAmount` is the LINE total (what a rep says out loud) and `toLineItemProperties` divides by quantity once, at the boundary.
  - **That division keeps SIX decimals and is exact.** HubSpot rounds the TOTAL, not the per-unit figure: $100 off 3 units sends `33.333333` and bills exactly $100. Rounded to 2dp it would bill $99.99. Verified end-to-end through the shipping code path on four cases including $1,000 off 7 × $999.99.
  - **The two levers are MUTUALLY EXCLUSIVE.** `applyLineAdjustment` clears both and sets one; `toLineItemProperties` emits one; both policy comps DROP `discountAmount` (not null it — the key goes, so a comped line keeps its old shape) because `lineNetAmount` reads the cash lever FIRST and a leftover amount would quietly outrank a 100% comp.
  - **A cash discount is held to the SAME admin cap, converted against the list amount.** Without that the dollar box walks straight around the limit: $700 off a $749 line is 93% and the percentage check never looks at it. An amount larger than the line is REFUSED, not clamped — unlike `discountQty`, where "more than the line" can only mean "all of them".
  - **`lineFor`'s summed give-away in `ProductConfigurator` is `discountGiven`, not `discountAmount`.** The names collided when the lever was added and the collision silently fed the computed give-away back into the dollar input, so a 20% discount on a $749 line made the cash box read $149.80. Don't rename it back.
  The percentage lever survives for "give them 20% off" and still rounds to one decimal (`cleanPercent`), which costs nothing now that an exact price is typed in dollars. The merchant's own quote prints the dollars (`$747.00 off`), never the percentage they work out as.
- **A merchant who takes orders online and has nothing on site is quoted NO card-present rate** (2026-10-14, product owner: "card would never be present no need to show"). `processesCardNotPresentOnly` (quoting.ts) hides the lane in `RateFields` on all three rep surfaces and drops the row from the disclosure text. Two things about the predicate: it is NOT `isMarketingQuote && websiteTakesOrders` — a `marketing_term` quote **includes a kiosk**, and a kiosk takes a card in person — and it is not ordering points alone, because the AMS1 is a card reader that deliberately counts ZERO points. And it is not display-only: `CONFIG_QUOTE_ASSUMPTIONS` assumes **95%** card-present, so hiding the lane while leaving the blend alone would have left the merchant's own headline effective rate 95% weighted on the rate we had just said can never apply. `analysisFromQuoteConfig` takes a `cardPresentPctOverride` and `leadQuote.ts` / `getPricingPreviewAction` / `assertRateAboveFloor` pass 0. A real statement is untouched — it carries a measured split.
- **One vocabulary for the two rates: "card present" and "card not present", never "in person" and "online"** (2026-10-14). A cashier keying a card in by hand is standing in front of the customer and is still card-not-present, so the in-person framing names the wrong thing on the one screen a merchant is often reading over the rep's shoulder. Likewise `+ $0.15 per transaction`, not `/txn`.
- **A quote that would collect under $0.50 at checkout gets a derived, untouchable $0.50 pre-auth line** (2026-10-07). HubSpot refuses to publish a payment-enabled quote below that (`MIN_TOTAL_NOT_REACHED`, ACH threshold), and a delayed recurring line collects nothing at checkout — so "comped hardware + plan billing in 60 days" owed $0 and could never be sent. The line is the existing HubSpot product `AIO Pre Auth` (`281354281678`, $0.50 one-time), appended by `buildQuote` AFTER every adjustment (`resolvePreAuthLine`), so no rep edit can reach it: not pickable, not discountable, not delayable, not removable, and absent from `lineFor` in the configurator. It is judged on the adjusted lines, so it appears and disappears as the rep sets and clears a delay, and a quote that already collects something is left alone. `quoteSanityBlockers` runs on the lines WITHOUT it so fifty cents can't rescue a quote that nets to $0; `checkoutAmountBlockers` runs on the final lines and is re-checked in `canPublishBillingQuote` (`nothing_due_at_checkout`) because published quotes carry saved lines verbatim — a row saved before this existed must be re-saved.
- **A ONE-TIME line CANNOT be deferred, and it IS a platform limit — PROVEN LIVE 2026-10-12.** This settles a question the portal could not, and it reverses the "by construction rather than by platform limit" wording that stood here. Publishing a payment-enabled quote carrying a dated one-time line is refused:
  ```
  400 NON_RECURRING_FUTURE_BILLED_LI_NOT_ALLOWED
  Line items with one-time frequency must start billing at payment (i.e.
  'hs_recurring_billing_start_date', 'hs_billing_start_delay_days', and
  'hs_billing_start_delay_months' should be empty) when using [HUBSPOT, BYO_STRIPE]
  ```
  So deferring hardware to a go-live date is NOT available to us at all, and a build that tries it makes the quote unpublishable. **Don't re-attempt it** — it was built on 2026-10-12 and reverted the same day. Four things this run established:
  - **THE DRAFT LIES.** HubSpot's own `hs_quote_amount` on the draft came back `$0.50` with a $249 dated one-time line on it — i.e. the amount calculation DOES defer it, and only the publish validator refuses. Checking the draft total would have "confirmed" the feature worked.
  - **That is why all 49 portal examples are on `PAYMENT_NOT_ENABLED` quotes.** Not a coincidence and not an accident of sampling: those quotes have no checkout, so the validator never runs. The HubSpot UI lets a human set the date there precisely because nothing will ever be collected.
  - Those 49 are also all discounted 100% to `amount: 0.00`, so even on a payment-enabled quote there would have been nothing to collect. Two independent reasons the portal could not answer this.
  - `hs_quote_amount` IS "amount due at checkout", not contract value — calibrated against PAID quote `332031953624`, which reads `$0.50` while carrying a $399/mo platform line delayed by months. That is the same semantics `amountDueAtCheckout` implements, so the two agree.
  **The one workaround was considered and REJECTED** (Shaheer, 2026-10-12: "not worth the hassle"). A recurring line with a bounded term bills a finite number of times — that is the same behaviour the `hs_recurring_billing_period` rule above exists to avoid — so a one-payment monthly line with a delayed start would be a deferred one-off charge that the validator accepts. It was turned down because it is not a flag flip: it makes hardware a SUBSCRIPTION, which lands in `findSubscriptionsForQuote`, the billing-completion gate and the Phase G P&L, and it shows the merchant a recurring item. Delayed finite-term lines do exist in the portal (payment counts of 3 and 78) but only on deals, never through a published payment-enabled quote, so it was never verified either. If deferring hardware ever becomes worth it, a second quote at go-live is the cleaner route.
  Reproduction: `scripts/probe-onetime-delay.ts` (creates REAL CRM objects on the test company; it deletes nothing, so clean up after). The original rule still holds and is now better founded: EasyOB never writes a start date on a one-time line, `applyLineAdjustment` strips one, and `toLineItemProperties` is the backstop at the HubSpot boundary.
- **Pre-made packages are expressed as a package SKU + the covered hardware at 100% off — NEVER as duplicate "free" products in HubSpot.** `lib/quotePackages.ts` breaks a cart into whole packages plus a remainder; each package puts one real HubSpot product on the quote at the package price and leaves the hardware it covers on the quote at MSRP, discounted 100% and carrying `QuoteLine.coveredByPackage`. Same expression as `COMPED_SERVICE_PRODUCT_IDS`, and the same one Steve's price sheet tells merchants to expect. The free/paid-twin alternative was rejected because `ORDER_POINT_RULES` is keyed by **product id**: a free twin counts zero ordering points, so every packaged POS and kiosk would have silently selected the 1–5 platform tier instead of 6+ — the largest recurring line on the quote. (That tier is gone as of 2026-10-05 and the count no longer prices anything, but the decomposition still reads points to decide what fills an `order_point` slot, so a zero-point twin would still mis-pack every package.) Four things are load-bearing:
  - **An `order_point` slot accepts ANY one-point product at ANY price, with no cap** (Shaheer, 2026-09-29) and this is EXPECTED TO CHANGE to an explicit eligible-product list per slot. The decomposition fills slots dearest-first, so today a merchant swapping a $749 POS Unit for a $2,459 Mega Kiosk pays the same and AIO absorbs the difference. The whole change is `slotAccepts` + the `PackageSlot` type; `decomposePackages` never reads the rules table directly.
  - **Packages cover ONE-TIME lines only, and a package SKU must itself be one-time.** The decomposition minimises a single scalar, and one-time dollars and a weekly fee are different units (see `quoteTotals`). Putting recurring software in a package is a deliberate change.
  - **A partly-covered line is SPLIT** (covered qty at 100%, remainder at MSRP), never one line at a blended percentage — that would round and make our totals disagree with HubSpot's. Hence `picksFromQuoteLines` SUMS quantities per product, and `adjustmentsFromQuoteLines` skips covered lines so a package's 100% is never read back as a rep adjustment pinned to the product id.
  - **`applyPackageComp` runs last and is NOT overridable**, unlike `applyServiceComp`. A covered line is hardware the package price already bought; charging for it is double-billing, not a commercial decision. It must run after `applyLineAdjustment`, which clears `discountPercent` whenever an adjustment carries none — adjustments are keyed by product id, so a rep delaying billing on a half-covered product would otherwise put the covered half back at full price.
  A package priced $0, missing from the catalog, or billing recurring is REFUSED and reported as a blocker — but only when the cart would actually have qualified for it. `PACKAGES` ships with **QSR Kit (`333450361558`) INACTIVE**: the HubSpot record is $0, so enabling it would hand over ~$4,000 of hardware for nothing.
- The three install services attach to the **picked products**, not to the quote type alone — an empty picker is a rate-only quote and carries none of them. Declared ordering channels don't pull them in (a website-ordering merchant has nothing on site to install), though they do still drive the platform fee.
- `buildQuote()` in `quoting.ts` is the **one** derivation — the configurator's live preview and the server's authoritative write both call it. Don't reintroduce a second copy in the client. Its `blockers[]` gates both the submit button and the server action.
- A `marketing_only` quote has **no processing rate at all** — `CustomerSafeQuote` is a discriminated union whose `basis: "products"` variant carries no volume/rate/savings fields. Don't flatten that back to nullable numbers; zeros there render as a real 0.00% quote.
- `ENABLE_DEBUG_ROLE_SWITCH` must never be set in a Vercel project environment — local `.env.local` only
- **Publishing a HubSpot quote is a one-way door.** No API edit (400 `LOCKED`), no delete (`PUBLISHED_QUOTE_CANNOT_BE_DELETED`), and no void — setting `hs_status: VOID` is itself an edit, so voiding is HubSpot-UI-only. Never build an "unpublish", "edit published quote", or "re-publish" affordance; `sendQuoteAction` refuses once `publishedAt` is set, and BOTH `saveQuoteConfigurationAction` and `EditQuotePanel` freeze on `publishedAt` as well as on `quoteAcceptedAt` — publishing now happens first, so there is a window where the document is live and unamendable but nothing is accepted yet. A `400 LOCKED` from `publishQuote` means **already published** and must be treated as success, or a crash between HubSpot's ack and the DB write wedges the account forever.
- **A quote template that AIO deactivates stops working IMMEDIATELY, and HubSpot only says so at the association.** `POST`ing association 286 to an inactive `quote_template` is a 400 `ASSOCIATION_TYPE_SPECIFIC_VALIDATION_FAILED` — "Quote template is not active" — which is step 4 of 5, *after* the contact, the line items and the draft quote exist. Found live 2026-10-09, when "AIO Quote v3" (`817263673055`) was retired for **v4 (`854670598854`)** and the next build stranded 13 line items and draft quote `333345545954` behind it. So: `DEFAULT_TEMPLATE_IDS` is now v4, `resolveQuoteTemplate()` resolves the id **and its `active` flag** together off a live list (not the admin page's TTL cache — the flag changes exactly when a stale cache would be wrong), `canPublishBillingQuote` refuses `template_inactive` before the first write, and `updateQuoteTemplatePolicyAction` refuses to SAVE an inactive one — which **reverses** the earlier rule that an inactive template was still selectable. The list still *shows* inactive templates, so an admin can see what their policy is pointing at. A stranded build is recoverable: the persisted ids are reused and the association re-run, so re-pointing the policy and retrying publishes the same draft rather than a second one. Nobody tells EasyOB when a template is retired, so `auditQuoteTemplatePolicy()` runs as a third pass of the nightly `/api/cron/hubspot-links` and reports a stale policy as a **failed cron run** (a quiet field in a 200 is a field nobody reads). It alerts and never heals — which template replaces a retired one is a human's call, and the region-split marketing pair is the proof. `marketing_term` defaults to **BAY AREA ONLY** (`854671277804`); HubSpot carries an equally active OUTSIDE BAY AREA twin (`850518393534`) and EasyOB has no region to choose between them with.
- **`hs_recurring_billing_period` is DELIBERATELY never written.** It is a contract *term*, not the billing cycle — HubSpot derives `hs_recurring_billing_number_of_payments` from it, so `P7D` on a weekly line takes one $99 charge and then silently stops collecting. 935 of AIO's 1,200 live weekly line items leave it NULL. `PHASE-E-SPEC.md` §3.3 says to send `P7D`; the spec is wrong. Product-owner decision, 2026-08-21. **LIVE-VERIFIED 2026-08-24** on quote `323970722493`: the weekly platform line came back `hs_recurring_billing_period: NULL` / `hs_recurring_billing_number_of_payments: NULL`, while all eight one-time lines got `nPayments: 1`. That is HubSpot deriving the payment count from the period, observed directly — the mechanism is no longer inferred.
- **`hs_sender_email` is NOT validated by HubSpot, so EasyOB validates it — CLOSED 2026-09-25.** HubSpot accepts any string: the 2026-08-24 gate run published with `rep@aioapp.com`, a seeded dev row that is not a portal user, not a mailbox, not anything, and there was **no 400 and no warning**. A wrong value is therefore invisible until a real merchant receives their quote "from" an address nobody owns, on a document that cannot be edited, voided or re-sent. Entra sign-in (Phase 5) narrowed it — a rep who signs in through Entra necessarily has a real tenant address — but never closed it, because `rep@aioapp.com` remains a valid `owner_user_id` and the debug role switcher writes as that row. The fix: `resolveSender` (`publishBillingQuote.ts`) now takes `users.email` only as a CANDIDATE and resolves it against the portal's own user list via `findOwnerByEmail` (`adapters/hubspot.ts`, `GET /crm/v3/owners?email=`), and **HubSpot's spelling of the address and name wins** over ours, so the two cannot disagree. Three distinct refusals, because they need three different people to fix them: `no_sender_email` (no address on the `users` row), `sender_not_hubspot_user` (an address the portal has never seen), `sender_unverified` (the lookup itself failed). **"Could not check" is refused exactly like "wrong"** — the door is one-way, so there is no fall-through to publishing unverified. O-1 (`PAYMENT-TEST-PLAN.md`:249) is explicit that all 46 live paid quotes use a real rep address, and archived owners are excluded for the same reason.
  **This needs the `crm.objects.owners.read` scope on the `EasyOB Billing` private app. GRANTED and VERIFIED 2026-09-25** — before that both apps 403'd `MISSING_SCOPES` and every send refused `sender_unverified`. Checked through the shipping `findOwnerByEmail`, not a curl: `shaheer.hasnain@aioapp.com` → owner `161790722`, `joe@aioapp.com` → owner `166240618`, while `rep@aioapp.com` and `admin@aioapp.com` come back a clean null. That last pair is the point — the lookup DISCRIMINATES rather than passing everything, so the seeded dev rows would still be refused `sender_not_hubspot_user`. Which is now the practical constraint on local testing: the **debug role switcher writes as `rep@aioapp.com`**, so a deal configured under it refuses at checkout. Test the merchant checkout path on a deal owned by a real Entra-linked row.
- **A published quote carries `app.quoteLines` VERBATIM — `publishBillingQuote.ts:211` never calls `buildQuote()`.** Derivation happens at *save* time in the configurator. So a row saved before a change to the derivation rules publishes under the OLD rules, silently. Two rows accepted 2026-08-18 are $1,498 short each (no Onsite Installation, no System Onboarding and Training) because they predate `272f58b`/`c65b4b1`, and `canPublishBillingQuote` does not catch it — it verifies the *platform* line resolves, never that the included services are present. Any backfill of pre-existing accepted rows must re-derive through `buildQuote()` first, or it publishes an under-priced quote onto a document nobody can amend.
- **Billing completion is gated on the SUBSCRIPTION, never on the quote's `hs_payment_status`.** The subscription appears 1–9 minutes after checkout; `PAID` lags it by a median of **5.7 days** (daily ~12:00 UTC ACH batch). Gating on `PAID` tells a merchant who already paid to "Review & Pay" for most of a week. Same reason the nightly cron's lookback is **10 days**, not 3.
- One quote yields **one subscription per distinct billing frequency**, so AIO's weekly-platform + monthly-add-on mix routinely produces two. Hence `hubspotIds.subscriptions[]` and `findSubscriptionsForQuote` (association **304**), never a single id, and never a deal-keyed lookup — a reused deal carries subscriptions from earlier quotes.
- `hs_quote_link` is **not** a one-time-use link, unlike the Adyen and Check ones — the slug exists at create, the URL is predictable, and auth is `public_access`. `/customer/applications/[id]/billing` is **read-or-refresh, not mint-per-click**. Don't "fix" it to match its two `/continue` siblings.
- A **rate-only quote** (empty `quoteLines`) creates no HubSpot billing objects at all and its checklist module is **omitted**, not shown pending — processing margin comes out of Adyen settlement and the catalog's processing products are $0 placeholders. Discriminate on `quoteAcceptedAt`: empty lines *before* acceptance just means the rep hasn't configured it yet.
- **No HubSpot Company linked → no deal, no billing quote, nothing.** A deal's company association (341) is only settable on the deal CREATE — the v3 PATCH takes properties only — so a deal pushed before `tenantLink.hubspotCompanyId` exists is orphaned off the Company record permanently. Every push site gates on `canPushToHubSpot()` (accept route, both customer-side saves, `sendQuoteAction`), `pushToHubSpot` itself throws as the backstop, and `buildAndPublishBillingQuote` short-circuits `awaiting_tenant_link` **before the build claim** so waiting leaves no `lastSyncError` — an unlinked account is normal, not a failure, and counting it as one floods the admin sync-error tripwire. `canPublishBillingQuote` restates it as `no_tenant_company` because that reason names the fix. The resume is `linkTenantCompanyAction`, which creates the held-back deal and publishes the quote right there — **so linking a company can open the one-way door**. That is intended (user's decision, 2026-09-10).
- **THERE IS EXACTLY ONE ACCEPTANCE, and EasyOB does not own it.** Changed 2026-09-24 (product-owner decision). The merchant used to accept in EasyOB ("Accept & Create Account") and then accept *again* on HubSpot's hosted quote, which is where the e-signature and the ACH mandate are actually collected. Entering billing details IS accepting the quote, so:
  - **THE REP OPENS THE DOOR AGAIN, at link-send time — reversed 2026-10-13, product owner, and this reverses the "THE MERCHANT OPENS THE DOOR" bullet that stood here since 2026-09-25 (quoted below for the history).** `createProspectAction` (`lib/actions/prospects.ts`) now attempts the same build-and-publish the instant a rep creates a prospect and its lead link goes out — via `publishAtSend`, calling the identical `buildAndPublishBillingQuote` orchestrator every other entry point uses — before the merchant has opened anything. Nothing about WHY the 2026-09-25 gate was scrapped is undone: the problem it fixed (a merchant staring at a link that does nothing, waiting on a separate rep click) doesn't reappear, because company and deal are already resolved by the time a prospect is created, so most of `canPublishBillingQuote`'s preconditions are already clear — a rep's link-send now usually publishes on the spot. The attempt is **best-effort and silent**: most new prospects aren't publishable yet anyway (rate-only, nothing picked), and that's a quiet skip, never a failure thrown back at the rep — a real refusal or HubSpot error lands on `hubspotIds.lastSyncError`, exactly as it already did for the entry points below. **"Continue to Billing" is UNCHANGED and remains the fallback** for whatever wasn't publishable at send time; it is no longer the *only* door, but it is still *a* door, same preconditions, same idempotency, same irreversibility. The 2026-09-25 bullet, kept for the history: "THE MERCHANT OPENS THE DOOR, not the rep — changed again 2026-09-25, same product owner, and this reverses the bullet that stood here. The rep used to publish first with 'Send Quote to Customer', and until they clicked it a merchant who opened the link *the same rep had just emailed them* saw 'your quote is being finalised' and could do nothing. 'Continue to Billing' on `/lead/[token]/quote` now POSTs `/api/lead/[token]/checkout`, which builds and publishes the quote on the spot and returns `hs_quote_link` to redirect to. Publishing is still irreversible, so the button asks first — an inline confirmation phrased around what the MERCHANT loses (the chance to have the pricing changed), never around HubSpot's inability to unpublish."
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
- **HubSpot's `processing_volume` IS populated, but EasyOB deliberately does NOT read it into `processing.monthlyVolume` any more (product owner, 2026-10-13).** An earlier comment in `hubspotPrefill.ts` claimed every volume property was empty portal-wide and listed it as structurally unknowable; it is not — 24 companies carried a value on 2026-09-25, checked against the live portal, and that fact still stands so nobody "rediscovers" it. What changed is the decision, not the data: monthly volume now starts empty and the rep types it, because a prefilled figure is indistinguishable from an answer the rep actually gave, and it feeds both the rate matrix and the margin floor — a stale or wrong value silently prices the quote. Its near-namesake `monthly_card_volume` is the empty one (0 rows) and remains deliberately NOT read: an empty property is worse than no property, because it looks authoritative.
- **The rate card SUGGESTS a card-present rate; it never sets one.** `lib/rateMatrix.ts` is the
  pricing guide's §10.3 grid — nine volume bands × nine ticket columns, at $0.15/txn (§10.5 names
  that the recommended default: it confines the "CP rate exceeds the CNP rate" crossover to one
  cell, $0–25K at a $10 ticket, and a test asserts exactly that cell and no other). Five things
  are load-bearing:
  - **Its volume bands must stay identical to `MARGIN_REQS`'.** The matrix prices off a tier's
    DESIRED margin and `belowMarginFloor` refuses against that same tier's MINIMUM; bands that
    drifted apart would price off one tier and refuse against another. A test asserts the equality.
  - **`DEFAULT_QUOTE_RATES` was NOT replaced.** A merchant with no volume and no average ticket on
    file — every marketing-only quote, and every processing quote whose merchant hasn't produced a
    statement — still gets the flat 2.49% + $0.15. `lookupCardPresentRate` returns null rather than
    a fallback, because reading the grid anyway would quote its dearest corner to everyone nobody
    has measured.
  - **A ticket reads the column AT OR BELOW it** ($22.40 → the $20 column), never an interpolation
    between two. Interpolating would be more precise and would mean a cell an admin typed is never
    the rate anyone is quoted; reading down also rounds toward margin, the direction §12 rounds.
  - **`RateSuggestion` auto-applies only where a quote is being STARTED** (the wizard's Pricing
    step, prospect creation) and only while the rates are still untouched at the flat default, at
    most once per mount. `EditQuotePanel` deliberately does not: those rates are a decision someone
    already made, and a saved quote must not change because an admin edited the card and a rep
    opened the panel.
  - **Card-not-present is ONE flat number** (3.30%, §10.1), not a grid — product owner, 2026-10-12.
    The notes ask for a separate online-ordering matrix eventually; it takes the CP grid's shape
    when it arrives. Note the default is 3.30% where every quote before this carried CNP equal to
    CP at 2.49%.
  Rates are stored as whole BASIS POINTS: every figure on AIO's rate card is a two-decimal
  percentage, exact in bps and not in a float, on a document nobody can amend.
- **`payment_processing_arr` is written to the HubSpot deal at ACCEPTANCE, never at publish.** It is
  `appliedTargetMargin × monthly volume × 12` (product owner, 2026-10-12), computed from the TRUE
  margin — this is AIO's own forecast of AIO's own revenue on a record reps already read, and
  padding it would make the number wrong rather than make a secret safe; the FLOOR is the secret and
  is not derivable from it. Marketing-only quotes and quotes with no volume are OMITTED, not zeroed:
  this property feeds HubSpot's calculated `total_arr`, which the sales org reads as booked revenue,
  and a 0 there reads as a measured zero. `saas_revenue` is deliberately not written.
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
- **Only `2-tier` is OFFERED, and the other two are HIDDEN, not disabled.** `SELECTABLE_PRICING_MODELS` (`types/merchant.ts`, beside the type) is the platform limit (Steve, 2026-07-23). Flat-rate and interchange-plus stay in the `PricingModel` type, in `MODEL_INFO` and in `pricing.ts`, which still prices both — the limit is on what can be SOLD today, and stored rows carry those values. They were rendered as disabled "Soon" cards until 2026-10-01, when the product owner asked for them gone outright; this REVERSES the earlier "all three are RENDERED" rule. That rule existed because a grid holding a single choice reads as a rendering bug, which is why `PricingStep`'s heading is now "Pricing" rather than "Select Pricing Model". The constant lives in `types/merchant.ts` because THREE rep surfaces offer this choice — `PricingStep`, prospect creation, `EditQuotePanel` — and each kept its own copy; two had drifted to offering all three as selectable.
- **The margin slider is gone from `PricingStep` ONLY** (2026-10-01, product owner). That is the step a rep works through with the merchant in the room, and a margin that visibly slides is an invitation to negotiate it; the typed "Manual input (%)" stays, and every floor check is unchanged. Prospect creation and `EditQuotePanel` keep their sliders deliberately — neither is a screen a customer is looking at.
- **Foodbuy has no API — don't reintroduce an `adapters/foodbuy.ts`, an onboarding-status enum, or a mint-fresh-link `/continue` route for it.** Enrollment is a signed paper agreement (`AIO_Foodbuy_Enrollment_Form_V1`) that the customer completes and hands off themselves; `lib/foodbuyForm.ts` only pre-fills what AIO already knows into a printable document. It asks for the Federal ID # (EIN) — never collect that field on AIO's side, same rule as Adyen/Check's EIN/bank/SSN prohibition.

### Transactional email (2026-09-24)

Merchant email goes through **Microsoft Graph, app-only, from AIO's own M365 tenant** — not Resend.
Resend stays wired as the fallback and is what a local checkout without tenant credentials uses.
**LIVE-VERIFIED 2026-09-24** via `scripts/send-test-email.ts`.

This sidesteps the Phase 4 Resend blocker entirely: a fresh `send.aioapp.com` subdomain would need
SPF/DKIM/DMARC records and would start with zero sending reputation, whereas
`aiodocuments@aioapp.com` already has both.

**EasyOB reuses the EXISTING `AIO Document Send` app registration**
(`747446ca-b3c9-4537-b2b5-066de0264e70` — the one behind "mockusign"), because it already has
everything the hard way costs:

| | |
|---|---|
| `Mail.Send` | already admin-consented |
| Exchange fence | already `RestrictAccess` to `AIO App Senders` → `aiodocuments@aioapp.com` |
| EasyOB's credential | a **separate second client secret** on that same app, minted 2026-09-24, 24 months |

**Rights live on the app registration, not on the secret.** So EasyOB's secret carries the same
authority as mockusign's, and the separation is of *rotation*, not of *permission*: deleting or
rotating EasyOB's secret leaves mockusign running, but revoking the app's `Mail.Send` — or deleting
the app — takes down both. The real cost of sharing is that both products are one identity in
sign-in and audit logs.

**Don't "improve" this into a separate registration.** That was tried first and was a mistake:
creating the app, its service principal and a secret only needs Application Administrator, but
**granting a Graph APPLICATION permission needs Global Administrator or Privileged Role
Administrator** — Application/Cloud Application Administrator is blocked by Microsoft, since an app
admin who could grant app permissions could grant themselves `Directory.ReadWrite.All`. Verified
live: `403 Authorization_RequestDenied`. A separate identity therefore costs a Global Admin and a
second Exchange fence, and buys only cleaner audit attribution.

`scripts/entra-mail-app.ps1` still exists as the escape hatch if that trade is ever worth making;
its header states the privilege cost. It is NOT the live setup.

**`Mail.Send` as an application permission is TENANT-WIDE** — without an Exchange
`ApplicationAccessPolicy` an app can send as *any* mailbox. Anything sending mail here must be
fenced. Tenant audit from the same session, unrelated to EasyOB but worth someone's attention:
**`QA-Automatic Email App` and `Logsign Mail Integration` hold UNFENCED tenant-wide `Mail.Send`.**
`AIO Nexus - Mail` IS fenced, but via the newer RBAC-for-Applications mechanism rather than
`ApplicationAccessPolicy`, so a check reading only the latter misreports it as unfenced.

**`documentsend@aioapp.com` does not exist** in the tenant — not a mailbox, not an alias, not a
proxy address. The real shared mailbox is `aiodocuments@aioapp.com`, and Graph's `sendMail` is
addressed to `/users/{mailbox}`, so it must be a real mailbox rather than an alias.

**It is load-bearing.** `sendMagicLinkEmail` is what creates a merchant's account after they sign
and pay (see the acceptance constraint above). Acceptance is recorded once, so there is no second
attempt — which is why a Graph failure falls through to Resend rather than giving up, accepting a
possible duplicate email as the cheaper failure.

**Both emails render through one template** (`render()` in `adapters/email.ts`): Hallmark, transcribed
for an inbox. The design system is CSS custom properties in oklch and email is none of those, so the
tokens are restated there as sRGB hex — **that block is the only sanctioned copy of them**; if a
token moves in `globals.css`, move its twin. Three things are left out on purpose and each would
look right in a browser and wrong in an inbox: no logo IMAGE (Outlook and most Gmail accounts block
remote images, and the absolute URL is localhost in dev — a type wordmark always renders), no
Coolvetica (self-hosted woff2; `@font-face` in mail is honoured by roughly nobody), and no gradient
(it needs VML to survive Outlook). Every caller-supplied value — the URL, the merchant name — goes
through `esc()`, because a merchant name is rep-entered text landing in an `href` and a heading.

Verify with `npx tsx scripts/send-test-email.ts <address>`, which goes through the shipping
`sendMagicLinkEmail` rather than curling Graph — and loads env with `@next/env`, so the `\$`-escaped
secret takes the same dotenv-expand path it does under `next dev`.

**In Vercel Production since 2026-09-24** (all five, and the project forces type `Sensitive` on
every variable, not just the secret). Two consequences:

- `vercel env pull` can neither read these back nor preserve them — it overwrites `.env.local`
  wholesale, so back it up first. Same hazard already documented for the Entra vars.
- **A production deploy is required for them to take effect** — env changes don't reach existing
  deployments.

On rotation, push the secret with the **raw `$`**, not the `\$` form that goes in `.env.local`:
Vercel stores literally and does not run dotenv-expand. (The 2026-09-24 secret happens to contain
no `$` at all, so this was moot that time — check each new one rather than assuming.)

### The Phase E gate run (2026-08-24) — the reference evidence

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

### The AIO dashboard provisioning path (2026-09-23)

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

### Env vars needed (per phase)
```
ANTHROPIC_API_KEY           # Phase 1 — required now
DATABASE_URL                # Phase 1.5 — Neon Postgres (+ several other PG*/POSTGRES_* vars, all Vercel-managed)
AUTH_SECRET                 # Phase 1.5 — NextAuth
AUTH_MICROSOFT_ENTRA_ID_ID       # Phase 5 — Entra app registration: Application (client) ID
AUTH_MICROSOFT_ENTRA_ID_SECRET   # Phase 5 — client secret VALUE
AUTH_MICROSOFT_ENTRA_ID_ISSUER   # Phase 5 — https://login.microsoftonline.com/<tenant-id>/v2.0
                            # PIN IT TO THE TENANT. Unset (or /common/) means any Microsoft
                            # account in the world can reach the sign-in; the tid check then
                            # can't fire, and only the "no users row" gate stops them.
SEED_ADMIN_PASSWORD         # Phase 5 — breakglass password for scripts/seed-users.ts; the
                            # seeded admin123 default is fine locally and nowhere else.
ENABLE_DEBUG_ROLE_SWITCH    # Phase 1.5 — local dev only, never in Vercel project env
                            # (NOTE: migration 0021 adds rate_matrix_policy — the admin-edited
                            #  card-present rate card. No env var; an unmigrated DB falls back to
                            #  the pricing guide's own numbers rather than blocking a quote.)
AIO_DASHBOARD_ENABLED       # master switch, must be exactly "true". ON IN PRODUCTION since
                            # 2026-10-14. All four below are required together —
                            # aioDashboardEnabled() is false unless every one is set, so a
                            # half-configured environment is OFF rather than half-broken.
AIO_DASHBOARD_BASE_URL      # https://backend.prod.aioapp.com (prod-verified 2026-10-09).
                            # No default, deliberately: the only plausible one is the
                            # internal-dev host, which prod must never reach by accident.
AIO_DASHBOARD_USERNAME      # the operation service account shaheer.hasnain+easyob@aioapp.com
                            # (MFA disabled, so it logs in unattended)
AIO_DASHBOARD_PASSWORD      # \$-escape any $ in .env.local; paste it RAW in the Vercel UI
AIO_DASHBOARD_BROWSER_ID    # optional, a STABLE uuid — Cognito treats it as a device
AIO_DASHBOARD_APP_ALLOWLIST # comma-separated application ids; empty = every eligible row.
                            # DELIBERATELY EMPTY in production, reversing the earlier advice to
                            # populate it for the first real runs. The gate already requires a
                            # paid HubSpot subscription, which nothing in the codebase can
                            # fabricate (the debug billing bypass refuses to, by design), so a
                            # real payment IS the canary and the allowlist adds nothing.
ADYEN_REPORT_API_KEY        # settlement reporting — KEPT, read-only, separate LIVE credential
ADYEN_REPORT_BASE_URL       # optional; defaults to https://ca-live.adyen.com/reports/download
ADYEN_POS_MERCHANT_ACCOUNT  # the merchant account the settlement report path is built from
CHECK_API_KEY               # Check payroll — bearer token
CHECK_API_BASE_URL          # Check payroll — defaults to https://sandbox.checkhq.com; set for production
NEXT_PUBLIC_HUBSPOT_PORTAL_ID  # Phase E — 244508708. Cosmetic only: turns deal/quote ids in the
                            # rep+admin billing panel into clickable CRM record links. Absent, they
                            # render as copyable text rather than broken links. NOT a secret.
CRON_SECRET                 # bearer for /api/cron/* (adyen-actuals, hubspot-links, hubspot-billing-sync)
HUBSPOT_PRIVATE_APP_TOKEN   # Phase 3 — general CRM app: companies (tenant linkage), deal sync
HUBSPOT_BILLING_PRIVATE_APP_TOKEN  # separate "EasyOB Billing" app: products (needs the
                            # `e-commerce` scope), quotes, line items, contacts, subscriptions
                            # + invoices read, AND `crm.objects.owners.read` — that last one
                            # verifies hs_sender_email against the portal's real users, and
                            # without it every quote send refuses `sender_unverified`.
                            # Deliberately a second token so billing write
                            # scopes don't widen what the sync path can reach.
HARDWARE_COMMISSION_WRITEBACK_ENABLED  # must be exactly "true". DEFAULT OFF — gates the
                            # rep_commission/rsm_commission deal writeback in hubspot.ts so the
                            # product owner can inspect the first computed figures before they
                            # start landing on live deals.
MAIL_GRAPH_TENANT_ID        # Phase 4 — transactional email via Microsoft Graph, PREFERRED over Resend:
MAIL_GRAPH_CLIENT_ID        #   sends from AIO's own M365 tenant, so it inherits the tenant's
MAIL_GRAPH_CLIENT_SECRET    #   SPF/DKIM/DMARC and sending reputation instead of warming a new subdomain.
MAIL_FROM_ADDRESS           #   The mailbox to send AS — a REAL mailbox, not an alias (Graph addresses
MAIL_FROM_NAME              #   /users/{this}). aiodocuments@aioapp.com. Name overrides the mailbox's
                            #   own Exchange display name. CLIENT_ID is the EXISTING "AIO Document
                            #   Send" app (747446ca-...) — see "Transactional email" below.
RESEND_API_KEY              # Phase 4 — fallback transport
RESEND_FROM_EMAIL           # Phase 4 — "Name <local@subdomain>"; requires that subdomain verified in Resend
                            # (SPF/DKIM/DMARC DNS records). Unset falls back to the shared resend.dev test
                            # domain, which only delivers to the API key's own account owner — not real merchants.
TWILIO_ACCOUNT_SID          # Phase 4 — SMS lead link, optional (only sent when the rep enters a phone)
TWILIO_AUTH_TOKEN           # Phase 4
TWILIO_FROM_NUMBER          # Phase 4 — E.164, e.g. +15551234567
NEXT_PUBLIC_BASE_URL        # Phase 1.5 — used to build the customer lead-link URL; keep in sync with actual dev port
```
(Phase F — Foodbuy — needs no env vars: it has no API, see lib/foodbuyForm.ts.)
