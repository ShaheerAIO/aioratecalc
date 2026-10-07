"use server";

import { randomUUID } from "crypto";
import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import { postgresStorage } from "@/lib/storage/postgresAdapter";
import {
  listCompanyContacts, getCompanyProfile, getDealById,
  type HubspotCompanyProfile, type HubspotContact, type HubspotDeal, type TenantCompany,
} from "@/lib/adapters/hubspot";
import { buildProspectPrefillForContact, initialContactChoice, type ProspectPrefill } from "@/lib/hubspotPrefill";
import { listQuotableProductsAction } from "@/lib/actions/catalog";
import { hasQuoteBasis } from "@/lib/leadQuote";
import { resolveLeadLinkIssue } from "@/lib/customerLink";
import { resolveDealForCompany, type DealChoice, type DealRefusalCode, type DealResolution } from "@/lib/hubspotDeal";
import { stripBlanks, validateOnboardingFields } from "@/lib/onboardingValidation";
import type { StorageScope } from "@/lib/storage/storageInterface";
import { sendLeadLinkEmail, type SendMagicLinkResult } from "@/lib/adapters/email";
import { sendLeadLinkSms, type SendSmsResult } from "@/lib/adapters/sms";
import { analysisFromQuoteConfig } from "@/lib/pricing";
import { getMaxDiscountPercent } from "@/lib/actions/pricing";
import { buildQuote, isAllowedForQuoteType, isProcessingQuote, quoteHasProcessing, quoteTypeOf, toQuoteLine } from "@/lib/quoting";
import { shouldAdvance } from "@/lib/stages";
import { DEFAULT_QUOTE_RATES } from "@/types/merchant";
import type {
  BusinessInfo, DealLink, MerchantApplication, OrderPoints, OwnerContact, PricingModel, ProcessingInfo,
  QuoteAdjustments, QuoteConfig, QuoteLine, QuoteRates, QuoteType, StatementAnalysis, TenantLink,
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

// ── Phase F: the "EasyOB Link" deep link from the HubSpot DEAL record ───────
// Every deal carries an `easyob_link` property pointing at
// /rep/prospects/new?hubspotCompanyId={id}&hubspotDealId={id} (written by
// /api/cron/hubspot-links). The form fetches this server-side to prefill
// business name/contact and to stamp tenantLink onto the new application from
// day one, instead of the manual/late attach flow in applications.ts.
// Read-only — never writes HubSpot.

/**
 * A quote starts at the DEAL (2026-10-01). The company is read OFF the deal
 * rather than chosen beside it, which is what retired the company search and
 * the deal picker from `/rep/prospects/new`: a rep arrives from the deal they
 * already own, so there is nothing left to pick, and every pick was a chance
 * to hang a merchant's quote off the wrong record.
 *
 * Validation is `resolveDealForCompany`'s, unchanged and deliberately re-run
 * rather than reimplemented — closed deals, deals already adopted by another
 * application. The one refusal that is new here is `no_company`: a deal with
 * no company association can't start a quote at all, because the company IS
 * the tenant link and association 341 is only settable at deal create.
 */
export type ProspectFromDeal =
  | {
      ok: true;
      deal: HubspotDeal;
      company: HubspotCompanyProfile;
      /** Every contact on the company, best association label first. The rep picks one. */
      contacts: HubspotContact[];
      /** Preselected only when the company has exactly one contact. */
      selectedContactId: string | null;
      prefill: ProspectPrefill | null;
    }
  | { ok: false; code: DealRefusalCode | "no_company"; message: string };

export async function openProspectFromDealAction(dealIdOrUrl: string): Promise<ProspectFromDeal> {
  const effective = await getEffectiveRole();
  if (!effective) throw new Error("Not authenticated");

  let deal: HubspotDeal | null;
  try {
    deal = await getDealById(dealIdOrUrl);
  } catch (err) {
    return { ok: false, code: "hubspot_error", message: err instanceof Error ? err.message : "Could not reach HubSpot" };
  }
  if (!deal) {
    return { ok: false, code: "not_found", message: `No HubSpot deal found for '${dealIdOrUrl}'.` };
  }

  // `dedupeCompanyIds` has already collapsed the labeled and unlabeled rows
  // for the one company a deal is actually on, so a second id here means the
  // deal genuinely spans two companies and we must not guess which tenant the
  // merchant belongs to.
  if (deal.companyIds.length === 0) {
    return {
      ok: false,
      code: "no_company",
      message: `Deal '${deal.name}' has no company on it in HubSpot. Associate it with the merchant's company record, then come back — the company is what links this quote to their AIO tenant.`,
    };
  }
  if (deal.companyIds.length > 1) {
    return {
      ok: false,
      code: "no_company",
      message: `Deal '${deal.name}' is on ${deal.companyIds.length} companies in HubSpot, so it's ambiguous which merchant this quote is for. Leave it on one and come back.`,
    };
  }
  const companyId = deal.companyIds[0];

  const resolution = await resolveDealForCompany({ companyId, choice: { mode: "existing", dealId: deal.id } });
  if (!resolution.ok) return { ok: false, code: resolution.code, message: resolution.message };

  try {
    const company = await getCompanyProfile(companyId);
    if (!company) {
      return {
        ok: false,
        code: "no_company",
        message: `Deal '${deal.name}' points at HubSpot company ${companyId}, which couldn't be read back (deleted, merged, or out of this token's reach).`,
      };
    }
    const contacts = await listCompanyContacts(companyId);
    const selectedContactId = initialContactChoice(contacts);
    return {
      ok: true,
      deal: resolution.deal,
      company,
      contacts,
      selectedContactId,
      prefill: buildProspectPrefillForContact(company, contacts, selectedContactId),
    };
  } catch (err) {
    return { ok: false, code: "hubspot_error", message: err instanceof Error ? err.message : "Could not reach HubSpot" };
  }
}

/**
 * Preview-resolve a rep's deal pick BEFORE they submit the form — the same
 * `resolveDealForCompany` createProspectAction calls at save time, exposed
 * here so the Company & Deal picker can show a refusal (including the
 * `ambiguous` candidates) or a confirmed deal name/stage inline, without
 * losing everything else the rep has already filled in on the page.
 * createProspectAction re-resolves at submit regardless — this is a preview,
 * not the authority.
 */
export async function resolveDealChoiceAction(input: {
  companyId: string;
  choice: DealChoice;
}): Promise<DealResolution> {
  const effective = await getEffectiveRole();
  if (!effective) throw new Error("Not authenticated");
  return resolveDealForCompany({ companyId: input.companyId, choice: input.choice });
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
// is display only: unit prices and the plan's platform fee are money, and a
// stale tab or an edited payload would otherwise persist a wrong price, a $0
// platform fee, or the wrong plan ($100/mo between the two POS plans).
// The client sends what the rep PICKED — product ids, quantities, channels —
// and everything downstream of that is computed against the live catalog.

/** What the rep picked. Prices and the derived tier are the server's business. */
export type QuotePick = { hubspotProductId: string; qty: number };

// ── Floor enforcement: OFF ───────────────────────────────────────────────────
// Deleted 2026-10-06 along with the margin target it checked. Rates are the
// pricing input now (see QuoteRates): a rep types 2.49% and whatever margin
// that leaves is whatever it leaves, so there is no margin for a write path to
// refuse. Any rate a rep types saves — product-owner decision, taken knowing
// that a below-cost rate can now reach a merchant.
//
// The machinery it used is INTACT and still runs: MARGIN_REQS, getMarginFloor
// and getPaddedFloorRate still feed `derivePricingForRole`, which still tells
// a rep's collapsed internal panel whether the rates they typed land under the
// floor. What's gone is only the refusal.
//
// Worth re-reading before enforcement comes back, because it was subtle: the
// guard was scoped PER ROLE (admins held to the true floor, reps to the padded
// one) because a refusal is an oracle — a rep calling the Server Action
// directly could binary-search the margin, refuse/refuse/succeed, and recover
// AIO's true floor to arbitrary precision. Enforcing the padded floor for reps
// closed that, at no cost, since the padded floor is strictly stricter. The
// same trap is waiting for whoever re-enforces this against a typed rate.

async function deriveQuoteLines(
  quoteType: QuoteType,
  picks: QuotePick[],
  channels: string[],
  adjustments: QuoteAdjustments
): Promise<{ quoteLines: QuoteLine[] | null; orderPoints: OrderPoints | null }> {
  const wanted = picks.filter(p => p.hubspotProductId && p.qty > 0);
  // A PROCESSING quote with nothing picked and no channel declared is a
  // rate-only quote: `resolvePlatformLine` returns `none_needed`, the install
  // services follow the products and so stay off, and `buildQuote` would
  // derive an empty line set. Returning that directly is the same answer
  // without the catalog read — which also means creating a rate-only prospect
  // survives a HubSpot outage.
  //
  // A MARKETING quote is the opposite and must NOT short-cut, which this
  // condition used to have backwards. There is no rate behind it, so an empty
  // picker doesn't mean "rate only", it means a subscription nobody has added
  // hardware to — and it still owes $199 or $299 a month plus the three Menu
  // Board Computers the plan includes. Skipping the derivation saved
  // `quoteLines: null`, so the rep approved a quote the configurator had
  // priced correctly in front of them and the merchant's link then showed no
  // quote at all. buildQuote() is the one derivation; this was a second one
  // disagreeing with it.
  if (!wanted.length && !channels.length && isProcessingQuote(quoteType)) {
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

  // The cap is read server-side, never taken from the browser: it is the only
  // thing standing between a rep's discount and an ACH mandate nobody can amend.
  const built = buildQuote(quoteType, lines, channels, catalog.all, adjustments, await getMaxDiscountPercent());
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
  // Required — the rep now reviews and edits these directly on
  // /rep/prospects/new's "Review What We Know" section (prefilled from
  // HubSpot when a company is linked, but the rep's own edits always win: see
  // the comment below on why this replaces the old server-side prefill
  // stamp). `business.legalName`/`ownerContact.email` are hard-blocked client
  // side and re-checked below — the link has to have a name and somewhere to
  // send it.
  business: BusinessInfo;
  ownerContact: OwnerContact;
  // Optional — a marketing-only quote's Review section still asks for
  // contact info, but processing details (mcc, current processor, …) don't
  // apply to it, so the form may omit this section entirely.
  processing?: ProcessingInfo | null;
  // What this quote is priced on. Optional — a rep who never opens the rate
  // controls quotes the standard 2.49% / 2.49% / $0.15, which is what the form
  // shows them by default.
  quoteRates?: QuoteRates | null;
  pricingModel: PricingModel;
  // Dual statement path. Either (or both) may be supplied: the rep can enter
  // ticket/volume configs, upload the statement themselves (analysis already
  // run through /api/analyze), or neither — in which case the customer is
  // asked for a statement on the lead page as before. When both exist the
  // analysis wins for pricing; quoteConfig stays as what the rep quoted on.
  quoteConfig?: QuoteConfig | null;
  analysis?: StatementAnalysis | null;
  // Which PLAN this quote is on. Every selection rule hangs off it, so it's
  // part of the payload rather than inferred from the picks. Defaults to
  // All-in-One, the same plan quoteTypeOf() reads an unset row as.
  quoteType?: QuoteType | null;
  // Phase C — what the rep picked in the configurator. Prices, the
  // ordering-point count and the platform line are derived server-side from
  // these (see deriveQuoteLines); the client's own copy is preview only.
  picks?: QuotePick[] | null;
  channels?: string[] | null;
  /**
   * Per-line discounts and delayed billing starts, keyed by product id. Keyed
   * separately from the picks because the lines reps discount most — the
   * derived install services — are never picked. Validated server-side against
   * the admin cap; the browser's copy of it is advisory only.
   */
  adjustments?: QuoteAdjustments | null;
  // Required — the Company & Deal section makes both mandatory before submit
  // is enabled. Re-fetched here (not trusted from whatever the client last
  // showed) so the persisted tenant-link snapshot reflects the Company at
  // creation time; the deal is re-resolved through the same
  // resolveDealForCompany the picker previewed with (see
  // resolveDealChoiceAction), since a client-side preview is not the
  // authority — a race (another rep adopting the same deal in the interim)
  // must still be caught here.
  hubspotCompanyId: string;
  deal: DealChoice;
}): Promise<{
  app: MerchantApplication;
  linkUrl: string;
  emailResult: SendMagicLinkResult;
  smsResult: SendSmsResult | null;
}> {
  const effective = await getEffectiveRole();
  if (!effective) throw new Error("Not authenticated");

  // ── Hard blocks ────────────────────────────────────────────────────────
  // Mirrors what the Review section's own submit gate checks client-side —
  // never trust the browser to have actually enforced it. Malformed (not
  // merely missing) fields also block: see stripBlanks' doc comment for why
  // that split needs no second copy of validateOnboardingFields' rules.
  if (!input.business.legalName.trim()) throw new Error("Enter the legal business name.");
  if (!input.ownerContact.email.trim()) throw new Error("Enter the customer's contact email — the link has to go somewhere.");
  const malformed = validateOnboardingFields(stripBlanks({ business: input.business, ownerContact: input.ownerContact }));
  const malformedMessages = Object.values(malformed);
  if (malformedMessages.length) throw new Error(malformedMessages.join(" "));

  const now = new Date();
  const link = mintLeadLink(now);

  // A failed company read is a hard error, not the old soft warning: the deal
  // hangs off this company (resolveDealForCompany needs a real companyId),
  // so an application can no longer exist without one.
  const company = await getCompanyProfile(input.hubspotCompanyId);
  if (!company) throw new Error(`HubSpot company ${input.hubspotCompanyId} wasn't found.`);
  const tenantLink = tenantLinkFromCompany(company, effective.userId);

  const dealResolution = await resolveDealForCompany({ companyId: input.hubspotCompanyId, choice: input.deal });
  if (!dealResolution.ok) throw new Error(dealResolution.message);

  // Stamped from resolveDealForCompany's own `created` answer — the
  // authoritative signal for whether this deal was just minted or already
  // existed — never guessed from `input.deal.mode` alone. This is what
  // buildDealProperties gates the dealname/amount writes on: an adopted deal
  // must never have either overwritten.
  const dealLink: DealLink = {
    origin: dealResolution.created ? "created" : "adopted",
    dealName: dealResolution.deal.name,
    pipelineStageAtLink: dealResolution.deal.stageId,
    linkedAt: now.toISOString(),
    linkedByUserId: effective.userId,
  };

  // A quote with no processing behind it drops the whole rate half rather than
  // storing-but-ignoring it: a statement, a ticket/volume basis or a margin
  // target on such a row would render as a rate we never quoted. The rep form
  // hides those inputs; this is the enforcement.
  //
  // Read off the PICKS, not the plan alone. A marketing quote carrying the
  // Website sells through it, so its rate half is real and must be kept — the
  // rep form shows those inputs for exactly the same reason.
  const quoteType: QuoteType = quoteTypeOf(input.quoteType);
  const rated = quoteHasProcessing(quoteType, input.picks ?? []);

  const quoteConfig =
    rated && input.quoteConfig && input.quoteConfig.monthlyVolume > 0 && input.quoteConfig.avgTicket > 0
      ? input.quoteConfig
      : null;
  const analysis = rated ? input.analysis ?? null : null;

  const { quoteLines, orderPoints } = await deriveQuoteLines(quoteType, input.picks ?? [], input.channels ?? [], input.adjustments ?? {});

  // The same predicate the customer-facing render uses, so a quote can't be
  // marked "sent" when it would draw as nothing. On a marketing-only quote the
  // lines ARE the quote, so they're what makes it sendable.
  // Rates don't affect WHETHER a quote renders, only what it says — so null
  // here is the honest answer rather than a dropped value.
  const hasQuote = hasQuoteBasis({
    quoteType, analysis, quoteConfig, quoteRates: null, targetMargin: null, pricingModel: null, quoteLines,
  });

  const app: MerchantApplication = {
    id: `prospect_${now.getTime()}`,
    ownerUserId: effective.userId,
    customerUserId: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    // The link goes out with a quote already on it when the rep supplied a
    // basis; otherwise it's still the "upload your statement" link.
    stage: hasQuote ? "quote_sent" : "lead_link_sent",
    hubspotDealId: dealResolution.deal.id,
    dealLink,
    tenantLink,
    adyenIds: null,
    adyenOnboardingUrl: null,
    aioTenant: null,
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
    quoteRates: rated ? (input.quoteRates ?? DEFAULT_QUOTE_RATES) : null,
    // Not written any more — rates replaced it as the input. Null on every new
    // row; the column stays for the rows that have one. See QuoteRates.
    targetMargin: null,
    pricingModel: rated ? input.pricingModel : null,
    customerLinkToken: link.token,
    customerLinkPurpose: "lead_upload",
    customerLinkSentAt: link.sentAt,
    customerLinkExpiresAt: link.expiresAt,
    analysis,
    proposal: null,
    // The rep's own reviewed values — no server-side HubSpot merge here
    // anymore. They already saw the HubSpot prefill on screen (badged "from
    // HubSpot") and either kept or overrode it; re-merging server-side would
    // let a stale/overridden field silently revert to whatever HubSpot holds.
    business: input.business,
    ownerContact: input.ownerContact,
    processing: input.processing ?? null,
    agreement: null,
  };

  await postgresStorage.saveApplication({ userId: effective.userId, role: effective.role }, app);

  // Best-effort from here — the prospect row is already saved, so a Resend or
  // Twilio hiccup must not undo it or block the response. The rep always has
  // the raw link to send by hand regardless of how these come back.
  const { emailResult, smsResult } = await deliverLeadLink(
    app.ownerContact!.email,
    link.url,
    app.business?.dba || app.business?.legalName,
    app.ownerContact!.phone,
  );

  return { app, linkUrl: link.url, emailResult, smsResult };
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
 *
 * This is also the ONE write path for a rep reworking an already-sent quote
 * (the account-detail "Edit Quote" panel calls it too) — which is why the
 * guard below lives here rather than in either caller's UI.
 *
 * Refuses once `quoteAcceptedAt` is set. `quoteLines`/`quoteConfig` are frozen
 * at acceptance on purpose: they record what the merchant was actually quoted,
 * and the gap between that frozen snapshot and the live billing state is the
 * whole quoted-vs-actual comparison the admin view is built on. Worse,
 * `publishBillingQuote.ts` carries `app.quoteLines` onto the published HubSpot
 * quote VERBATIM, and a published HubSpot quote is a one-way door — no API
 * edit, no delete, no void. So an edit after acceptance would either
 * desynchronize our record from the document the merchant actually signed, or
 * silently do nothing. A rep who needs to change terms after acceptance needs
 * a new quote, not an edit to this one.
 */
export async function saveQuoteConfigurationAction(input: {
  applicationId: string;
  picks: QuotePick[];
  channels: string[];
  /**
   * Per-line discounts and delayed billing starts, keyed by product id. Keyed
   * separately from the picks because the lines reps discount most — the
   * derived install services — are never picked. Validated server-side against
   * the admin cap; the browser's copy of it is advisory only.
   */
  adjustments?: QuoteAdjustments | null;
  /** What this quote is priced on. Omitted keeps whatever the row already has. */
  quoteRates?: QuoteRates | null;
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

  if (app.quoteAcceptedAt) {
    throw new Error(
      "This quote was accepted on " + new Date(app.quoteAcceptedAt).toLocaleDateString() +
      " and is frozen — it records what the merchant was actually quoted, and a published " +
      "HubSpot billing quote can't be edited or voided through the API. Start a new quote " +
      "instead of editing this one."
    );
  }

  // Published beats accepted as the freeze point now. The rep sends the quote
  // BEFORE the merchant accepts it (acceptance is them signing and paying it
  // on HubSpot), so there is a window — sometimes days long — where the
  // document is live and unamendable but `quoteAcceptedAt` is still null.
  // Editing our copy in that window would silently desynchronize it from the
  // one the merchant is actually looking at.
  if (app.hubspotIds?.publishedAt) {
    throw new Error(
      "This quote was sent to the merchant on " + new Date(app.hubspotIds.publishedAt).toLocaleDateString() +
      " and is frozen — a published HubSpot quote can't be edited, replaced or voided through " +
      "the API, so our copy has to keep matching the document they're signing. Start a new quote " +
      "instead of editing this one."
    );
  }

  const quoteType: QuoteType = quoteTypeOf(input.quoteType);
  const { quoteLines, orderPoints } = await deriveQuoteLines(quoteType, input.picks ?? [], input.channels ?? [], input.adjustments ?? {});

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
    quoteRates: input.quoteRates ?? app.quoteRates ?? DEFAULT_QUOTE_RATES,
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
