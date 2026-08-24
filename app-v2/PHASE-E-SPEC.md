# Phase E — Billing through HubSpot

> ## ⚠️ BUILT 2026-08-21. Read this box before following anything below.
>
> This spec was **written before** the build and the build **deliberately diverged from it** in the
> places listed here. Where this box and the body disagree, this box is what shipped and why. The
> body is kept for its reasoning, not as instructions.
>
> **Decided by the product owner (Shaheer), 2026-08-21:**
>
> 1. **Auto-publish on merchant acceptance.** §6.2's two-step rep confirmation modal (typed-DBA gate)
>    is **cancelled**, and with it §6.1 items 1 and 10 (rep authorization, client-submitted totals) —
>    there is no rep in the loop and no client submission to cross-check. The whole graph is built and
>    published inside `/api/lead/[token]/accept`. **Consequence: `canPublishBillingQuote` is now the
>    only thing standing between a bad quote and a live, unamendable ACH mandate**, which is why §6.1
>    item 9 was *hardened* from "or the rep acknowledged" to a hard refusal.
> 2. **`hs_recurring_billing_period` is never written** — §3.3 is **wrong** to send `P7D`. It is a
>    contract *term*, not the billing cycle (`label: "Term"`; HubSpot derives
>    `hs_recurring_billing_number_of_payments` from it), so `P7D` takes one $99 charge and then
>    silently stops collecting. 935 of AIO's 1,200 live weekly line items leave it NULL, matching the
>    real invoice stream. This also answers **O-2**. **LIVE-VERIFIED 2026-08-24** on quote
>    `323970722493`: the weekly platform line read back `period: NULL` / `nPayments: NULL`, while all
>    eight one-time lines got `nPayments: 1` — HubSpot deriving the count from the period, observed
>    directly rather than inferred.
> 3. **The quote template is admin-configurable**, not a constant: a `quote_template_policy` table
>    maps `quoteType` → template id, edited at `/admin/settings/quote-templates` with the list read
>    live from HubSpot. Defaults `full_pos`/`food_truck` → AIO Quote v3 (`817263673055`),
>    `marketing_only` → Marketing Only Quote (`817697352408`). Attached by association **286**.
>    Closes the template half of **O-1**; the sender half is the owning rep's `users.email`.
> 4. **`schedule_demo` and Foodbuy ship as `coming_soon` shells** (closes **O-13**).
>
> **Corrected by evidence, not preference** — all from `PAYMENT-TEST-PLAN.md`, which supersedes this
> document wherever they conflict:
>
> 5. **§7.2's status matrix is defective.** Billing completion is gated on the **subscription**, not
>    `hs_payment_status`: the subscription appears 1–9 min after checkout, `PAID` lags by a median of
>    **5.7 days**. As written, the matrix invites a merchant who already paid to "Review & Pay" for
>    most of a week.
> 6. **`findSubscriptionForDeal` → `findSubscriptionsForQuote`** (association **304**), and
>    `HubspotIds` carries `subscriptions[]`. One quote yields one subscription per distinct billing
>    frequency. Closes **O-4**; `listSubscriptionsModifiedSince` was never needed.
> 7. **Cron lookback 3 d → 10 d** (§8.1) — ACH settlement outlasts a 3-day window, permanently.
> 8. **Quote expiry 30 d → 90 d** (§3.4), matching AIO's live quotes. Expiry gates the buyer's
>    e-signature, which happens *after* this publish.
> 9. Closed by live reads: **O-3** (`hs_allowed_payment_methods: "ACH"`), **O-5** (real stage ids —
>    `STAGE_MAP` was repaired in `9aafa5d`), **O-8**, **O-15** (`BYO_STRIPE`, 46/46), **O-17**
>    (deal→company 341, deal→contact 3), **O-14** (`hubspotDealId` is canonical; `HubspotIds` has no
>    `dealId`).
>
> **Not implementable as scoped:** correction #10 in `PAYMENT-TEST-PLAN.md` §6
> (`hs_discount_percentage`, `hs_billing_start_delay_*`) needs `QuoteLine` extended first — a
> quoting-model change, not an adapter one.
>
> **Still outstanding:** the one human-run live create→publish→read-`hs_quote_link` run (§9.2, and
> `PAYMENT-TEST-PLAN.md` §2.2), against TEST COMPANY `334295287484`; migration `0008` is generated
> but unapplied; nobody has enumerated the portal's **workflows**, so an EasyOB-created deal could
> still trip a customer-facing automation.

Implementation spec. Companion to `E2E-PLAN.md` (Phase E, lines 409–576) and the live
quote-publish spike of 2026-08-18 (`E2E-PLAN.md:446–504`). Where the spike settled something,
this document cites it and does not re-open it. Where this document infers, it says so.

Written against the code at `HEAD` on branch `v2`. Every claim about existing code carries a
`file:line`.

> **Note on `AGENTS.md`.** It directs you to `node_modules/next/dist/docs/`. That directory does
> not exist in this install (`next@15.5.20`, verified). All App Router mechanics below are
> therefore specified by matching in-repo precedent — route handlers with
> `{ params }: { params: Promise<{ id: string }> }`
> (`src/app/customer/applications/[id]/payroll/continue/route.ts:10`), `"use server"` actions
> (`src/lib/actions/customer.ts`), `export const maxDuration`
> (`src/app/api/cron/adyen-actuals/route.ts:19`), and `vercel.json` crons.

---

## 1. Scope

Phase E turns an accepted EasyOB quote into a HubSpot **deal → line items → quote** graph, publishes
that quote to obtain the hosted checkout link `hs_quote_link`, hands the customer to that link from
a new **Billing** module on the onboarding checklist, and reads the outcome back (quote payment
status, then the subscription HubSpot creates from the checkout) into a cached snapshot on
`merchant_applications.hubspot_ids`. It adds a rep-side "build/publish the HubSpot quote" surface
with an irreversibility gate, a nightly reconciliation cron, and an on-view refresh for the moment
the customer finishes checkout. It **also repairs the existing deal sync, which has never once
succeeded** (§5.2, confirmed against the live portal 2026-08-19) — Phase E's first network call is
deal creation, so that repair is a prerequisite rather than an adjacent cleanup — and gives every
swallowing HubSpot path a persisted, visible failure state (§5.7).

## 2. Non-goals

EasyOB never creates the subscription or its invoices — HubSpot does that from the checkout
(`E2E-PLAN.md:476-477`), so `crm.objects.subscriptions.write` / `invoices.write` stay ungranted
(`E2E-PLAN.md:561-564`). No bidirectional sync: authority hands off at publish and EasyOB becomes a
reader (`E2E-PLAN.md:508-517`). No "unpublish", "edit published quote", or "void" affordance —
publish is irreversible via API (`E2E-PLAN.md:489-493`). No parallel mirror quote: one HubSpot quote
serves both rep visibility and customer checkout (`E2E-PLAN.md:420-428`). No processing-rate line
item — processing margin comes out of Adyen settlement, and the catalog's processing products are
$0 placeholders (`E2E-PLAN.md:286-292`, already excluded from the picker at
`src/lib/quoting.ts:28-33`). `quoteLines` / `quoteConfig` / `orderPoints` are never written by any
sync path. The other two Phase E items in `E2E-PLAN.md:573-576` — **Schedule a demo** (a HubSpot
Meetings link with no completion signal) and **Foodbuy** (`coming_soon`, scope undefined) — are out
of scope here; see open question **O-13**. The invoice-history read for the admin revenue view is
Phase G, not this spec.

---

## 3. The HubSpot object graph

### 3.1 Shape

```
Contact ──69──┐
              ├──▶ Quote (CPQ_QUOTE) ──67──▶ Line items (one per QuoteLine)
Contact ─702──┘         │
                        └──64──▶ Deal  ◀── 1393 auto-added by HubSpot on publish
```

The deal usually **already exists** before Phase E runs — see §5.1. Line items are created fresh for
the quote; HubSpot clones its own deal-side copy at publish, and the deal ends up with separate
line-item ids. That is expected duplication, not a sync bug (`E2E-PLAN.md:495-498`).

### 3.2 Association type IDs

From the quote object, as exercised by the spike (`E2E-PLAN.md:461-470`, `543-548`):

