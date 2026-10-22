// Acceptance is DETECTED, never asserted.
//
// EasyOB used to ask the merchant to accept, and then HubSpot asked them again
// — an "Accept & Create Account" button on the lead page, followed days later
// by "Review & Pay" pointing at a hosted quote whose whole purpose is to
// collect an e-signature and an ACH mandate. Two acceptances for one decision.
// The second one is the real one: entering billing details IS accepting the
// quote. So the button is gone and this is what replaces it — the moment
// HubSpot reports the merchant has actually signed and paid, we record it.
//
// The signal is `hasBillingCompleted` — the SAME predicate the checklist and
// AIO tenant provisioning already use. Reused rather than re-derived on
// purpose: if acceptance and "billing is done" could ever disagree, a merchant
// could be provisioned against a quote we don't consider accepted, or shown a
// frozen quote they never paid for.
//
// Idempotent, and the one-shot-ness is load-bearing: `quoteAcceptedAt` is the
// gate. Once set, every call is a no-op, so the account email below is sent
// exactly once no matter how many times the cron, the lead page and the
// authenticated dashboard all observe the same paid subscription.

import { randomUUID } from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications, customerLoginTokens } from "@/lib/db/schema";
import { sendMagicLinkEmail } from "@/lib/adapters/email";
import { syncDealFromApplication } from "@/lib/adapters/hubspot";
import { writeCommissionToDeal } from "@/lib/billing/commissionWriteback";
import { issueOneTimeInvoiceSafely } from "@/lib/billing/oneTimeInvoice";
import { hasBillingCompleted } from "@/lib/onboardingModules";
import { shouldAdvance } from "@/lib/stages";
import type { MerchantApplication } from "@/types/merchant";

// Matches the TTL the old accept route used. Short on purpose — it is a
// bearer credential — and a stale one is not a dead end: /customer/login
// offers "email me a link", and an expired token redirects there saying so.
const TOKEN_TTL_MINUTES = 30;

/**
 * Has HubSpot told us the merchant signed and paid? Thin alias over
 * `hasBillingCompleted` so call sites read as what they mean rather than
 * reaching for a checklist helper to answer a question about acceptance.
 */
export function isAcceptedInHubspot(app: MerchantApplication): boolean {
  return hasBillingCompleted(app.hubspotIds);
}

/**
 * Records acceptance if — and only if — HubSpot now says the merchant
 * completed checkout, and returns the resulting application.
 *
 * Called from every place that refreshes the billing snapshot: the nightly
 * cron, the public lead checklist, and the authenticated customer dashboard.
 * All three race harmlessly; the `quoteAcceptedAt` check is the guard.
 *
 * NEVER THROWS. This is an observation, not a command — it runs inside a
 * billing refresh whose own try/catch means "the HubSpot read failed", and
 * inside a nightly cron that reports per-application failures. A write error
 * here is neither of those things, and letting it surface as one would file a
 * misleading `lastSyncError` against a merchant whose billing is perfectly
 * fine. The two side effects after the write are fire-and-log for the same
 * reason: the acceptance is already committed, and neither a HubSpot outage
 * nor an email failure may un-accept a merchant who has demonstrably paid us.
 */
export async function applyDetectedAcceptance(app: MerchantApplication): Promise<MerchantApplication> {
  if (app.quoteAcceptedAt) return app;
  if (!isAcceptedInHubspot(app)) return app;
  const accepted = await recordAcceptance(app, { syncDeal: true });
  // The one-time invoice goes out the moment acceptance is seen (2026-10-22).
  // Here and not inside recordAcceptance, so the DEBUG billing bypass — which
  // calls recordAcceptance directly — never bills anyone. Its own claim makes
  // the race between observers harmless, and it never throws.
  if (accepted.quoteAcceptedAt) await issueOneTimeInvoiceSafely(accepted);
  return accepted;
}

/**
 * The write + side effects, with no billing check. Only two callers:
 * applyDetectedAcceptance above, and the DEBUG billing bypass
 * (lib/actions/debugBilling.ts), which skips the deal sync so a test click
 * never moves a real HubSpot deal.
 */
