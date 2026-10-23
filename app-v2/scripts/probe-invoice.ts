// OPEN QUESTION (2026-10-22) — can EasyOB bill one-time lines on a HubSpot
// INVOICE, payable by ACH, instead of on the quote? Phase 0 of the one-time
// invoice plan. Nothing in EasyOB writes an invoice until this has been run
// and its answers recorded in docs/claude/hubspot-billing.md.
//
// What it answers:
//   1. Which invoice properties exist for payments (printed from the schema).
//   2. The association type ids invoice → contact / company / deal / line item
//      (read from the labels endpoint, never hard-coded).
//   3. Whether a draft accepts a 100%-discounted line next to a charged one —
//      the shape packages and comps publish as.
//   4. With --open: whether hs_invoice_status: open is accepted, whether
//      hs_invoice_link comes back, and whether the open invoice can still be
//      PATCHed (the one-way-door question).
//
// Needs crm.objects.invoices.write on the EasyOB Billing private app — not
// granted as of E2E-PLAN.md. A 403 MISSING_SCOPES on the create is that.
//
// ⚠️ CREATES REAL CRM OBJECTS and deletes nothing. A DRAFT invoice and its
// line items can be deleted afterwards (DELETE /crm/v3/objects/invoices/{id}
// and .../line_items/{id}). Whether an OPEN one can be is what --open finds
// out, so assume it can't.
//
//   npx tsx scripts/probe-invoice.ts                # schema + draft invoice, read back
//   npx tsx scripts/probe-invoice.ts --open <id>    # make an EXISTING draft ACH-only, then try to open it
//
// RUN 2026-10-22 (draft): invoice 878578016996 — see hubspot-billing.md.
//
// Everything is created on Shaheer's Second test company. A test company is
// not a sandbox — the objects are real.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const COMPANY_ID = "348342243030";   // Shaheer's Second test company
const DEAL_ID = "353614285505";      // ...  / Deal - 8
const CONTACT_EMAIL = "shaheer.hasnain+11@aioapp.com";  // plus-addressed, routes to Shaheer

const THERMAL_PRINTER = "223511653104";  // $249 one-time

const BASE = "https://api.hubapi.com";