| From → To | `associationTypeId` | Required to publish? |
| --- | --- | --- |
| Quote → Line item | **67** | Yes |
| Quote → Deal | **64** | Yes |
| Quote → Contact | **69** | Yes |
| Quote → Contact (**signer**) | **702** | Yes, because `hs_acceptance_method: esignature` is forced (§3.4) |
| Deal → Quote ("Deal with Primary Quote") | **1393** | **HubSpot adds this itself at publish — never create it** (`E2E-PLAN.md:469-470`) |

Not applicable to Phase E: subscription↔line-item **301** and subscription↔contact/company **295**
(`E2E-PLAN.md:228-231`) belong to the seller-created-subscription flow we deliberately do not use.

*Inference:* the spike's write path is described as "v4 associations" (`E2E-PLAN.md:128`) but the
exact call is not recorded. Use
`PUT /crm/v4/objects/quotes/{quoteId}/associations/{toObjectType}/{toObjectId}` with body
`[{ "associationCategory": "HUBSPOT_DEFINED", "associationTypeId": <id> }]`, which is the same v4
surface `getCompanyOwnerContact` already reads from (`src/lib/adapters/hubspot.ts:296`).

### 3.3 Line-item properties

One line item per `QuoteLine` (`src/types/merchant.ts:119-126`).

| Property | Value |
| --- | --- |
| `hs_product_id` | `line.hubspotProductId` |
| `quantity` | `line.qty` |
| `price` | `line.unitPrice` — **per billing cycle**, never a monthly conversion (`src/types/merchant.ts:105-107`) |
| `recurringbillingfrequency` | `line.billingFrequency`, omitted when `"one_time"` |
| `hs_recurring_billing_period` | **`P7D`** for `weekly`. Spiked: a `P12M` period 400s with `BILLING_PERIOD_TO_FREQUENCY_FORM_MISMATCH` (`E2E-PLAN.md:450-453`). Omitted for `one_time`. |

HubSpot then derives `hs_recurring_billing_number_of_payments: 1` / `FIXED` on the weekly line
(`E2E-PLAN.md:453-454`). Whether that is intended is open question **O-2** — it does not block the
publish.

The period string for every non-weekly frequency in `BillingFrequency`
(`src/types/merchant.ts:90-101`) was **not** exercised by the spike. Only `weekly`, `monthly` and
`one_time` appear in AIO's live catalog for quotable products (`E2E-PLAN.md:193-201`), so implement
the mapping as a total `Record<BillingFrequency, string | undefined>` and make anything outside
`{one_time, weekly, monthly}` a hard error at build time rather than a guessed ISO period. See
**O-9**.

### 3.4 Quote properties

At **create** (`hs_status: DRAFT`):

| Property | Value | Source |
| --- | --- | --- |
| `hs_template_type` | `CPQ_QUOTE` | `E2E-PLAN.md:266` |
| `hs_title` | `"{DBA} — AIO Platform Quote"` | inference |
| `hs_expiration_date` | create-date + 30 days (default, **O-8**) | not spiked |
| `hs_billing_enabled` | `true` — this is what makes HubSpot create the subscription | `E2E-PLAN.md:272` |
| `hs_payment_enabled` | `true` — allows collection via the quote link | `E2E-PLAN.md:273` |
| `hs_store_payment_method_at_checkout` | `true` — stores the ACH method for future automatic charges | `E2E-PLAN.md:274` |
| `hs_collection_process` | **`AUTO_PAYMENTS`** (enum `AUTO_PAYMENTS\|MANUAL_PAYMENTS`). Do **not** reuse the subscription's `automatic_payments` value — it 400s here | `E2E-PLAN.md:457-460` |
| `hs_acceptance_method` | **`esignature`** — `print_and_sign` (the default) is incompatible with `hs_payment_enabled: true` | `E2E-PLAN.md:465-467` |
| `hs_esign_enabled` | **never written** — derived, silently ignores writes | `E2E-PLAN.md:467-468` |
| `hs_quote_auth_method` | left at the portal default `public_access` — matches how AIO shares quotes today; resolved, no change needed | `E2E-PLAN.md:502-504`, `1055` |
| allowed payment methods | must include ACH. **The property name was not recorded by the spike** — confirm before writing the create call | `E2E-PLAN.md:459`, **O-3** |

At **publish** (a `PATCH` setting `hs_status: APPROVAL_NOT_NEEDED`):

| Property | Note |
| --- | --- |
| `hs_sender_email` | **Required at publish, not at create.** Set it in the publish PATCH. Which mailbox is **O-1** | `E2E-PLAN.md:463-465` |
| `hs_status` | `APPROVAL_NOT_NEEDED` (or `APPROVED`) | `E2E-PLAN.md:461` |

Read back after publish:

| Property | Meaning |
| --- | --- |
| `hs_quote_link` | `https://{hs_domain}/{hs_slug}`. The slug exists at create so the URL is predictable, but the link itself only populates **at publish, ~3s later** — one read-after-write with a **single** retry is enough, no poll loop | `E2E-PLAN.md:472-475` |
| `hs_payment_status` | Calculated, read-only: `PENDING \| PROCESSING \| PAID \| PAYMENT_NOT_ENABLED`. Spiked: reads `PENDING` immediately post-publish | `E2E-PLAN.md:478-483` |
| `hs_payment_date` | Set when paid | `E2E-PLAN.md:276` |

### 3.5 Deal properties

The quoted rate cannot be a line item, so `E2E-PLAN.md:435-440` puts it on deal properties — "which
is what the existing `pushToHubSpot` stub already writes" (`src/lib/adapters/hubspot.ts:41-50`).
**That premise is false.** Five of the nine property names it sends do not exist on the portal's DEAL
object, so the write 400s in its entirety and always has. Four defects in that function, one of them
fatal, are a prerequisite for Phase E — see §5.2.

---

## 4. New functions in `src/lib/adapters/hubspot.ts`

All of these use **`billingHeaders()`** (`src/lib/adapters/hubspot.ts:36-38`) — quotes, line items,
deals, contacts and subscriptions all live on `HUBSPOT_BILLING_PRIVATE_APP_TOKEN`, which probed 200
for every one of these writes during the spike with zero 403s (`E2E-PLAN.md:127-129`). The general
token stays companies-read-only. Every network call throws via `hubspotErr(prefix, status, body)`
(`src/lib/adapters/hubspot.ts:120-123`) so a 403 self-describes. Reads and idempotent writes go
through `fetchWithRetry` (`src/lib/adapters/hubspot.ts:463-473`); **`publishQuote` does not** — see
its note.

