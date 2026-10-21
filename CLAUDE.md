# ClearRate / EasyOB (AIO)

> **Active work is on the `v2` branch, in `app-v2/`**: a Next.js app with Postgres (Drizzle/Neon),
> NextAuth (Entra ID for staff), a role-scoped "pillowed" margin model, server-side Anthropic calls,
> AIO dashboard API provisioning (Adyen tenant + KYC link), and HubSpot quote/billing.
> The root HTML files and `clearrate-main/` are the frozen v1 reference.

## Where to look

Detailed notes live in `docs/claude/` at the repo root (`../docs/claude/` from `app-v2/`). Read the
relevant file **before** changing code in that area: most rules there were set by the product
owner or learned from a live incident, and several cover irreversible actions.

| File | Read it when you touch |
|---|---|
| `docs/claude/architecture.md` | Stack, roles and the pillowed margin model, **the key-files map**, storage-error handling, the removed demo gate, deleted admin pages whose policies still run |
| `docs/claude/auth.md` | Entra staff sign-in, `profile()`/`aioUserId`, the popup flow, credentials `scope`, per-request session resolution |
| `docs/claude/quoting.md` | `buildQuote`/`quoting.ts`, quote types/plans, derived lines, discounts, packages, pre-auth, disclosure line, billing-start notes, rate card, margin and $10/mo revenue floors, the pricing step |
| `docs/claude/hubspot-billing.md` | Publishing quotes (one-way door), templates, sender email, subscriptions, acceptance/confirmation flow, deals/companies, ARR, company address fields, the Phase E gate-run evidence |
| `docs/claude/provisioning.md` | AIO dashboard API (tenant/location/KYC), provisioning gate and retries, lead-link repair, Adyen/Check/Foodbuy rules, EIN/SSN/bank-field rules |
| `docs/claude/email.md` | Graph/Resend transactional email and its shared app registration |
| `docs/claude/running.md` | Local setup, dev credentials, `.env.local` hazards (`$` escaping, `vercel env pull`), the full env-var list |
| `docs/claude/phase-status.md` | What's done, live-verified, or still pending, per phase |
| `docs/claude/v1-legacy.md` | The frozen root HTML builds (only if asked about them) |

When you learn something new, add it to the matching file, not here. Keep this file an index.

## Always-on rules
- All v2 work in `app-v2/` — **do not touch the root HTML files**
- **Reps never see the true margin floor or true Adyen cost** — always go through `derivePricingForRole`/`getPricingPreviewAction`, never `derivePricing` directly from a rep-facing client component
- Pricing math (`MARGIN_REQS`, `derivePricing`) lives in `pricing.ts`, **not** in Claude prompts
- `generateProposal()` force-overrides any AI-returned numbers with locally computed `exactRates`/`exactProjected`
- HubSpot uses Private App Token — **no OAuth**
- `ENABLE_DEBUG_ROLE_SWITCH` must never be set in a Vercel project environment — local `.env.local` only
- **Irreversible actions:** publishing a HubSpot quote and anything created through the AIO dashboard
  API can't be undone. EasyOB never creates Adyen objects directly. Read `hubspot-billing.md` /
  `provisioning.md` before changing either path.
- **Back up `.env.local` before any `vercel env` command.** A pull overwrites it, and the Sensitive vars can't be pulled back. See `running.md`.
