"use server";

import { randomUUID } from "crypto";
import { inArray } from "drizzle-orm";
import { postgresStorage } from "@/lib/storage/postgresAdapter";
import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import { db } from "@/lib/db/client";
import { customerLoginTokens, users } from "@/lib/db/schema";
import { sendMagicLinkEmail, type SendMagicLinkResult } from "@/lib/adapters/email";
import {
  searchTenantCompanies, getTenantCompany, createDeal, buildDealProperties,
  listDealsForCompany, searchDealsByName, getDealById, associateDealToCompany,
  advanceDealStage,
  type TenantCompany, type HubspotDeal,
} from "@/lib/adapters/hubspot";
import { resolveDealForCompany } from "@/lib/hubspotDeal";
import { buildAndPublishBillingQuote } from "@/lib/billing/publishBillingQuote";
import type { PublishRefusal } from "@/lib/billing/preconditions";
import type { StorageScope } from "@/lib/storage/storageInterface";
import type { MerchantApplication, AppSettings, CustomerSubmission, DemoState, DealLink } from "@/types/merchant";

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
  const scope = await requireScope();
  // demoBookingUrl is the one org-wide link every merchant's checklist sees;
  // only updateDemoBookingUrlAction (admin-gated, below) may move it.
  // /rep/settings posts this same AppSettings shape to save processors/
  // adyenConfig, so a rep's payload is never trusted for that one field here —
  // whatever is currently stored is preserved regardless of what the client sent.
  const current = await postgresStorage.getSettings();
  await postgresStorage.saveSettings(scope, { ...s, demoBookingUrl: current.demoBookingUrl });
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

// ── Deal picker (adoption, not create-on-accept) ────────────────────────────
// Reads for the "pick an existing deal" surface. All degrade to `{ error }`
// rather than throwing, the `ProspectPrefillResult` precedent above: a bad id
// or a HubSpot hiccup should leave the picker empty, not crash the page.

export type DealListResult = { deals: HubspotDeal[]; error: string | null };

export async function listCompanyDealsAction(companyId: string): Promise<DealListResult> {
  await requireScope();
  try {
    return { deals: await listDealsForCompany(companyId), error: null };
  } catch (err) {
    return { deals: [], error: err instanceof Error ? err.message : "Could not reach HubSpot" };
  }
}

export async function searchDealsAction(query: string): Promise<DealListResult> {
  await requireScope();
  try {
    return { deals: await searchDealsByName(query), error: null };
  } catch (err) {
    return { deals: [], error: err instanceof Error ? err.message : "Could not reach HubSpot" };
  }
}

export type DealLookupResult = { deal: HubspotDeal | null; error: string | null };

