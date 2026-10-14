// Is HubSpot's line-item `discount` PER UNIT or PER LINE?
//
// It matters because the quote configurator lets a rep type a cash discount
// and the answer is a factor of `quantity`: read it wrong and "$747 off" on a
// 3-unit line takes off $2,241 or $249, on a document nobody can amend.
//
// THE PORTAL CANNOT ANSWER IT. 166 live line items carry a `discount` and
// every single one has `quantity: 1`, where both readings agree — the same
// shape as the one-time-delay question (49 examples, all on quotes with no
// checkout, so the validator never ran). HubSpot's own label says "Unit
// discount" and `hs_total_discount` is a separate CALCULATED field, which
// argues per-unit, but a label is not a measurement.
//
// So: create ONE line item at quantity 3, read back what HubSpot computed,
// delete it.
//
//   price 100.00 × qty 3  →  pre-discount 300.00
//   discount 10.00
//     per UNIT  → amount 270.00, hs_total_discount 30.00
//     per LINE  → amount 290.00, hs_total_discount 10.00
//
// ⚠️ CREATES A REAL CRM OBJECT, then deletes it. It is associated with
// nothing — an unassociated line item is invisible in the CRM UI (the same
// fact `createQuoteLineItems` relies on when it rolls back a partial create)
// — and it never reaches a quote, a deal or a customer. The delete runs in a
// finally block, and the id is printed either way so a failed cleanup can be
// finished by hand.
//
//   npx tsx scripts/probe-cash-discount.ts
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const BASE = "https://api.hubapi.com";
const TOKEN = process.env.HUBSPOT_BILLING_PRIVATE_APP_TOKEN;

const headers = () => ({
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
});

const READ_BACK = [
  "price", "quantity", "discount", "hs_discount_percentage",
  "amount", "hs_total_discount", "hs_pre_discount_amount",
].join(",");

async function main() {
  if (!TOKEN) throw new Error("HUBSPOT_BILLING_PRIVATE_APP_TOKEN is not set — add it to .env.local.");

  const [price = "100", quantity = "3", discount = "10"] = process.argv.slice(2);
  const properties = {
    name: "EASYOB PROBE — cash discount semantics (delete me)",
    price, quantity, discount,
  };
  console.log("Creating:", properties);

  const res = await fetch(`${BASE}/crm/v3/objects/line_items`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) throw new Error(`create failed ${res.status}: ${await res.text()}`);
  const { id } = await res.json() as { id: string };
  console.log("Created line item", id);

  try {
    const read = await fetch(
      `${BASE}/crm/v3/objects/line_items/${id}?properties=${READ_BACK}`,
      { headers: headers() }
    );
    if (!read.ok) throw new Error(`read failed ${read.status}: ${await read.text()}`);
    const { properties: p } = await read.json() as { properties: Record<string, string> };

    console.log("\nHubSpot computed:");
    for (const k of READ_BACK.split(",")) console.log(`  ${k.padEnd(26)} ${p[k] ?? "(null)"}`);

    const perUnit = Number(price) * Number(quantity) - Number(discount) * Number(quantity);
    const perLine = Number(price) * Number(quantity) - Number(discount);
    const amount = Number(p.amount);
    console.log(`\n  per-unit reading would be ${perUnit.toFixed(2)}`);
    console.log(`  per-line reading would be ${perLine.toFixed(2)}`);
    console.log(`  HubSpot says            ${amount.toFixed(2)}`);
    console.log(`  discount read back as   ${p.discount}  (sent ${discount})`);
  } finally {
    const del = await fetch(`${BASE}/crm/v3/objects/line_items/${id}`, {
      method: "DELETE",
      headers: headers(),
    });
    console.log(del.ok ? `\nDeleted ${id}.` : `\n⚠️ DELETE FAILED (${del.status}) — remove ${id} by hand.`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
