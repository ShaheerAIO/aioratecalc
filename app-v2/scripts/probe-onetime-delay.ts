// ANSWERED 2026-10-12 — HubSpot REFUSES a dated one-time line on a
// payment-enabled quote. Keep this script only to re-check if HubSpot changes
// the rule; don't run it expecting news.
//
//   400 NON_RECURRING_FUTURE_BILLED_LI_NOT_ALLOWED
//   "Line items with one-time frequency must start billing at payment (i.e.
//    'hs_recurring_billing_start_date', 'hs_billing_start_delay_days', and
//    'hs_billing_start_delay_months' should be empty) when using
//    [HUBSPOT, BYO_STRIPE]"
//
// ⚠️ THE DRAFT TOTAL LIES, which is the trap this script exists to avoid. The
// draft's own hs_quote_amount came back $0.50 with a $249 dated one-time line
// on it — HubSpot's amount calculation DOES defer it. Only the publish
// validator refuses. A probe that stopped at the draft would have reported
// success.
//
// ⚠️ CREATES REAL CRM OBJECTS and deletes nothing. A draft quote and its line
// items can be deleted afterwards (DELETE /crm/v3/objects/quotes/{id} and
// .../line_items/{id}); a PUBLISHED quote cannot. The 2026-10-12 run was
// cleaned up — quotes 333183026876 and 333188419310, four line items — and
// nothing reached a published state, because the publish is what failed.
//
//   npx tsx scripts/probe-onetime-delay.ts            # build the draft and read it
//   npx tsx scripts/probe-onetime-delay.ts --publish  # ...then try to publish it
//
// Built against the SHIPPING adapter functions, so the line-item shape is
// exactly what EasyOB would write. Two lines:
//
//   Thermal Printer  $249   one-time, billing start DATED in the future
//   AIO Pre Auth     $0.50  one-time, undelayed — so the quote could publish either way
//
// hs_quote_amount is AMOUNT DUE AT CHECKOUT, not contract value. Calibrated
// against paid quote 332031953624, which reads $0.50 while carrying a $399/mo
// platform line delayed by months.
//
// Everything is created on Shaheer's Second test company. A test company is
// not a sandbox — the objects are real.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const COMPANY_ID = "348342243030";   // Shaheer's Second test company
const DEAL_ID = "353614285505";      // ...  / Deal - 8
const CONTACT_EMAIL = "shaheer.hasnain+11@aioapp.com";  // plus-addressed, routes to Shaheer
const SENDER_EMAIL = "shaheer.hasnain@aioapp.com";

const THERMAL_PRINTER = "223511653104";  // $249 one-time
const PRE_AUTH = "281354281678";         // $0.50 one-time
const GO_LIVE = "2026-12-01";

const QUOTE_TO_LINE_ITEM = 67;
const QUOTE_TO_DEAL = 64;
const QUOTE_TO_CONTACT = 69;
const QUOTE_TO_SIGNER_CONTACT = 702;
const QUOTE_TO_TEMPLATE = 286;

