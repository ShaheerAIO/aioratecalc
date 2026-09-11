"use server";

import { randomUUID } from "crypto";
import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import { postgresStorage } from "@/lib/storage/postgresAdapter";
import {
  getCompanyOwnerContact, getCompanyProfile,
  type HubspotCompanyProfile, type TenantCompany,
} from "@/lib/adapters/hubspot";
import { buildProspectPrefill, type ProspectPrefill } from "@/lib/hubspotPrefill";
import { listQuotableProductsAction } from "@/lib/actions/catalog";
import { hasQuoteBasis } from "@/lib/leadQuote";
import { resolveLeadLinkIssue } from "@/lib/customerLink";
import type { StorageScope } from "@/lib/storage/storageInterface";
import { sendLeadLinkEmail, type SendMagicLinkResult } from "@/lib/adapters/email";
import { sendLeadLinkSms, type SendSmsResult } from "@/lib/adapters/sms";
import { analysisFromQuoteConfig } from "@/lib/pricing";
import { buildQuote, isAllowedForQuoteType, isProcessingQuote, toQuoteLine } from "@/lib/quoting";
import { shouldAdvance } from "@/lib/adapters/adyenWebhook";
import type {
  MerchantApplication, OrderPoints, PricingModel, ProcessingInfo, QuoteConfig, QuoteLine,
  QuoteType, StatementAnalysis, TenantLink,
} from "@/types/merchant";

const LINK_TTL_DAYS = 14;

function leadLinkUrl(token: string) {
  return `${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/lead/${token}`;
}