```ts
// ── Phase E: billing quote ──────────────────────────────────────────────────

/** Pure. One QuoteLine → the line-item property bag. Throws on a frequency with
 *  no confirmed hs_recurring_billing_period (see §3.3). Unit-testable. */
export function toLineItemProperties(line: QuoteLine): Record<string, string>;

/** Pure. The DRAFT quote property bag. senderEmail is deliberately absent — it
 *  belongs to the publish PATCH (E2E-PLAN.md:463). Unit-testable. */
export function draftQuoteProperties(input: {
  title: string;
  expirationDate: string;           // yyyy-MM-dd
}): Record<string, string | boolean>;

export type QuoteContactInput = {
  firstName: string; lastName: string; email: string; phone?: string;
};
/** Find-or-create the Contact the quote associates (69) and takes as signer (702).
 *  Searches by email first so a merchant already in the CRM isn't duplicated.
 *  Needs contacts.read + contacts.write — granted, E2E-PLAN.md:97. */
export async function ensureQuoteContact(input: QuoteContactInput): Promise<string>;

/** Creates one line item per quote line. Returns ids in input order. */
export async function createQuoteLineItems(lines: QuoteLine[]): Promise<string[]>;

/** Deletes one quote-side line item. Used only while the quote is a DRAFT. */
export async function deleteQuoteLineItem(lineItemId: string): Promise<void>;

/** POST the draft quote. Returns its id and hs_slug (the slug exists at create,
 *  E2E-PLAN.md:473 — the LINK does not). */
export async function createDraftQuote(props: Record<string, string | boolean>):
  Promise<{ quoteId: string; slug: string | null }>;

/** PATCH a DRAFT quote's properties. Refuses nothing itself — the caller enforces
 *  "draft only"; a published quote 400s LOCKED (E2E-PLAN.md:490). */
export async function updateDraftQuote(
  quoteId: string, props: Record<string, string | boolean>
): Promise<void>;

export type QuoteAssociation = {
  toObjectType: "deals" | "contacts" | "line_items";
  toObjectId: string;
  associationTypeId: number;        // 64 | 69 | 702 | 67 — see §3.2
};
export async function associateQuote(quoteId: string, assocs: QuoteAssociation[]): Promise<void>;

export type PublishedQuote = {
  quoteId: string;
  status: string;                   // hs_status as HubSpot returns it
  quoteLink: string | null;         // may be null on the first read; see below
  paymentStatus: string | null;     // hs_payment_status
};
/** THE ONE-WAY DOOR. Sets hs_sender_email + hs_status: APPROVAL_NOT_NEEDED, then
 *  re-reads hs_quote_link once, waits ~3s, and re-reads a SECOND time if still
 *  empty (E2E-PLAN.md:474-475). No poll loop, and deliberately NOT wrapped in
 *  fetchWithRetry: a retried publish is a second irreversible act.
 *  A 400 LOCKED here means the quote is ALREADY published — the caller must
 *  treat that as success and fall through to a read (see §6, idempotency). */
export async function publishQuote(quoteId: string, senderEmail: string): Promise<PublishedQuote>;

export type QuoteSnapshot = {
  quoteId: string;
  status: string | null;            // hs_status
  quoteLink: string | null;         // hs_quote_link
  paymentStatus: string | null;     // hs_payment_status
  paymentDate: string | null;       // hs_payment_date
};
export async function getQuoteSnapshot(quoteId: string): Promise<QuoteSnapshot | null>;

export type SubscriptionSnapshot = {
  subscriptionId: string;
  status: string | null;            // hs_status: scheduled | active | …
  mrr: number | null;               // hs_mrr — HubSpot's own weekly × 52/12 figure
  collectionProcess: string | null; // hs_collection_process
  paymentMethod: string | null;     // hs_payment_method, e.g. "ACH - 1117"
};
/** The subscription HubSpot created from this quote's checkout, or null if there
 *  isn't one yet. HOW the linkage is queried is OPEN — see O-4. */
export async function findSubscriptionForDeal(dealId: string): Promise<SubscriptionSnapshot | null>;

/** Nightly reconciliation reads. Search-API filtered on hs_lastmodifieddate so the
 *  cron pulls only what changed instead of one GET per application
 *  (E2E-PLAN.md:531-534). Paginate like listProducts (hubspot.ts:366-387). */
export async function listQuotesModifiedSince(sinceIso: string): Promise<QuoteSnapshot[]>;
export async function listSubscriptionsModifiedSince(
  sinceIso: string
): Promise<Array<SubscriptionSnapshot & { dealIds: string[] }>>;
```

**Deleted:** `pullFromHubSpot` (`src/lib/adapters/hubspot.ts:559-571`). Three independent reasons,
any one sufficient. It has zero call sites. It requests `current_processor` and
`current_monthly_fees` (`hubspot.ts:561`), two of the five property names confirmed **not to exist**
on the portal's DEAL object (§5.2), so it would 400 if it were ever called. And it maps `dealname`
onto `business.legalName` / `business.dba` (`hubspot.ts:568-570`) while a portal workflow renames
deals to `{company} / Deal-{n}` on its own schedule (`E2E-PLAN.md:499-500`), so a successful call
would overwrite the merchant's legal name with a workflow-generated string. The read-back Phase E
needs is `getQuoteSnapshot` / `findSubscriptionForDeal`, a different shape entirely. Delete it.

**Kept and repaired:** `pushToHubSpot` (`src/lib/adapters/hubspot.ts:40-72`). It is **live**, with
two call sites — `src/lib/actions/customer.ts:138` and `:177`, imported at `:20` — both wrapped in
fire-and-log `try/catch`. Phase E **reuses** it for deal creation rather than opening a competing
deal path. But it does not currently work at all: see §5.2, which is a prerequisite, not a cleanup.

---

## 5. State machine and persistence

### 5.1 Where the deal id lives — decide this before writing any code

There are two homes for a HubSpot deal id, and only one of them is real:

| | `hubspotDealId` | `hubspotIds.dealId` |
| --- | --- | --- |
| Storage | flat column `hubspot_deal_id` (`src/lib/db/schema.ts:56`) | inside the `hubspot_ids` JSONB (`schema.ts:69`) |
| Type | `src/types/merchant.ts:276` | `src/types/merchant.ts:164` |
| Written today | **Yes** — `src/lib/actions/customer.ts:139`, `:178` | **Never.** Written `null` at `src/app/rep/proposals/new/page.tsx:38,43` and `src/lib/actions/prospects.ts:231,236`, nowhere else |
| Read today | `src/lib/adapters/hubspot.ts:52`, `src/app/admin/users/page.tsx:374`, `src/components/dashboard/AccountsDashboard.tsx:494,507`, `src/lib/actions/applications.ts:136`, `src/lib/storage/postgresAdapter.ts:19,50` | nothing |
| Customer-writable | **Yes** — `src/lib/storage/storageInterface.ts:16` | No |

**Decision: `hubspotDealId` is canonical. `dealId` is REMOVED from the `HubspotIds` type.**

Rationale: the flat column is the one that is actually populated, read by five call sites, on the
customer-writable whitelist, and already carries `pushToHubSpot`'s create-or-update logic. Adopting
the JSONB field instead would require a data backfill, a whitelist change, three UI edits, and would
— until the backfill ran — cause Phase E to create a **second** deal for every application that
already has one.

**No SQL migration is required.** `hubspot_ids` is JSONB and Postgres does not enforce its shape;
every write of that column in the tree writes literal `null` (grep above), so no row can hold a
`dealId` to strand. Removing the field is a pure TypeScript change. If a future reviewer wants
`hubspotIds.dealId` back, that becomes a migration and a blocking prerequisite — it is not one today.

The three admin UI read sites (`admin/users/page.tsx:374`,
`AccountsDashboard.tsx:494`, `:507`) are unchanged. They should gain sibling rows for
`hubspotIds.quoteId` / `paymentStatus` / `subscriptionId` — additive, §11 step 7.

### 5.2 `pushToHubSpot` has never worked — repair it first

> **Verified against the live HubSpot portal, read-only, 2026-08-19.** Of the nine properties
> `pushToHubSpot` sends (`src/lib/adapters/hubspot.ts:41-50`), **five do not exist on the DEAL
> object**: `current_processor`, `current_monthly_fees`, `projected_annual_savings`,
> `proposed_effective_rate`, `mcc_code`. Confirmed twice — the full valid-property list for DEAL
> contains none of them, and a targeted property search returned only unrelated fuzzy matches
> (`projected_golive_date`, `migrated_00nfi00000adci8uan` "POS System(s) Currently Using?"). Only
> `dealname`, `dealstage` and `amount` are real.
>
> HubSpot v3 rejects the **entire** request with 400 `PROPERTY_DOESNT_EXIST` when any property name
> is unknown. So `hubspot.ts:59` and `:69` throw on every call, and the fire-and-log `try/catch` at
> `src/lib/actions/customer.ts:137-142` and `:176-181` swallows it to `console.error`. **The deal
> sync has never landed a deal in the portal.** `hubspotDealId` is presumably null on every row,
> which is also why the admin UI's "HubSpot Deal ID" reads "Not synced" everywhere
> (`src/app/admin/users/page.tsx:374`, `src/components/dashboard/AccountsDashboard.tsx:494,507`).

This is not a cleanup item. **Phase E's very first network step is deal creation, and that step is
currently a guaranteed 400.** Steps 1–4 below are prerequisites for anything else in this spec.

**1. The five phantom properties.** Two remediations:

- **(a) Create the five custom properties in HubSpot.** A portal configuration task for a human, not
  code. It is what `E2E-PLAN.md:435-440` assumes when it says the quoted rate "goes onto deal
  properties — which is what the existing `pushToHubSpot` stub already writes."