function headers() {
  const token = process.env.HUBSPOT_BILLING_PRIVATE_APP_TOKEN;
  if (!token) throw new Error("HUBSPOT_BILLING_PRIVATE_APP_TOKEN is not set");
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function main() {
  const openAt = process.argv.indexOf("--open");
  if (openAt !== -1) {
    const id = process.argv[openAt + 1];
    if (!id) throw new Error("--open needs the draft invoice id");
    return openExisting(id);
  }

  // Imported AFTER loadEnvConfig — the adapter reads its token from process.env.
  const hs = await import("../src/lib/adapters/hubspot");

  // 1. Schema — read-only.
  const schema = await call<{ results: { name: string; label: string; type: string; options?: { value: string }[] }[] }>(
    "GET", "/crm/v3/properties/invoices"
  );
  const interesting = schema.results.filter(p =>
    /payment|status|link|due|currency|collection|allowed|method|balance|amount/i.test(p.name)
  );
  console.log("[probe] invoice properties of interest:");
  for (const p of interesting) {
    const opts = p.options?.length ? ` [${p.options.map(o => o.value).join(", ")}]` : "";
    console.log(`    ${p.name} (${p.type}) — ${p.label}${opts}`);
  }

  // 2. Association type ids — read-only.
  const assoc: Record<string, number> = {};
  for (const to of ["contacts", "companies", "deals", "line_items"]) {
    const labels = await call<{ results: { category: string; typeId: number; label: string | null }[] }>(
      "GET", `/crm/v4/associations/invoices/${to}/labels`
    );
    console.log(`[probe] invoice → ${to}:`, JSON.stringify(labels.results));
    const def = labels.results.find(r => r.category === "HUBSPOT_DEFINED");
    if (!def) throw new Error(`no HUBSPOT_DEFINED invoice → ${to} association`);
    assoc[to] = def.typeId;
  }

  // 3. Draft invoice with the SHIPPING line-item shape.
  const contactId = await hs.ensureQuoteContact({
    firstName: "Invoice", lastName: "Probe", email: CONTACT_EMAIL,
  });
  console.log("[probe] contact:", contactId);

  const lines = [
    {
      hubspotProductId: THERMAL_PRINTER, name: "Thermal Printer", qty: 1, unitPrice: 249,
      billingFrequency: "one_time" as const, productType: "inventory",
    },
    {
      hubspotProductId: THERMAL_PRINTER, name: "Thermal Printer (comped)", qty: 1, unitPrice: 249,
      billingFrequency: "one_time" as const, productType: "inventory", discountPercent: 100,
    },
  ];
  console.log("[probe] property bags EasyOB will send:");
  for (const l of lines) console.log("   ", l.name, JSON.stringify(hs.toLineItemProperties(l)));
  const lineItemIds = await hs.createQuoteLineItems(lines);
  console.log("[probe] line items:", lineItemIds.join(", "));

  const today = new Date().toISOString().slice(0, 10);
  const created = await call<{ id: string }>("POST", "/crm/v3/objects/invoices", {
    properties: { hs_currency: "USD", hs_invoice_date: today, hs_due_date: today },
  });
  const invoiceId = created.id;
  console.log("[probe] draft invoice:", invoiceId);

  const targets: [string, string][] = [
    ["contacts", contactId], ["companies", COMPANY_ID], ["deals", DEAL_ID],
    ...lineItemIds.map(id => ["line_items", id] as [string, string]),
  ];
  for (const [to, id] of targets) {
    await call("PUT", `/crm/v4/objects/invoices/${invoiceId}/associations/${to}/${id}`, [
      { associationCategory: "HUBSPOT_DEFINED", associationTypeId: assoc[to] },
    ]);
  }
  console.log("[probe] associations written");

  await report(invoiceId, "DRAFT", interesting.map(p => p.name));

  console.log(`\n[probe] stopped before opening. Re-run with --open ${invoiceId} to open it.`);
}

// 4. Open an existing draft, then test the door. Reuses the draft rather than
//    building another, so the probe leaves one invoice behind, not two.
async function openExisting(invoiceId: string) {
  const props = [
    "hs_invoice_status", "hs_payment_status", "hs_balance_due", "hs_amount_billed", "hs_invoice_link",
    "hs_allowed_payment_methods", "hs_allowed_commerce_payment_methods",
    "hs_invoice_payment_collection_method", "hs_due_date", "hs_status",
  ];
  const today = new Date().toISOString().slice(0, 10);

  // ACH only, like the quote. HubSpot's default is ACH + card.
  await call("PATCH", `/crm/v3/objects/invoices/${invoiceId}`, {
    properties: { hs_allowed_payment_methods: "ach", hs_allowed_commerce_payment_methods: "ACH" },
  });
  await report(invoiceId, "DRAFT, ACH-only", props);

  try {
    await call("PATCH", `/crm/v3/objects/invoices/${invoiceId}`, { properties: { hs_invoice_status: "open" } });
    console.log("[probe] open accepted");
  } catch (err) {
    console.log("[probe] open REFUSED:", (err as Error).message);
    return;
  }
  await report(invoiceId, "OPEN", props);

  try {
    await call("PATCH", `/crm/v3/objects/invoices/${invoiceId}`, { properties: { hs_due_date: today } });
    console.log("[probe] VERDICT: an OPEN invoice is still editable through the API.");
  } catch (err) {
    console.log("[probe] VERDICT: an OPEN invoice is LOCKED:", (err as Error).message);
  }
}

async function report(invoiceId: string, when: string, props: string[]) {
  const body = await call<{ properties?: Record<string, string | null> }>(
    "GET", `/crm/v3/objects/invoices/${invoiceId}?properties=${props.join(",")}`
  );
  console.log(`\n[probe] ===== ${when} (${invoiceId}) =====`);
  console.log(JSON.stringify(body.properties, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