async function main() {
  const publish = process.argv.includes("--publish");

  // Imported AFTER loadEnvConfig — the adapter reads its token from process.env.
  const hs = await import("../src/lib/adapters/hubspot");

  const lines = [
    {
      hubspotProductId: THERMAL_PRINTER,
      name: "Thermal Printer",
      qty: 1,
      unitPrice: 249,
      billingFrequency: "one_time" as const,
      productType: "inventory",
      billingStart: { mode: "date" as const, date: GO_LIVE },
    },
    {
      hubspotProductId: PRE_AUTH,
      name: "AIO Pre Auth",
      qty: 1,
      unitPrice: 0.5,
      billingFrequency: "one_time" as const,
      productType: "Service",
    },
  ];

  console.log("[probe] property bags EasyOB will send:");
  for (const l of lines) console.log("   ", l.name, JSON.stringify(hs.toLineItemProperties(l)));

  // DEFAULT_TEMPLATE_IDS.all_in_one, checked live for `active` the same way
  // resolveQuoteTemplate does. Not imported from quoteTemplates.ts because
  // that pulls in the "server-only" DB client, which tsx refuses to load — and
  // the policy table is empty anyway, so this IS what it would return.
  const TEMPLATE_ID = "854670598854";  // AIO Quote v4
  const template = (await hs.listQuoteTemplates()).find(t => t.id === TEMPLATE_ID);
  console.log("[probe] template:", JSON.stringify(template));
  if (!template?.active) throw new Error("quote template v4 is inactive — association 286 would 400");

  const owner = await hs.findOwnerByEmail(SENDER_EMAIL);
  if (!owner) throw new Error(`sender ${SENDER_EMAIL} is not an active HubSpot owner`);
  console.log("[probe] sender:", owner.id, owner.email);

  const contactId = await hs.ensureQuoteContact({
    firstName: "Delay", lastName: "Probe", email: CONTACT_EMAIL,
  });
  console.log("[probe] contact:", contactId);

  const lineItemIds = await hs.createQuoteLineItems(lines);
  console.log("[probe] line items:", lineItemIds.join(", "));

  const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { quoteId, slug } = await hs.createDraftQuote(
    hs.draftQuoteProperties({
      title: "PROBE — deferred one-time line (do not send)",
      expirationDate: expiry,
    })
  );
  console.log("[probe] draft quote:", quoteId, "slug:", slug);

  await hs.associateQuote(quoteId, [
    ...lineItemIds.map(id => ({
      toObjectType: "line_items" as const, toObjectId: id, associationTypeId: QUOTE_TO_LINE_ITEM,
    })),
    { toObjectType: "deals" as const, toObjectId: DEAL_ID, associationTypeId: QUOTE_TO_DEAL },
    { toObjectType: "contacts" as const, toObjectId: contactId, associationTypeId: QUOTE_TO_CONTACT },
    { toObjectType: "contacts" as const, toObjectId: contactId, associationTypeId: QUOTE_TO_SIGNER_CONTACT },
    { toObjectType: "quote_template" as const, toObjectId: TEMPLATE_ID, associationTypeId: QUOTE_TO_TEMPLATE },
  ]);
  console.log("[probe] associations written");

  await report(quoteId, "DRAFT");

  if (!publish) {
    console.log(`\n[probe] stopped before publishing. Re-run with --publish to publish ${quoteId}.`);
    console.log(`[probe] company ${COMPANY_ID}, deal ${DEAL_ID}`);
    return;
  }

  const published = await hs.publishQuote(quoteId, {
    email: owner.email,
    firstName: owner.firstName ?? undefined,
    lastName: owner.lastName ?? undefined,
  });
  console.log("[probe] publish returned:", JSON.stringify(published));

  await report(quoteId, "PUBLISHED");
}

async function report(quoteId: string, when: string) {
  const props = [
    "hs_quote_amount", "hs_subtotal", "hs_status", "hs_payment_enabled",
    "hs_payment_status", "hs_quote_link", "hs_esign_enabled", "hs_acceptance_method",
  ].join(",");
  const res = await fetch(
    `https://api.hubapi.com/crm/v3/objects/quotes/${quoteId}?properties=${props}`,
    { headers: { Authorization: `Bearer ${process.env.HUBSPOT_BILLING_PRIVATE_APP_TOKEN}` } }
  );
  const body = await res.json() as { properties?: Record<string, string | null> };
  console.log(`\n[probe] ===== ${when} (${quoteId}) =====`);
  console.log(JSON.stringify(body.properties, null, 2));

  const amount = Number(body.properties?.hs_quote_amount);
  if (Number.isFinite(amount)) {
    console.log(
      amount <= 1
        ? `[probe] VERDICT: $${amount} due at checkout → HubSpot DEFERS the dated one-time line.`
        : `[probe] VERDICT: $${amount} due at checkout → HubSpot CHARGES the dated one-time line NOW.`
    );
  }
}

main().catch(err => { console.error(err); process.exit(1); });
