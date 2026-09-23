// Phase 2: pure logic for the Adyen Balance Platform webhook receiver.
// Kept separate from the route handler so it can be unit-tested without a
// server or DB. No "server-only" / DB imports here on purpose.
import crypto from "crypto";
import type { DealStage } from "@/types/merchant";

/**
 * Verify a Balance Platform webhook HMAC signature.
 * The key from the Customer Area is HEX-encoded and must be decoded first; the
 * signature is HMAC-SHA256 over the RAW request body, base64-encoded.
 */
export function verifyBalancePlatformHmac(
  rawBody: string,
  hmacKeyHex: string,
  signature: string | null | undefined
): boolean {
  if (!signature || !hmacKeyHex) return false;
  let key: Buffer;
  try {
    key = Buffer.from(hmacKeyHex, "hex");
  } catch {
    return false;
  }
  const computed = crypto.createHmac("sha256", key).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(computed);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface WebhookOutcome {
  legalEntityId: string | null;
  nextStage: DealStage | null;
}

/**
 * Decide the deal stage a webhook event implies (or null to leave unchanged).
 * Stage is driven by the receiveFromPlatformPayments capability — in AIO's split
 * model that's the sub-merchant's "can receive its funds" signal (the capability
 * we request in adyen.ts). Keep this in sync with the requested capabilities.
 */
export function stageFromEvent(event: any): WebhookOutcome {
  const ah = event?.data?.accountHolder;
  const legalEntityId = ah?.legalEntityId ?? null;
  const type = event?.type;

  if (!ah) return { legalEntityId, nextStage: null };

  // Merchant finished the hosted flow, verification may still be processing.
  if (type === "balancePlatform.accountHolder.onboarded") {
    return { legalEntityId, nextStage: "adyen_kyc_complete" };
  }

  if (
    type === "balancePlatform.accountHolder.updated" ||
    type === "balancePlatform.accountHolder.created"
  ) {
    const cap = ah.capabilities?.receiveFromPlatformPayments;
    if (!cap) return { legalEntityId, nextStage: null };
    if (cap.verificationStatus === "rejected") return { legalEntityId, nextStage: "closed_lost" };
    if (cap.allowed === true) return { legalEntityId, nextStage: "adyen_approved" };
    if (cap.verificationStatus === "valid") return { legalEntityId, nextStage: "adyen_kyc_complete" };
    return { legalEntityId, nextStage: null }; // still pending — no change
  }

  return { legalEntityId, nextStage: null };
}