// Accepts a bare deal id or a pasted HubSpot record URL (see parseDealIdInput)
// — the escape hatch for a deal `listCompanyDealsAction` can't see yet because
// deals/search lags a fresh create by seconds to minutes.
export async function lookupDealAction(dealIdOrUrl: string): Promise<DealLookupResult> {
  await requireScope();
  try {
    return { deal: await getDealById(dealIdOrUrl), error: null };
  } catch (err) {
    return { deal: null, error: err instanceof Error ? err.message : "Could not reach HubSpot" };
  }
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
  /**
   * True when this link instead found a PRE-EXISTING deal (adopted via the
   * deal picker, or a legacy orphan) with no company on it at all, and
   * repaired that via a v4 associations PUT (`associateDealToCompany`,
   * verified live 2026-09-21 — see its comment in adapters/hubspot.ts).
   */
  dealCompanyRepaired?: boolean;
  /**
   * The pre-existing deal already carries a DIFFERENT company. Never touched
   * automatically — adding a second association silently would be worse than
   * leaving it — so this is surfaced for a human to look at and decide.
   */
  dealCompanyMismatch?: { dealId: string; otherCompanyIds: string[] };
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

  // ── Legacy deal-creation repair ──────────────────────────────────────────
  // A row from before deal adoption existed may carry no `hubspotDealId` and
  // no company link at all. Every OTHER write path — the acceptance route,
  // the customer-side saves — is PATCH-only now (`syncDealFromApplication`
  // has no CREATE branch) and simply does nothing for a row with no deal;
  // only this legacy recovery path still creates one, because a company
  // association can only be set on a deal CREATE (a v3 PATCH used to update
  // an existing deal can't touch associations at all — though a v4 PUT CAN
  // attach one to an already-created deal afterwards, see
  // `associateDealToCompany` below). This link is the moment that recovery
  // happens — and if the merchant already accepted while this row sat
  // unlinked, the billing quote they're owed is built and published here too,
  // exactly as it would have been at acceptance.
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
      // `syncDealFromApplication` has no CREATE branch any more — deals are
      // adopted or minted through `resolveDealForCompany` at prospect time —
      // so this legacy repair path (a row from before deal adoption existed,
      // whose company link only just arrived) goes straight through
      // `createDeal`. `buildDealProperties(updated)` is computed while
      // `hubspotDealId` is still null, so its ownership gate reads this as a
      // genuine create and includes dealname/amount, reused here rather than
      // re-fetching the deal right after making it.
      const createdProps = buildDealProperties(updated);
      const dealId = await createDeal({
        name: createdProps.dealname ?? "New Deal",
        companyId: company.id,
        amount: createdProps.amount ? Number(createdProps.amount) : undefined,
        stageId: createdProps.dealstage,
      });
      updated = {
        ...updated,
        hubspotDealId: dealId,
        dealLink: {
          origin: "created",
          dealName: createdProps.dealname ?? "New Deal",
          pipelineStageAtLink: createdProps.dealstage ?? null,
          linkedAt: new Date().toISOString(),
          linkedByUserId: scope.userId,
        },
      };
      await postgresStorage.saveApplication(scope, updated);
      dealCreated = true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("HubSpot deal creation on tenant link failed:", detail);
      return { app: updated, dealCreated: false, quotePublished: false, error: detail };
    }
  }

  // Orphan repair: this account may already have carried a deal into the link
  // (adopted via the deal picker, or a legacy row from before this gate
  // existed) — never one `createDeal` just created above, since that one
  // was created with this same company on it. `getDealById` reads its actual
  // company associations; `associateDealToCompany`'s v4 PUT is verified live
  // (2026-09-21, see its comment in adapters/hubspot.ts) to attach one
  // afterwards. A deal with no company gets this one attached. A deal already
  // on some OTHER company is never touched — silently adding a second
  // association would be worse than leaving it — so that's reported back on
  // the result instead, for a human to look at in HubSpot and decide.
  // Best-effort throughout: a read/write failure here must not undo the link
  // that's already saved, nor block the billing catch-up below.
  let dealCompanyRepaired = false;
  let dealCompanyMismatch: { dealId: string; otherCompanyIds: string[] } | undefined;
  if (!dealCreated && updated.hubspotDealId) {
    try {
      const deal = await getDealById(updated.hubspotDealId);
      if (deal && deal.companyIds.length === 0) {
        await associateDealToCompany(updated.hubspotDealId, company.id);
        dealCompanyRepaired = true;
      } else if (deal && !deal.companyIds.includes(company.id)) {
        dealCompanyMismatch = { dealId: updated.hubspotDealId, otherCompanyIds: deal.companyIds };
      }
    } catch (err) {
      console.error(
        "HubSpot deal-company repair on tenant link failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

  // Only for a quote the merchant has already accepted. An unaccepted one is
  // built at acceptance as usual — linking early must not bill anybody.
  if (!updated.quoteAcceptedAt) {
    return { app: updated, dealCreated, dealCompanyRepaired, dealCompanyMismatch, quotePublished: false };
  }

  const outcome = await buildAndPublishBillingQuote(updated);
  const refreshed = (await postgresStorage.getApplication(scope, appId)) ?? updated;
  switch (outcome.status) {
    case "published":
      return { app: refreshed, dealCreated, dealCompanyRepaired, dealCompanyMismatch, quotePublished: true };
    case "refused":
      return {
        app: refreshed, dealCreated, dealCompanyRepaired, dealCompanyMismatch,
        quotePublished: false, billingReasons: outcome.reasons,
      };
    case "failed":
      return {
        app: refreshed, dealCreated, dealCompanyRepaired, dealCompanyMismatch,
        quotePublished: false, error: `${outcome.step}: ${outcome.error}`,
      };
    case "skipped":
      return { app: refreshed, dealCreated, dealCompanyRepaired, dealCompanyMismatch, quotePublished: false };
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

// ── Deal adoption (closing the other half of the dead end) ─────────────────
// `retryBillingQuoteAction` (billing.ts) already refuses `ambiguous` when a
// company has deals and tells the rep to "open the deal picker on the
// account and adopt the right one instead" — until now there was nowhere to
// go do that for a row that already exists (`hubspotDealId: null`, most
// commonly a legacy account from before deal adoption existed). DealPicker's
// `mode: "existing"` path through `resolveDealForCompany` was already fully
// built and tested; its only caller was on /rep/prospects/new, reachable
// only when creating a brand-new prospect. This is the second caller,
// mounted on the account detail (AccountsDashboard.tsx) for a row with no
// deal at all.
//
// Existing-deal only, deliberately: minting a brand-new deal for a company
// that has none is retryBillingQuoteAction's job (mode: "create"), which
// already refuses `ambiguous` and points here instead of creating a second
// deal on a company that already has one.
export type AdoptDealResult =
  | {
      ok: true;
      app: MerchantApplication;
      /** True when adopting this deal unblocked a quote the merchant had already accepted. */
      quotePublished: boolean;
      /** Preconditions still unmet — billing stays pending until a rep clears them. */
      billingReasons?: PublishRefusal[];
      /** A HubSpot/network failure during the billing catch-up. The adoption itself already succeeded. */
      error?: string;
    }
  | { ok: false; error: string };

export async function adoptDealAction(appId: string, dealId: string): Promise<AdoptDealResult> {
  const scope = await requireScope();
  const app = await postgresStorage.getApplication(scope, appId);
  if (!app) throw new Error("Application not found"); // also the rep-not-owner case (scoped read returns null)

  // Re-pointing a row that already has a deal is a different, riskier
  // operation than this one: if its quote has already published, that
  // document would be stranded on the old deal with nothing linking back.
  // Out of scope for this action — refuse plainly rather than silently swap it.
  if (app.hubspotDealId) {
    return {
      ok: false,
      error:
        `This account is already attached to HubSpot deal ${app.hubspotDealId}. ` +
        "Re-pointing an account at a different deal isn't supported — if its quote has already " +
        "published, that document would be stranded on the old deal with nothing linking back.",
    };
  }

  const companyId = app.tenantLink?.hubspotCompanyId;
  if (!companyId) {
    return {
      ok: false,
      error: "This account isn't linked to a HubSpot company yet. Link the tenant company first, then adopt its deal.",
    };
  }

  const resolution = await resolveDealForCompany({
    companyId,
    choice: { mode: "existing", dealId },
    excludeApplicationId: appId,
  });
  if (!resolution.ok) return { ok: false, error: resolution.message };

  const dealLink: DealLink = {
    origin: "adopted",
    dealName: resolution.deal.name,
    pipelineStageAtLink: resolution.deal.stageId,
    linkedAt: new Date().toISOString(),
    linkedByUserId: scope.userId,
  };
  const updated: MerchantApplication = {
    ...app,
    hubspotDealId: resolution.deal.id,
    dealLink,
    updatedAt: new Date().toISOString(),
  };
  await postgresStorage.saveApplication(scope, updated);

  // Same deferred billing catch-up linkTenantCompanyAction runs after its own
  // legacy deal-creation repair, and for the same reason: only a quote the
  // merchant has ALREADY accepted gets built and published here — an
  // unaccepted one is built at acceptance as usual, and adopting early must
  // not bill anybody. This is the one place adopting a deal can publish a
  // HubSpot quote — a one-way door, no API edit, no delete, no void — which
  // is why the UI warns before this call is made, not after.
  if (!updated.quoteAcceptedAt) {
    return { ok: true, app: updated, quotePublished: false };
  }

  const outcome = await buildAndPublishBillingQuote(updated);
  const refreshed = (await postgresStorage.getApplication(scope, appId)) ?? updated;
  switch (outcome.status) {
    case "published":
      return { ok: true, app: refreshed, quotePublished: true };
    case "refused":
      return { ok: true, app: refreshed, quotePublished: false, billingReasons: outcome.reasons };
    case "failed":
      return { ok: true, app: refreshed, quotePublished: false, error: `${outcome.step}: ${outcome.error}` };
    case "skipped":
      return { ok: true, app: refreshed, quotePublished: false };
  }
}

export async function markApplicationClosedLostAction(id: string): Promise<MerchantApplication> {
  const scope = await requireScope();
  const app = await postgresStorage.getApplication(scope, id);
  if (!app) throw new Error("Application not found");
  const updated: MerchantApplication = { ...app, stage: "closed_lost", updatedAt: new Date().toISOString() };
  await postgresStorage.saveApplication(scope, updated);
  return updated;
}

const EMPTY_DEMO_STATE: DemoState = {
  bookedAt: null, heldAt: null, source: null,
  meetingId: null, meetingTitle: null, outcome: null,
  markedByUserId: null, checkedAt: null,
  lastSyncError: null, lastSyncErrorAt: null,
};

// Rep/admin override for a demo AIO can't see in HubSpot (a phone call, an
// in-person visit, a meeting logged without hs_activity_type = "Demo"). NOT
// admin-only — a rep who mis-clicks needs to be able to undo their own mark
// via clearDemoHeldAction below, and it's their deal either way.
//
// This is the one thing that makes a manual mark stick against a later poll:
// deriveDemoState's rule 1 treats `heldAt` as terminal, so a HubSpot read that
// disagrees (a CANCELED meeting, or none at all) can never revert it — a
// human beat the CRM, and that's the correct tiebreak. Don't add a precedence
// table elsewhere; that one rule already does it.
export async function markDemoHeldAction(appId: string, heldAt?: string): Promise<MerchantApplication> {
  const scope = await requireScope();
  const app = await postgresStorage.getApplication(scope, appId);
  if (!app) throw new Error("Application not found");

  const now = new Date().toISOString();
  const base = app.demo ?? EMPTY_DEMO_STATE;
  const updated: MerchantApplication = {
    ...app,
    demo: {
      ...base,
      heldAt: heldAt ?? now,
      source: "manual",
      markedByUserId: scope.userId,
      checkedAt: now,
      lastSyncError: null,
      lastSyncErrorAt: null,
    },
    updatedAt: now,
  };
  await postgresStorage.saveApplication(scope, updated);

  // Best-effort: advanceDealStage is already forward-only (a no-op once the
  // deal is further along than Demo Meeting), so a failure here must never
  // fail the mark itself — the demo state above is already saved.
  if (updated.hubspotDealId) {
    try {
      await advanceDealStage(updated.hubspotDealId, "stage_0"); // Demo Meeting
    } catch (err) {
      console.error("advanceDealStage on demo mark failed:", err instanceof Error ? err.message : err);
    }
  }

  return updated;
}

// Clears a mark (manual or HubSpot-sourced) so the on-view/nightly poller
// resumes reading HubSpot for this account. Not admin-only, same reasoning as
// markDemoHeldAction above.
export async function clearDemoHeldAction(appId: string): Promise<MerchantApplication> {
  const scope = await requireScope();
  const app = await postgresStorage.getApplication(scope, appId);
  if (!app) throw new Error("Application not found");

  const base = app.demo ?? EMPTY_DEMO_STATE;
  const updated: MerchantApplication = {
    ...app,
    demo: { ...base, heldAt: null, source: null, markedByUserId: null },
    updatedAt: new Date().toISOString(),
  };
  await postgresStorage.saveApplication(scope, updated);
  return updated;
}

// Admin-only: the org-wide demo-booking calendar link (see
// AppSettings.demoBookingUrl). Kept out of saveSettingsAction, which
// /rep/settings uses for the same AppSettings shape — a rep must never be
// able to repoint the one link every merchant's checklist sees.
export async function updateDemoBookingUrlAction(url: string | null): Promise<AppSettings> {
  const scope = await requireScope();
  if (scope.role !== "admin") throw new Error("Admin only");

  const trimmed = url?.trim() || null;
  if (trimmed && !/^https?:\/\//i.test(trimmed)) {
    throw new Error("Demo booking URL must be an absolute http(s) URL");
  }

  const current = await postgresStorage.getSettings();
  const updated: AppSettings = { ...current, demoBookingUrl: trimmed };
  await postgresStorage.saveSettings(scope, updated);
  return updated;
}
