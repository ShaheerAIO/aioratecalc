# MERGE NOTES — `nov11-feedback` and `debug/team-preview`

Written 2026-11-11 for whoever merges this work into `v2`. Read it before merging anything.

## Branch layout

```
v2
 └─ nov11-feedback          ← 6 feature commits. MERGE THIS into v2.
     └─ debug/team-preview  ← debug-only commits ("DEBUG-ONLY: …"). NEVER MERGE THIS.
```

### `nov11-feedback` (`git log --oneline v2..nov11-feedback`)

| Commit | What it is |
|---|---|
| `80b19b3` Nov 11 quoting feedback | Website off the Order & Pay picker, Go Live billing-start copy, "Mixed" billing-start seed fix, install/training charged at list again (`COMPED_SERVICE_PRODUCT_IDS = []`), payroll billed separately (100% off, no commission), Mega Kiosk Loaner back on every plan. |
| `f450770` Standard rates button | `lib/standardRates.ts` + the "Use standard rates" button; `createProspectAction`'s `standardRates` flag waives the volume/ticket requirement for exactly the standard card. |
| `c59de53` Admin-only skip billing; never send Adyen cost to reps | `bypassBillingAction` refuses non-admins; `derivePricingForRole` always returns `adyenCostRate: null` to non-admins. |
| `b68b62d` Account dashboard revamp (phases 1-2) + last_edited_at | `AccountsDashboard` on `lib/accountStatus.ts` (status, flags, next action, tabs), `last_edited_at` column (migration `0033_last_edited_at.sql`), and the whole of `actions/prospects.ts` (standard rates + `lastEditedAt`). |
| `b085025` Docs for Nov 11 batch | `docs/claude/*` updates for the above. |
| `7a0ca6a` Standard rates is a toggle that hides volume/ticket | Product-owner feedback on `f450770` ("buggy"). "Standard rates" is now a pressed/unpressed toggle (`RateFields` `standardRates` + `onStandardRatesChange`, host-driven). New Prospect: ON applies the card, hides and empties volume/ticket, unmounts `RateSuggestion`; OFF resets to the fresh-form rate and shows the empty boxes; a typed rate turns it off. Edit Quote: OFF restores the rates and adjustment from before ON. Server waiver unchanged. Not yet in `docs/claude/quoting.md`. |

**Merge the set, not single commits.** `f450770` does not compile on its own: it uses
`actions/prospects.ts` changes that only landed in `b68b62d`. Cherry-picking any one commit will break the
build; merge the branch (or all six, in order).

### `debug/team-preview` — NEVER MERGE

Exists only so the team can click through a shareable Vercel preview of `nov11-feedback`. Every commit on it
is prefixed `DEBUG-ONLY:` and every hunk is marked in code with `DEBUG-SANDBOX`, `DEBUG-AUTO-LOGIN` or
`DEBUG-ROLE-SWITCHER` + "debug-only, never merge". `git log --oneline nov11-feedback..debug/team-preview`
lists them. If anything from it is ever wanted on `v2`, re-implement it deliberately; do not merge or
cherry-pick the branch.

## What the debug branch adds

Everything is inert unless its env flag is exactly `"true"`.

| Flag | Effect |
|---|---|
| `ENABLE_DEBUG_ROLE_SWITCH` | The existing debug role switcher (pre-existing; now rendered as a floating Rep/Admin pill on staff pages). |
| `DEBUG_AUTO_LOGIN` | Only together with `ENABLE_DEBUG_ROLE_SWITCH`. A visitor with no session and no `debug_role` cookie is the debug **rep**, acting as the dedicated `debug-rep@aioapp.com` users row; the pill sets the cookie to flip to admin (`debug-admin@aioapp.com`). A missing row is logged and falls through to the real session. With auto-login off, the switcher keeps the local seeded `rep@`/`admin@aioapp.com` rows. `/customer` and `/lead` are untouched. |
| `DEBUG_SANDBOX` | No outbound side effects (email, SMS, HubSpot writes, AIO dashboard, Check, crons); send/publish/provision actions refuse before writing to the DB ("Sandbox: nothing was sent (debug deployment)."); a bottom banner says so. |

The owner overrode the "`ENABLE_DEBUG_ROLE_SWITCH` must never be set in a Vercel project environment" rule
**for this preview deployment only**, with the flags passed per deployment (`vercel deploy -e … -b …`), never
stored in the project env. That rule still stands for everything else.

### Debug-only files (new)

- `app-v2/src/lib/debug/sandbox.ts` — `isSandbox`, `assertNotSandbox`, `SandboxError`, `SANDBOX_MESSAGE`, `sandboxFetch`
- `app-v2/src/lib/debug/autoLogin.ts` — `isDebugAutoLoginEnabled`, `effectiveDebugRole`
- `app-v2/src/components/dev/SandboxBanner.tsx`, `SandboxBanner.module.css`
- Tests: `app-v2/src/lib/__tests__/debugSandbox.test.ts`, `debugSandboxBilling.test.ts`,
  `debugSandboxProspects.test.ts`, `debugSandboxStaffActions.test.ts`, `debugAutoLogin.test.ts`,
  `app-v2/src/components/dev/__tests__/debugChrome.test.tsx`

### Debug-only hunks in existing files

