"use server";

import { randomUUID } from "crypto";
import { inArray } from "drizzle-orm";
import { postgresStorage } from "@/lib/storage/postgresAdapter";
import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import { db } from "@/lib/db/client";
import { customerLoginTokens, users } from "@/lib/db/schema";
import { sendMagicLinkEmail, type SendMagicLinkResult } from "@/lib/adapters/email";
import { applyTenantNumber } from "@/lib/adapters/adyen";
import { searchTenantCompanies, getTenantCompany, pushToHubSpot, type TenantCompany } from "@/lib/adapters/hubspot";
import { buildAndPublishBillingQuote } from "@/lib/billing/publishBillingQuote";
import type { PublishRefusal } from "@/lib/billing/preconditions";
import type { StorageScope } from "@/lib/storage/storageInterface";
import type { MerchantApplication, AppSettings, CustomerSubmission } from "@/types/merchant";

export type RepSummary = { id: string; name: string; email: string };

const LOGIN_TOKEN_TTL_MINUTES = 30;

async function requireScope(): Promise<StorageScope> {
  const effective = await getEffectiveRole();
  if (!effective) throw new Error("Not authenticated");
  return { userId: effective.userId, role: effective.role };
}

export async function listApplicationsAction(): Promise<MerchantApplication[]> {
  return postgresStorage.listApplications(await requireScope());
}

export async function getApplicationAction(id: string): Promise<MerchantApplication | null> {
  return postgresStorage.getApplication(await requireScope(), id);
}

// Never trusts the client's ownerUserId for a brand-new application — the
// server stamps it from the session on first save. Returns the persisted
// record so the caller's local state stays in sync with what was written.
export async function saveApplicationAction(app: MerchantApplication): Promise<MerchantApplication> {
  const scope = await requireScope();
  const toSave: MerchantApplication = { ...app, ownerUserId: app.ownerUserId || scope.userId };
  await postgresStorage.saveApplication(scope, toSave);
  return toSave;
}

export async function deleteApplicationAction(id: string): Promise<void> {
  await postgresStorage.deleteApplication(await requireScope(), id);
}

export async function getSettingsAction(): Promise<AppSettings> {
  return postgresStorage.getSettings();
}

export async function saveSettingsAction(s: AppSettings): Promise<void> {
  await postgresStorage.saveSettings(await requireScope(), s);
}

export async function listSubmissionsAction(): Promise<CustomerSubmission[]> {
  return postgresStorage.listSubmissions(await requireScope());
}

// Rep/admin-triggered: emails the merchant contact a magic link that logs
// them straight into /customer/applications/{id} to complete Adyen KYC.
// The short-lived auth mechanism is the customerLoginTokens row below, reusing
// the existing /api/customer/verify route unmodified.
//
// This deliberately does NOT touch customerLinkToken/Purpose/SentAt/ExpiresAt.
// Those used to be written here with purpose "kyc_handoff" as bookkeeping, but
// nothing ever read a kyc_handoff token — /lead/[token] and both lead API
// routes require purpose === "lead_upload" — so the write's only observable
// effect was silently killing a live quote link the merchant already had in
// hand. The "we sent it" record lives in the stage move plus the
// customerLoginTokens row's own createdAt. See lib/customerLink.ts.
//
// `url` is returned alongside `result` so the caller can always show the rep
// the link itself — SendMagicLinkResult.devUrl is only populated when Resend
// isn't configured, which would otherwise leave the rep with nothing to share.
export async function sendMerchantOnboardingLinkAction(id: string): Promise<{ app: MerchantApplication; result: SendMagicLinkResult; url: string }> {
  const scope = await requireScope();
  const app = await postgresStorage.getApplication(scope, id);
  if (!app) throw new Error("Application not found");
  const email = app.ownerContact?.email;
  if (!email) throw new Error("No owner contact email on file for this application");

  const now = new Date();
  const updated: MerchantApplication = {
    ...app,
    stage: "merchant_link_sent",
    updatedAt: now.toISOString(),
  };
  await postgresStorage.saveApplication(scope, updated);

  const loginToken = randomUUID();
  const loginExpiresAt = new Date(now.getTime() + LOGIN_TOKEN_TTL_MINUTES * 60 * 1000);
  await db.insert(customerLoginTokens).values({ email, token: loginToken, applicationId: id, expiresAt: loginExpiresAt });

  const base = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
  const url = `${base}/api/customer/verify?token=${loginToken}`;
  const result = await sendMagicLinkEmail(email, url);

  return { app: updated, result, url };
}

// Admin-only: lets the admin dashboard show which rep owns each application
// (for commission attribution) without exposing this to reps, who should
// only ever see their own applications, not a directory of other reps.
export async function listRepsAction(): Promise<RepSummary[]> {
  const scope = await requireScope();
  if (scope.role !== "admin") throw new Error("Admin only");
  return db.select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.role, ["rep", "admin"]));
}

// ── Phase 3: tenant linkage ─────────────────────────────────────────────────
// Links an easyob account (ezacc) to the HubSpot Company representing the AIO
// tenant. Ownership is enforced through the scoped storage: a rep's
// getApplication/saveApplication only touch their own accounts, an admin's
// touch any — so a rep can only link accounts made from their own link, and an
// admin can link for everyone, with no extra role check needed here. Recording
// only: we persist the equivalency + a snapshot of the tenant's AIOad ids; no
// Adyen mutation happens (that's the LATER "replace AIOad with ezad" work).

export async function searchTenantCompaniesAction(query: string): Promise<TenantCompany[]> {
  await requireScope(); // any authenticated rep/admin may search the tenant list
  return searchTenantCompanies(query);
}

