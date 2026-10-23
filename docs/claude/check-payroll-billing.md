# Check payroll billing — `/admin/payroll-billing`

Outside EasyOB's own scope (2026-10-23, product owner): it lives here only because the HubSpot
invoice plumbing already does. Reached from the admin's **name menu** ("Payroll Billing"), not the
top rail; `admin/layout.tsx` keeps reps out. (The admin top rail's "Accounts" tab was removed the
same day as unused — `/admin?view=accounts` still works by URL.)

## What it does
Elizabeth downloads Check's monthly usage summary (`usage_summaries_YYYY-M.csv`, one row per
company × category with a count) and uploads it. Each company gets **one draft HubSpot invoice**:
`Payroll - AIO Platform (Per Person)` (product `223152695998`, price read live — $8 on
2026-10-23) × that month's `employee` count.

## Decisions (product owner, 2026-10-23)
- **Only `employee` rows are billed.** `company`, `company_setup` and every other category are
  ignored; a company with 0 employees is listed as "Not billed".
- **Drafts only.** Nothing is opened, sent or charged; Elizabeth reviews and sends from HubSpot.
  (The one-time hardware invoice is *opened* — this one deliberately is not.)
- **CSV upload only.** Pulling from Check's API (`GET /usage/summaries?period_start=&period_end=`,
  documented at docs.checkhq.com/docs/usage) is deferred: `CHECKHQ_API_KEY` answered
  `403 authentication_failed "Invalid API key."` on both `api.checkhq.com` and
  `sandbox.checkhq.com` on 2026-10-23. `CHECK_API_KEY` is the separate onboarding key.

**The line item inherits `recurringbillingfrequency: monthly` from the product**, so it is blanked
right after creation (`clearLineItemRecurrence`) — a one-off invoice has no use for a recurring
line. Found on the first live run, 2026-10-23: draft invoice `880595988161` (Lajevard Eats & Co.,
3 × $8 = $24, to Mina Gilan), left in HubSpot as a real September draft.

## Who the invoice goes to
"The contact that has billing info attached — it's on the deal." No portal contact carries the
"Billing Contact" association label (checked 2026-10-23), so the rule is: **the contact on the
company's subscription** — the one whose payment details HubSpot holds, and whom the recurring
invoices already go to. `pickBillingSubscription`: newest **active** subscription, else newest of
any status; none at all → flagged, no invoice. The invoice is associated to that contact, the
company, and the subscription's deal.

Token split (verified live): company → deals reads **403 on the billing token** and works on the
general one; deal → subscriptions and subscription → contacts need the billing token.

## Matching Check companies to HubSpot
Check names companies by **legal** name ("TEA AMPERSAND LLC"), HubSpot by restaurant
("Lajevard Eats & Co."). Exact search matched 1 of 17 on the Sept 2026 file; stripping
entity suffixes (`normalizeCompanyName`) gets ~5. So the page suggests, an admin confirms, and the
pairing is saved in `check_company_links` — every later month matches automatically.

**The HubSpot property wins.** Elizabeth is adding Check's company id (`com_…`) to each HubSpot
company as `checkhq_company_id` (`CHECK_COMPANY_ID_PROPERTY` — if she names it differently, change
that constant). On every preview, a Check id carried by **exactly one** company links — or
re-links, overriding a manual pick — with `linked_by: hubspot:checkhq_company_id`. Two or more
companies with the same id are only offered as suggestions. If the lookup fails (e.g. the property
doesn't exist yet: 400), the page falls back to saved links and name matching.

## Double-billing guard
`check_payroll_invoices`, unique on (`check_company_id`, `period_start`). The row is claimed
before the first HubSpot write, each id (line item, invoice) is persisted as created, and a retry
resumes from them. `invoiced_at` is set only once associations are done. A resumed row keeps the
count, contact and amount it was claimed with. Re-uploading the same month shows those rows as
already invoiced. The server re-parses the CSV for every create — the client never sends amounts.

## Files
`lib/payroll/checkUsage.ts` (pure: parser, name normalizer, contact pick) ·
`lib/actions/checkPayroll.ts` · `app/admin/payroll-billing/` · HubSpot reads at the end of
`adapters/hubspot.ts` · migration `0029_check_payroll.sql`.
