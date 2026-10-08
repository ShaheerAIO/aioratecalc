// Backfill the $0.50 pre-authorization onto quotes that were saved before it existed
// and can't publish because nothing is due at checkout (HubSpot MIN_TOTAL_NOT_REACHED).
//
//   npx tsx --conditions=react-server scripts/backfill-preauth.ts            # dry run
//   npx tsx --conditions=react-server scripts/backfill-preauth.ts --apply    # write
//
// Only ever touches an UNPUBLISHED, UNACCEPTED row. It re-derives the quote through the
// shipping buildQuote() and writes ONLY if the result is exactly the saved lines plus the
// pre-auth line: a row whose other lines would change under today's rules is reported and
// left alone, because re-pricing someone's quote is not what this script is for.
//
// It never publishes anything. Publishing is a one-way door and stays the merchant's click.
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

// Key-order-independent: jsonb hands keys back sorted, buildQuote emits them in
// construction order, and a plain JSON.stringify compare calls those different.
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v
  );
}

async function main() {
  const apply = process.argv.includes("--apply");
  const { db } = await import("./db");
  const { sql, eq } = await import("drizzle-orm");
  const { merchantApplications } = await import("../src/lib/db/schema");
  const { listProducts, getQuoteSnapshot, deleteQuoteLineItem } = await import("../src/lib/adapters/hubspot");
  const {
    buildQuote, checkoutAmountBlockers, picksFromQuoteLines, adjustmentsFromQuoteLines, quoteTypeOf,
    isPreAuthProduct, toQuoteLine, DEFAULT_MAX_DISCOUNT_PERCENT,
  } = await import("../src/lib/quoting");
  const { marginPolicy } = await import("../src/lib/db/schema");

  const [policy] = await db.select().from(marginPolicy).where(eq(marginPolicy.isActive, true)).limit(1);
  const cap = policy?.maxDiscountPercent ?? DEFAULT_MAX_DISCOUNT_PERCENT;
  const catalog = await listProducts();

  const rows = await db.select().from(merchantApplications).where(
    sql`${merchantApplications.quoteLines} is not null
        and jsonb_array_length(${merchantApplications.quoteLines}) > 0
        and ${merchantApplications.quoteAcceptedAt} is null
        and coalesce(${merchantApplications.hubspotIds}->>'publishedAt', '') = ''`
  );

  console.log(`${apply ? "APPLY" : "DRY RUN"} — ${rows.length} unpublished, unaccepted quote(s) with lines; discount cap ${cap}%\n`);
  let fixed = 0, skipped = 0;

  for (const row of rows) {
    const lines = row.quoteLines ?? [];
    if (checkoutAmountBlockers(lines).length === 0) continue; // not stuck

    const label = `${row.id}`;
    const quoteType = quoteTypeOf(row.quoteType);
    const rebuilt = buildQuote(
      quoteType,
      picksFromQuoteLines(lines, quoteType).flatMap(pick => {
        const product = catalog.find(c => c.hubspotProductId === pick.hubspotProductId);
        return product ? [toQuoteLine(product, pick.qty)] : [];
      }),
      row.orderPoints?.channels ?? [],
      catalog,
      adjustmentsFromQuoteLines(lines),
      cap
    );

    const withoutPreAuth = rebuilt.quoteLines.filter(l => !isPreAuthProduct(l.hubspotProductId, l.name));
    const unchanged = stable(withoutPreAuth) === stable(lines);
    if (rebuilt.blockers.length || !unchanged || rebuilt.preAuth.lines.length === 0) {
      skipped++;
      console.log(`SKIP  ${label} (${quoteType}) — needs a human:`);
      if (rebuilt.blockers.length) console.log(`        blockers: ${rebuilt.blockers.join(" | ")}`);
      if (!unchanged) {
        console.log("        other lines would change under today's rules:");
        console.log("          saved:  ", stable(lines));
        console.log("          rebuilt:", stable(withoutPreAuth));
      }
      continue;
    }

    const ids = row.hubspotIds;
    console.log(`FIX   ${label} (${quoteType}) — add ${rebuilt.preAuth.lines[0].name} $${rebuilt.preAuth.lines[0].unitPrice}` +
      (ids?.quoteId ? `; discard stale draft quote ${ids.quoteId} (${ids.lineItemIds?.length ?? 0} line items)` : ""));
    if (!apply) { fixed++; continue; }

    if (ids?.quoteId) {
      // Same guard as saveQuoteConfigurationAction: only abandon a quote HubSpot says is a draft.
      const snapshot = await getQuoteSnapshot(ids.quoteId);
      if (snapshot && snapshot.status && snapshot.status !== "DRAFT") {
        skipped++;
        console.log(`SKIP  ${label} — quote ${ids.quoteId} is ${snapshot.status} in HubSpot, not a draft`);
        continue;
      }
    }
    for (const id of ids?.lineItemIds ?? []) {
      try { await deleteQuoteLineItem(id); } catch (err) { console.log(`        could not delete line item ${id}: ${err instanceof Error ? err.message : err}`); }
    }
    await db.update(merchantApplications).set({
      quoteLines: rebuilt.quoteLines,
      hubspotIds: ids
        ? { ...ids, quoteId: null, quoteTemplateId: null, lineItemIds: null, lastSyncError: null, lastSyncErrorAt: null }
        : ids,
      updatedAt: new Date(),
    }).where(eq(merchantApplications.id, row.id));
    fixed++;
  }

  console.log(`\n${apply ? "Fixed" : "Would fix"} ${fixed}; skipped ${skipped}.`);
}
main().catch(e => { console.error(e); process.exit(1); });
