// Live check of the "Included with QSR Kit" line-item label against HubSpot.
//
//   npx tsx --conditions=react-server scripts/test-package-label.ts            # create a DRAFT test quote
//   npx tsx --conditions=react-server scripts/test-package-label.ts --cleanup <quoteId>
//
// WHAT IT DOES: runs a realistic cart through the shipping decomposePackages(), then
// writes it with the shipping createQuoteLineItems / createDraftQuote / associateQuote
// and reads the line items back. The quote is a DRAFT attached to the real AIO Quote v3
// template and to NO deal or contact.
//
// WHAT IT NEVER DOES: publish. Publishing is a one-way door. A draft can be previewed
// from the quote record in HubSpot and deleted with --cleanup afterwards.
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

const BASE = "https://api.hubapi.com";
const TEMPLATE_ID = "854670598854"; // AIO Quote v4 — v3 (the code default) is INACTIVE in HubSpot
const QUOTE_TO_LINE_ITEM = 67;
const QUOTE_TO_TEMPLATE = 286;

function headers() {
  const token = process.env.HUBSPOT_BILLING_PRIVATE_APP_TOKEN;
  if (!token) throw new Error("HUBSPOT_BILLING_PRIVATE_APP_TOKEN is not set");
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function cleanup(quoteId: string) {
  const hs = await import("../src/lib/adapters/hubspot");
  void hs;
  const assoc = await fetch(`${BASE}/crm/v4/objects/quotes/${quoteId}/associations/line_items`, { headers: headers() });
  const body = (await assoc.json()) as { results?: Array<{ toObjectId: string | number }> };
  const lineIds = (body.results ?? []).map(r => String(r.toObjectId));

  const q = await fetch(`${BASE}/crm/v3/objects/quotes/${quoteId}?properties=hs_status`, { headers: headers() });
  if (q.ok) {
    const status = ((await q.json()) as { properties?: { hs_status?: string } }).properties?.hs_status;
    if (status && status !== "DRAFT") {
      throw new Error(`Quote ${quoteId} is ${status}, not DRAFT — refusing to touch it.`);
    }
  }
  const del = await fetch(`${BASE}/crm/v3/objects/quotes/${quoteId}`, { method: "DELETE", headers: headers() });
  console.log(`delete quote ${quoteId}: ${del.status}`);
  for (const id of lineIds) {
    const r = await fetch(`${BASE}/crm/v3/objects/line_items/${id}`, { method: "DELETE", headers: headers() });
    console.log(`delete line item ${id}: ${r.status}`);
  }
}

async function main() {
  const ci = process.argv.indexOf("--cleanup");
  if (ci >= 0) {
    const id = process.argv[ci + 1];
    if (!id) throw new Error("--cleanup needs a quote id");
    return cleanup(id);
  }

  const { listProducts, createQuoteLineItems, createDraftQuote, associateQuote, draftQuoteProperties } =
    await import("../src/lib/adapters/hubspot");
  const { toQuoteLine } = await import("../src/lib/quoting");
  const { decomposePackages, PRODUCT_PARTS } = await import("../src/lib/quotePackages");

  const catalog = await listProducts();

  // Doubles as the check the summary asked for: do the ids PRODUCT_PARTS relies on exist?
  console.log("PRODUCT_PARTS ids against the live catalog:");
  for (const id of Object.keys(PRODUCT_PARTS)) {
    const p = catalog.find(c => c.hubspotProductId === id);
    console.log(
      `  ${id}  ${p ? `OK   $${p.price}  ${p.billingFrequency.padEnd(8)} ${p.name}` : "MISSING from catalog"}`
    );
  }

  const cart: Array<[string, number]> = [
    ["217445755632", 1], // POS
    ["222497165009", 1], // Kiosk 27" + terminal
    ["318736467644", 1], // customer facing display
    ["223511653105", 1], // payment terminal
    ["223452690132", 2], // KDS x2 — the second one should stay at list
    ["223511653104", 1], // printer
    ["222497165011", 1], // cash drawer
    ["223511653103", 1], // menu board
    ["281351401209", 1], // WiFi package
  ];
  const lines = [];
  for (const [id, qty] of cart) {
    const product = catalog.find(c => c.hubspotProductId === id);
    if (!product) { console.log(`\nSkipping ${id}: not in the catalog`); continue; }
    lines.push(toQuoteLine(product, qty));
  }

  const out = decomposePackages({ lines, quoteType: "all_in_one" });
  console.log("\nLines going to HubSpot:");
  for (const l of out.lines) {
    console.log(
      `  ${String(l.qty).padStart(2)} x ${l.name.padEnd(46)} $${String(l.unitPrice).padStart(7)}  ` +
      `${String(l.discountPercent ?? 0).padStart(3)}% off  ${l.coveredByPackage ? `[${l.coveredByPackage}]` : ""}`
    );
  }
  console.log(`  covered list value: $${out.coveredListAmount}`);

  const expiry = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
  const lineItemIds = await createQuoteLineItems(out.lines);
  const { quoteId } = await createDraftQuote(
    draftQuoteProperties({ title: "[TEST] QSR Kit label — DELETE ME, never published", expirationDate: expiry })
  );
  await associateQuote(quoteId, [
    ...lineItemIds.map(id => ({ toObjectType: "line_items" as const, toObjectId: id, associationTypeId: QUOTE_TO_LINE_ITEM })),
    { toObjectType: "quote_template" as const, toObjectId: TEMPLATE_ID, associationTypeId: QUOTE_TO_TEMPLATE },
  ]);

  console.log("\nRead back from HubSpot:");
  for (const id of lineItemIds) {
    const r = await fetch(
      `${BASE}/crm/v3/objects/line_items/${id}?properties=name,description,quantity,price,hs_discount_percentage,amount,hs_total_discount`,
      { headers: headers() }
    );
    const p = ((await r.json()) as { properties: Record<string, string | null> }).properties;
    console.log(
      `  ${String(p.quantity).padStart(2)} x ${(p.name ?? "").padEnd(46)} price ${p.price}  disc ${p.hs_discount_percentage ?? "-"}%  ` +
      `amount ${p.amount}  desc: ${p.description ?? "(none)"}`
    );
  }

  console.log(`\nDRAFT quote ${quoteId} (NOT published).`);
  console.log(`Open:    https://app-na2.hubspot.com/quotes/244508708/details/${quoteId}`);
  console.log(`Cleanup: npx tsx --conditions=react-server scripts/test-package-label.ts --cleanup ${quoteId}`);
}

main().catch(err => { console.error(err); process.exit(1); });