export async function recordAcceptance(
  app: MerchantApplication,
  opts: { syncDeal: boolean },
): Promise<MerchantApplication> {
  if (app.quoteAcceptedAt) return app;

  // Forward-only, same rule the Adyen webhook used: a deal already further
  // along (onboarding, closed won) is never dragged back to quote_accepted.
  const advance = shouldAdvance(app.stage, "quote_accepted");
  const acceptedAt = new Date();

  let updated;
  try {
    [updated] = await db
      .update(merchantApplications)
      .set({
        ...(advance ? { stage: "quote_accepted" as const } : {}),
        quoteAcceptedAt: acceptedAt,
        updatedAt: acceptedAt,
      })
      // Only the row that has NOT been accepted yet. Two observers detecting
      // the same payment in the same second would otherwise both send the
      // account email; this makes the loser's UPDATE match nothing and return
      // no row.
      .where(and(eq(merchantApplications.id, app.id), isNull(merchantApplications.quoteAcceptedAt)))
      .returning();
  } catch (err) {
    // Unrecorded, not lost: the merchant has paid, so the next observer
    // (the nightly cron at worst) sees the same subscription and tries again.
    console.error(
      `[acceptance] ${app.id}: could not record the acceptance`,
      err instanceof Error ? err.message : err
    );
    return app;
  }

  const accepted: MerchantApplication = {
    ...app,
    stage: advance ? "quote_accepted" : app.stage,
    quoteAcceptedAt: acceptedAt.toISOString(),
    updatedAt: acceptedAt.toISOString(),
  };
  // Lost the race — the other observer owns the side effects below. The
  // timestamp here is a few milliseconds optimistic; the next refresh corrects it.
  if (!updated) return accepted;

  if (opts.syncDeal && accepted.hubspotDealId) {
    try {
      await syncDealFromApplication(accepted);
    } catch (err) {
      // This PATCH is what carries `payment_processing_arr` (lib/billing/
      // processingArr.ts) onto the deal, and until now a failure here was
      // ONLY a console.error — which is exactly how that property went
      // unwritten on every accepted deal: `recordAcceptance` never runs again
      // for a row once `quoteAcceptedAt` is set (the guard at the top of this
      // function, and of applyDetectedAcceptance, is a hard no-op), so this
      // is the ONE chance this row ever gets. Persisted to the same
      // `hubspotIds.lastSyncError` convention every other sync failure in
      // this codebase uses, so it's visible on the rep's billing panel
      // instead of vanishing into a Vercel log. Best-effort, like the write
      // this function is already inside of: the acceptance is committed
      // either way, and a failed error-write just means the nightly cron's
      // resync (hubspot-billing-sync, for a row that's already accepted) is
      // the next chance this gets.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[acceptance] ${app.id}: HubSpot deal sync failed`, message);
      try {
        await db.update(merchantApplications)
          .set({
            hubspotIds: { ...accepted.hubspotIds!, lastSyncError: message, lastSyncErrorAt: new Date().toISOString() },
            updatedAt: new Date(),
          })
          .where(eq(merchantApplications.id, app.id));
      } catch (writeErr) {
        console.error(
          `[acceptance] ${app.id}: could not persist the deal sync error`,
          writeErr instanceof Error ? writeErr.message : writeErr
        );
      }
    }

    // Commission writeback — gated on COMMISSION_WRITEBACK_ENABLED (default
    // off) and never throws; see lib/billing/commissionWriteback.ts's module
    // comment for why it stays off by default (an unidentified HubSpot-side
    // automation is already populating the same two properties on ~700 live
    // deals) and why this sits beside, not inside, the deal-sync try/catch
    // above — a commission-write failure must never be mistaken for a deal
    // sync failure in `lastSyncError`, and vice versa.
    await writeCommissionToDeal(accepted);
  }

  await sendAccountLink(accepted);
  return accepted;
}

/**
 * Emails the merchant the link that creates their EasyOB account.
 *
 * Under the old flow the customer typed their address into the accept form, so
 * there was always one to send to. Now nobody types anything — the merchant is
 * off on HubSpot's hosted page — so the address is `ownerContact.email`, which
 * `createProspectAction` populates on every prospect row from what the rep
 * entered. A row without one is not an error worth failing acceptance over:
 * the merchant has paid, the rep can see the account, and the merchant can
 * still get in through /customer/login's "email me a link".
 */
async function sendAccountLink(app: MerchantApplication): Promise<void> {
  const email = app.ownerContact?.email?.trim();
  if (!email) {
    console.warn(`[acceptance] ${app.id}: accepted with no contact email — no account link sent`);
    return;
  }

  try {
    const token = randomUUID();
    await db.insert(customerLoginTokens).values({
      email,
      token,
      applicationId: app.id,
      expiresAt: new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000),
    });
    const base = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
    await sendMagicLinkEmail(email, `${base}/api/customer/verify?token=${token}`);
  } catch (err) {
    console.error(
      `[acceptance] ${app.id}: could not send the account link`,
      err instanceof Error ? err.message : err
    );
  }
}
