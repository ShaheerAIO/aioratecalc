// The public lead link's billing read-back.
//
// The authenticated dashboard refreshes billing on every view
// (lib/actions/customer.ts) — but a merchant who has just signed and paid on
// HubSpot has NO EasyOB account yet, so that path can't reach them. Their only
// two observers are the nightly cron and this: the lead link they already
// have, which is exactly where they land if they click back after checkout.
//
// Without it, a merchant who pays and immediately reopens their link sees a
// "Review & Sign" button for their already-signed quote, and waits until the
// morning for the email that creates their account.
//
// Deliberately NARROWER than the authenticated refresh: no error persistence
// and no write on an unchanged snapshot. This runs on an unauthenticated,
// crawlable route, so the cheapest correct thing is the right thing — the cron
// is the durable backstop and it does persist errors.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications } from "@/lib/db/schema";
import { after } from "next/server";
import { findSubscriptionsForQuote, getInvoiceSnapshot, getQuoteSnapshot } from "@/lib/adapters/hubspot";
import { applyDetectedAcceptance } from "@/lib/billing/acceptance";
import { buildOneTimeInvoiceForId, isInvoicePaid, mergeInvoiceSnapshot } from "@/lib/billing/oneTimeInvoice";
import { rollUpSubscriptionStatus, type MerchantApplication } from "@/types/merchant";

// 60s, matching the authenticated refresh. A merchant refreshing while waiting
// for a payment to clear is the EXPECTED behaviour here, not an edge case.
const LEAD_BILLING_TTL_MS = 60_000;

/**
 * Re-reads the HubSpot quote + its subscriptions for a lead-link view, records
 * the acceptance if the merchant has now paid, and returns the latest
 * application. A no-op unless there is a published quote with something still
 * to learn.
 *
 * Failures are swallowed whole — a HubSpot outage must not break a public page.
 */
export async function refreshLeadBilling(app: MerchantApplication): Promise<MerchantApplication> {
  const hubspotIds = app.hubspotIds;
  if (!hubspotIds?.quoteId || !hubspotIds.publishedAt) return app;
  // Terminal: acceptance is recorded once and never revisited, so there is
  // nothing this read could change for the merchant on this page.
  if (app.quoteAcceptedAt) return app;

  const syncedAtMs = hubspotIds.syncedAt ? Date.parse(hubspotIds.syncedAt) : NaN;
  if (!Number.isNaN(syncedAtMs) && Date.now() - syncedAtMs < LEAD_BILLING_TTL_MS) return app;

  try {
    const snapshot = await getQuoteSnapshot(hubspotIds.quoteId);
    if (!snapshot) return app;
    const subscriptions = await findSubscriptionsForQuote(hubspotIds.quoteId);

    const next = {
      ...hubspotIds,
      // Never null out a link that works on a read that came back empty.
      quoteLink: snapshot.quoteLink ?? hubspotIds.quoteLink,
      paymentStatus: snapshot.paymentStatus,
      paymentDate: snapshot.paymentDate,
      esignStatus: snapshot.esignStatus,
      subscriptions,
      subscriptionStatus: rollUpSubscriptionStatus(subscriptions),
      syncedAt: new Date().toISOString(),
    };

    // Written unconditionally: syncedAt IS the TTL above, so skipping the
    // write would mean the TTL never engages and every page view re-reads
    // HubSpot twice.
    await db
      .update(merchantApplications)
      .set({ hubspotIds: next, updatedAt: new Date() })
      .where(eq(merchantApplications.id, app.id));

    return await applyDetectedAcceptance({ ...app, hubspotIds: next });
  } catch (err) {
    console.error("Lead billing refresh failed:", err instanceof Error ? err.message : err);
    return app;
  }
}

/**
 * The one-time invoice's read-back for the same lead-link views, so the
 * Quote & Billing row clears as soon as staff charge it rather than the next
 * morning. Same TTL and the same swallow-everything posture as above.
 *
 * An invoice that should exist but isn't finished is built after the
 * response — the page shows "being prepared" meanwhile.
 */
export async function refreshLeadInvoice(app: MerchantApplication): Promise<MerchantApplication> {
  if (!app.hubspotIds?.publishedAt || !app.hubspotIds.splitBilling) return app;
  const inv = app.hubspotInvoice;
  if (!inv?.builtAt || !inv.openedAt) {
    after(() => buildOneTimeInvoiceForId(app.id));
    return app;
  }
  if (!inv.invoiceId || isInvoicePaid(inv)) return app;

  const syncedAtMs = inv.syncedAt ? Date.parse(inv.syncedAt) : NaN;
  if (!Number.isNaN(syncedAtMs) && Date.now() - syncedAtMs < LEAD_BILLING_TTL_MS) return app;

  try {
    const snap = await getInvoiceSnapshot(inv.invoiceId);
    if (!snap) return app;
    // syncedAt is the TTL, so it is written even when nothing else moved.
    const next = mergeInvoiceSnapshot(inv, snap) ?? { ...inv, syncedAt: new Date().toISOString() };
    await db
      .update(merchantApplications)
      .set({ hubspotInvoice: next, updatedAt: new Date() })
      .where(eq(merchantApplications.id, app.id));
    return { ...app, hubspotInvoice: next };
  } catch (err) {
    console.error("Lead invoice refresh failed:", err instanceof Error ? err.message : err);
    return app;
  }
}
