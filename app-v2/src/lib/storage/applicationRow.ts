// The row ⇄ MerchantApplication projection, kept out of postgresAdapter.ts for
// one reason: that file is `server-only`, and the token-authenticated lead
// routes need `rowToApp` for rows they read by link token rather than by scope
// (so they can't go through the adapter's scoped getters). Same rationale as
// lib/leadQuote.ts — pure mapping, no DB handle, unit-testable.
//
// Both directions live together on purpose: a new column has to be added to
// each, and splitting the pair across files is how one of them gets forgotten.
import { merchantApplications } from "@/lib/db/schema";
import type { MerchantApplication, DealStage, PricingModel } from "@/types/merchant";

export type ApplicationRow = typeof merchantApplications.$inferSelect;

export function rowToApp(row: ApplicationRow): MerchantApplication {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    customerUserId: row.customerUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    stage: row.stage as DealStage,
    hubspotDealId: row.hubspotDealId,
    dealLink: row.dealLink,
    demo: row.demo,
    tenantLink: row.tenantLink,
    adyenIds: row.adyenIds,
    adyenOnboardingUrl: row.adyenOnboardingUrl,
    aioTenant: row.aioTenant,
    checkIds: row.checkIds,
    foodbuyIds: row.foodbuyIds,
    hubspotIds: row.hubspotIds,
    quoteType: row.quoteType,
    quoteConfig: row.quoteConfig,
    quoteLines: row.quoteLines,
    orderPoints: row.orderPoints,
    quoteAcceptedAt: row.quoteAcceptedAt ? row.quoteAcceptedAt.toISOString() : null,
    targetMargin: row.targetMargin != null ? Number(row.targetMargin) : null,
    pricingModel: row.pricingModel as PricingModel | null,
    customerLinkToken: row.customerLinkToken,
    customerLinkPurpose: row.customerLinkPurpose as "lead_upload" | "kyc_handoff" | null,
    customerLinkSentAt: row.customerLinkSentAt ? row.customerLinkSentAt.toISOString() : null,
    customerLinkExpiresAt: row.customerLinkExpiresAt ? row.customerLinkExpiresAt.toISOString() : null,
    analysis: row.analysis,
    proposal: row.proposal,
    business: row.business,
    ownerContact: row.ownerContact,
    processing: row.processing,
    agreement: row.agreement,
  };
}

export function appToRow(app: MerchantApplication) {
  return {
    id: app.id,
    ownerUserId: app.ownerUserId,
    customerUserId: app.customerUserId,
    stage: app.stage,
    hubspotDealId: app.hubspotDealId,
    dealLink: app.dealLink,
    demo: app.demo,
    tenantLink: app.tenantLink,
    adyenIds: app.adyenIds,
    adyenOnboardingUrl: app.adyenOnboardingUrl,
    aioTenant: app.aioTenant,
    checkIds: app.checkIds,
    foodbuyIds: app.foodbuyIds,
    hubspotIds: app.hubspotIds,
    quoteType: app.quoteType,
    quoteConfig: app.quoteConfig,
    quoteLines: app.quoteLines,
    orderPoints: app.orderPoints,
    quoteAcceptedAt: app.quoteAcceptedAt ? new Date(app.quoteAcceptedAt) : null,
    targetMargin: app.targetMargin != null ? String(app.targetMargin) : null,
    pricingModel: app.pricingModel,
    customerLinkToken: app.customerLinkToken,
    customerLinkPurpose: app.customerLinkPurpose,
    customerLinkSentAt: app.customerLinkSentAt ? new Date(app.customerLinkSentAt) : null,
    customerLinkExpiresAt: app.customerLinkExpiresAt ? new Date(app.customerLinkExpiresAt) : null,
    analysis: app.analysis,
    proposal: app.proposal,
    business: app.business,
    ownerContact: app.ownerContact,
    processing: app.processing,
    agreement: app.agreement,
    updatedAt: new Date(),
  };
}