| File | Hunk |
|---|---|
| `lib/adapters/hubspot.ts`, `hubspotFiles.ts`, `lib/billing/commissionWriteback.ts`, `lib/adapters/check.ts`, `lib/adapters/aioDashboard.ts` | one line: `import { sandboxFetch as fetch } from "@/lib/debug/sandbox"` |
| `lib/adapters/email.ts` | import + early `{ sent: false }` return in `send()` |
| `lib/adapters/sms.ts` | import + early `{ sent: false }` return in `sendLeadLinkSms` |
| `lib/actions/prospects.ts` | import + `assertNotSandbox()` in `sendProspectToMerchant`, `issueCustomerQuoteLinkAction`, `resendLeadLinkAction` |
| `lib/actions/applications.ts` | import + `assertNotSandbox()` in `sendMerchantOnboardingLinkAction` |
| `lib/actions/billing.ts` | import + early return in `sendQuoteAction`, `retryOneTimeInvoiceAction` |
| `lib/actions/checkPayroll.ts` | import + early return in `createPayrollInvoiceAction` |
| `lib/actions/customer.ts` | import + early return in `requestCustomerLoginAction`, `assertNotSandbox()` in `startPayrollOnboardingAction` |
| `lib/actions/leadConfirm.ts` | import + early `formError` in `confirmLeadDetailsAction` |
| `lib/billing/acceptance.ts` | import + early return in `recordAcceptance` |
| `lib/billing/publishBillingQuote.ts` | import + early `failed` in `buildAndPublishBillingQuote` (before the build claim) |
| `lib/billing/oneTimeInvoice.ts` | import + early `failed` in `buildOneTimeInvoice` (before the claim) |
| `lib/aio/kick.ts`, `lib/aio/provision.ts` | import + early return in `kickAioProvisioning` / `provisionAioTenant` |
| `app/api/lead/[token]/checkout/route.ts`, `accept/route.ts` | import + early 409 |
| `app/api/cron/{adyen-actuals,aio-provisioning,hubspot-billing-sync,hubspot-links}/route.ts` | import + `{ skipped: "sandbox" }` after the auth check |
| `components/customer/LeadQuoteView.tsx` | import + `sandbox` entry in `CHECKOUT_ERRORS` |
| `lib/auth.config.ts`, `lib/auth/getEffectiveRole.ts` | `parseDebugRole` → `effectiveDebugRole`; debug row via `debugUserEmail`, `console.error` when it's missing |
| `app/layout.tsx` | `effectiveDebugRole`, `SandboxBanner`, new `RoleSwitcher` props |
| `components/dev/RoleSwitcher.tsx`, `RoleSwitcher.module.css` | rewritten as the floating pill (staff pages only, flips in place) |

## Prerequisites

**Already done:**
- Migration `0033_last_edited_at.sql` was applied to the production DB on 2026-11-11.

**Still to do before deploying `nov11-feedback` to production:**
- In `/admin/settings/quote-limits`, set the per-product discount cap to **100** for **Onsite Installation**
  (`223452690133`) and **System Onboarding and Training** (`223152695032`). They are charged at list again,
  and without the cap a rep can't discount them to 100% (the cap, not the old comp, is what stops them).
- **Customer-facing changes were NOT exercised in the sandbox preview** (sends are refused there, so new quotes
  never get a customer link; only the two [TEST] copies' existing links can be viewed, and confirm/accept/checkout
  are blocked). Before merging, check on a real (non-sandbox) environment: customer quote shows "Billing starts
  N days after checkout or on Go Live"; payroll line reads "Billed separately" at $0; Onsite Installation /
  Training priced at list unless discounted; Website absent on Order & Pay quotes; QuoteSummary PDF matches.

## Open product questions

- **Onboarding link from Signed.** `canSendOnboarding` only offers it from `quote_accepted`,
  `merchant_link_sent` or legacy `proposal_sent` with no KYC link. Should a Signed account offer it too?
- **Admin default tab.** Admin defaults to "All", rep to "Needs me". Confirm that's what admins want.
- **Standard rates with no volume: margin gap.** A standard-rate prospect has no volume, so no margin floor
  can be judged, and 2.49% is below the minimum margin at small volumes. Nothing catches that today.
- **Payroll $0 subscription.** If payroll is a quote's only monthly line, the published HubSpot quote may
  carry a $0/mo subscription (unverified).
- **Dashboard phases 3–4** (versions / "Unsent changes", full-width editor) are blocked on proposal
  questions Q1, Q5 and Q6.

## Cleanup after team testing

Auto-login acts as two dedicated users that exist in the **PRODUCTION** `users` table (created by the owner
2026-11-11, no password, no Entra link): "Debug Rep" `debug-rep@aioapp.com` (role `rep`) and "Debug Admin"
`debug-admin@aioapp.com` (role `admin`). Every account/draft the team created through the preview is owned by
them (`merchant_applications.owner_user_id`). Find those rows with (not run; review before running anything):

```sql
SELECT id, stage, quote_status, created_at
FROM merchant_applications
WHERE owner_user_id IN (SELECT id FROM users WHERE email LIKE 'debug-%@aioapp.com');
```

The team may also have edited real accounts in admin view (approvals, closed lost, rate/limit edits); those
keep their real owner and aren't found by this query. `quote_approval.approvedByUserId` and the policy tables'
`updated_by_user_id` can name a debug user too.

`owner_user_id` is a required FK, so **deleting the debug users needs those rows reassigned or deleted first**
(`/admin/users` → delete reassigns; or delete the test applications). Disabling them (`disabled_at`) is the
softer option and also stops auto-login resolving to them.

## Team feedback

_(For the owner to fill in after the team has used the preview.)_

-