/**
 * What the deferred CRM work did when the link unblocked it. Everything here
 * is informational — the link itself always succeeds, and a HubSpot problem
 * afterwards never un-links the company.
 */
export type TenantLinkResult = {
  app: MerchantApplication;
  /** True when this link created the HubSpot deal that was being held back. */
  dealCreated: boolean;
  /** True when the held-back billing quote published on the back of it. */
  quotePublished: boolean;
  /** Preconditions still unmet — billing stays pending until a rep clears them. */
  billingReasons?: PublishRefusal[];
  /** A HubSpot/network failure while catching up. The link is saved regardless. */
  error?: string;
};

export async function linkTenantCompanyAction(appId: string, companyId: string): Promise<TenantLinkResult> {
  const scope = await requireScope();
  const app = await postgresStorage.getApplication(scope, appId);
  if (!app) throw new Error("Application not found"); // also the rep-not-owner case (scoped read returns null)

  const company = await getTenantCompany(companyId);
  if (!company) throw new Error("HubSpot company not found");

  let updated: MerchantApplication = {
    ...app,
    hubspotDealId: app.hubspotDealId,
    tenantLink: {
      hubspotCompanyId: company.id,
      companyName: company.name,
      tenantRef: company.tenantRef,
      adyenAccountHolderId: company.adyenAccountHolderId,
      linkedAt: new Date().toISOString(),
      linkedByUserId: scope.userId,
    },
    updatedAt: new Date().toISOString(),
  };
  await postgresStorage.saveApplication(scope, updated);

  // ── The deferred CRM work, now unblocked ─────────────────────────────────
  // A deal can only be associated to its Company at create time, so both the
  // acceptance route and the customer-side saves hold the deal push back until
  // this link exists. This is the moment it does — and if the merchant already
  // accepted while we were waiting, the billing quote they're owed is built and
  // published here too, exactly as it would have been at acceptance.
  //
  // Note that means publishing a quote — a one-way door, with an ACH mandate
  // behind it — can happen on the back of this click. That is the intended
  // behaviour (the same auto-publish-on-acceptance posture, just deferred), and
  // `canPublishBillingQuote` is the same and only gate it passes through.
  //
  // Nothing below can fail the link: it is already saved, and a rep who has to
  // re-link because HubSpot 500'd would end up with the company recorded twice
  // over. Failures come back on the result for the caller to show.
  let dealCreated = false;
  if (!updated.hubspotDealId) {
    try {
      const dealId = await pushToHubSpot(updated);
      updated = { ...updated, hubspotDealId: dealId };
      await postgresStorage.saveApplication(scope, updated);
      dealCreated = true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("HubSpot deal creation on tenant link failed:", detail);
      return { app: updated, dealCreated: false, quotePublished: false, error: detail };
    }
  }

  // Only for a quote the merchant has already accepted. An unaccepted one is
  // built at acceptance as usual — linking early must not bill anybody.
  if (!updated.quoteAcceptedAt) return { app: updated, dealCreated, quotePublished: false };

  const outcome = await buildAndPublishBillingQuote(updated);
  const refreshed = (await postgresStorage.getApplication(scope, appId)) ?? updated;
  switch (outcome.status) {
    case "published":
      return { app: refreshed, dealCreated, quotePublished: true };
    case "refused":
      return { app: refreshed, dealCreated, quotePublished: false, billingReasons: outcome.reasons };
    case "failed":
      return { app: refreshed, dealCreated, quotePublished: false, error: `${outcome.step}: ${outcome.error}` };
    case "skipped":
      return { app: refreshed, dealCreated, quotePublished: false };
  }
}

export async function unlinkTenantCompanyAction(appId: string): Promise<MerchantApplication> {
  const scope = await requireScope();
  const app = await postgresStorage.getApplication(scope, appId);
  if (!app) throw new Error("Application not found");
  const updated: MerchantApplication = { ...app, tenantLink: null, updatedAt: new Date().toISOString() };
  await postgresStorage.saveApplication(scope, updated);
  return updated;
}

export async function markApplicationClosedLostAction(id: string): Promise<MerchantApplication> {
  const scope = await requireScope();
  const app = await postgresStorage.getApplication(scope, id);
  if (!app) throw new Error("Application not found");
  const updated: MerchantApplication = { ...app, stage: "closed_lost", updatedAt: new Date().toISOString() };
  await postgresStorage.saveApplication(scope, updated);
  return updated;
}

// Admin-only: records the AIO tenant number for an onboarded account and applies
// it to Adyen — stamps the account-holder reference, and (if the POS config is
// set) creates the prod-{tenant} store so terminals can be assigned. Without the
// POS config it degrades to handoff mode: the number is saved and exported, but no
// store is made. Pushes to Adyen first so we don't persist a number that failed.
export async function setTenantNumberAction(id: string, tenantNumber: string): Promise<MerchantApplication> {
  const scope = await requireScope();
  if (scope.role !== "admin") throw new Error("Admin only");
  const trimmed = tenantNumber.trim();
  if (!trimmed) throw new Error("A tenant number is required");

  const app = await postgresStorage.getApplication(scope, id);
  if (!app) throw new Error("Application not found");
  if (!app.adyenIds?.legalEntityId) throw new Error("This account has no Adyen objects yet");

  const result = await applyTenantNumber(app.adyenIds, trimmed, app);

  const updated: MerchantApplication = {
    ...app,
    adyenIds: {
      ...app.adyenIds,
      tenantNumber: trimmed,
      storeId: result.storeId ?? app.adyenIds.storeId,
      merchantAccountId: result.merchantAccountId ?? app.adyenIds.merchantAccountId,
    },
    updatedAt: new Date().toISOString(),
  };
  await postgresStorage.saveApplication(scope, updated);
  return updated;
}
