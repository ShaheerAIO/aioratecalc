// Backfills `payment_processing_arr` onto accepted deals that never got it.
//
//   npx tsx scripts/backfill-processing-arr.ts            # dry run (default)
//   npx tsx scripts/backfill-processing-arr.ts --apply    # write
//
// Why there's a backlog at all: `recordAcceptance` (lib/billing/acceptance.ts)
// only ever attempts this write ONCE, in the same breath `quoteAcceptedAt` is
// first set — `applyDetectedAcceptance`'s guard at its own top line makes
// every later call a no-op for that row, forever. `payment_processing_arr`
// itself didn't exist until lib/billing/processingArr.ts shipped on
// 2026-10-12, so every row accepted before that date never got a single
// attempt — which is most of the 702 live deals a portal audit found sitting
// on the `2500` placeholder (619) or blank/0 (83), not one of them carrying
// an EasyOB-computed value. The nightly hubspot-billing-sync cron now also
// retries this for an already-accepted row on a LATER run, but only while
// that row's HubSpot quote is still inside its 10-day lookback window — which
// none of the backlog is, months on. This script is the one-time catch-up;
// going forward the cron's retry (and a clean first attempt) should keep the
// backlog from re-forming.
//
// DRY RUN BY DEFAULT, and meant to stay that way: this touches a live
// production CRM shared with other AIO teams, across ~700 real deals. It
// prints exactly what it would write — application id, deal id, the CURRENT
// HubSpot value, and the computed value — and writes NOTHING without
// --apply.
//
// Scope, deliberately narrow:
//   - Only rows with BOTH quoteAcceptedAt and hubspotDealId set. An
//     unaccepted row has nothing to state yet; a deal-less row has nowhere
//     to write it.
//   - Only rows where paymentProcessingArr() returns a number. A
//     marketing-only quote, or a processing quote with no volume behind it
//     yet, returns null — OMITTED here exactly like buildDealProperties
//     omits it, never zeroed: a 0 on this property would read as a measured
//     zero, the same reason `monthly_card_volume` is deliberately never read
//     (see app-v2/CLAUDE.md).
//   - Writes ONLY `payment_processing_arr`. Never `saas_revenue` (HubSpot-
//     calculated), `total_arr` (HubSpot-calculated sum), `amount` (EasyOB's
//     own annualized-volume estimate, gated on deal ownership — see
//     buildDealProperties — and a different number with a different
//     purpose), `dealname`, or either commission property. A dedicated PATCH
//     (`patchDealProcessingArr`) is used instead of `syncDealFromApplication`
//     for exactly this reason: the normal sync necessarily carries whatever
//     buildDealProperties decides for those other fields too.
//   - A row already carrying the correct value is left out of the printed
//     plan entirely — re-running this script after a partial --apply (or
//     after the cron has since caught a row up) should not reprint 700
//     no-op lines every time.
//
// Every planned write also prints the INPUTS behind the number — monthly
// volume, average ticket, the take rate, the wholesale % that ticket read,
// the margin between them, and whether they came from a real statement
// (`analysis`) or the rep's typed figures (`quoteConfig`). A bare dollar
// total doesn't let a human tell a real merchant from a fat-fingered test
// row, or catch a ticket that read the wrong wholesale column — printing
// BOTH halves of `commissionMargin` (not just the difference) is what lets
// someone approving --apply across ~700 live production deals check the
// arithmetic instead of trusting it. (2026-10-13: this used to print
// derivePricing's `appliedTargetMargin`, revenue over interchange, which
// could never exceed the quoted card rate — that identity does NOT hold for
// `commissionMargin`, built from a flat wholesale table instead of
// interchange, so don't resurrect it as a sanity check against this number.)
//
// A row whose quoted rate exceeds MAX_PLAUSIBLE_CARD_RATE is reported, not
// silently folded into "no ARR to state" — paymentProcessingArrBreakdown
// returns null for the same reason a marketing-only quote does (don't
// annualise a wrong number; this figure feeds rep commission via
// total_arr), but a decimal-point typo on a real accepted deal is something
// a human needs to go fix, not something that should vanish from view the
// same way a marketing quote correctly having nothing to state does.
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