- **(b) Drop them from the payload.** Send only `dealname`, `dealstage`, `amount`.

Reasoning it through rather than defaulting: what would (b) actually lose? Not the Phase G
quoted-vs-actual comparison — the quoted side of that lives in EasyOB, frozen on the application
(`quoteConfig`, `analysis`, `targetMargin`, `quoteLines`), and `E2E-PLAN.md:519-528` is explicit that
those are the record of what was quoted. Not the quote document either — the commercial detail the
customer signs is the line items, and the processing rate deliberately is not a line item because
processing margin comes out of Adyen settlement (`E2E-PLAN.md:286-292`). What (b) loses is **rep and
admin visibility of the rate story inside the CRM**: someone looking at the deal in HubSpot sees a
name, a stage and an amount, and has to come back to EasyOB for everything else. That is a real but
soft loss, and it does not block a single Phase E mechanism.

**Recommendation: build (b), make (a) light up for free.** Make `pushToHubSpot` self-healing rather
than hardcoding either answer: fetch the DEAL property definitions once
(`GET /crm/v3/properties/deals`) behind a module-level TTL cache — the exact pattern
`src/lib/actions/catalog.ts:13-30` already uses for the product catalog, including the in-flight
collapse — and filter the outgoing property bag against it, `console.warn`ing which names were
dropped. Today that filters all five and the deal lands with three properties. The day someone
creates them in the portal, they start being written with **no code change and no deploy**. This
also permanently removes the failure mode where one typo'd property name kills the whole deal write,
which is what happened here.

Keep `dealname`, `dealstage` and `amount` outside the filter — if one of those is rejected,
something is genuinely wrong and it should throw.

**2. `STAGE_MAP` regresses live deals.** `STAGE_MAP` (`src/lib/adapters/hubspot.ts:8-20`) is missing
   four of the fifteen `DealStage` values (`src/types/merchant.ts:3-18`, ranked in
   `src/lib/stages.ts:16-42`): `prospect_created`, `lead_link_sent`, `lead_analysis_pending`, and —
   critically — **`merchant_filling`**. The fallback is `"appointmentscheduled"`
   (`hubspot.ts:43`), the *first* stage. `saveMyApplicationOnboardingAction` sets
   `stage: "merchant_filling"` at `customer.ts:112` and then calls `pushToHubSpot` at `:138`; if the
   Adyen chain in between failed (`:133-135`, which it does whenever Adyen creds are absent), the
   deal is pushed **backwards** to the pipeline's first stage. Fix: make `STAGE_MAP` a
   `satisfies Record<DealStage, string>` so a missing stage is a compile error, the same technique
   `STAGE_RANK` already uses (`src/lib/stages.ts:42`). Requires **O-5** (the real pipeline).

**3. `amount` has two writers.** `pushToHubSpot` writes `amount` = annualized card volume
(`hubspot.ts:44`), and publishing a quote makes HubSpot itself roll the line-item total into `amount`
and `hs_mrr` (`E2E-PLAN.md:495-497`). Fix: stop writing `amount` from EasyOB once
`hubspotIds.quoteId` exists. (Default; see **O-6**.)

**4. The deal is created with no associations at all.** `hubspot.ts:64-70` POSTs a properties bag and
nothing else — no company, no contact. Three consequences:

- A HubSpot deal with no associated company is an orphan in the CRM. Nobody working the Company
  record sees it, which defeats the "rep visibility comes free because it lives on the deal in the
  CRM" argument that justifies the whole one-quote-two-audiences design (`E2E-PLAN.md:420-428`).
- Phase F already resolves the company id and stores it on the application from day one:
  `tenantLink.hubspotCompanyId` (`src/types/merchant.ts:325`), stamped at prospect creation
  (`src/lib/actions/prospects.ts:232`, resolved at `:180-197`). So the id is usually already in hand
  at deal-creation time and costs nothing to use. When `tenantLink` is null — a prospect created
  without the HubSpot deep link — create the deal unassociated and let the existing manual
  tenant-link flow attach it later; do **not** block deal creation on it, mirroring how
  `createProspectAction` degrades with a warning rather than failing (`prospects.ts:191-197`).
- The contact association is a separate matter. The **quote** requires contact associations 69 and
  702 (§3.2); the **deal** does not require one to publish a quote. Associate the contact to the deal
  anyway once `ensureQuoteContact` has resolved it — a deal with a quote whose signer isn't on the
  deal is confusing in the CRM — but treat it as best-effort, not a precondition.

Specification: after `pushToHubSpot` returns a deal id, associate deal → company (when
`tenantLink.hubspotCompanyId` exists) and deal → contact (after step 1 of §5.4), via the same v4
association surface as §3.2. **The association type ids for deal → company and deal → contact were
NOT established by the spike** — it only exercised the quote's associations. Confirm them with a
read-only call before writing them (**O-17**); do not carry HubSpot's commonly-quoted defaults into
code on the strength of memory.

### 5.3 The revised `HubspotIds`

Replaces `src/types/merchant.ts:163-170`. The shipped shape cannot express what Phase E needs: it
has one `status` field, documented as "cached subscription hs_status snapshot", but the design
requires **two** independent statuses — the quote's `hs_payment_status` and the subscription's
`hs_status` (`E2E-PLAN.md:478-483`).

```ts
export type HubspotIds = {
  // dealId intentionally absent — the canonical home is the flat hubspotDealId
  // column (schema.ts:56). See PHASE-E-SPEC §5.1.
  quoteId: string | null;
  /** Quote-side line items, in quoteLines order. Lets a DRAFT re-save reconcile
   *  instead of duplicating. HubSpot clones its own deal-side copies at publish
   *  (E2E-PLAN.md:497) — those ids are NOT these and are never tracked here. */
  lineItemIds: string[] | null;
  /** The Contact associated (69) and taken as signer (702). */
  contactId: string | null;
  /** hs_quote_link. Populated at publish, ~3s later (E2E-PLAN.md:474). NOT a
   *  one-time-use link — see §7.3 for why the Adyen/Check mint-per-click rule
   *  does not apply. Re-readable, never authoritative here. */
  quoteLink: string | null;
  /** ISO timestamp of the successful publish. THE one-way-door marker: null means
   *  the quote is still a DRAFT and still editable from EasyOB. */
  publishedAt: string | null;
  /** hs_payment_status: PENDING | PROCESSING | PAID | PAYMENT_NOT_ENABLED. */
  paymentStatus: string | null;
  paymentDate: string | null;
  subscriptionId: string | null;
  /** Subscription hs_status: scheduled → authorized, awaiting first cycle;
   *  active → billing (E2E-PLAN.md:479-480). */
  subscriptionStatus: string | null;
  /** When the three snapshot fields above were last refreshed. Mirrors
   *  checkIds.onboardStatusAt (types/merchant.ts:266) — list views read this
   *  cache and never call HubSpot. */
  syncedAt: string | null;
  /** Last swallowed background-sync failure, persisted so it is VISIBLE.
   *  The deal sync has been failing silently since it was written (§5.2) purely
   *  because a console.error is the only record. Cleared on the next success. */
  lastSyncError: string | null;
  lastSyncErrorAt: string | null;
};
```

`src/lib/storage/postgresAdapter.ts:24,55` pass `hubspotIds` straight through and need no change.
`src/lib/storage/storageInterface.ts:16` **does** need `"hubspotIds"` added to
`CustomerApplicationPatch` — the on-view refresh (§8.2) runs as the customer and writes through
`updateApplicationAsCustomer`, exactly as the Check refresh does for `checkIds`
(`src/lib/actions/customer.ts:236-...`).

### 5.4 The lifecycle

| # | Trigger | Actor | Writes |
| --- | --- | --- | --- |
| 1 | Rep clicks **Save quote to HubSpot** on the rep quote surface | rep/admin | `hubspotDealId` (via the repaired `pushToHubSpot`, §5.2, plus its deal→company association), then `hubspotIds.contactId`, `.lineItemIds`, `.quoteId` |
| 2 | Rep re-saves after editing lines | rep/admin | reconciles `lineItemIds`; PATCHes the draft quote |
| 3 | Rep clicks **Publish** and clears the gate (§6) | rep/admin | `hubspotIds.publishedAt`, `.quoteLink`, `.paymentStatus` |
| 4 | Customer opens the checklist and clicks **Review & Pay** | customer | nothing (redirect only; §7.3) |
| 5 | Customer views the application after checkout | customer | `hubspotIds.paymentStatus`, `.paymentDate`, `.subscriptionId`, `.subscriptionStatus`, `.syncedAt` (§8.2) |
| 6 | Nightly cron | system | same fields as 5, across all applications (§8.1) |