function leadLinkExpiry(now: Date) {
  return new Date(now.getTime() + LINK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

// The customer-facing lead link, minted in one place. Both the prospect form
// (link at row creation) and the proposal wizard (link at the end of the
// wizard) issue the same thing: a `lead_upload` token on the 14-day TTL.
function mintLeadLink(now: Date) {
  const token = randomUUID();
  return {
    token,
    sentAt: now.toISOString(),
    expiresAt: leadLinkExpiry(now),
    url: leadLinkUrl(token),
  };
}

// Best-effort delivery shared by create and resend. A Resend/Twilio hiccup
// must not undo the persisted row — the caller always has the raw URL to
// hand the merchant themselves.
async function deliverLeadLink(
  email: string,
  url: string,
  merchantName: string | undefined,
  phone: string | null | undefined,
): Promise<{ emailResult: SendMagicLinkResult; smsResult: SendSmsResult | null }> {
  const emailResult = await sendLeadLinkEmail(email, url, merchantName).catch(err => {
    console.error("lead link email failed", err);
    return { sent: false, devUrl: url };
  });
  const smsResult = phone
    ? await sendLeadLinkSms(phone, url).catch(err => {
        console.error("lead link sms failed", err);
        return { sent: false, devUrl: url };
      })
    : null;
  return { emailResult, smsResult };
}

async function persistLeadLink(
  scope: StorageScope,
  app: MerchantApplication,
  now: Date,
): Promise<{ app: MerchantApplication; linkUrl: string }> {
  const decision = resolveLeadLinkIssue(app, now.getTime());
  const token = decision.reuse ? decision.token : randomUUID();
  const nextStage = hasQuoteBasis(app) ? "quote_sent" : "lead_link_sent";

  const updated: MerchantApplication = {
    ...app,
    stage: shouldAdvance(app.stage, nextStage) ? nextStage : app.stage,
    customerLinkToken: token,
    customerLinkPurpose: "lead_upload",
    customerLinkSentAt: now.toISOString(),
    customerLinkExpiresAt: leadLinkExpiry(now),
    updatedAt: now.toISOString(),
  };
  await postgresStorage.saveApplication(scope, updated);
  return { app: updated, linkUrl: leadLinkUrl(token) };
}

// ── Phase F: "Push to EasyOB" deep link from the HubSpot Company record ─────
// A CRM card on the Company links out to /rep/prospects/new?hubspotCompanyId={id}.
// The form fetches this server-side to prefill business name/contact and to
// stamp tenantLink onto the new application from day one, instead of the
// manual/late attach flow in applications.ts. Read-only — never writes HubSpot.

// `company` stays a TenantCompany as far as callers are concerned (the profile
// is a superset), so the tenant-link badge and the picker path are unaffected;
// `prefill` is the new, mapped form data.
export type ProspectPrefillResult = {
  company: HubspotCompanyProfile | null;
  prefill: ProspectPrefill | null;
  error: string | null;
};

/**
 * Everything the deep link can prefill, in one call: the Company profile, its
 * owner Contact, and the mapping of both onto the app's own shapes.
 *
 * Returns an error string instead of throwing so a bad id or missing token
 * degrades to an un-prefilled, un-linked form rather than a broken page. The
 * contact read is best-effort inside the adapter (it spans a second token and
 * can 403), so a company with no readable contact still prefills the business
 * half rather than failing the whole call.
 */
export async function getHubspotCompanyForProspectAction(companyId: string): Promise<ProspectPrefillResult> {
  const effective = await getEffectiveRole();
  if (!effective) throw new Error("Not authenticated");

  try {
    const company = await getCompanyProfile(companyId);
    if (!company) return { company: null, prefill: null, error: "HubSpot company not found" };
    const contact = await getCompanyOwnerContact(companyId);
    return { company, prefill: buildProspectPrefill(company, contact), error: null };
  } catch (err) {
    return { company: null, prefill: null, error: err instanceof Error ? err.message : "Could not reach HubSpot" };
  }
}

// Mirrors the shape linkTenantCompanyAction persists in applications.ts —
// only what's actually known from the Company read, no invented variant.
function tenantLinkFromCompany(company: TenantCompany, linkedByUserId: string): TenantLink {
  return {
    hubspotCompanyId: company.id,
    companyName: company.name,
    tenantRef: company.tenantRef,
    adyenAccountHolderId: company.adyenAccountHolderId,
    linkedAt: new Date().toISOString(),
    linkedByUserId,
  };
}

// ── Quote lines are re-derived here, never accepted from the browser ────────
// The configurator computes the same thing for its live preview, but that copy
// is display only: unit prices, the ordering-point count and the platform tier
// it implies are money, and a stale tab or an edited payload would otherwise
// persist a wrong price, a $0 platform fee, or the wrong tier ($433/mo).
// The client sends what the rep PICKED — product ids, quantities, channels —
// and everything downstream of that is computed against the live catalog.

/** What the rep picked. Prices and the derived tier are the server's business. */
export type QuotePick = { hubspotProductId: string; qty: number };

async function deriveQuoteLines(
  quoteType: QuoteType,
  picks: QuotePick[],
  channels: string[]
): Promise<{ quoteLines: QuoteLine[] | null; orderPoints: OrderPoints | null }> {
  const wanted = picks.filter(p => p.hubspotProductId && p.qty > 0);
  // Nothing picked and nothing declared still falls through for a rated quote:
  // a food-truck deal owes its flat platform fee either way. What it does NOT
  // pick up is the install services — those follow the products, so an empty
  // picker is a rate-only quote (see resolveIncludedServices). A marketing-only
  // quote with an empty picker genuinely has nothing on it, so it short-cuts
  // the catalog read.
  if (!wanted.length && !channels.length && !isProcessingQuote(quoteType)) {
    return { quoteLines: null, orderPoints: null };
  }

  const catalog = await listQuotableProductsAction();
  if (catalog.error) throw new Error(`Couldn't price this quote: ${catalog.error}`);

  // Resolved against the PICKABLE list, so the picker's exclusions (every
  // derived line among them) are enforced server-side too — and then re-checked
  // against the quote type, because "the picker didn't show it" is not the same
  // as "it can't be sent".
  const lines = wanted.map(pick => {
    const product = catalog.products.find(p => p.hubspotProductId === pick.hubspotProductId);
    if (!product) {
      throw new Error(
        `Product ${pick.hubspotProductId} is no longer in the AIO catalog — reload the page and re-add it.`
      );
    }
    if (!isAllowedForQuoteType(product, quoteType)) {
      throw new Error(`"${product.name}" can't go on a ${quoteType.replace("_", " ")} quote.`);
    }
    return toQuoteLine(product, Math.floor(pick.qty));
  });

  const built = buildQuote(quoteType, lines, channels, catalog.all);
  if (built.blockers.length) throw new Error(built.blockers.join(" "));

  return {
    quoteLines: built.quoteLines.length ? built.quoteLines : null,
    // A marketing-only quote has no ordering-point count to record, even if the
    // browser sent channels along.
    orderPoints:
      isProcessingQuote(quoteType) && (built.quoteLines.length || channels.length)
        ? built.orderPoints
        : null,
  };
}

export async function createProspectAction(input: {
  merchantName: string;
  contactEmail: string;
  // Phase 4 — optional. When given, the lead link is also texted, alongside
  // the email that's always attempted. No phone means no SMS attempt.
  contactPhone?: string | null;
  targetMargin: number;
  pricingModel: PricingModel;
  // Dual statement path. Either (or both) may be supplied: the rep can enter
  // ticket/volume configs, upload the statement themselves (analysis already
  // run through /api/analyze), or neither — in which case the customer is
  // asked for a statement on the lead page as before. When both exist the
  // analysis wins for pricing; quoteConfig stays as what the rep quoted on.
  quoteConfig?: QuoteConfig | null;
  analysis?: StatementAnalysis | null;
  // What KIND of quote this is. Every selection rule hangs off it, so it's part
  // of the payload rather than inferred from the picks. Defaults to full_pos.
  quoteType?: QuoteType | null;
  // Phase C — what the rep picked in the configurator. Prices, the
  // ordering-point count and the platform tier are derived server-side from
  // these (see deriveQuoteLines); the client's own copy is preview only.
  picks?: QuotePick[] | null;
  channels?: string[] | null;
  // Phase F — set when the rep arrived via the HubSpot Company deep link, so
  // the linkage is stamped from day one instead of attached manually/late.
  // Re-fetched here (not trusted from whatever the client last showed) so the
  // persisted snapshot reflects the Company at creation time.
  hubspotCompanyId?: string | null;
}): Promise<{
  app: MerchantApplication;
  linkUrl: string;
  warning: string | null;
  emailResult: SendMagicLinkResult;
  smsResult: SendSmsResult | null;
}> {
  const effective = await getEffectiveRole();
  if (!effective) throw new Error("Not authenticated");

  const now = new Date();
  const link = mintLeadLink(now);

  let tenantLink: TenantLink | null = null;
  // The same HubSpot read also prefills business/owner details onto the new
  // application, so whatever the CRM already knows reaches the customer's
  // onboarding form instead of being asked for again. Derived here rather than
  // accepted from the browser, for the same reason quote lines are.
  let prefill: ProspectPrefill | null = null;
  // Surfaced on the success screen: the rep is told the prospect was created,
  // so they also have to be told the linkage they asked for wasn't.
  let warning: string | null = null;
  if (input.hubspotCompanyId) {
    try {
      const company = await getCompanyProfile(input.hubspotCompanyId);
      if (company) {
        tenantLink = tenantLinkFromCompany(company, effective.userId);
        prefill = buildProspectPrefill(company, await getCompanyOwnerContact(input.hubspotCompanyId));
      } else warning = `HubSpot company ${input.hubspotCompanyId} wasn't found, so the prospect isn't linked — attach it manually.`;
    } catch (err) {
      // HubSpot unreachable at submit time — create the prospect unlinked
      // rather than blocking prospect creation on a read-only enrichment call,
      // but never silently: an unlinked application breaks the Phase F chain.
      console.error("createProspectAction: HubSpot company link failed", input.hubspotCompanyId, err);
      warning = "Prospect created, but the HubSpot company link could not be stamped — attach it manually.";
    }
  }

  // A marketing-only quote has no processing behind it, so the whole rate half
  // is dropped rather than stored-but-ignored: a statement, a ticket/volume
  // basis or a margin target on such a row would render as a rate we never
  // quoted. The rep form hides those inputs; this is the enforcement.
  const quoteType: QuoteType = input.quoteType ?? "full_pos";
  const rated = isProcessingQuote(quoteType);

  const quoteConfig =
    rated && input.quoteConfig && input.quoteConfig.monthlyVolume > 0 && input.quoteConfig.avgTicket > 0
      ? input.quoteConfig
      : null;
  const analysis = rated ? input.analysis ?? null : null;

  const { quoteLines, orderPoints } = await deriveQuoteLines(quoteType, input.picks ?? [], input.channels ?? []);

  // The same predicate the customer-facing render uses, so a quote can't be
  // marked "sent" when it would draw as nothing. On a marketing-only quote the
  // lines ARE the quote, so they're what makes it sendable.
  const hasQuote = hasQuoteBasis({
    quoteType, analysis, quoteConfig, targetMargin: null, pricingModel: null, quoteLines,
  });

  // Only materialize a ProcessingInfo when HubSpot actually gave us something —
  // an all-blank record would read as "the rep answered these" downstream.
  const prefilledProcessing: ProcessingInfo | null =
    prefill && Object.keys(prefill.processing).length
      ? {
          monthlyVolume: "", avgTicket: "", cardPresentPct: "", mcc: "",
          businessDescription: "", previouslyTerminated: "no", bankruptcy: "no", currentProcessor: "",
          ...prefill.processing,
        }
      : null;

  const app: MerchantApplication = {
    id: `prospect_${now.getTime()}`,
    ownerUserId: effective.userId,
    customerUserId: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    // The link goes out with a quote already on it when the rep supplied a
    // basis; otherwise it's still the "upload your statement" link.
    stage: hasQuote ? "quote_sent" : "lead_link_sent",
    hubspotDealId: null,
    tenantLink,
    adyenIds: null,
    adyenOnboardingUrl: null,
    checkIds: null,
    foodbuyIds: null,
    hubspotIds: null,
    quoteType,
    quoteConfig,
    // Kept even when there's no rate basis yet: the lines are what the rep
    // configured, and the customer sees them once a quote exists (their own
    // statement upload can supply the rate half later).
    quoteLines,
    orderPoints,
    quoteAcceptedAt: null,
    targetMargin: rated ? input.targetMargin : null,
    pricingModel: rated ? input.pricingModel : null,
    customerLinkToken: link.token,
    customerLinkPurpose: "lead_upload",
    customerLinkSentAt: link.sentAt,
    customerLinkExpiresAt: link.expiresAt,
    analysis,
    proposal: null,
    // HubSpot fills the blanks; what the rep actually typed always wins.
    business: {
      bizType: "llc",
      address: "", city: "", state: "", zip: "", phone: "", website: "",
      yearsInBusiness: "", annualRevenue: "",
      ...prefill?.business,
      legalName: input.merchantName, dba: input.merchantName,
    },
    ownerContact: {
      firstName: "", lastName: "", title: "",
      ...prefill?.ownerContact,
      email: input.contactEmail || prefill?.ownerContact.email || "",
      phone: input.contactPhone || prefill?.ownerContact.phone || "",
    },
    processing: prefilledProcessing,
    agreement: null,
  };

  await postgresStorage.saveApplication({ userId: effective.userId, role: effective.role }, app);

  // Best-effort from here — the prospect row is already saved, so a Resend or
  // Twilio hiccup must not undo it or block the response. The rep always has
  // the raw link to send by hand regardless of how these come back.
  const { emailResult, smsResult } = await deliverLeadLink(
    app.ownerContact!.email,
    link.url,
    input.merchantName,
    app.ownerContact!.phone,
  );

  return { app, linkUrl: link.url, warning, emailResult, smsResult };
}

// ── The proposal wizard writes through the same derivation ──────────────────
// /rep/proposals/new used to hard-code quoteConfig/quoteLines/orderPoints/
// targetMargin/pricingModel to null and throw away everything the rep set in
// the pricing step, so a wizard-built deal was quoted at the tier default
// rather than the margin the rep actually chose. These two actions give the
// wizard the same write path the prospect form has: picks in, money derived
// server-side, and one link out at the end.

/**
 * Persist the quoting half of an application the wizard has already created.
 *
 * Deliberately NOT saveApplicationAction: that is a blind full-row upsert of
 * whatever the browser is holding, so a stale tab could push back old prices.
 * This reads the stored row, replaces only the quoting fields, and re-derives
 * the lines from the picks against the live catalog (deriveQuoteLines, shared
 * with createProspectAction) — the browser never sends a price.
 */
export async function saveQuoteConfigurationAction(input: {
  applicationId: string;
  picks: QuotePick[];
  channels: string[];
  targetMargin: number;
  pricingModel: PricingModel;
  quoteConfig?: QuoteConfig | null;
  // The wizard is statement-driven, so it only ever offers the rated types —
  // there is no marketing-only path through it (see ProductConfigurator's
  // `selectableTypes`). Still explicit rather than assumed, so a food-truck
  // deal built in the wizard gets the flat platform fee.
  quoteType?: QuoteType | null;
}): Promise<MerchantApplication> {
  const effective = await getEffectiveRole();
  if (!effective) throw new Error("Not authenticated");
  const scope = { userId: effective.userId, role: effective.role };

  const app = await postgresStorage.getApplication(scope, input.applicationId);
  if (!app) throw new Error("Application not found");

  const quoteType: QuoteType = input.quoteType ?? "full_pos";
  const { quoteLines, orderPoints } = await deriveQuoteLines(quoteType, input.picks ?? [], input.channels ?? []);

  const quoteConfig =
    input.quoteConfig && input.quoteConfig.monthlyVolume > 0 && input.quoteConfig.avgTicket > 0
      ? input.quoteConfig
      : app.quoteConfig;

  const updated: MerchantApplication = {
    ...app,
    quoteType,
    quoteConfig,
    quoteLines,
    orderPoints,
    targetMargin: input.targetMargin,
    pricingModel: input.pricingModel,
    updatedAt: new Date().toISOString(),
  };
  await postgresStorage.saveApplication(scope, updated);
  return updated;
}

/**
 * Persist the rep's pre-fill of the merchant's own details — the back half of
 * the wizard's Details step. Targeted for the same reason as above: it is the
 * last write before the customer link goes out, and routing it through the
 * blind full-row upsert would round-trip the browser's copy of the quote lines
 * on top of the ones the server just derived.
 *
 * Stage stays `proposal_sent`: it is the only stage that unlocks the
 * dashboard's rep-driven "Send Onboarding Link" escape hatch, and existing
 * deals sitting there depend on it.
 */
export async function saveApplicationDetailsAction(input: {
  applicationId: string;
  business: MerchantApplication["business"];
  ownerContact: MerchantApplication["ownerContact"];
  processing: MerchantApplication["processing"];
  agreement: MerchantApplication["agreement"];
}): Promise<MerchantApplication> {
  const effective = await getEffectiveRole();
  if (!effective) throw new Error("Not authenticated");
  const scope = { userId: effective.userId, role: effective.role };

  const app = await postgresStorage.getApplication(scope, input.applicationId);
  if (!app) throw new Error("Application not found");

  const updated: MerchantApplication = {
    ...app,
    stage: shouldAdvance(app.stage, "proposal_sent") ? "proposal_sent" : app.stage,
    business: input.business,
    ownerContact: input.ownerContact,
    processing: input.processing,
    agreement: input.agreement,
    updatedAt: new Date().toISOString(),
  };
  await postgresStorage.saveApplication(scope, updated);
  return updated;
}

/**
 * Issue (or re-issue) the customer-facing quote link for an application that
 * already exists — the wizard's terminus, and the same `lead_upload` token the
 * prospect form mints at row creation.
 *
 * The stage move is forward-only (the webhook's rule), so re-issuing a link on
 * a deal that has already moved into onboarding can't drag it backwards.
 *
 * Re-issuing is also non-destructive: a still-live `lead_upload` token is kept
 * and its expiry pushed out, so the URL the merchant already has never stops
 * working. A fresh token is minted only when there is nothing live to preserve.
 * See lib/customerLink.ts for why the slot is handled this carefully.
 */
export async function issueCustomerQuoteLinkAction(
  applicationId: string
): Promise<{ app: MerchantApplication; linkUrl: string }> {
  const effective = await getEffectiveRole();
  if (!effective) throw new Error("Not authenticated");
  const scope = { userId: effective.userId, role: effective.role };

  const app = await postgresStorage.getApplication(scope, applicationId);
  if (!app) throw new Error("Application not found");

  return persistLeadLink(scope, app, new Date());
}

/**
 * Issue or re-send the `/lead/{token}` quote link for any account the caller
 * can see. Stage does not gate this: a deal in analysis, onboarding, or even
 * closed_lost still gets a URL, and shouldAdvance keeps a later stage from
 * sliding backwards. A live lead_upload token is reused so the merchant's
 * existing URL never dies; otherwise a fresh 14-day token is minted.
 *
 * Email/SMS are best-effort and skipped when no contact is on file — the
 * returned URL is always shown so the rep can copy it by hand.
 *
 * Open to the owning rep and to any admin. Storage already enforces that a
 * rep cannot reach someone else's row.
 */
export async function resendLeadLinkAction(
  applicationId: string
): Promise<{
  app: MerchantApplication;
  linkUrl: string;
  emailResult: SendMagicLinkResult;
  smsResult: SendSmsResult | null;
}> {
  const effective = await getEffectiveRole();
  if (!effective) throw new Error("Not authenticated");
  const scope = { userId: effective.userId, role: effective.role };

  const app = await postgresStorage.getApplication(scope, applicationId);
  if (!app) throw new Error("Application not found");

  const { app: updated, linkUrl } = await persistLeadLink(scope, app, new Date());
  const email = updated.ownerContact?.email;
  const merchantName =
    updated.business?.dba || updated.business?.legalName || updated.analysis?.merchantName || undefined;

  if (!email) {
    return {
      app: updated,
      linkUrl,
      emailResult: { sent: false, devUrl: linkUrl },
      smsResult: null,
    };
  }

  const { emailResult, smsResult } = await deliverLeadLink(
    email,
    linkUrl,
    merchantName,
    updated.ownerContact?.phone,
  );

  return { app: updated, linkUrl, emailResult, smsResult };
}

/**
 * The statement-less entry into the proposal wizard: turn the rep's average
 * ticket + monthly volume into the same StatementAnalysis shape the Claude
 * extraction produces, so Analysis/Pricing/Proposal need no special case.
 *
 * Lives server-side because analysisFromQuoteConfig is in pricing.ts, and
 * pulling that into a client bundle would ship MARGIN_REQS to the browser.
 */
export async function analysisFromQuoteConfigAction(config: QuoteConfig): Promise<StatementAnalysis> {
  const effective = await getEffectiveRole();
  if (!effective) throw new Error("Not authenticated");
  if (!(config.avgTicket > 0) || !(config.monthlyVolume > 0)) {
    throw new Error("Enter both average ticket and monthly volume.");
  }
  return analysisFromQuoteConfig(config);
}
