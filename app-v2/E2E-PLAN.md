# E2E Implementation Plan

> **⚠️ SUPERSEDED IN PART (2026-09-23).** Everything in this document describing EasyOB creating
> Adyen objects itself — legal entity, account holder, business line, balance account, onboarding
> link, the Balance Platform webhook, the manual "Save tenant number" step — is **no longer how it
> works**. That code is deleted. A merchant now gets a tenant, a location and an Adyen KYC link
> from **AIO's own dashboard API**, triggered once their billing is paid. See the root `CLAUDE.md`
> section "The AIO dashboard provisioning path". The settlement/actuals half of this document
> (Phase G) is unaffected and still current.

Gap analysis of the current app against `E2E.md`, turned into phased work. Updated 2026-08-18
after four rounds of clarification:

1. **Statement upload stays, as a dual path.** Either the rep uploads the statement themselves
   and *then* sends the link (customer sees a prepared quote), or the rep sends the link with no
   statement and the customer uploads it (quote generated from their upload). Both paths converge
   on the same customer quote view.
2. **Admin portal needs a real identity.** Feedback: admins can't tell they're in an admin
   portal. Root cause is structural: `/admin` redirects to `/rep`, so admins see the rep UI with
   only minor additions (a Rep column, a Leads tab, extra Settings items).
3. **Billing = HubSpot subscriptions.** Investigated against the live HubSpot portal
   (244508708). Findings below materially change Phases C, E, and G.
4. **Ordering points are a first-class concept**, in both proposal generation and the admin
   overview — every place an order can be placed (POS terminals, kiosks, MPOS, website). They
   already exist in HubSpot as the platform-tier boundary, and the deployed hardware half can be
   sourced from the `aioinventory` app. See **Phase H**.
5. **The admin overview is a per-restaurant P&L.** Steve wants to see, at a glance, every
   meaningful way AIO makes money off a given restaurant — combining inventory, Adyen transactions
   and billing. That makes cost (which only inventory has) as load-bearing as revenue. See
   **Phase I**.

---

## Before you write any code

Orientation for whoever picks this up — human or agent.

**Read order.** This section → "Human-gated inputs" (below) → the phase you're working on. The
human-gated section lists what has **already been verified live**: HubSpot scopes, Adyen report
auth, the inventory endpoint, the product catalog. Don't re-probe those. Everything there was
checked against production credentials on 2026-08-18 and the results are recorded.

**`AGENTS.md` is not boilerplate.** This Next.js version differs from training data. Read the
relevant guide in `node_modules/next/dist/docs/` before writing App Router code.

### Invariants — cheap to honour, expensive to unwind

1. **Reps never see the true margin floor or true Adyen cost.** Always go through
   `derivePricingForRole` / `getPricingPreviewAction`; never call `derivePricing` from a rep-facing
   client component.
2. **`quoteLines` and `quoteConfig` freeze at publish.** They are what we *quoted*. No sync may
   overwrite them — the gap between them and the live billing snapshot is the entire Phase G/I
   comparison.
3. **No SSN, bank account, routing number, or EIN fields on `MerchantApplication`.** Adyen and
   Check collect those on their own hosted pages. Same rule for both.
4. **`/api/lead/[token]/analyze` returns only `CustomerSafeQuote`** — never raw `StatementAnalysis`,
   never a cost or margin field.

### Two arithmetic traps that produce plausible wrong numbers

Both fail silently, and both are off by enough to embarrass someone in front of a customer.

- **Platform fees bill WEEKLY.** A catalog price rendered as monthly is wrong by **4.33×**. Use
  `monthlyEquivalent()` in `utils.ts`; never sum across billing frequencies.
- **Restaurants pre-auth.** Adyen rows must be **deduped on `Psp Reference` at a single record
  type**. Raw row counts overstate transaction count several-fold and divide average ticket by the
  same factor. One day's file: 14,015 rows, ~3,468 actual payments.

### Sequencing advice

**Spike the HubSpot quote publish before building Phase E around it** — **done, 2026-08-18,
verdict YES.** Ran against the live portal: created a draft quote against a throwaway deal,
published it, read back `hs_quote_link`. It worked end to end, with three publish-time gates and
a couple of corrections to this plan's earlier assumptions — folded into Phase E below. No longer
an outstanding prerequisite.

