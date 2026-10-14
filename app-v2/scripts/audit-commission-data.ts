// What HubSpot's product library says about cost and commission, read through
// the SHIPPING ingest (`listProducts` → `toCatalogProduct` → `commissionRateToBps`)
// rather than a curl, so what it prints is what a quote would actually use.
//
//   npx tsx scripts/audit-commission-data.ts
//
// Why this exists: the catalog is maintained in HubSpot by people who don't
// deploy EasyOB, and since 2026-10-14 it decides what an AE is paid. A product
// with no "Cost to Rep" earns no commission at all — correctly, since the
// alternative is paying commission on the full sale price — but silently, on
// whichever quotes happen to carry it. This lists the holes so they can be
// filled, and re-run to confirm they were.
//
// Read-only. Writes nothing to HubSpot and touches no database.
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { listProducts } from "@/lib/adapters/hubspot";
import { fmt$ } from "@/lib/utils";
import type { CatalogProduct } from "@/types/merchant";

const pad = (s: string | number, n: number) => String(s).padEnd(n).slice(0, n);
const rate = (bps: number | null | undefined) =>
  bps == null ? "—" : `${(bps / 100).toFixed(2)}%`;

function marginOf(p: CatalogProduct): number | null {
  return p.costToRep == null ? null : p.price - p.costToRep;
}

async function main() {
  const catalog = await listProducts();
  const oneTime = catalog.filter(p => p.billingFrequency === "one_time");
  const recurring = catalog.filter(p => p.billingFrequency !== "one_time");

  console.log(`\n${catalog.length} active products — ${oneTime.length} one-time, ${recurring.length} recurring.\n`);
  console.log(pad("product", 48), pad("price", 11), pad("cost", 11), pad("margin", 11), pad("rep", 8), pad("rsm", 8));
  console.log("-".repeat(100));

  for (const p of oneTime) {
    const margin = marginOf(p);
    console.log(
      pad(p.name, 48),
      pad(fmt$(p.price), 11),
      pad(p.costToRep == null ? "—" : fmt$(p.costToRep), 11),
      pad(margin == null ? "—" : fmt$(margin), 11),
      pad(rate(p.repCommissionBps), 8),
      pad(rate(p.rsmCommissionBps), 8)
    );
  }

  // The three things worth acting on, each needing a different person.
  const noCost = oneTime.filter(p => p.costToRep == null);
  const noRate = oneTime.filter(p => p.costToRep != null && p.repCommissionBps == null && p.rsmCommissionBps == null);
  const recurringRated = recurring.filter(p => p.repCommissionBps != null || p.rsmCommissionBps != null);

  console.log(`\nNO "Cost to Rep" — earns no commission on any quote (${noCost.length}):`);
  for (const p of noCost) console.log(`   ${pad(p.name, 48)} ${fmt$(p.price)}`);

  console.log(`\nCost but NO rate — earns nothing either (${noRate.length}):`);
  for (const p of noRate) console.log(`   ${pad(p.name, 48)} ${fmt$(p.price)}`);

  // Hardware commission is one-time dollars only (lib/commission.ts, rule 1),
  // so a rate on a subscription is either a data-entry habit or a decision
  // nobody has written down. Either way EasyOB ignores it, loudly.
  console.log(`\nRECURRING products carrying a commission rate — IGNORED by the math (${recurringRated.length}):`);
  for (const p of recurringRated) {
    console.log(`   ${pad(p.name, 48)} ${fmt$(p.price)}/${p.billingFrequency}  rep ${rate(p.repCommissionBps)}`);
  }

  // A cost ABOVE the list price means every sale of it pays negative
  // commission — far more likely a swapped column than a deliberate loss.
  const underwater = oneTime.filter(p => {
    const m = marginOf(p);
    return m != null && m < 0;
  });
  if (underwater.length > 0) {
    console.log(`\n⚠ COST ABOVE LIST PRICE — every sale would pay a NEGATIVE commission (${underwater.length}):`);
    for (const p of underwater) console.log(`   ${pad(p.name, 48)} ${fmt$(p.price)} list vs ${fmt$(p.costToRep!)} cost`);
  }
  console.log();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
