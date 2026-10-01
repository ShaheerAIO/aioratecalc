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

The core trust boundary: **reps must never see or derive AIO's true minimum profitable margin.** `pricing.ts`'s `getMarginFloor()` (true volume-tiered floor) and `calcAdyenCost`/`adyenRateOnVolume` (true per-transaction processing cost) are real numbers computed correctly everywhere internally, but a rep's UI/API responses only ever see a **pillowed** (padded) floor and, by default, no exact Adyen cost at all — controlled by an admin-editable global policy (`margin_policy` table, `/admin/settings/pillow`). This is enforced **server-side** in `derivePricingForRole()` (`pricing.ts`) via `src/lib/actions/pricing.ts`'s `getPricingPreviewAction()` — `PricingStep.tsx` has no client-side access to the true numbers at all, it only renders whatever the server decided this role gets to see. Don't move this computation back to the client.

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
  lib/claude.ts              ← analyzeStatement(), generateProposal() — server-side only
  lib/utils.ts               ← fmt$, fmtPct, fmtPct2, fmtBps, parseJSON
  lib/defaults.ts            ← DEFAULT_PROCESSOR (shared between client settings UI and server adapter)
  lib/db/
    schema.ts                ← Drizzle tables: users, margin_policy, app_settings, merchant_applications, customer_submissions
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
                                 listQuoteTemplatesAction — quoteType → HubSpot quote template mapping
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
    rep/settings/             ← processor/tier config (rep-editable; pillow policy is admin-only, separate)
    admin/                    ← dashboard, session-gated (no more hardcoded password)
    admin/settings/pillow/    ← admin-only margin pillow policy editor
    admin/?view=revenue       ← Phase G money view — a tab on the one admin surface, not a route of
                                 its own (the nav is capped at 4 items). See RevenuePanel.
    lead/[token]/             ← PUBLIC customer self-serve upload + instant quote (no auth, token-gated)
    api/analyze/              ← POST — rep flow, calls analyzeStatement() server-side
    api/proposal/             ← POST — rep flow, calls generateProposal() server-side
    api/lead/[token]/analyze/ ← POST — PUBLIC, dedicated route, returns ONLY CustomerSafeQuote
    api/lead/[token]/checkout/ ← POST — PUBLIC. THE MERCHANT'S DOOR TO BILLING: builds + publishes the
                                 HubSpot quote on demand and returns hs_quote_link. Irreversible, so
                                 the page confirms first. Never leaks a precondition message.
    api/auth/[...nextauth]/   ← NextAuth route handlers
  components/rep/
    UploadStep.tsx            ← drag-drop, calls /api/analyze
    AnalysisStep.tsx          ← 3-way fee split display, two panes above 64rem
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
  entra-app-registration.ps1   ← creates/updates the Entra app registration via Graph (pwsh +
                                 Microsoft.Graph.Authentication). Idempotent, so it's also the
                                 secret-rotation path. Writes the 3 env vars into .env.local.
  run-hubspot-links.ts         ← runs /api/cron/hubspot-links NOW, no dev server and no deploy:
                                 stamps every deal's easyob_link, empties the old company-level
                                 one. Calls the shipping adapter functions, so it IS the cron.
                                 Pins NEXT_PUBLIC_BASE_URL to the production alias, because
                                 .env.local says localhost and the backfill rightly refuses to
                                 write a link a rep couldn't click.
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
| 2 | Adyen onboarding | **REPLACED 2026-09-23 — EasyOB no longer creates Adyen accounts.** Product-owner decision: our own integration was "harmful and redundant", producing balance accounts that were misnamed and unlinked from the AIO tenant graph. `adapters/adyen.ts`, `adapters/adyenWebhook.ts` and `/api/adyen/webhook` are DELETED. A merchant now gets a tenant + location + KYC link from **AIO's dashboard API**, triggered when their **billing is paid** (the HubSpot subscription appears), by `/api/cron/aio-provisioning` → `lib/aio/provision.ts`. Behind `AIO_DASHBOARD_ENABLED`, **default OFF** — the API exists only on internal dev and its own developer calls it proof-of-concept. See "The AIO dashboard provisioning path" below. |
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
- **Reps never see the true margin floor or true Adyen cost** — always go through `derivePricingForRole`/`getPricingPreviewAction`, never `derivePricing` directly from a rep-facing client component
- `owner_user_id` (the rep who owns a deal, FK to `users.id`) and `ownerContact` (the merchant's own business contact person) are two different "owner" concepts — don't conflate them
- `customer_link_token`/`customer_link_purpose` is a **generalized, reusable** token slot: `"lead_upload"` (Phase 1.5, pre-analysis self-serve) and `"kyc_handoff"` (Phase 2, post-proposal Adyen KYC) are different moments in the deal lifecycle sharing the same field — don't assume a token is one or the other without checking `customer_link_purpose`
- `MerchantApplication` has **no EIN, bank account, or payroll tax fields** for Check either — Check collects those on its hosted pages, same rule as Adyen
- Check's `industry_type` is **its own enum, not an MCC/SIC code** (`restaurant`, `food_and_beverage_retail_or_wholesale`, …) — `check.ts` maps `processing.mcc` onto it, defaulting to `restaurant`. Don't pass a raw MCC through.
- `/api/lead/[token]/analyze` must only ever return `CustomerSafeQuote` — never the raw `StatementAnalysis` or any cost/margin field
- **A quote's `quoteType` (`full_pos` | `food_truck` | `marketing_only`) drives every selection rule** and is chosen before anything is picked — never inferred from the picks, because the derived lines land on an empty quote. Null on pre-existing rows means `full_pos` (`quoteTypeOf`). Matrix in E2E-PLAN.md, "Quote types and selection rules".
- **Derived quote lines are never pickable**: all three platform products and the three always-included services (AIO WiFi Network Package, Onsite Installation, System Onboarding and Training) are hidden from the picker and re-derived server-side. A rep able to add one by hand is a double platform fee or a second $999 install. Reopening a saved quote strips them via `picksFromQuoteLines()`.
- **Onsite Installation ($999) and System Onboarding and Training ($499) are quoted at MSRP and COMPED TO $0.** Steve's AE price sheet (`AE_Hardware_SaaS_Price_Sheet.pdf`, effective 2026-09-18) is the source of truth for what a merchant is charged, and it is explicit: they "will still appear on customer quotes at their listed MSRP, automatically discounted to $0 — this is expected, not an error." Until 2026-09-25 EasyOB put both on at full price, so **every quote it built was $1,498 too high**. `COMPED_SERVICE_PRODUCT_IDS` in `quoting.ts` holds the two ids; emptying that array ends the promotion and nothing else has to change. Three things are load-bearing about how it is applied:
  - **The WiFi package is NOT comped.** It is the third always-included service and it is not on that sheet at all — the sheet prices the network as separate hardware (Unifi Router, 8 Port Switch, Access Point, U-LTE Backup Pro). Comping its $999 would be inventing a discount nobody authorized.
  - **It is a DEFAULT, not an override.** A rep who deliberately types a discount on that line keeps it; silently turning their 50% into 100% would be the tool disagreeing with the person using it. But `applyServiceComp` runs AFTER `applyLineAdjustment`, which clears `discountPercent` whenever an adjustment carries none — so a rep who only delayed the billing start on the install line would otherwise have silently put $999 back on. Don't collapse the two passes.
  - **It is exempt from the discount cap, but only at exactly 100%.** `DEFAULT_MAX_DISCOUNT_PERCENT` is 50, so an un-exempted policy comp would make `adjustmentBlockers` refuse every quote — and `canPublishBillingQuote` re-runs that check at publish. Any other figure on the line is a rep's choice and is capped like anything else.
- **A discount can be scoped to part of a line's quantity (`LineAdjustment.discountQty`), and that SPLITS the line.** "One of the three POS units is free" becomes a 1-unit line at 100% plus a 2-unit line at list — not 33.3333% across the whole line, which bills $1,498.07 instead of $1,498.00 at two decimals on a document nobody can amend. `splitPartialDiscount` runs LAST in `buildQuote`, after both comps, and never touches a package-covered line (already wholly paid for). `discountQty` never reaches HubSpot — there is no such property; the split is the representation. A stale value larger than the line is CLAMPED (the rep set it and then lowered the quantity); a non-integer or non-positive one is refused by `discountQtyBlockers`. `adjustmentsFromQuoteLines` recovers it by comparing the discounted line's quantity against the product's total CHARGEABLE quantity — without that, "1 of 3 free" reopens as "all 3 free". Note that a 100% scoped discount is **not** exempt from `DEFAULT_MAX_DISCOUNT_PERCENT`: only the policy comps are, so giving a unit away needs an admin to raise the cap, which is the discretion the cap exists to bound.
- **A discount is CLAMPED to 0–100 in the configurator, as well as refused in the engine.** `adjustmentBlockers` has always refused anything outside that range and still does — but a `type="number"` input accepts typed values past its own `max`, so without the clamp a rep types 150, watches the preview go negative, and has to work out what they did wrong from a blocker. Both halves stay: the clamp is a UI courtesy and the blocker is the authority, since the server re-derives from the picks and never trusts the browser's copy.
- **`quoteSanityBlockers` is the arithmetic floor under every quote, separate from policy and from catalog completeness.** It refuses a negative or unreadable unit price, a quantity that isn't a whole number ≥ 1, a quote whose totals come out negative on either side, and a quote with lines on it that nets to $0. The first two are only reachable through bad CATALOG data — a price nobody in this codebase chose — which is exactly why they're asserted: the discount cap bounds a *percentage*, and a negative list price turns any percentage into money owed the wrong way. A quote with NO lines is left alone: that's a rate-only quote, which is a real thing to send. It runs inside `buildQuote`, so it gates the submit button, `saveQuoteConfigurationAction` and the publish alike.
- **A quote-wide "Billing Start" control sets `billingStart` on RECURRING lines only, and that is not a shortcut.** A one-time charge has no billing schedule to move: `applyLineAdjustment` strips the property off one, HubSpot has nothing to apply it to, and the charge lands at checkout either way. Sweeping across everything would write adjustments that change nothing and then read back as edits the rep never made. The per-line drawers still win for exceptions — the global control writes the same `billingStart` they do, and shows "Mixed" rather than claiming a shared start the lines don't have.
- **EasyOB one-time lines ALWAYS bill at checkout, by construction rather than by platform limit** (confirmed live 2026-10-01). EasyOB never writes a start date on a one-time line, and the Phase E gate quote's eight one-time lines came back with no delay and `nPayments: 1`. HubSpot itself is *not* so restricted: 49 one-time line items in the portal carry `hs_recurring_billing_start_date`, all of them hand-set on quote `330294198002` (Kalefornia) to 2026-10-19 — presumably deferring hardware to a go-live date. That quote is `PAYMENT_NOT_ENABLED`, so it is NOT evidence that deferred collection on a one-time line actually works; nothing was ever collected through it. If AIO wants to defer hardware to go-live, that is a product decision to take deliberately, not a platform fact to discover.
- **Pre-made packages are expressed as a package SKU + the covered hardware at 100% off — NEVER as duplicate "free" products in HubSpot.** `lib/quotePackages.ts` breaks a cart into whole packages plus a remainder; each package puts one real HubSpot product on the quote at the package price and leaves the hardware it covers on the quote at MSRP, discounted 100% and carrying `QuoteLine.coveredByPackage`. Same expression as `COMPED_SERVICE_PRODUCT_IDS`, and the same one Steve's price sheet tells merchants to expect. The free/paid-twin alternative was rejected because `ORDER_POINT_RULES` is keyed by **product id**: a free twin counts zero ordering points, so every packaged POS and kiosk would silently select the 1–5 platform tier instead of 6+ — the largest recurring line on the quote. Four things are load-bearing:
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
  - **THE MERCHANT OPENS THE DOOR, not the rep** — changed again 2026-09-25, same product owner, and this reverses the bullet that stood here. The rep used to publish first with "Send Quote to Customer", and until they clicked it a merchant who opened the link *the same rep had just emailed them* saw "your quote is being finalised" and could do nothing. **"Continue to Billing"** on `/lead/[token]/quote` now POSTs `/api/lead/[token]/checkout`, which builds and publishes the quote on the spot and returns `hs_quote_link` to redirect to. Publishing is still irreversible, so the button asks first — an inline confirmation phrased around what the MERCHANT loses (the chance to have the pricing changed), never around HubSpot's inability to unpublish.
  - **Nothing from `canPublishBillingQuote` is ever shown to a merchant.** Those messages name AIO's internals and address a rep. The route answers one neutral code (`not_ready` / `link_pending` / `rate_only` / `no_quote`) and writes the real reason to `hubspotIds.lastSyncError`. It records refusals that the orchestrator deliberately does not — see the note under `buildAndPublishBillingQuote` below: an account waiting on a company link is normal, but an account waiting on one *with a merchant standing at the door* is not, and only the customer-triggered entry point persists it.
  - `sendQuoteAction` **survives as the staff escape hatch** ("Publish Quote Now" on the billing panel), for a rep sitting with the merchant or finishing on the phone. It is no longer on the critical path and nothing waits on it. Its deal-backfill moved out to `lib/billing/ensureDeal.ts` so both entry points share one copy — a legacy row with no `hubspotDealId` would otherwise be recoverable from the rep's side only, and refuse the merchant `no_deal` forever.
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
- **HubSpot's `processing_volume` IS populated and IS mapped to `processing.monthlyVolume`.** An earlier comment in `hubspotPrefill.ts` claimed every volume property was empty portal-wide and listed it as structurally unknowable; it is not — 24 companies carried a value on 2026-09-25, checked against the live portal. Its near-namesake `monthly_card_volume` is the empty one (0 rows) and is deliberately NOT read: an empty property is worse than no property, because it looks authoritative. Zero and non-numeric values are dropped rather than prefilled, since `monthlyVolume` feeds the margin floor.
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

Base `https://backend.internal.dev.aioapp.com`. **Auth is TWO headers**, not one:
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

Open asks blocking flag-on, tracked in `app-v2/ADYEN-KYC-LINK-QUESTIONS.md` and
`app-v2/AIO-DASHBOARD-API-TRANSCRIPT.md`: is the store reference `prod-{businessId}` or
`prod-{restaurantId}`; is there a readable KYC status; a service account instead of a human
super-admin password; a stage/production base URL; and **who owns the Check company**, since AIO
creates one at tenant create and `startPayrollOnboardingAction` creates another — two Check
companies for one restaurant is real payroll, not a sandbox object.

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
AIO_DASHBOARD_ENABLED       # master switch, must be exactly "true". DEFAULT OFF.
AIO_DASHBOARD_BASE_URL      # no default on purpose — unset means OFF. Internal dev today.
AIO_DASHBOARD_USERNAME      # a human super-admin today; a service account is an open ask
AIO_DASHBOARD_PASSWORD
AIO_DASHBOARD_BROWSER_ID    # optional, a STABLE uuid — Cognito treats it as a device
AIO_DASHBOARD_APP_ALLOWLIST # comma-separated application ids; empty = every eligible row.
                            # Populate it for the first real runs: every create burns a
                            # globally-unique alias that is NEVER freed, in a shared DB.
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
