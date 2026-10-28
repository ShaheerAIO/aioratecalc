# Running v2 locally and env vars

## To run v2
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

**`.env.local`'s `DATABASE_URL` IS THE PRODUCTION DATABASE** (confirmed by the product owner 2026-10-27).
Local dev and prod share one Neon DB, so a migration applied locally is applied to prod, and a local
schema change made before its migration is run breaks prod's queries the same way. Nothing runs
migrations at deploy (`build` is plain `next build`); apply them by hand against this URL BEFORE
deploying code that reads the new columns. The Vercel copy is a Secret and can't be pulled.

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

## Env vars needed (per phase)
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
                            # start landing on live deals. ON IN PRODUCTION since 2026-10-15
                            # (product owner). Unset in .env.local, so local syncs still omit it.
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

## Deploying

Production deploys go out from the CLI, **from the repo root, not `app-v2/`**: the Vercel project's Root
Directory is `app-v2`, so a deploy started inside it fails with `The specified Root Directory "app-v2" does not
exist`. From anywhere: `vercel --prod --yes --cwd "<repo root>"`. It uploads the working tree, so uncommitted
edits ship too.