function money(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

async function main() {
  const apply = process.argv.includes("--apply");

  // Imported AFTER loadEnvConfig — both the DB client and the HubSpot adapter
  // read connection details / tokens from process.env at call time.
  const { db } = await import("./db");
  const { sql } = await import("drizzle-orm");
  const { merchantApplications } = await import("../src/lib/db/schema");
  const { rowToApp } = await import("../src/lib/storage/applicationRow");
  const { paymentProcessingArrBreakdown } = await import("../src/lib/billing/processingArr");
  const { getDealProcessingArr, patchDealProcessingArr } = await import("../src/lib/adapters/hubspot");

  const rows = await db.select().from(merchantApplications).where(
    sql`${merchantApplications.quoteAcceptedAt} is not null and ${merchantApplications.hubspotDealId} is not null`
  );

  console.log(`${apply ? "APPLY" : "DRY RUN"} — ${rows.length} accepted application(s) carrying a HubSpot deal id\n`);

  let noArr = 0;        // paymentProcessingArr() returned null for an ordinary reason (marketing-only, no volume yet)
  let implausible = 0;  // returned null because a quoted rate exceeded MAX_PLAUSIBLE_CARD_RATE — needs a human
  let alreadyRight = 0; // HubSpot already carries the computed value
  let planned = 0;      // would write / did write
  let written = 0;
  let readFailed = 0;
  let writeFailed = 0;

  for (const row of rows) {
    const app = rowToApp(row);
    const dealId = app.hubspotDealId!; // the WHERE clause guarantees this

    const breakdown = paymentProcessingArrBreakdown(app);
    const computed = breakdown.arr;
    if (computed === null) {
      if (breakdown.implausibleRate !== null) {
        implausible++;
        console.log(
          `SKIP-IMPLAUSIBLE  app ${app.id}  deal ${dealId}  ` +
          `quoted rate ${(breakdown.implausibleRate * 100).toFixed(2)}% exceeds the ` +
          `plausible ceiling — likely a decimal-point typo (e.g. 20.00% meant as 2.0%), ` +
          `not annualised`
        );
      } else {
        noArr++;
      }
      continue;
    }

    let current: string | null;
    try {
      current = await getDealProcessingArr(dealId);
    } catch (err) {
      readFailed++;
      console.log(`READ-FAIL  app ${app.id}  deal ${dealId}  — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (current === String(computed)) {
      alreadyRight++;
      continue;
    }

    planned++;
    console.log(
      `${apply ? "WRITE" : "WOULD WRITE"}  app ${app.id}  deal ${dealId}  ` +
      `current=${current ?? "(none)"}  computed=${computed}`
    );
    console.log(
      `        inputs: ${money(breakdown.monthlyVolume ?? 0)}/mo volume, ` +
      `$${breakdown.avgTicket ?? "?"} avg ticket, ` +
      `${((breakdown.takeRate ?? 0) * 100).toFixed(3)}% take rate − ` +
      `${((breakdown.wholesalePct ?? 0) * 100).toFixed(2)}% wholesale = ` +
      `${((breakdown.commissionMargin ?? 0) * 100).toFixed(3)}% margin, ` +
      `source=${breakdown.source}`
    );

    if (!apply) continue;

    try {
      await patchDealProcessingArr(dealId, computed);
      written++;
    } catch (err) {
      writeFailed++;
      console.log(`        WRITE-FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(
    `\n${rows.length} accepted row(s) checked — ` +
    `${noArr} with no ARR to state, ${implausible} with an implausible quoted rate (see above — needs a human), ` +
    `${alreadyRight} already correct, ${readFailed} unreadable, ` +
    `${apply ? `${written} written (${writeFailed} write failures)` : `${planned} would be written`}.`
  );
}

main().catch(e => { console.error(e); process.exit(1); });