Steps 1–3 never touch `quoteLines` / `quoteConfig` / `orderPoints`. Steps 5–6 never touch anything
except the snapshot fields listed. That separation is what makes the Phase G quoted-vs-actual
comparison possible at all (`E2E-PLAN.md:519-528`).

**Sequencing surprise worth stating plainly:** `E2E-PLAN.md:446` describes deal creation as an
acceptance-time step, but the code already creates the deal much earlier — at the customer's
business-details save (`src/lib/actions/customer.ts:138`). So by the time a quote is published, a
deal normally exists. `E2E-PLAN.md:444` ("only create a deal when the application has no
`hubspotDealId`") is already the behaviour of `pushToHubSpot` (`hubspot.ts:52-60`). Phase E calls
`pushToHubSpot` and takes whatever id comes back; it never branches on create-vs-update itself.

### 5.5 Partial failure mid-graph

The Adyen adapter builds its whole five-object graph and persists once at the end
(`src/lib/adapters/adyen.ts:114-183`, persisted at `src/lib/actions/customer.ts:118`), so a failure
at step 4 orphans steps 1–3. **Phase E must not copy that.** A duplicated Adyen legal entity is
recoverable; a duplicated *published quote* is not (§6).

Rule: **persist after every step that yields an id, in its own DB write, before attempting the next
step.**

| Step fails | State on disk | Retry behaviour |
| --- | --- | --- |
| `pushToHubSpot` | `hubspotDealId` null | Retry creates the deal. Safe. |
| `ensureQuoteContact` | dealId set, contactId null | Retry searches by email first, so no duplicate contact. |
| `createQuoteLineItems` (partial) | `lineItemIds` holds only what was created | Retry: delete the stragglers via `deleteQuoteLineItem`, recreate the full set. Orphan line items with no quote association are invisible in the CRM but should still be cleaned. |
| `createDraftQuote` | line items exist, `quoteId` null | Retry reuses `lineItemIds` and creates the quote. |
| `associateQuote` (partial) | `quoteId` set, associations incomplete | Retry re-PUTs all associations — v4 association PUT is idempotent. Publish would have failed anyway; the missing association is exactly what the publish gate checks (§6). |
| `publishQuote` after HubSpot accepted it but before the DB write landed | `publishedAt` null but the quote **is** published | Retry's PATCH 400s `LOCKED` → treated as "already published", falls through to `getQuoteSnapshot`, writes `publishedAt` from `hs_status`. **This is why the LOCKED-means-success rule in `publishQuote` exists.** |

### 5.6 Idempotency — what stops a double-click creating two quotes

The established in-repo precedent is `pushToHubSpot`'s create-or-update check
(`src/lib/adapters/hubspot.ts:52-60`): if the id is already on the application, PATCH it and return
it; only POST when the id is absent. Follow that, with one addition where it is not sufficient.

- **Deal:** covered as-is by `hubspot.ts:52-60`.
- **Contact / line items / quote:** same pattern — `if (app.hubspotIds?.quoteId) → PATCH` else POST.
  Sequential clicks are safe.
- **Two *concurrent* creates** are not covered by a read-then-write check: both requests read
  `quoteId: null` and both POST. Guard the create with a conditional claim as the lock, in the same
  Drizzle direct-`db.update` style the accept route already uses
  (`src/app/api/lead/[token]/accept/route.ts:45-51`):

  ```ts
  const [claimed] = await db.update(merchantApplications)
    .set({ hubspotIds: { ...EMPTY_HUBSPOT_IDS, syncedAt: now }, updatedAt: new Date() })
    .where(and(eq(merchantApplications.id, id), isNull(merchantApplications.hubspotIds)))
    .returning();
  if (!claimed) throw new Error("A quote is already being built for this application");
  ```

- **Two concurrent publishes** need no extra lock: the second PATCH hits HubSpot's own 400 `LOCKED`
  (`E2E-PLAN.md:490`), which `publishQuote` treats as already-published. A double-click therefore
  yields one publish and one no-op, never two published quotes. The irreplaceable guard is on
  *create*, not on publish.

### 5.7 Failure visibility — do not copy the fire-and-log convention

The existing HubSpot call sites swallow every failure to `console.error`
(`src/lib/actions/customer.ts:140-142`, `:179-181`). That convention was defensible when it was
written — a customer saving their own business details should not see a 500 because a partner
integration is unconfigured — but §5.2 is what it costs: a total, permanent integration failure
produced no signal anywhere for the entire life of the feature. Phase E must not inherit that
property, and the rule is not uniform across paths. It depends on **who is waiting**.

| Path | Who is waiting | Rule |
| --- | --- | --- |
| `buildBillingQuoteAction` (rep clicks "Save quote to HubSpot") | a rep, synchronously | **Throw / return a structured error.** Render it in the panel with the failing step named ("line items created, quote creation failed"). Never a bare "something went wrong" — `hubspotErr` (`hubspot.ts:120-123`) already carries the status and HubSpot's body, including `requiredGranularScopes` on a 403 |
| `publishBillingQuoteAction` (rep clicks "Publish") | a rep, synchronously, on a one-way door | **Throw, loudly, and never wrap in a catch that can return success.** The one exception is 400 `LOCKED`, which means already-published and is handled as success by re-reading (§5.5). A publish whose true outcome is unknown must be reported as unknown, with a "re-check status" action, never as failure — HubSpot may have published it |
| `/customer/applications/[id]/billing` route (customer clicks "Review & Pay") | a customer, synchronously | Redirect back with `?error=quote_link` and render a neutral banner — the precedent at `src/app/customer/applications/[id]/payroll/continue/route.ts:30-33`. The customer must never see a raw HubSpot error. **Also** persist `lastSyncError` so the rep and admin can see the account is stuck |
| On-view refresh (§8.2) | nobody | Swallow — a HubSpot outage must not break the application page — **but persist `lastSyncError`/`lastSyncErrorAt`** rather than only logging |
| Nightly cron (§8.1) | nobody | Already reports: non-2xx status when anything failed, matching `src/app/api/cron/adyen-actuals/route.ts:67`. Per-application failures go into `lastSyncError` too |
| `pushToHubSpot` from the customer's own save (`customer.ts:138`, `:177`) | a customer, saving unrelated data | Keep it non-blocking — that judgement was right — but **persist the failure**. This is the change that would have surfaced §5.2 on day one |

Surface `lastSyncError` in the two admin/rep views that already show HubSpot state
(`src/app/admin/users/page.tsx:374`, `src/components/dashboard/AccountsDashboard.tsx:494,507`) as a
warning row beside the ids, and count "applications with a HubSpot sync error" on the admin
dashboard. A background integration with no visible failure state is how this got here.

---

## 6. The irreversibility gate

Spiked and settled (`E2E-PLAN.md:489-493`): a published quote **cannot be edited** (400 `LOCKED`),
**cannot be deleted** (400 `PUBLISHED_QUOTE_CANNOT_BE_DELETED`), and **cannot be voided via the
API** — setting `hs_status: VOID` is itself an edit and hits the same `LOCKED`. Voiding is
HubSpot-UI-only.

### 6.1 Server-side preconditions — all must hold, checked in the publish action, not the client

1. **Authorization.** `getEffectiveRole()` (`src/lib/auth/getEffectiveRole.ts`) resolves to `admin`,
   or to `rep` with `app.ownerUserId === userId`. A customer must never reach this action.
2. **Not already published.** `app.hubspotIds?.publishedAt` is null.
3. **A quote exists.** `app.hubspotIds?.quoteId` is set.
4. **A deal exists.** `app.hubspotDealId` is set — association 64 is required to publish
   (`E2E-PLAN.md:546-548`).
5. **A contact exists with an email.** `app.hubspotIds?.contactId` set — associations 69 **and** 702
   are both required once `hs_acceptance_method: esignature` is forced (`E2E-PLAN.md:467-469`).
6. **`hs_sender_email` is resolvable** — publish 400s without it (`E2E-PLAN.md:463-465`). Blocked on
   **O-1**.
7. **Lines are non-empty and complete.** `app.quoteLines?.length > 0`, and every line has a
   non-empty `hubspotProductId` and a `billingFrequency` with a confirmed
   `hs_recurring_billing_period` (§3.3).
8. **The platform tier resolved.** Re-run `resolvePlatformTier(app.orderPoints.total, catalog,
   app.quoteLines)` (`src/lib/quoting.ts:317-331`) and refuse on `status: "unresolved"` — that state
   means the largest recurring charge on the quote is missing, and the function's own docstring
   already says it "must block the save" (`quoting.ts:314-315`).
9. **No unreviewed order points.** `deriveOrderPoints(...).needsReview` (`src/lib/quoting.ts:232`)
   is empty, or the rep has explicitly acknowledged each entry. A tablet counted wrong is a $433/mo
   error on an unamendable document (`src/lib/quoting.ts:137-139`).
10. **What the rep saw is what publishes.** The client submits the `quoteTotals` it rendered
    (`src/lib/quoting.ts:97`) plus the line count. The server recomputes from `app.quoteLines` and
    refuses on any mismatch. This closes the window where the catalog or another session changed the
    lines between render and click.
11. **Stage sanity.** `app.stage !== "closed_lost"`.

Failures return a structured `{ ok: false, reason }` the modal renders as a checklist, not a bare
error string — the rep needs to know *which* precondition to fix.

### 6.2 Confirmation UX

Two steps, on the rep quote surface, behind a destructive-styled button.

**Step 1 — the document.** Render the quote exactly as the customer will receive it: every line with
its per-cycle amount and `fmtFrequency` label (`src/lib/utils.ts:51`), the one-time total, the
recurring totals **grouped by cycle**, and the monthly-equivalent as a separate labelled figure —
never one summed number (`src/types/merchant.ts:128-136`). The derived platform tier is shown with
the order-point count that selected it and the tier boundary. A `$99/week (~$428.67/mo)` line must
read as both.

**Step 2 — the door.** Plain text, no euphemism:

> Publishing sends this quote to HubSpot for the customer to sign and pay. **It cannot be undone
> from EasyOB.** A published quote cannot be edited, deleted, or voided through the API — voiding is
> only possible by hand in HubSpot. Check the lines above before continuing.

Require an explicit typed confirmation of the merchant's DBA (not a bare checkbox) to arm the
button. Disable the button while the request is in flight.

**After publish**, the rep surface renders the quote read-only, links out to the HubSpot quote
record, shows `quoteLink`, and offers **no** edit, unpublish, void, or "rebuild quote" affordance
(`E2E-PLAN.md:493`). A rep who needs to change a published quote is told to do it in HubSpot.

---

## 7. The customer Billing module

### 7.1 Slotting into `getOnboardingModules`

`src/lib/onboardingModules.ts:14-16` returns `[adyenModule(app), payrollModule(app)]`. Billing
becomes the third:

```ts
export function getOnboardingModules(app: MerchantApplication): OnboardingModule[] {
  return [billingModule(app), adyenModule(app), payrollModule(app)];
}
```

Billing goes **first**: it is the money step, it is the direct continuation of the acceptance the
customer just performed, and unlike Adyen it needs nothing from the business-details form. *This
ordering is a stated default, not a derived requirement — reorder freely if product disagrees.*

`billingModule` is a **pure function of the cached snapshot**. It must never call HubSpot. Both
`src/app/customer/page.tsx:28` and `src/components/dashboard/AccountsDashboard.tsx:603` call
`getOnboardingModules` inside a loop over many applications; a network call there fans out one
HubSpot request per row. This is exactly the constraint `payrollModule` documents at
`src/lib/onboardingModules.ts:65-68`.

### 7.2 Status matrix

| Condition | `status` | `href` / CTA | Description |
| --- | --- | --- | --- |
| `hubspotIds` null, or `quoteId` null | `not_started` | none | "Your quote is being prepared. We'll email you when it's ready." |
| `quoteId` set, `publishedAt` null | `not_started` | none | Same copy. **A draft quote's link is never surfaced** (see O-10). |
| `publishedAt` set, `paymentStatus` ∈ {null, `PENDING`} | `in_progress` | `/customer/applications/{id}/billing` — "Review & Pay" | "Review your quote and set up billing." |
| `paymentStatus` = `PROCESSING` | `in_progress` | none | "Your payment is being processed." |
| `paymentStatus` = `PAID`, `subscriptionStatus` null | `complete` | none | "Billing is set up." |
| `subscriptionStatus` = `scheduled` | `complete` | none | "Billing is set up — your first charge is scheduled." |
| `subscriptionStatus` = `active` | `complete` | none | "Billing is active." |
| `paymentStatus` = `PAYMENT_NOT_ENABLED` | `in_progress` | none | "We're finishing setting up your billing — no action needed." **Also `console.error`**: this state means a quote was published without payments enabled, which is a build defect, not a customer state. |

`coming_soon` is unused by this module. Note that `src/app/customer/page.tsx:28` filters
`coming_soon` out of the dashboard entirely, so a `coming_soon` module only ever appears on the
application detail page — relevant to Foodbuy (**O-13**), not to billing.

### 7.3 Does the mint-fresh-link-per-click rule apply to `hs_quote_link`? **No.**

Adyen and Check links are minted per click because they are one-time-use bearer artifacts with short
fuses — Adyen ~4 minutes and single-use (`src/lib/adapters/adyen.ts:174`, `:186-190`), Check 24h and
single-use (`src/lib/adapters/check.ts:2-4`, `:119-122`). Re-serving one sends the merchant to an
error page.

`hs_quote_link` is a different kind of artifact, and the spike data says so directly:

- It is `https://{hs_domain}/{hs_slug}`, and **the slug exists at create — the URL is predictable**
  (`E2E-PLAN.md:473`). A one-time credential cannot be predictable.
- Buyer authentication on it is `hs_quote_auth_method: public_access`, the portal default, which
  "already matches how AIO shares quotes today" (`E2E-PLAN.md:502-504`). A public, shareable URL is
  by definition re-servable.
- The plan itself says to "treat `hs_quote_link` as **re-readable** rather than permanently
  stored-and-reserved — re-fetch it if a stored one stops working" (`E2E-PLAN.md:486-487`). That is
  a staleness rule, not a single-use rule.

**Implementation:** `/customer/applications/[id]/billing` is still a route handler in the same shape
as the Adyen and Check `/continue` routes
(`src/app/customer/applications/[id]/payroll/continue/route.ts`) — session-gated, loads via
`getApplicationForCustomer`, redirects — but its body is *read-or-refresh*, not *mint*:

1. Refuse if `publishedAt` is null (redirect back to the application with `?error=quote_not_ready`).
2. If `hubspotIds.quoteLink` is set, redirect to it.
3. If it is null, call `getQuoteSnapshot(quoteId)`, persist `quoteLink`, redirect. This covers the
   case where publish's read-after-write came back empty.

**What the spike did not establish, and this design does not assume:** whether the link stops
resolving at `hs_expiration_date`, and whether HubSpot ever rotates a slug. Both are listed as
**O-8**. Neither blocks: the nightly sync (§8.1) re-reads `hs_quote_link` on every changed quote, so
a rotated slug self-heals within a day, and step 3 above self-heals immediately on a null.

---

## 8. Read-back and sync

Nothing pushes to EasyOB. Both mechanisms below are pulls, both write only the snapshot fields in
§5.3, and both are one-way HubSpot → EasyOB (`E2E-PLAN.md:508-517`).

### 8.1 Nightly cron — `/api/cron/hubspot-billing-sync`

A sibling of `/api/cron/hubspot-links/route.ts`, not a second step bolted onto it — the same
process-isolation argument that route already documents at lines 5-11 applies.

- **Auth:** identical `CRON_SECRET` bearer check to
  `src/app/api/cron/hubspot-links/route.ts:13-20`. No new env var; `CRON_SECRET` already exists.
- **Registration:** third entry in `vercel.json` `crons`, `"schedule": "0 8 * * *"` (an hour before
  the two existing 9am jobs, so it can't contend with them).
- **`export const maxDuration = 300;`** — same reason as
  `src/app/api/cron/adyen-actuals/route.ts:19`.
- **What it reads:** `listQuotesModifiedSince()` and `listSubscriptionsModifiedSince()` — the
  **search API filtered on `hs_lastmodifieddate`**, paginated like `listProducts`
  (`src/lib/adapters/hubspot.ts:366-387`). One request per page of *changed records*, not one per
  account. 91 subscriptions today and growing (`E2E-PLAN.md:531-534`).
- **The window is stateless.** `since = now - 3 days`, a module constant, following the
  `expectedReportFilenames()` / `LOOKBACK_DAYS` philosophy already in
  `src/lib/adyen/reportWindow.ts`. No cursor table, therefore no migration, and a missed night
  self-heals on the next run. (`app_settings` is a typed two-column table —
  `src/lib/db/schema.ts:39-44` — so parking a cursor in it would cost a schema change for no
  benefit.)
- **Join back:** match `QuoteSnapshot.quoteId` against `hubspot_ids->>'quoteId'`, and each
  subscription against `hubspotDealId` via its associated deal ids. Update only changed rows.
- **Response:** a summary object (`{ quotesChecked, applicationsUpdated, subscriptionsMatched,
  unmatched, failed }`), 500 when `failed.length > 0`, matching
  `src/app/api/cron/adyen-actuals/route.ts:59-67`.

### 8.2 On-view refresh — the checkout moment

Nightly alone leaves the checklist reading "pending" until the next morning right after the customer
pays, which generates support calls (`E2E-PLAN.md:536-541`). Cover it exactly the way Check is
covered.

Add `getMyApplicationWithBillingSyncAction(id)` to `src/lib/actions/customer.ts`, a direct mirror of
`getMyApplicationWithPayrollSyncAction` (same file, from line 236), preserving all four of its
properties:

1. **Takes an id and re-loads server-side** via `getApplicationForCustomer(userId, id)` — never
   accepts a caller-supplied application object, because a Server Action would then let a client
   forge the id it queries (that reasoning is in the comment at `customer.ts:232-235`).
2. **No-ops when terminal** — returns immediately unless `publishedAt` is set and
   (`paymentStatus !== "PAID"` or `subscriptionId` is null).
3. **Swallows failures** — a HubSpot outage must not break the application page.
4. **Writes through `updateApplicationAsCustomer`**, which requires `"hubspotIds"` on the whitelist
   at `src/lib/storage/storageInterface.ts:16`.

One addition beyond the Check precedent: **a 60-second TTL** — skip the refresh when
`hubspotIds.syncedAt` is within 60s. Check's version has no TTL and re-reads on every page view;
that is tolerable at one API call but this action makes up to two (quote, then subscription), and a
customer refreshing the page while waiting for a payment to clear is the expected behaviour here.

`src/app/customer/applications/[id]/page.tsx:12` currently calls the payroll variant. Combine them
into one `getMyApplicationWithSyncAction(id)` that runs both refreshes independently, each in its own
`try/catch`, so a HubSpot failure cannot suppress the Check refresh or vice versa.

### 8.3 The caching rule, restated

`billingModule()` reads `hubspotIds` and nothing else. The only two places that call HubSpot for
billing state are the cron (§8.1) and the single-record on-view action (§8.2). Any list, dashboard,
or `getOnboardingModules` caller reads the cache. This is the `checkIds.onboardStatus` rule
(`src/types/merchant.ts:262-266`, `src/lib/onboardingModules.ts:65-68`) applied unchanged.

---

## 9. Test plan

### 9.1 Pure logic — vitest, `src/lib/__tests__/`, no network

Follow the existing style (`src/lib/__tests__/quoting.test.ts`,
`src/lib/__tests__/hubspotEasyobLink.test.ts` — which is the precedent for testing a pure planner
extracted out of a HubSpot call, cf. `planEasyobLinkUpdates` at `src/lib/adapters/hubspot.ts:407`).

| Under test | Cases |
| --- | --- |
| `toLineItemProperties` | table-driven over every `BillingFrequency`: `weekly` → `P7D`; `monthly` → its confirmed period; `one_time` → no `recurringbillingfrequency`, no period; every unconfirmed frequency → throws |
| `draftQuoteProperties` | every property in §3.4 present with the exact literal value; `hs_esign_enabled` **absent**; `hs_sender_email` **absent** |
| the publish PATCH builder | contains `hs_sender_email` + `hs_status: APPROVAL_NOT_NEEDED` and nothing else |
| `canPublish(app, catalog, clientTotals)` | one case per precondition in §6.1, each asserting its own `reason` |
| line-item reconciliation planner | added / removed / qty-changed / unchanged lines against existing `lineItemIds` |
| `billingModule(app)` | every row of the §7.2 matrix. There is **no** `onboardingModules` test file today — add one; it also locks in that the module never touches the network |
| snapshot mappers | `hs_payment_status` and subscription `hs_status` → module status, incl. unknown values |
| `STAGE_MAP` | `satisfies Record<DealStage, string>` makes this a compile-time check rather than a test; add a runtime assertion that every `STAGE_ORDER` entry (`src/lib/stages.ts:44`) has a mapping |

### 9.2 Needs a live portal call

**There is no HubSpot sandbox for this portal.** The spike ran against live (`E2E-PLAN.md:63-67`),
and publish is irreversible. Everything below is therefore a **human-run, one-shot** procedure, not
something CI or an agent repeats.

Follow the probing convention in `E2E-PLAN.md:73-83`: a throwaway `scripts/_tmp-*.ts` loading config
via `loadEnvConfig` from `@next/env` (never a `grep` of `.env.local`), deleted afterwards.

| Check | Read/write | Note |
| --- | --- | --- |
| AIO's real pipeline + stage internal ids (**O-5**) | read-only | `GET /crm/v3/pipelines/deals` |
| Deal → company and deal → contact association type ids (**O-17**) | read-only | `GET /crm/v4/associations/deals/{companies,contacts}/labels` |
| The allowed-payment-methods property name/values (**O-3**) | read-only | `GET /crm/v3/properties/quotes` |
| The DEAL property list, for the §5.2 filter | read-only | `GET /crm/v3/properties/deals`. Already run 2026-08-19: five of the nine written properties do not exist. Re-run only to confirm a remediation |
| A deal actually landing in the portal after the §5.2 repair | write (recoverable) | Deals can be deleted; this is safe to repeat, unlike the publish below |
| How a paid quote links to its subscription (**O-4**) | read-only | inspect an existing paid AIO subscription's associations |
| Full create → associate → publish → read `hs_quote_link` | **irreversible write** | one designated throwaway deal, clearly named, run once by a human |
| Checkout to `PAID` and subscription creation | needs a real ACH authorization | cannot be exercised without a real bank auth. Verify the read-back path against an **existing** paid subscription instead of manufacturing one |

The nightly cron can be exercised safely without any of the above: it is read-only, and calling it
locally with the `CRON_SECRET` header against live returns whatever changed in the last three days.

---

## 10. Open questions

**BLOCKING** — implementation cannot start (or cannot be correct) without an answer.

| id | Question | Why it blocks | Where |
| --- | --- | --- | --- |
| **O-1** | Which quote template do EasyOB quotes use, and which owner/sender do they carry (`hs_sender_email`)? | `hs_sender_email` is a hard publish-time requirement — the publish 400s without it | `E2E-PLAN.md:1054`, `:463-465` |
| **O-3** | What is the exact property name and value set for restricting quote payment methods to ACH? | It goes in the create payload; the spike recorded the requirement ("ACH among the allowed methods") but not the property | `E2E-PLAN.md:459`. One read-only probe answers it |
| **O-4** | How does a paid quote link back to the subscription HubSpot creates? | Step 5 of the plan reads subscription status, and the spike stopped at `hs_payment_status: PENDING` — the quote→subscription linkage was **never exercised**. Fallback assumption (deal-associated subscriptions, newest wins) is unverified | `E2E-PLAN.md:476-483` |
| **O-5** | Which HubSpot pipeline does AIO actually use, and what are its stage internal ids? | `STAGE_MAP` (`hubspot.ts:8-20`) uses default-pipeline ids and omits four `DealStage` values, so a customer save at `merchant_filling` pushes the deal **backwards** to the first stage today (§5.2) | new finding |
| **O-14** | Sign-off that `hubspotDealId` (flat column) is canonical and `dealId` is dropped from `HubspotIds`. | Get it wrong and Phase E creates a second deal per application. Cheap to answer, but must be answered before the type is written. **No migration is required for the recommended direction** (§5.1); the opposite direction *does* require one, and migrations are user-run | new finding |
| **O-17** | The `associationTypeId` for deal → company and deal → contact. | The spike only established the **quote's** associations (67/64/69/702). Deal creation currently makes no associations at all (§5.2 item 4), and guessing an id from memory is exactly the class of error that produced the phantom-property bug | new finding. One read-only probe answers it |

**DEFAULTABLE** — proceed with the stated assumption; revisit if contradicted.

| id | Question | Default assumption |
| --- | --- | --- |
| **O-2** | Is a 1-payment `FIXED` term intended for the weekly platform line? HubSpot derives it from `hs_recurring_billing_period: P7D` (`E2E-PLAN.md:453-454`, `:1056`) | Accept it — the line publishes either way. Steve question, does not gate the build |
| **O-6** | Should EasyOB keep writing deal `amount`, given HubSpot overwrites it at publish (`E2E-PLAN.md:495-497`)? | Stop writing `amount` once `hubspotIds.quoteId` exists |
| **O-7** | Should the five phantom deal properties (`current_processor`, `current_monthly_fees`, `projected_annual_savings`, `proposed_effective_rate`, `mcc_code`) be **created in the portal**, or dropped? Their absence is a confirmed live finding, not a question (§5.2) | Ship the property-existence filter so the deal write succeeds today with three properties; creating them in HubSpot later lights them up with no code change. Whether to create them is a product call about CRM visibility, not a build blocker. **Note this contradicts `E2E-PLAN.md:435-440`**, which assumes they already exist |
| **O-8** | Does the quote link stop resolving at `hs_expiration_date`, and can a slug rotate? | 30-day expiry; store the link, re-read on null, nightly re-read heals a rotation (§7.3) |
| **O-9** | ISO period strings for the `BillingFrequency` values the spike never exercised (`biweekly`, `quarterly`, `annually`, …) | Hard-error on them. Only `one_time` / `weekly` / `monthly` appear in the live quotable catalog (`E2E-PLAN.md:193-201`) |
| **O-10** | Is a DRAFT quote's predictable public URL already reachable before publish? | Assume it may be; never surface `quoteLink` while `publishedAt` is null (§7.2) |
| **O-11** | When is the draft created — at prospect creation, at first line save, or at acceptance? Creating early means orphan HubSpot deals and quotes for dead leads | Explicit rep action ("Save quote to HubSpot"), never automatic |
| **O-12** | Who is the signer contact — the person accepting the quote, or the business owner on file? `ownerContact` (`src/types/merchant.ts:186`) is a blob, not a HubSpot contact; `getCompanyOwnerContact` (`hubspot.ts:293`) only works when a `tenantLink` exists | `ownerContact.email`, deduped by email search, created if absent. Flagged as mildly legal-shaped |
| **O-13** | Foodbuy scope (`E2E-PLAN.md:1053`, `:575-576`) — and separately, is "Schedule a demo" a checklist module at all, given it has no completion signal? | Foodbuy ships `coming_soon`; demo becomes a persistent CTA rather than a checklist item. Both out of scope for this spec |
| **O-15** | `hs_payment_type` reads back as `BYO_STRIPE` at portal level, not native HubSpot payments (`E2E-PLAN.md:168-171`) | Does not change the mechanism; carried forward because it changes who to loop in, and unresolved it leaves a small doubt over whether `hs_store_payment_method_at_checkout` yields ACH auto-debit |
| **O-16** | Should the checkout link ever appear in `CustomerSafeQuote` (`src/lib/leadQuote.ts:56`), i.e. on the pre-account `/lead/[token]` view? | No — that view is pre-acceptance and the quote is not published yet. Checklist only |

---

## 11. Work breakdown

Sizes are rough engineer-days. Steps 0–2 are prerequisites; nothing after step 3 is safe to start
until the blocking open questions above are answered.

| # | Step | Size | Depends on |
| --- | --- | --- | --- |
| 0 | Answer **O-14**; revise `HubspotIds` (`src/types/merchant.ts:163-170`) per §5.3; add `"hubspotIds"` to `CustomerApplicationPatch` (`storageInterface.ts:16`). No SQL migration. | 0.25 | O-14 |
| 1 | Read-only portal probes for **O-3**, **O-4**, **O-5**, **O-17** via one throwaway `scripts/_tmp-*.ts`. Delete it. | 0.5 | live creds |
| 2 | **Repair `pushToHubSpot` (§5.2) — the deal sync is currently a guaranteed 400 and nothing downstream can work until it isn't.** Property-existence filter with a TTL cache (pattern: `src/lib/actions/catalog.ts:13-30`); `satisfies Record<DealStage, string>` on `STAGE_MAP` with real stage ids; stop writing `amount` once a quote exists; associate deal → company from `tenantLink.hubspotCompanyId`. Delete `pullFromHubSpot` (`hubspot.ts:559-571`). Add the `STAGE_ORDER` coverage test and a unit test for the property filter. | 1 | O-5, O-17 |
| 2b | Failure visibility (§5.7): `lastSyncError`/`lastSyncErrorAt` written by every swallowing path, surfaced in `admin/users/page.tsx:374` and `AccountsDashboard.tsx:494,507`. Verify against a real deal landing in the portal. | 0.5 | 2 |
| 3 | Pure builders + their tests: `toLineItemProperties`, `draftQuoteProperties`, the publish PATCH builder, the line-item reconciliation planner. | 0.75 | O-3, O-9 |
| 4 | Network functions in `hubspot.ts` (§4): `ensureQuoteContact`, `createQuoteLineItems`, `deleteQuoteLineItem`, `createDraftQuote`, `updateDraftQuote`, `associateQuote`, `getQuoteSnapshot`, `findSubscriptionForDeal`. All on `billingHeaders()`, all through `hubspotErr` + `fetchWithRetry`. | 1.5 | 3 |
| 5 | `publishQuote` (§4) — read-after-write with one retry, LOCKED-means-already-published, **no** `fetchWithRetry`. | 0.5 | 4, O-1 |
| 6 | Server actions: `buildBillingQuoteAction` (steps 1–2 of §5.4, with the conditional-claim lock from §5.6 and persist-after-every-step from §5.5) and `publishBillingQuoteAction` (the §6.1 precondition set). Rep/admin only via `getEffectiveRole`. | 1.5 | 4, 5 |
| 7 | Rep UI: the quote surface's HubSpot panel — build/save, draft state, the two-step publish gate (§6.2), post-publish read-only view. Plus the additive `hubspotIds` rows on `admin/users/page.tsx:374` and `AccountsDashboard.tsx:494,507`. | 2 | 6 |
| 8 | `billingModule()` + its status-matrix test; insert into `getOnboardingModules` (`onboardingModules.ts:15`). | 0.5 | 0 |
| 9 | `/customer/applications/[id]/billing` route handler (§7.3, read-or-refresh). | 0.5 | 4, 8 |
| 10 | `getMyApplicationWithBillingSyncAction` + merge with the payroll variant at `customer/applications/[id]/page.tsx:12` (§8.2). | 0.75 | 4 |
| 11 | `listQuotesModifiedSince` / `listSubscriptionsModifiedSince` + `/api/cron/hubspot-billing-sync` + the `vercel.json` entry (§8.1). | 1 | 4, O-4 |
| 12 | Human-run live verification: one throwaway deal through create → publish → read `hs_quote_link`; read-back verified against an existing paid subscription (§9.2). | 0.5 | everything |

Total ≈ 12 days, of which ~2 days is unblocking probes and repairs to existing code that was
believed to work and does not.
