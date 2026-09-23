// Who is eligible to be provisioned into the AIO platform, and when.
//
// Pure — no DB, no network, no env. The cron calls it per row and the tests
// drive it directly. Kept out of the adapter because the adapter is about
// talking to AIO, and out of the cron because the cron is about scheduling.

import type { MerchantApplication } from "@/types/merchant";
import { hasBillingCompleted } from "@/lib/onboardingModules";
import { isProcessingQuote, quoteTypeOf } from "@/lib/quoting";

export type ProvisioningSkip =
  | "already_provisioned"
  | "closed_lost"
  | "quote_not_accepted"
  | "billing_not_paid"
  | "no_processing_quote"
  | "missing_business_details"
  | "too_many_attempts"
  | "backing_off"
  | "claimed";

export type GateResult = { ready: true } | { ready: false; reason: ProvisioningSkip };

// After five failures stop trying and leave it for a human. Every attempt that
// gets as far as creating a business burns a globally-unique alias that is
// never freed, so an unbounded retry loop is not a harmless one.
const MAX_ATTEMPTS = 5;
// A claim older than this is assumed dead (the function timed out or the
// instance died mid-chain) and may be re-taken.
export const CLAIM_STALE_MS = 15 * 60 * 1000;

/** Exponential, capped at a day: 1h, 2h, 4h, 8h, 16h, 24h… */
export function backoffMs(attempts: number): number {
  return Math.min(2 ** Math.max(attempts - 1, 0), 24) * 60 * 60 * 1000;
}

export function isReadyForAioProvisioning(app: MerchantApplication, now = new Date()): GateResult {
  const t = app.aioTenant;

  if (t?.provisionedAt) return { ready: false, reason: "already_provisioned" };
  if (app.stage === "closed_lost") return { ready: false, reason: "closed_lost" };
  if (!app.quoteAcceptedAt) return { ready: false, reason: "quote_not_accepted" };

  // A marketing-only merchant pays us but sells nothing, so they never need an
  // Adyen account and their KYC would sit permanently incomplete. Same
  // predicate the quote itself was built under.
  if (!isProcessingQuote(quoteTypeOf(app.quoteType))) {
    return { ready: false, reason: "no_processing_quote" };
  }

  // The trigger. AIO's floor is $99/month, so every real merchant reaches a
  // subscription — there is no product that is an Adyen account with nothing
  // to sell, which is why gating on payment cannot strand anyone.
  if (!hasBillingCompleted(app.hubspotIds)) return { ready: false, reason: "billing_not_paid" };

  // AIO's business create needs a name, address and an owner contact. Without
  // them we would create a tenant named "" — an alias burned on a row we then
  // could not fix.
  const biz = app.business;
  const hasName = Boolean((biz?.dba || biz?.legalName || "").trim());
  if (!biz || !hasName || !app.ownerContact?.email) {
    return { ready: false, reason: "missing_business_details" };
  }

  if (t) {
    if (t.attempts >= MAX_ATTEMPTS) return { ready: false, reason: "too_many_attempts" };
    if (t.claimedAt && now.getTime() - Date.parse(t.claimedAt) < CLAIM_STALE_MS) {
      return { ready: false, reason: "claimed" };
    }
    if (t.lastAttemptAt && now.getTime() - Date.parse(t.lastAttemptAt) < backoffMs(t.attempts)) {
      return { ready: false, reason: "backing_off" };
    }
  }

  return { ready: true };
}