Otherwise: Phase B first (pure UI, no external dependencies, and Phase I's admin views hang off it),
then the Adyen ingest (every input verified, and it's what was actually asked for), then the quote
spine and configurator.

### Probing live services

Use a throwaway `scripts/_tmp-*.ts` that loads config via `loadEnvConfig` from `@next/env`, then
delete it. **A plain `grep` of `.env.local` will hand you a corrupted Adyen key** — values are
`\$`-escaped because `@next/env` runs `dotenv-expand`, and only the real parser resolves them. The
symptom is a 401 that looks like a bad credential.

When probing an endpoint for the first time, **include a negative control** (garbage credential, or
none). A 404 only proves auth succeeded if a bad key fails differently — that distinction is what
established the Adyen report path.

Do not annualise a single day of Adyen data. Restaurants swing hard by weekday.

---

## Human-gated inputs (everything an agent cannot do for itself)

Verified against live credentials 2026-08-18. **Anything not listed here is unblocked** — see
"Buildable now" at the bottom.

### Hard blockers — each kills a phase until done

| # | Action | Where | Status |
| --- | --- | --- | --- |
| 1 | Add `crm.objects.contacts.read` + `.write` | HubSpot → EasyOB Billing app | **✅ DONE** — re-probed 200. Phase E unblocked. |
| 2 | Schedule the Aggregate Settlement Details Report | Adyen CA → `AIOAppIncPOS` → Reports | **NO LONGER BLOCKING** — 21 reports are already being generated and are downloadable today, including a store-attributed daily one. Now an efficiency nice-to-have. See "Reports that already exist". |
| 3 | Wire `INVENTORY_METRICS_URL` + `INVENTORY_METRICS_KEY` | `aioinventory` Firebase | **✅ DONE** — endpoint verified end to end (401 without key, 400 without dates, 200 with both). |
| 4 | Firebase deploy access | — | **✅ CONFIRMED** — CLI 15.26.0, logged in, `aio-inventory-b9b29` visible, `METRICS_KEY` readable via Secret Manager. |
| 5 | ~~Platforms-tab report credential~~ | — | **✅ NOT NEEDED.** AIO's commission is derivable per store from `Split Payment Data` in the existing merchant-scoped report — verified on 2,815/2,815 transactions with zero parse failures. Don't spend an access request on this. |

**No external blockers remain.** Every Phase G/I data source is reachable with credentials already
in `.env.local`.

**Live inventory baseline (2026-08-18), for sizing Phase I:** 3,236 units in stock at $717,618 cost ·
**1,275 units deployed across 92 customers at $207,244 cost** · 0 in transit · July flow: 261
received, 258 deployed, 0 RMA/total-loss · 34 product lines. **Cost coverage is 0.909** — 9% of
stock carries no cost, which is exactly why the per-account P&L must publish its coverage ratio
rather than a bare number. 1,275 units over 92 customers is ~14 devices per customer, so
per-customer breakdowns will be small payloads.

### Scope status — probed live, do not re-guess

| Token | Scope | Result |
| --- | --- | --- |
| `HUBSPOT_PRIVATE_APP_TOKEN` | companies.read | **200** ✅ (tenant linkage + Phase F work; earlier notes claiming this token was empty are stale) |
| `HUBSPOT_PRIVATE_APP_TOKEN` | deals.read | 403 — **no action needed**, see below |
| `HUBSPOT_BILLING_PRIVATE_APP_TOKEN` | products / quotes / line_items / deals / subscriptions / invoices read | **200** ✅ |
| `HUBSPOT_BILLING_PRIVATE_APP_TOKEN` | contacts.read | **403** ❌ → blocker #1 |

**The general token's missing deals scope is a code fix, not a scope request.** The billing token
already holds deals read/write (quotes require them), so point `pushToHubSpot`/`pullFromHubSpot` at
`billingHeaders()` and leave the general app as companies-read-only. Two tokens able to write deals
would be redundant scope surface.

**Spike update (2026-08-18):** the live quote-publish run exercised every billing-token write
scope end to end — contacts, deals, line_items, and quotes write, plus v4 associations — with zero
403s anywhere. Scopes are not a blocker for Phase E.

### Env vars — paste-able now

```
ADYEN_POS_MERCHANT_ACCOUNT=AIOAppIncPOS   # verified live 2026-08-18; report download path
ADYEN_REPORT_API_KEY=...                  # report service user; LIVE key (\$-escape it)
ADYEN_REPORT_BASE_URL=...                 # optional; defaults to https://ca-live.adyen.com/reports/download
                                          #   NOT derived from ADYEN_ENVIRONMENT — that var is `test`
INVENTORY_METRICS_URL=...                 # blocker #3
INVENTORY_METRICS_KEY=...                 # blocker #3
RESEND_API_KEY=...                        # empty; Phase D only
```
`ADYEN_COMPANY_ID` and `ADYEN_MANAGEMENT_API_KEY` are **empty** but only feed the dormant
onboarding code — ignore unless that work resumes.

### Decisions only you can make (no dashboard, just answers)

| Question | Blocks | Recommendation if you'd rather not decide |
| --- | --- | --- |
| Tablet order-point resolution | Phase H counting | Per-account admin override |
| Headline metric for the P&L list | Phase I sort order | Hardware payback in months |
| Is the tier re-evaluated as clients grow, and who acts on a mismatch? | Phase H admin view | Report first, task queue later |
| Which catalog products may reps quote? | Phase C picker | Resolved 2026-08-20 — see "Quote types and selection rules" below |
| Is hardware COGS the right cost basis, or landed cost? | Phase I | COGS, flag the gap |
| Foodbuy scope | Phase E module | Ship `coming_soon` |

### Asks of other people — send now, arrive later

- **Platforms report credential access** (blocker #5) — whoever administers the Adyen CA.
- **Confirm weekly billing is intended** on all platform tiers — whoever runs billing. Contradicts
  the "monthly invoices" assumption and sets every quote's headline number.
- **Does Adyen split commission arrive gross or net of scheme/interchange cost?** Decides whether
  `calcAdyenCost` gets subtracted in Phase I.
- **PRICING-QUESTIONS-FOR-STEVE answers** — needed for statement-less quotes (Phase A).
- **HubSpot catalog hygiene** — set `hs_product_type` on the four untyped products; decide on
  "AIO Pre Auth"; trim trailing whitespace. Delegable.
- **Which webhook surface** Adyen report notifications arrive on (classic vs Balance Platform) —
  decides which HMAC verifier the route needs.
- **`hs_payment_type` reads back as `BYO_STRIPE`** at the portal level, not native HubSpot
  payments — worth confirming with whoever runs billing, since the plan's text above assumes
  "HubSpot payments." Doesn't block Phase E (the quote/checkout mechanism is the same either way),
  but changes who to loop in on payment-processing questions.

### Buildable now — zero further input

Phase B (admin portal identity, pure UI) · Phase A (quote spine: types, migration, customer quote
view, accept) · Phase C (configurator — `listProducts()` verified against live HubSpot, frequency
math already shipped in `utils.ts`) · the deal-sync token swap above · the Adyen report client and
CSV parser, which can be written and unit-tested against a sample file before any report is
scheduled · `merchant_monthly_actuals` schema and idempotent upsert.

---

## Verified findings from the live HubSpot portal

Checked directly against HubSpot on 2026-08-17 (product catalog, 91 subscriptions, 793 invoices).

### ⚠️ Platform fees bill WEEKLY, not monthly

This is the highest-impact finding and it contradicts the natural reading of the products export.
The catalog's `Unit price` is the **per-billing-cycle** price, and for the flagship platform
products that cycle is **weekly**:

| Product | Unit price | `recurringbillingfrequency` | Effective monthly |
| --- | --- | --- | --- |
| AIO Platform (1 to 5 Order Points) | $99 | **weekly** | ~$428.67 |
| AIO Platform (6 + Order Points) | $199 | **weekly** | ~$861.67 |
| AIO Platform - Food Truck | $75 | **weekly** | ~$325 |
| AIO Marketing Platform | $49 | **weekly** | ~$212 |
| Payroll - AIO Platform (Per Person) | $2 | **weekly** | ~$8.67 |
| AIO - Automated Review Manager | $39 | monthly | $39 |
| AIO Marketing Add Spend | $99 | monthly | $99 |

Confirmed four independent ways: the product's `recurringbillingfrequency`; the subscription's
`hs_recurring_billing_frequency`; `hs_mrr` equal to price × 52/12 (e.g. $99 → $428.67); and the
actual invoice stream — Crema Coffee has 17 invoices of exactly $99, one every Friday, 7 days
apart. Invoice due dates are ~1 day after issue.

**Consequence:** a quoting tool that renders "$99/month" is wrong by 4.33×. Every quote line must
carry its billing frequency, and the UI should show both the per-cycle charge and the
monthly-equivalent so reps and customers can compare against a statement's monthly figures.

*(Note: this contradicts the "subs generate monthly invoices" assumption — worth a sanity check
with whoever runs billing, but the invoice data is unambiguous.)*

### Subscriptions and invoices ARE creatable via API — the constraint is the payment method

*(Correction: an earlier draft of this plan claimed subscriptions and invoices were read-only.
That was wrong — it was based on the write access of the OAuth connection used to investigate,
not on the REST API's actual capability.)*

Both objects support creation, currently documented as BETA:

- `POST /crm/v3/objects/subscriptions` — needs `crm.objects.subscriptions.write`
- `POST /crm/v3/objects/invoices` — needs `crm.objects.invoices.write`

The documented subscription flow is: create line items → create the subscription → associate the
line items (`PUT /crm/v4/objects/subscriptions/{id}/associations/line_item/{lineItemId}`,
`associationTypeId: 301`) → `PATCH` `hs_invoice_creation: "on"` to make it billable → associate
the contact/company (typeId 295). Prerequisite: the account uses HubSpot payments or Stripe
(AIO uses HubSpot payments). Note the limitation that **line items belong to exactly one parent
object**, so subscription line items are separate instances from any deal or quote line items —
if we want both a CRM deal and a billing subscription, each needs its own set.

**The real constraint is the payment method, and it requires a hosted customer step.** There is
no API to attach raw bank details — HubSpot stores a payment method only after the buyer
authorizes one through a HubSpot-hosted checkout (payment link, invoice payment page, or quote
with payments enabled). HubSpot's docs: for a bank debit method, "a subscription record will be
created once the payment is authorized and submitted," and automatic charges use "the payment
method they originally purchased with, or … the stored payment method."

AIO's live subscriptions confirm exactly this shape:

| Property | Value on AIO's subscriptions |
| --- | --- |
| `hs_collection_process` | `automatic_payments` (all sampled) |
| `hs_invoice_creation` | `on` |
| `hs_payment_method` | `ACH - 1117`, `ACH - 3515`, … (bank debit, last 4) |
| `hs_payments_source_app_id` | **`quote`** (all sampled) |
| `hs_payment_method_source_at_creation` | **`checkout`** (all sampled) |

The one sampled subscription **without** an `hs_payment_method` is the one sitting at status
`unpaid` — confirmation that the ACH authorization is the load-bearing step, not the record
creation.

### …and the quote checkout is the vehicle that produces them

Every sampled subscription was born from a **quote** (`hs_payments_source_app_id: quote`) with the
payment method captured **at checkout**. That is not incidental — it's the only path that yields
AIO's auto-debit model. HubSpot's docs warn that for a seller-created subscription, "if a buyer
agrees to store their payment method when paying for the subscription you are setting up, the
future subscription charges won't be charged automatically"; automatic charging requires a method
stored *before* the subscription exists. API-creating a subscription and then asking for bank
details would therefore land in manual-collection territory rather than reproducing the weekly
auto-ACH that all 91 live subscriptions run on.

Quotes are creatable via API (`POST /crm/v3/objects/quotes`, `hs_template_type: CPQ_QUOTE`,
requiring line-item + contact + deal associations, published by setting `hs_status` to
`APPROVAL_NOT_NEEDED`/`APPROVED`). The properties that make the handoff work:

| Property | Role |
| --- | --- |
| `hs_billing_enabled` | "Enable billing to automatically create invoices and subscriptions" — the flag that makes the quote spawn the subscription |
| `hs_payment_enabled` | "Indicates if payment can be collected via the quote link" |
| `hs_store_payment_method_at_checkout` | stores the ACH method for future automatic charges |
| `hs_quote_link` | **the public hosted quote URL — the port-out target** |
| `hs_payment_status` / `hs_payment_date` | read back to detect completion |
| `hs_quote_auth_method` | buyer auth on the shared link |

So the architectural conclusion: **EasyOB owns quote building; HubSpot owns quote checkout.**
EasyOB creates the deal, line items, and a payment-and-billing-enabled quote, then redirects the
customer to `hs_quote_link` to enter bank details. HubSpot creates the subscription and its
weekly invoices itself. This reproduces the exact mechanism behind every existing AIO
subscription, and keeps the same posture as Adyen and Check — the partner collects the sensitive
credentials on their own page.

### Processing revenue does not flow through HubSpot billing

The two `AIO Payment Processing` products ("AIO Processing Two Tiered Rate", "AIO Tier
Processing") carry a **$0** unit price — they're placeholder line items, not billed amounts.
Processing margin is collected through Adyen (out of settlement); platform, hardware, and
services are billed through HubSpot. **AIO revenue has two separate sources**, which Phase G
must reconcile.

### The product catalog is the hardware catalog

37 products, already maintained in HubSpot, with a taxonomy in `hs_product_type`:
`inventory` (hardware, one-time), `Software` (recurring), `Service` (installation/training,
mostly one-time), `AIO Payment Processing` ($0 placeholders). This removes the need for an
EasyOB-side catalog table. Filtering to `hs_status = active` and excluding
"AIO Platform fee TEST - do not use" leaves **33 quotable products** — verified by running
`listProducts()` against the live portal.

**Catalog data hygiene (fix in HubSpot, not in code):**

- Four products carry **no `hs_product_type`** — "Customer Facing Display", "Small TV (32in to
  43in)", "TV Installation", "CAMP Invoice". They'd fall out of any type-grouped configurator.
  The first three are plainly hardware/hardware/service; set them. The configurator should still
  render an "Uncategorized" bucket rather than silently hiding untyped products.
- **"AIO Pre Auth" ($0.50, `Service`, one-time)** is really a per-transaction fee, so quoting it
  as a single $0.50 line is meaningless. Either exclude it from the picker or model it alongside
  the processing rate rather than as a quote line.
- Several names carry trailing whitespace ("POS Unit ", "Thermal Printer ") — `listProducts()`
  trims, but the underlying records are worth tidying.
- Decide which products reps may quote at all: "CAMP Invoice" and the $0 processing placeholders
  probably shouldn't appear in a rep-facing picker.

---

## Current state (what already matches E2E.md)

- Rep rate quoting with margin slider, server-side pillowed margins ✅
- Statement analysis via Claude (rep upload path `/rep/proposals/new` AND customer upload path
  `/lead/[token]`) ✅
- Customer account creation via magic link (`request-access` → `verify` → `set-password`) ✅
- Onboarding checklist framework (`getOnboardingModules`) with Adyen (in testing) and
  CheckHQ (sandbox) ✅
- Admin sees all accounts + tenant linkage (read-only HubSpot) ✅

## Gaps, phased

### Phase A — Quote flow spine (dual statement path + customer quote view + accept)

The single biggest reshape. Today the customer link *always* demands a statement upload before
showing anything, and there is no config-driven quote, no prepared-quote presentation, and no
explicit accept.

- **Quote config on the application.** Add `quoteConfig: { avgTicket, monthlyVolume } | null` to
  `MerchantApplication` (+ column in `merchant_applications`). These are the E2E.md "configs".
  When a statement analysis exists, its numbers take precedence; the config is the no-statement
  base and also what "quoted volume/ticket" is later compared against (Phase G).
- **Prospect form gains configs + optional statement.** `/rep/prospects/new` grows ticket-size and
  monthly-volume inputs and an *optional* statement upload (reusing the `/api/analyze` path). If
  the rep uploads, the analysis is attached before the link is ever sent.
- **Pricing without a statement.** A thin path in `pricing.ts` that derives a quote from
  `quoteConfig` (volume, ticket, default CP/CNP split) when `analysis` is null. Interchange
  assumptions come from the PRICING-QUESTIONS-FOR-STEVE answers — these are load-bearing here
  since there's no statement to anchor them.
- **Customer link branches.** `/lead/[token]`: if the application already has a quote (rep
  uploaded a statement or set configs) → render the quote view; else → today's upload flow, which
  on completion lands on the same quote view.
- **Customer quote view.** Token-gated page presenting the full quote (rate now; hardware and
  subscription lines once Phase C lands). Data crosses the boundary only as an extended
  `CustomerSafeQuote` — no margin, no cost, enforced server-side as today.
- **Explicit accept.** "Accept & create account" button on the quote view → records acceptance,
  advances stage, and flows into the existing magic-link account creation → checklist. New
  `DealStage` values: `quote_sent`, `quote_accepted`.

Verify: rep-upload path (statement → link → customer sees prepared quote → accept → account →
checklist) and customer-upload path (link → upload → quote → accept) both work end to end.

### Phase B — Admin portal identity (feedback-driven, independent, cheap — do early)

- **Stop redirecting `/admin` → `/rep`.** Give `/admin` its own dashboard: org-wide metrics
  (pipeline totals, per-rep breakdown, leads), then the all-accounts table. The rep view stays
  what a rep sees.
- **Unmistakable admin chrome.** Admin routes get a visibly distinct shell: an "Admin" badge in
  the nav (next to the wordmark and user name), a distinct accent/header treatment, and the nav
  sub-label reading "Admin Console" instead of "Rate Calculator".
- **Nav reflects the role.** Admin nav links: Dashboard (`/admin`), Accounts, Leads, Users,
  Settings (processors/tiers + margin padding) — instead of the rep nav plus a dropdown.
- Later phases hang admin-only views here (quoted-vs-actual, Phase G).

Verify: log in as admin → land on `/admin`, visibly admin-branded; log in as rep → unchanged.

### Phase C — Product & hardware quoting (sourced from HubSpot, not a local catalog)

Revised: the catalog already exists in HubSpot and is actively maintained there. Building a
parallel `hardware_items` table would immediately drift.

- **Read the catalog from HubSpot.** Extend `hubspot.ts` with `listProducts()` reading
  `name, price, hs_product_type, recurringbillingfrequency, hs_status`, filtered to active and
  excluding the TEST product. Cache it (it changes rarely) rather than fetching per page load.
- **Quote lines on the application.** `quoteLines: Array<{ hubspotProductId, name, qty,
  unitPrice, billingFrequency: "one_time" | "weekly" | "monthly" | …, productType }>`. **Snapshot
  price and frequency at quote time** — HubSpot's own model does the same (line items capture the
  product at time of sale and don't retroactively change).
- **Frequency-aware totals.** Compute three separate totals — one-time (hardware + install),
  recurring per-cycle, and normalized monthly-equivalent — and label them unambiguously. Do not
  sum across frequencies.
- **Rep configurator** grouped by `hs_product_type` (Hardware / Software / Service);
  **customer display** on the quote view (Phase A), showing rate + hardware + subscription
  together as E2E.md step 3's "full quote".
- **The platform tier is not a free choice — it's derived from the ordering-point count.**
  "AIO Platform (1 to 5 Order Points)" vs "(6 + Order Points)" is the single largest recurring
  line on the quote, and which one applies is a function of the configured order points, not a
  dropdown a rep picks. See Phase H.

Verify: a quote containing AIO Platform (1-5) + a POS Unit renders "$99/week (~$429/mo)" and
"$749 one-time" as distinct lines, never added together.

### Phase D — Email the quote link (Resend)

- Verify a sending domain in Resend; replace `onboarding@resend.dev`; set `RESEND_API_KEY`.
- Auto-send a branded quote email from `createProspectAction` (and a "resend link" action on the
  account detail). Reuses `email.ts`; add a quote-link template alongside the magic-link one.

Verify: creating a prospect emails the customer; the copy-link UI remains as fallback.

### Phase E — Missing checklist modules

Additions to `getOnboardingModules` (the framework needs no redesign; `coming_soon` status
already exists for stubs).

**Billing (through HubSpot)** — now well-specified by the findings above. Same hosted posture as
Adyen and Check: EasyOB creates the records, the partner collects the payment credentials.

**The shape: EasyOB builds the quote, HubSpot takes the checkout.** EasyOB never sees bank
details; it hands the customer to HubSpot's hosted quote page and reads the result back.

> **Not a parallel copy — one quote, two audiences.** The tempting version is "EasyOB quotes, and
> also mirrors an identical quote into HubSpot so reps can see it." Don't build that: two records
> for one deal drift the moment anyone edits either side, and only one of them can be the thing
> the customer actually pays. Instead the **HubSpot quote is the billing vehicle**, and rep
> visibility comes free because it lives on the deal in the CRM. Create it early as a **draft** so
> reps see it while the deal is still being worked, then publish that same quote on acceptance to
> get the checkout link. HubSpot's own lifecycle (`draft` → `approval_not_needed`/`approved` →
> `accepted`) maps onto this exactly, and publishing updates the linked deal's amount and line
> items automatically.
>
> Sync is **one-way, EasyOB → HubSpot**, while the quote is a draft: the rep edits in EasyOB, and
> EasyOB patches the HubSpot quote and its line items on explicit save (not per keystroke). Once
> published, EasyOB stops editing and HubSpot becomes the source of truth — the customer may
> already have paid against it. Don't attempt bidirectional sync.
>
> **The processing rate can't be a line item.** The catalog's "AIO Processing Two Tiered Rate" is
> $0, because processing margin is collected via Adyen, not billed by HubSpot. So the quote's line
> items carry only what HubSpot actually bills (platform, hardware, services), and the quoted rate
> goes onto **deal properties** — which is what the existing `pushToHubSpot` stub already writes
> (`proposed_effective_rate`, `current_processor`, `current_monthly_fees`, …). Optionally include
> the $0 processing product as a line item so the quote document reads completely.
>
> **Reuse an existing deal when there is one.** Once Phase F lands, a merchant may arrive from a
> HubSpot Company that already has an open deal; attach the quote to it rather than creating a
> duplicate. Only create a deal when the application has no `hubspotDealId`.

1. On quote acceptance, EasyOB creates a **deal**, then **line items** from `quoteLines`
   (each carrying the product's own `hs_recurring_billing_period`/frequency — weekly for platform
   fees, one-time for hardware and installation, which can live on the same quote). Spiked: a
   weekly `recurringbillingfrequency` line item needs `hs_recurring_billing_period` in weekly
   form — **`P7D`**, not `P12M` (a `P12M` period 400s with
   `BILLING_PERIOD_TO_FREQUENCY_FORM_MISMATCH`). HubSpot then derives
   `hs_recurring_billing_number_of_payments: 1` / `FIXED` on that line item — worth a Steve
   question on whether a 1-payment fixed term is actually intended for the platform fee (added to
   the open-decisions table below).
2. Creates a **quote** (`hs_template_type: CPQ_QUOTE`) with
   `hs_billing_enabled: true` (this is what makes HubSpot create the subscription),
   `hs_payment_enabled: true`, `hs_store_payment_method_at_checkout: true`, ACH among the allowed
   methods, and `hs_collection_process: "AUTO_PAYMENTS"` (enum `AUTO_PAYMENTS|MANUAL_PAYMENTS` —
   this is the quote's own property; it is *not* the subscription's `automatic_payments` value,
   which 400s if reused here). Associate line items, contact, and deal, then publish by setting
   `hs_status` to `APPROVAL_NOT_NEEDED`.

   **Publish-time gates (spiked 2026-08-18, three 400s hit in order):** `hs_sender_email` is
   required at publish, not at create — set it before the publish call. `hs_payment_enabled: true`
   is incompatible with the default `hs_acceptance_method: print_and_sign`; set
   `hs_acceptance_method: "esignature"` (or `"clickwrap"`) instead, and never write
   `hs_esign_enabled` directly — it's derived and silently ignores writes. An esign-enabled quote
   also can't publish without a **contact signer association (typeId 702)**, in addition to
   contact 69 / deal 64 / line items 67. (HubSpot auto-adds association 1393, "Deal with Primary
   Quote," on publish — don't create it yourself.)
3. **Port out:** read `hs_quote_link` and send the customer there — the checklist module's CTA is
   a redirect to that URL, exactly like the Adyen and Check "continue" routes. The customer enters
   their bank details on HubSpot's page. `hs_quote_link` is `https://{hs_domain}/{hs_slug}` — the
   slug exists at create (the URL is predictable), but the link itself only populates at publish,
   ~3s later. One read-after-write with a single retry is enough; no poll loop needed.
4. HubSpot creates the **subscription** (with the ACH method stored, so it auto-debits) and issues
   its invoices on its own cycle. EasyOB creates neither.
5. Status is derived by **reading back**: `hs_payment_status`/`hs_payment_date` on the quote, and
   once it exists, the subscription's `hs_status` (`scheduled` → authorized, awaiting first cycle;
   `active` → billing). Cache the snapshot on the application, mirroring `checkIds.onboardStatus`,
   so list views don't fan out one API call per account. Spiked: `hs_payment_status` reads
   `PENDING` immediately post-publish — a calculated, read-only enum
   `PENDING|PROCESSING|PAID|PAYMENT_NOT_ENABLED` — confirming this read-back design works.
6. Store `hubspotIds: { dealId, quoteId, quoteLink, subscriptionId, status, statusAt }` alongside
   `adyenIds` / `checkIds`. Treat `hs_quote_link` as re-readable rather than permanently
   stored-and-reserved — re-fetch it if a stored one stops working, the same caution Adyen and
   Check links needed.

> **Publish is irreversible via API.** Spiked 2026-08-18: a published quote cannot be edited (400
> `LOCKED`), cannot be deleted (400 `PUBLISHED_QUOTE_CANNOT_BE_DELETED`), and cannot even be voided
> via the API — setting `hs_status: VOID` is itself an edit, so it hits the same `LOCKED` 400.
> Voiding is UI-only. Phase E therefore needs an explicit confirmation gate before the publish
> call, and must never offer "unpublish" or "edit published quote" as UI affordances.

**Two deal-side effects to expect, not reconcile.** Publishing rolls the line-item total into the
deal's `amount` and `hs_mrr` (HubSpot itself computes weekly × 4.33 for the MRR figure), and
HubSpot **clones the line items into a deal-side copy** — the deal ends up with its own line-item
ids, separate from the quote's. Treat that as expected duplication, not a sync bug to fix.
Separately, a portal workflow renames deals to `{company} / Deal-{n}` on its own schedule, so
EasyOB must never treat `dealname` as a field it owns or can predict.

The quote link is a public URL. Spiked: the portal default `hs_quote_auth_method: public_access`
already matches how AIO shares quotes today — no change needed, which resolves the open question
below.

#### Who owns the quote, and keeping EasyOB in step

Authority **hands off at publish**, it isn't split:

| Phase | Source of truth | Direction |
| --- | --- | --- |
| Draft (rep still building) | **EasyOB** | EasyOB → HubSpot on save |
| Published onward (customer can pay; billing changes happen in the CRM) | **HubSpot** | HubSpot → EasyOB on sync |

So yes — once published, the live quote and everything downstream of it (subscription, invoices,
tier changes, pauses) live in HubSpot, because that's where AIO's billing operation actually runs.
EasyOB is the origination tool and thereafter a reader.

**The thing a sync must never do is overwrite `quoteLines`.** E2E.md's admin view asks for both
"what they are paying us" *and* "what we originally quoted them for" — those are two different
records, and a sync that refreshes the quote in place destroys the second one:

- `quoteLines` + `quoteConfig` — **frozen at publish.** What we quoted. Never touched by sync.
- `hubspotIds` + a billing snapshot (subscription status, MRR, invoice totals) — **refreshed.**
  What they're billed today.

The gap between them *is* the Phase G comparison, so keeping them separate is what makes that
view possible at all.

**Sync mechanism — nightly, plus on-view for the urgent case.** A nightly Vercel Cron route
(`/api/cron/hubspot-sync`) reconciles all accounts: quote payment status, subscription
status/MRR, invoice totals. Pull only what changed by filtering the search API on
`hs_lastmodifieddate` since the last run rather than fanning out one request per account — 91
subscriptions today, and this only grows.

Nightly alone isn't enough for one moment: the customer finishing checkout. If the onboarding
checklist still reads "pending" until the next morning, that generates support calls. Cover it the
way the codebase already covers Check — refresh that single record when it's viewed
(`getMyApplicationWithPayrollSyncAction` is the working precedent: re-read server-side by id,
skip if already terminal, swallow failures so a partner outage can't break the page). HubSpot
webhooks are the later upgrade if nightly + on-view proves too coarse; don't start there.

#### Private app scopes

Per HubSpot's Quotes API guide, publishing a quote **requires** `crm.objects.quotes.read/write`,
`crm.objects.deals.read`, `crm.objects.line_items.read/write`, and `crm.objects.contacts.read` —
a quote cannot be published without line-item, deal, **and contact** associations (type IDs 67,
64, 69; plus 702 for a signer if e-sign is on).

| Scope | Why |
| --- | --- |
| `crm.objects.quotes.read` / `.write` | create + publish the quote, read `hs_quote_link` |
| `crm.objects.deals.read` / `.write` | quotes must associate a deal; we create it |
| `crm.objects.line_items.read` / `.write` | the quote's goods and services |
| `crm.objects.contacts.read` / `.write` | **required association**; write to create the merchant contact when absent |
| `e-commerce` | **required by the Products API** — without it the catalog read fails |
| `crm.objects.subscriptions.read` | read back subscription status for the module |
| `crm.objects.invoices.read` | invoice history for the admin revenue view (Phase G) |
| `crm.objects.companies.read` | already used by the shipped tenant-linkage code (`searchTenantCompanies`) and Phase F |

Not needed: `crm.objects.subscriptions.write` and `crm.objects.invoices.write` (HubSpot creates
both from the quote checkout); all `crm.schemas.*.write`, which grant editing **property
definitions**, not records; and the `deals.sensitive` / `deals.highly_sensitive` scopes. Trim
those — this token lives in an env var in a web app, so least privilege matters.

**Resolved: two apps, two tokens.** Billing lives in its own private app, so `hubspot.ts` picks
headers per call — `HUBSPOT_PRIVATE_APP_TOKEN` for the general CRM app (companies behind tenant
linkage, deal sync) and `HUBSPOT_BILLING_PRIVATE_APP_TOKEN` for products, quotes, line items,
subscriptions and invoices. The split is the point: billing needs write scopes, and a single
shared token would hand those to the sync path too. The scope table above therefore applies to
the **billing** app; the general app only needs companies read plus its existing deal scopes.

**Schedule a demo** — HubSpot Meetings scheduler link/embed. Trivial; do first.

**Foodbuy** — no public API assumed; realistically an enrollment-interest form + internal handoff
(email/HubSpot task). Confirm scope. Ship as `coming_soon` until defined.

### Phase F — "Push to EasyOB" from HubSpot

- Deep link on the HubSpot Company record (custom property/CRM card) →
  `/rep/prospects/new?hubspotCompanyId={id}`.
- Prospect form prefills name/contact from the Company (read via existing `hubspot.ts` client)
  and stores the company id on the application from day one (today `tenantLink` is attached
  manually and late).
- Requires `HUBSPOT_PRIVATE_APP_TOKEN` actually configured (currently empty) with
  companies-read scope.

### Phase G — Actuals pipeline + quoted-vs-actual

Reprioritized: originally filed as "only matters post-go-live", but this is a first-class admin
requirement, not a trailing nice-to-have. It's also **independent of Phases A–E** — it reads live
Adyen and HubSpot data for merchants already processing, so it can be built in parallel with the
quoting work rather than queued behind it. The only real gate is having the reports scheduled and
a report user created in the Adyen Customer Area.

"What they're paying us" has **two sources** that must be combined.

#### Adyen actuals — monthly volume and average ticket per client

The admin ask ("what their actual size and volume is") reduces to gross volume and transaction
count per client per month; average ticket is volume ÷ count. Every client sits under **one shared
POS merchant account** and is distinguished by its **store** (`prod-{tenantNumber}`), so the store
is the attribution dimension.

#### Reports that already exist — verified live 2026-08-18

The earlier plan assumed the Aggregate Settlement Details Report had to be scheduled first. It
doesn't: probing 36 candidate filenames found **21 already downloadable** with the existing
merchant-scoped key. Adyen has been generating these all along.

| Report | Cadence | Coverage found | Store dimension |
| --- | --- | --- | --- |
| `payments_accounting_report_{yyyy_MM_dd}.csv` | daily | every date probed | **✅ `Store` column, `prod-{n}`** |
| `received_payments_report_{yyyy_MM_dd}.csv` | daily | every date probed | not checked |
| `settlement_detail_report_batch_{n}.csv` | per settlement batch | **batches 1 → 300+** (500 absent) | ❌ none — but see Merchant Reference |
| `aggregate_settlement_detail_report_batch_{n}.csv` | — | **absent** | would need scheduling |

**Use `payments_accounting_report` as the primary source.** 88 columns, and critically column 53 is
**`Store`**, carrying clean `prod-{n}` values — 44 distinct tenants on 2026-08-15 — which joins
straight onto `tenantLink.tenantRef` with no inference. It is daily, needs no CA configuration, and
history is already on disk at Adyen.

**Cross-check against `settlement_detail_report`** for a settled-money basis. It has no `Store`
column, but its **`Merchant Reference` encodes the tenant as `{n}-prod`** (the reverse of the store
format), so it can be attributed by parsing. Batch 300 held 1,925 `Settled` rows summing to
$74,410.98 gross.

**⚠️ Staging traffic is in the live data.** One settlement reference was **`4-stagev2`**, not
`{n}-prod`. The ingest must accept only the `prod` pattern and report anything else, or staging
volume gets attributed to a real client.

**⚠️ Restaurants pre-auth, so naive row counting is badly wrong.** One day's accounting report held
14,015 rows but only ~3,468 distinct payments, spread across record types
(`Received`, `AuthorisedPending`, `Authorised`, `SentForSettle`, `ReceivedIncrementalAuth` 253,
`Refused` 65, `Chargeback` 1, …). Restaurants run pre-auth → incremental auth → tip adjust, so a row
count would multiply the transaction count several-fold and divide average ticket by the same
factor. **Dedupe on `Psp Reference` and pick exactly one record type** (`SentForSettle` for a
will-settle basis, `Authorised` for an auth basis) — then be consistent, because the choice moves
every average-ticket number in the product. Note the HubSpot catalog's "AIO Pre Auth" product
confirms pre-auth is standard in this flow, not an edge case.

**⚠️ `Commission (SC)` is zero on all 14,015 rows** — Adyen's fee is not in that column for this
account. The economics live in **`Split Payment Data`** instead.

#### `Split Payment Data` — AIO's commission, per payment (verified 2026-08-18)

The field is JSON with flattened keys, one entry per split item:

```
{"split.item1.reference":"BA32B6Q22322C25PLCVN7CTR7","split.item1.amount":"2594",
 "split.item1.type":"BalanceAccount","split.item2.amount":"77",
 "split.item2.type":"Commission","split.item2.description":"Commission split",
 "split.nrOfItems":"2","split.currencyCode":"USD", …}
```

Amounts are **minor units**. Items with `type: "Commission"` are AIO's cut; `type: "BalanceAccount"`
is the restaurant's. Richer split configurations also appear, with `PaymentFee`, `Fixed Fee` and
`Remainder` descriptions — the parser must sum all `Commission`-typed items rather than assuming
`item2`.

**This is the whole processing half of Phase I, and it needs no additional credential.** Verified
against 2026-08-15, deduped on `Psp Reference` at `SentForSettle`:

| store | txns | volume | commission | take % |
| --- | --- | --- | --- | --- |
| prod-562 | 145 | $24,770.23 | $594.47 | 2.40% |
| prod-596 | 104 | $7,563.16 | $204.27 | 2.70% |
| prod-46 | 73 | $5,770.86 | $161.60 | 2.80% |
| prod-1934 | 198 | $5,368.26 | $154.10 | 2.87% |
| prod-4 | 256 | $3,732.28 | $152.44 | 4.08% |
| **44 stores** | **2,815** | **$101,587.65** | **$3,071.21** | **3.02%** |

Coverage was **2,815/2,815** — zero parse failures, zero empty split fields. Average ticket falls
straight out (blended $36.09, ranging from $14.58 at prod-4 to $170.83 at prod-562).

**The take-rate spread is itself the product.** Realized margin ranges **2.40% → 4.08%** across
clients. That's the number to compare against `proposal.proposedRates` for the quoted-vs-actual
view, and the low end is where margin is quietly leaking.

*(Caveat: this is one day. Restaurants swing hard by weekday, so do not annualise a single file —
the ingest should build months from daily files before anyone quotes a figure.)*

Rejected alternatives, and why:

- *Transfers API per balance account* — amounts arriving in a merchant's balance account are
  **post-split (net of AIO's commission)**, so any average ticket derived from them is understated.
- *Aggregating `AUTHORISATION` webhooks ourselves* — rebuilds refund/chargeback handling that
  settled reporting already accounts for.
- *Waiting on the aggregate report* — it would be lighter to parse, but it does not exist yet and
  the daily accounting report already carries store, amount, and count. Schedule it later as an
  optimisation, not a prerequisite.

~~Second source: the Balance Platform Accounting Report.~~ **Superseded** — AIO's commission is
already in `Split Payment Data` on the merchant-scoped accounting report (above), so no second
report, credential, or pipeline is needed for the processing half. (The HubSpot half still comes
from Phase E's sync.)

**Retrieval — automated, with exactly one manual setup step.** Four moving parts:

1. ~~**Schedule (manual, once).**~~ **Not needed** — the reports we want are already being
   generated (see above). Scheduling only matters if we later want the pre-aggregated variant.
   Report *filenames* are predictable (`payments_accounting_report_{yyyy_MM_dd}.csv`,
   `settlement_detail_report_batch_{n}.csv`), so a cron can construct URLs directly and does not
   strictly need the webhook at all.
2. **Notify.** Adyen fires a webhook when each report is generated: `REPORT_AVAILABLE` on the
   classic notification surface, or `balancePlatform.report.created` on the Balance Platform one.
   The payload carries the filename and the download URL (on the classic event, `pspReference` and
   `reason` respectively).
3. **Download.** HTTPS GET against that URL using a **Report User credential** — created in the CA
   under Developers → API credentials as a report-user type, with the report-download role. This is
   a *separate credential* from the LEM and Management keys already in `.env.local`; the existing
   ones will not authenticate a report download. Send `Accept-Encoding: gzip`; the payload is CSV.
4. **Parse and upsert** into `merchant_monthly_actuals`, aggregating at ingest. Never store the raw
   CSV or per-transaction rows.

**✅ Verified live 2026-08-18.** Report service user created (`report_733223@Company.AIOAppInc`,
**Merchant Report Download role only** — "Export Payments" deliberately not granted), API-key auth,
key in `ADYEN_REPORT_API_KEY`. Probed against `ca-live`:

| Request | Result | Meaning |
| --- | --- | --- |
| `MerchantAccount/AIOAppIncPOS/<nonexistent>.csv` + real key | **404** | auth accepted, merchant account correct |
| same URL + garbage key | 401 | control — confirms the 404 is not a false pass |
| same URL, no key | 401 | control |
| `MerchantAccount/AIOAppInc/…` | 403 | `AIOAppInc` is the company, not a merchant account |
| `Company/AIOAppInc/…` | 403 | credential is merchant-scoped, no company-level access |

So the working shape is
`https://ca-live.adyen.com/reports/download/MerchantAccount/AIOAppIncPOS/{filename}` with an
`X-API-Key` header — API-key auth works, basic auth is not needed. **21 reports are already
downloadable with it** (see "Reports that already exist"), so there is no gating manual step left.

**⚠️ Those 403s mean the commission half needs a second credential.** This report user reaches the
shared POS merchant account only, so it covers the Aggregate Settlement Details Report (volume,
transaction count, average ticket) but **not** the company/balance-platform-scoped Balance Platform
Accounting Report that carries AIO's `platformPayment` split lines. Expect a second report
credential from the **Platforms** tab, on its own host/path, for the revenue side of Phase I.
Confirm in the CA rather than assuming the same path works.

**⚠️ The report host must not be derived from `ADYEN_ENVIRONMENT`.** That var is `test` while
`ADYEN_REPORT_API_KEY` is a **live** credential — the rest of the Adyen integration is still on test
keys. A report client that resolves its host the way `adyen.ts` does would hit `ca-test` with a live
key and 401, looking exactly like a bad key. Resolve the report host separately.

**⚠️ The two webhook surfaces sign differently, and the app only implements one.**
`src/app/api/adyen/webhook/route.ts` uses `verifyBalancePlatformHmac`, which HMACs the **raw JSON
body** — correct for Balance Platform events. Classic notifications (`REPORT_AVAILABLE`) instead
sign a **concatenation of specific fields** (pspReference, originalReference, merchantAccountCode,
merchantReference, value, currency, eventCode, success). Pointing the classic report notification
at the existing route would fail signature verification and look like a config problem. Either
prefer the Balance Platform report event and reuse the existing verifier, or add a second verifier
and a separate route. Confirm which surface AIO's reports actually publish on before building.

**Use the webhook as the trigger and a nightly cron as the backstop.** A missed or duplicated
webhook shouldn't mean a permanently missing month. The cron route (the same one Phase E adds for
HubSpot) re-checks for expected-but-absent report days and fetches them. Adyen retries unacked
webhooks, so the route must ack fast (2xx within ~10s) and do the download out of band rather than
inline — the existing route's fast-ack shape is the right precedent.

**Idempotency is mandatory, not defensive.** Webhooks duplicate and reports get reprocessed, so
the upsert must key on (tenant number, month) and recompute rather than increment. Track processed
filenames so a re-delivered report is a no-op.

**Roll up on day of sale, not settlement date.** The aggregate report is summarized by day of sale
while batches settle later; keying months off the batch date smears transactions across month
boundaries and makes every monthly comparison subtly wrong.

**⚠️ Join on the store reference, not the stored store ID.** `applyTenantNumber` degrades to
handoff mode when the POS env config is absent, and accounts predating business-line capture have
their store created manually by the OB team — in both cases a store exists in Adyen while
`adyenIds.storeId` is null in EasyOB. The durable key is `prod-{tenantNumber}`. Stores in the
report that match no application should be **surfaced in the admin view, not silently dropped** —
those are accounts onboarded outside EasyOB, and quietly discarding them would make the totals
lie.

**Storage.** A `merchant_monthly_actuals` table keyed on (tenant number, month) holding gross
volume, transaction count, and AIO commission — aggregated at ingest rather than storing
transaction rows. Keep the upsert idempotent on that key so reprocessing a report is safe.

New env: **`ADYEN_REPORT_API_KEY`** — the report service user supports either an API key or basic
auth, and the API key wins: one secret instead of two, rotatable without touching the username, and
it matches the `X-API-Key` header shape `ADYEN_LEM_API_KEY` / `ADYEN_CONFIG_API_KEY` already use.
Basic auth (`report_…@Company.AIOAppInc` + password) stays as the fallback if a download 401s.
Either way the value goes through the same `\$`-escaping rule as every other Adyen key.

- **Processing revenue** = the commission column above, cross-checked against actual volume ×
  contracted margin (`proposal.proposedRates`, already stored) — a divergence there is itself a
  finding worth showing.
- **Platform/hardware revenue** — read from HubSpot: subscription `hs_mrr` for recurring, plus
  paid invoices for one-time hardware and services. No new pipeline needed — the Phase E nightly
  sync already collects this.
- **Admin comparison view** (in the Phase B admin portal): quoted volume/ticket (`quoteConfig` /
  statement analysis) vs. trailing actuals, variance %, and a combined revenue column broken out
  by source — E2E.md's "what they are paying us" and "how true were their reported numbers".

This view only works if the frozen-vs-synced split from Phase E holds: `quoteLines`/`quoteConfig`
are what we quoted and must never be overwritten by the sync, while the billing snapshot is what
they pay now. Comparing the two is the whole feature.

### Phase H — Ordering points (quoted vs. deployed)

An **ordering point** is any place an order can be placed: POS terminal, kiosk, MPOS handheld,
tableside device, website/online ordering. Requested for both proposal generation and the admin
overview.

This is not a new reporting nicety bolted onto the side — it is **already the pricing dimension
AIO bills on**, and the app currently ignores it:

| Product | Price | Effective monthly |
| --- | --- | --- |
| AIO Platform (**1 to 5 Order Points**) | $99/week | ~$429 |
| AIO Platform (**6 + Order Points**) | $199/week | ~$862 |

So the order-point count selects the biggest recurring line on every quote — a $433/mo swing.
That makes Phase H a dependency of Phase C's configurator, and it makes the quoted-vs-actual
comparison a **billing-leakage report**, not just an interesting statistic: a client quoted at the
1–5 tier who has since deployed eight order points is under-billed by $100/week ($5,200/yr).

#### Two halves, two different sources

Order points split cleanly by lifecycle, and conflating them is the main trap here:

- **Quoted (pre-go-live).** At quote time the customer has no deployed hardware, so inventory has
  nothing to say. The quoted count is derived from **the quote itself** — the order-point-bearing
  hardware lines the rep configured — plus any **non-hardware channels** declared on the deal
  (website / online ordering, QR, third-party delivery, phone-AI). Store it on the application
  next to `quoteConfig`, because it's part of what we quoted and must be frozen at publish like
  everything else in that bucket.
- **Actual (post-go-live).** What's physically deployed at that customer today, from
  `aioinventory`. This is the Phase G-style actuals half and belongs in the admin comparison view.

**Non-hardware order points exist only in the quote.** A website is an ordering point and will
never appear in an inventory system, so "actual order points" is always *deployed hardware +
declared channels*. Don't build the admin view as if inventory were the complete truth — it isn't,
and a client whose sixth order point is their website would silently read as tier-1 compliant.

#### The inventory API — what's there and what isn't

`aioinventory` (`/Volumes/Shaheer T7/Projects - AIO/aioinventory`) is a Firebase/Firestore SPA with
Cloud Functions in `functions/`. The existing endpoint is a **genuine head start but not a drop-in**:

- ✅ `exports.metrics` (`functions/index.js`) — HTTP, authenticated by an `X-Metrics-Key` header
  against a Secret Manager secret (`METRICS_KEY`), fails closed if unset. The auth pattern, deploy
  path, and secret wiring all exist and can be copied verbatim.
- ✅ `functions/inventoryStats.js` — already computes `computeDeployedByCustomer(movements,
  serialCosts)`, correctly excluding RMA/total-loss (`!mv.isRmaTl`) and serials re-received into
  stock. Deployment state is live and self-correcting.
- ✅ `data.hubspotCompanyMap` — a **customer-name → HubSpot Company ID** map, maintained through an
  admin panel in the inventory app and already used by `hubspotNightlySync`. This is the join key.
- ❌ The metrics payload is **org-wide aggregate only** — `deployed: { units, value, customers }`.
  There is no per-customer breakdown and no per-category breakdown, so it cannot answer "how many
  order points does *this* client have."

**What to add (small, in `aioinventory`):** extend `computeDeployedByCustomer` to also group by
`mv.category`, and add a `deployedByCompany` endpoint — same `X-Metrics-Key` auth — returning per
customer: HubSpot company ID (from `hubspotCompanyMap`), customer name, and unit counts per
category. Roughly 60 lines plus an EasyOB-side client. Note the standing warning at the top of
`inventoryStats.js`: it is a hand-maintained server-side copy of the rules in `js/inventory.js`
and nothing enforces the two staying in sync.

**Update 2026-08-18: the endpoint exists.** `exports.deployedByCompany` (`functions/index.js`),
same `X-Metrics-Key` auth as `metrics`, built and passing fixtures but **not yet deployed**.
Category resolution per unit is a three-step chain — `mv.category` on the movement → a lookup in
admin-added `data.productRecords` → a movement-derived fallback that infers the category from other
movements of the same product (preferring a stock-IN movement's category on conflict, since the
stock-in form auto-fills from the product list; first-seen otherwise) → `"(uncategorized)"`. The
fallback exists because the ~26 core products in `js/inventory.js`'s `HARDCODED_PRODUCTS` (POS
Terminal, Kiosk, MPOS, Tableside AI Device, …) are invisible to the functions code and deliberately
not mirrored there. Any unit that still lands in `"(uncategorized)"` after all three steps is a
genuine unknown, not a bug, and EasyOB's admin view must surface it as needs-review — never count it
toward a tier or silently drop it, same rule as the tablet and unmapped-customer cases above.

**Which categories count** — resolved 2026-08-18:

| Counts as an ordering point | Does not |
| --- | --- |
| `POS Terminal`, `Kiosk` (**one point each**, not one per lane), `MPOS`, `Tableside AI Device` | `Payment Terminal`, `Card Reader`, `Customer-Facing Display`, `Kitchen Display System`, printers, `Menu Board`, mounts/stands, all network gear (`Gateway/Router`, `Wi-Fi Access Point`, `PoE Switch`, `LTE Failover`), `Cash Drawer` |
| **Website / online ordering — counts.** Confirmed, and treated as important | |
| `QSR POS Hardware Bundle` — **1 point** (confirmed 2026-08-20: it contains exactly one POS) | |
| `Tablet` — **conditional**: sometimes deployed as a D3 POS replacement (counts), sometimes not | |

### Quote types and selection rules — resolved 2026-08-20

A quote's **type** is chosen before anything is picked, and every selection rule hangs off it. It
has to be explicit rather than inferred: the derived lines land on an empty quote, so there is
nothing to infer from at the moment the decision is needed. Stored on the application as
`quote_type` (null on pre-existing rows = `full_pos`).

| | `full_pos` | `food_truck` | `marketing_only` |
| --- | --- | --- | --- |
| Platform line (derived) | 1–5 or 6+ tier, by order-point count | flat `AIO Platform - Food Truck` | none |
| Network + install + training | qty 1 each, locked — **whenever any product is picked** | same | none |
| Pickable products | anything pickable, marketing included | same | Marketing Platform + Marketing Add Spend only |
| Ordering-point channels | declared by the rep | declared by the rep | **ignored** — a ticked "website" must not conjure a $99/wk tier |
| Processing rate / margin target / statement | yes | yes | **none** — the lines are the whole quote |

**The install services follow the products, not the quote type alone** (confirmed 2026-08-20). An
empty picker is a **rate-only quote** — nothing to install, no network to run, nothing to train on —
so all three come off. Declared ordering channels do *not* pull them back in: a website-ordering
merchant carries a platform fee but has no on-site anything for a $999 install or a $999 WiFi
package to cover. A food-truck quote with an empty picker still owes its flat platform fee.

**Derived lines are never pickable.** All three platform products and the three always-included
services are hidden from the picker and re-derived server-side, for the same reason: a rep able to
add one by hand is how a quote ends up with two platform fees or a second $999 install. Reopening a
saved quote goes through `picksFromQuoteLines()`, which strips them back out.

**A missing derived line blocks the send.** `buildQuote()` returns `blockers[]`; the configurator
disables submit on it and the server action throws on the same list. Silently omitting the platform
tier is a $433/mo hole; silently omitting the install is $999.

Still excluded from the picker for the original reasons: the two $0 processing placeholders, CAMP
Invoice, and AIO Pre Auth (a per-transaction fee, meaningless as a $0.50 line).

Keep this mapping **in EasyOB, not in the inventory endpoint** — it's a pricing rule, and it will
change when the tier definition does. The endpoint stays generic and returns raw category counts.
Any category the mapping doesn't recognise should surface as unclassified rather than defaulting
to zero, so a new product category can't quietly shrink someone's tier.

**⚠️ The tablet case cannot be resolved from inventory data.** A Galaxy Tab A9 deployed as a D3 POS
replacement and one deployed as a display are the same product in the same category — nothing in
the movement record distinguishes them. So any purely automatic count will be wrong for tablets.
Three ways out, in preference order:

1. **A per-account override in EasyOB** (recommended) — the derived count is a default, and an
   admin can set "of 4 tablets, 2 are order points" on the account, with the reason recorded.
   Keeps a pricing judgement in the pricing tool and leaves the inventory stock-out flow alone.
2. A flag captured at stock-out time in `aioinventory` — more accurate at source, but it puts a
   billing-relevant field into an operational workflow where it will get skipped.
3. Count all tablets and let the admin subtract — simplest, but it over-bills by default, which is
   the worse direction to be wrong in.

Until one exists, **tablets should be surfaced as "needs review" rather than silently counted or
silently ignored**, for the same reason unmapped customers must be: a wrong tier is $433/mo.

**Website counting has an immediate consequence worth pricing out.** With the website counting and
a kiosk counting as one, five terminals plus online ordering already reaches the 6+ tier. Once the
pipeline exists, the **first thing to run is a one-time audit of the existing book**: how many live
accounts are on the 1–5 tier but would classify as 6+ today. That is a concrete revenue number,
it needs no new UI, and it's the fastest way to show Steve the pipeline is worth having.

#### The join, and why it's already solid

**HubSpot Company ID is the spine that connects all four systems**, which is worth stating plainly
because it means no new identifier has to be invented:

```
EasyOB application  --tenantLink.hubspotCompanyId-->  HubSpot Company
aioinventory        --hubspotCompanyMap[customer]-->  HubSpot Company
Adyen store         --tenantLink.tenantRef ("prod-{n}" == HubSpot tenant_id)
```

Phase G already joins Adyen actuals on `prod-{tenantNumber}`; Phase H joins inventory actuals on
`hubspotCompanyId`. Same admin row, same `tenantLink` record, no new plumbing.

**The weak link is the inventory side of that map.** `mv.customer` is free text and the mapping to
a company is maintained by hand; `hubspotNightlySync` pushes unmapped customers into a
`{ skipped: 'unmapped' }` result that goes to a log nobody reads. EasyOB must **surface unmapped
inventory customers in the admin view** — same rule already written down for unmatched Adyen
stores. An account showing zero deployed order points because nobody mapped it looks identical to
one that genuinely has none, and the two have opposite billing implications.

Second-order caveat: `mv.category` is captured on the movement and can be blank. Fall back to a
product→category lookup from `data.productRecords`, and report blanks rather than dropping them.

#### The zero-build fallback

`hubspotNightlySync` already writes **`aio_device_count`** and **`aio_total_deployed_value`** onto
each mapped HubSpot Company, nightly at 02:00 America/Chicago. EasyOB can read those two
properties today through the existing `tenantLink` company read — no inventory API work at all.
It's a *total device* count, not an order-point count, so it can't drive tiering; but it's enough
to prove the join end to end and to put a "hardware deployed" figure on the admin row while the
proper endpoint is built. Worth doing first for that reason.

#### Work items

1. **Type + storage:** `orderPoints: { hardware: Record<string, number>; channels: string[];
   total: number } | null` on `MerchantApplication`, frozen at publish alongside `quoteConfig` /
   `quoteLines`.
2. **Rep configurator (Phase C):** derive the hardware half from the quote's order-point-bearing
   lines, add a small checklist for non-hardware channels, show a running count, and
   **auto-select the platform tier product** from it — with the boundary visible ("6 order points
   → 6+ tier, $199/wk"), since crossing it is a $433/mo decision a rep should see, not discover.
3. **Customer quote view (Phase A):** show the order-point count as the stated basis for the
   platform fee. It's the most legible justification for that line on the whole quote.
4. **Inventory endpoint:** `deployedByCompany` in `aioinventory/functions/`, plus
   `ADYEN`-style env wiring in EasyOB (`INVENTORY_METRICS_URL`, `INVENTORY_METRICS_KEY`).
5. **Admin view (Phase B/G):** quoted order points vs. deployed, tier implied by each, and an
   explicit **tier mismatch** flag. Refresh nightly on the existing cron, cached on the
   application like `checkIds.onboardStatus` — this is org-wide data, so never fetch per page view.

Verify: a client with 3 POS terminals + 2 kiosks + a website reads 6 order points and prices at the
6+ tier; the admin row for a live account shows quoted vs. deployed with the mismatch flagged.

### Phase I — The account P&L ("how much are we making off this restaurant")

Steve's ask, stated directly: at a glance, every meaningful way AIO makes money off a given
restaurant, across inventory, Adyen transactions, and billing. This is the **destination the other
phases feed** rather than a separate pipeline — G supplies Adyen, E supplies billing, H supplies
inventory. What it adds is the thing none of them currently carry: **cost**, and therefore profit
rather than revenue.

#### The four revenue streams

| Stream | Source | Shape |
| --- | --- | --- |
| **Processing margin** | Adyen — `platformPayment` split lines, Balance Platform Accounting Report (Phase G) | Recurring, volume-driven, the variable one |
| **Platform subscription** | HubSpot — subscription `hs_mrr` (Phase E) | Recurring, weekly, tier-driven (Phase H) |
| **Add-on software** | HubSpot — Marketing Platform $49/wk, Review Manager $39/mo, Payroll $2/person/wk | Recurring, easy to miss because it's several small lines |
| **Hardware + services** | HubSpot — paid invoices | One-time, lumpy, front-loaded |

Note these have genuinely different characters: processing scales with the restaurant's success,
subscription is fixed until the tier moves, hardware is a one-off at signing. A single blended
"revenue" number hides exactly the differences Steve is asking to see, so the view should break
them out and only then total them.

#### The cost side — this is what inventory uniquely provides

Adyen and HubSpot between them can only ever produce a revenue figure. **Inventory is the only
system that knows what a restaurant cost AIO**, and it already tracks it per serial:

- **Hardware at cost.** `computeDeployedByCustomer` already returns `value` per customer, summed
  from `serialCosts[serial]` — capital currently deployed at that restaurant, at cost. This comes
  free with the Phase H `deployedByCompany` endpoint; it is the same function call.
- **RMA and total loss.** Movements carry `isRmaTl` and a customer, so replacement hardware burned
  on an account is attributable. A restaurant on its third replacement terminal is materially less
  profitable than one on its first, and nothing today surfaces that.
- **Adyen's own processing cost.** `calcAdyenCost` / `adyenRateOnVolume` in `pricing.ts` already
  model this correctly and are used internally — reuse them, subject to the open question below
  about whether split commission arrives gross or net.

**⚠️ The cost figures are only as good as `serialCosts` coverage.** `computeMetrics` already
computes a `costCoverage` ratio precisely because uncosted serials contribute **0** and silently
understate the total. For an org-wide dashboard that's a rounding error; for a per-restaurant P&L
it's a lie with a specific victim — an account whose devices are half uncosted looks twice as
profitable as it is. The `deployedByCompany` endpoint must therefore return **costed vs. total unit
counts per customer**, and the view must show "cost basis covers 8 of 11 devices" rather than
printing a confident number. Same discipline as unmapped customers and unclassified tablets: make
the gap visible instead of letting it silently flatter the figure.

#### What the view should actually show

Revenue alone answers "how much do they pay us." Steve asked how much we're **making**, which needs
the pairing:

- **Monthly gross profit** — recurring revenue (processing + subscription + add-ons) minus
  recurring cost. The steady-state number.
- **Hardware payback** — deployed hardware at cost ÷ monthly gross profit, in months. This is the
  metric that makes a restaurant legible at a glance, and it's the one that only exists once
  inventory is joined in. POS deals routinely subsidise hardware to win the processing, so an
  account can show negative hardware margin and still be excellent — payback is what tells them
  apart, and nothing in AIO's current stack can compute it.
- **Lifetime to date** — cumulative revenue minus cumulative cost since go-live, i.e. whether this
  restaurant has paid back yet at all.
- **Revenue mix** — the four streams broken out, so a processing-heavy account and a
  subscription-heavy account of equal size don't look identical. They carry very different risk:
  processing revenue disappears if the restaurant's volume drops, subscription revenue doesn't.

Sort the admin list on one headline metric (see open decisions) and let the row expand into the
breakdown. Reuse the Phase B admin portal shell.

#### Sequencing

Phase I is mostly **composition**, not new plumbing — which means its real cost is the three feeds,
not the view. The cheapest honest ordering:

1. **HubSpot billing** (Phase E sync) — already specified, and covers two of four revenue streams.
2. **Inventory `deployedByCompany`** (Phase H) — small, and unlocks the entire cost side plus
   order points in one endpoint.
3. **Adyen actuals** (Phase G) — the largest single revenue line, but gated on reports being
   scheduled and a report user existing in the Customer Area, so start that request now.
4. The composed view.

Each step is independently useful: after 1 the admin sees billed revenue, after 2 it sees deployed
capital and payback on the subscription half, after 3 the picture is complete. Don't hold the view
back for step 3.

Verify: a live account shows four revenue streams broken out, deployed hardware at cost with its
coverage ratio, monthly gross profit, and a payback figure in months.

## Open decisions needed before the relevant phase

| Decision | Blocks |
| --- | --- |
| Confirm weekly billing is intended for all platform tiers (contradicts the "monthly invoices" assumption) | Phase C — every quote's headline number |
| Which products a rep may quote, and whether prices are ever overridable per deal | Phase C |
| Foodbuy scope (form + handoff vs. something deeper) | Phase E (Foodbuy module) |
| Whether EasyOB-created quotes should reuse AIO's existing quote template, and which quote owner/sender they carry | Phase E |
| ~~Buyer authentication on the shared quote link (`hs_quote_auth_method`)~~ | **Resolved 2026-08-18:** portal default `public_access` already matches how AIO shares quotes today — no change needed |
| Is a 1-payment `FIXED` term intended for the weekly platform-fee line item (HubSpot derives this from `hs_recurring_billing_period: P7D`) — a Steve question | Phase E |
| Interchange/CP-split assumptions for statement-less quotes (PRICING-QUESTIONS follow-up) | Phase A pricing path |
| Resend sending domain | Phase D |
| Schedule the Aggregate Settlement Details + Balance Platform Accounting reports in the Adyen CA, and create a Report Service user | Phase G — nothing can be ingested until these exist |
| How to attribute stores created manually by the OB team (no `storeId` in EasyOB) — confirm `prod-{tenant}` is always the reference used | Phase G |
| HubSpot token provisioning + scopes (line items, deals, quotes write; subs/invoices read) | Phases E, F, G |
| ~~Which devices count as an ordering point~~ | **Resolved 2026-08-18:** kiosk = 1 point, website counts, tablet is conditional |
| How the conditional `Tablet` case gets resolved (per-account override vs. capture at stock-out) | Phase H — tablets are otherwise uncountable |
| Is the tier re-evaluated as a client grows (and who acts on a mismatch), or fixed at signing? | Phase H admin view — determines whether the mismatch flag is a task queue or just a report |
| Confirm `aioinventory`'s customer→HubSpot-company map is complete enough to rely on, and who maintains it | Phase H — unmapped customers read as zero deployed hardware, and zero cost in the Phase I P&L |
| Does the Adyen split commission arrive gross or net of scheme/interchange cost? Decides whether processing gross profit needs `calcAdyenCost` subtracted or not | Phase I — the largest revenue line's margin |
| Is hardware COGS the right cost basis for Steve's view, or should landed/shipping cost be included? | Phase I |
| Which single number is the headline for "how much we make off this restaurant" — monthly gross profit, hardware payback, or lifetime-to-date | Phase I — determines what the dashboard sorts on |
