"use server";

import { randomUUID } from "crypto";
import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import { postgresStorage } from "@/lib/storage/postgresAdapter";
import {
  listCompanyContacts, listDealContacts, mergeDealAndCompanyContacts, getCompanyProfile, getDealById,
  type HubspotCompanyProfile, type HubspotContact, type HubspotDeal, type TenantCompany,
} from "@/lib/adapters/hubspot";
import { buildProspectPrefillForContact, initialContactChoice, type ProspectPrefill } from "@/lib/hubspotPrefill";
import { listQuotableProductsAction } from "@/lib/actions/catalog";
import { hasQuoteBasis } from "@/lib/leadQuote";
import { resolveLeadLinkIssue } from "@/lib/customerLink";
import { resolveDealForCompany, type DealChoice, type DealRefusalCode, type DealResolution } from "@/lib/hubspotDeal";
import { stripBlanks, validateOnboardingFields } from "@/lib/onboardingValidation";
import type { StorageScope } from "@/lib/storage/storageInterface";
import { sendLeadLinkEmail, type ReplyToRep, type SendMagicLinkResult } from "@/lib/adapters/email";
import { sendLeadLinkSms, type SendSmsResult } from "@/lib/adapters/sms";
import {
  deleteQuoteLineItem, ensureQuoteContact, getContactById, getQuoteSnapshot,
  setDealBillingNotes, updateCompanyMerchantDetails, updateContactDetails, type ContactDetailsPatch,
} from "@/lib/adapters/hubspot";
import { resolveSender } from "@/lib/billing/publishBillingQuote";
import { analysisFromQuoteConfig, marginFloorBlockers, minRateFloorBlockers, monthlyRevenueFloorBlockers } from "@/lib/pricing";
import { getMaxDiscountPercent, getPricingPreviewAction, getQuoteLimits } from "@/lib/actions/pricing";
import {
  buildQuote, describeDelayDeviation, isAllowedForQuoteType, isProcessingQuote,
  longestBillingDelayDays, planDefaultBillingDelayDays,
  processesCardNotPresentOnly, quoteHasProcessing,
  quoteNoteBlockers, quoteTypeOf, toQuoteLine,
} from "@/lib/quoting";
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

// Called with the exact same arguments `sendLeadLinkEmail` was already given
// whenever there's no rep to report — so a caller with no resolved rep (every
// existing one, before 10/13) makes the exact 3-argument call it always did.
// That arity matters: `toHaveBeenCalledWith(a, b, c)` in Jest/Vitest does NOT
// match a call made as `fn(a, b, c, undefined)` — an explicitly-passed
// trailing `undefined` is a real 4th argument, not the same as omitting it —
// so this avoids silently widening every existing call site.
//
// It used to carry a `quoteLink` too, for the "go straight to billing" CTA.
// That went with publish-at-send on 2026-10-15: the quote is no longer built
// until the merchant confirms their details, so there is no HubSpot document
// to link to at the moment this email is written.
function sendLeadLinkEmailWithOptionalRep(
  to: string, url: string, merchantName: string | undefined,
  rep: ReplyToRep | null | undefined,
) {
  if (rep) return sendLeadLinkEmail(to, url, merchantName, rep);
  return sendLeadLinkEmail(to, url, merchantName);
}

// Best-effort delivery shared by create and resend. A Resend/Twilio hiccup
// must not undo the persisted row — the caller always has the raw URL to
// hand the merchant themselves.
async function deliverLeadLink(
  email: string,
  url: string,
  merchantName: string | undefined,
  phone: string | null | undefined,
  /** A second address to send the same link to. Best-effort; its result isn't reported. */
  altEmail?: string | null,
  /**
   * The owning rep's verified reply-to identity, when `resolveReplyToRep`
   * could establish one (10/13/2026). Best-effort and independent of
   * everything else here — a failed lookup just means this email reads like
   * every one sent before today.
   */
  rep?: ReplyToRep | null,
): Promise<{ emailResult: SendMagicLinkResult; smsResult: SendSmsResult | null }> {
  const emailResult = await sendLeadLinkEmailWithOptionalRep(email, url, merchantName, rep).catch(err => {
    console.error("lead link email failed", err);
    return { sent: false, devUrl: url };
  });
  const alt = altEmail?.trim();
  if (alt && alt.toLowerCase() !== email.trim().toLowerCase()) {
    await sendLeadLinkEmailWithOptionalRep(alt, url, merchantName, rep)
      .catch(err => console.error("lead link email (second address) failed", err));
  }
  const smsResult = phone
    ? await sendLeadLinkSms(phone, url).catch(err => {
        console.error("lead link sms failed", err);
        return { sent: false, devUrl: url };
      })
    : null;
  return { emailResult, smsResult };
}

/**
 * The owning rep's verified reply-to identity for EasyOB's own merchant-facing
 * mail (2026-10-13, "can the email go through the sales rep?"). Reuses
 * `resolveSender` VERBATIM — the exact same check that gates HubSpot's
 * `hs_sender_email` — rather than inventing a second, looser notion of "the
 * rep's real address" next to it. That matters because the cheap version
 * (just read `users.email`) is exactly what let a seeded dev row like
 * `rep@aioapp.com` reach a real merchant before `hs_sender_email` was
 * verified; the same hazard applies here and the same fix closes it.
 *
 * Returns null — never throws — on ANY refusal (`no_rep_email`,
 * `not_a_portal_owner`, `owner_lookup_failed`) or network failure: this is a
 * cosmetic reply-to/display-name, not a precondition for anything, so the
 * email still goes out exactly as it did before today's change, just without
 * the rep's name on it.
 */
async function resolveReplyToRep(ownerUserId: string): Promise<ReplyToRep | null> {
  try {
    const resolved = await resolveSender(ownerUserId);
    if (!resolved.ok) return null;
    const name = [resolved.firstName, resolved.lastName].filter(Boolean).join(" ").trim();
    return { email: resolved.email, name: name || undefined };
  } catch (err) {
    console.error("resolveReplyToRep failed", ownerUserId, err);
    return null;
  }
}

/**
 * Write the merchant details the rep entered onto the HubSpot Company — the
 * legal name and address, the previous processor and the MCC. Best-effort,
 * like the link delivery: the row is already saved, and a HubSpot hiccup must
 * not undo a link the rep has to send.
 *
 * The legal ADDRESS goes out from here as well as from the merchant's own
 * onboarding submission (`syncLegalAddressBestEffort`, customer.ts), so a rep
 * who already knows it doesn't have to wait for the merchant to retype it —
 * which, since that form is behind a customer account, means waiting until
 * after they've paid. The two writes can't fight: whoever answers later wins,
 * and `updateCompanyMerchantDetails` LEAVES OUT blanks rather than sending
 * "", so the usual case — the rep leaving those fields to the customer —
 * sends nothing for them and erases nothing HubSpot already had.
 */
async function syncCompanyDetails(
  companyId: string | null | undefined,
  app: Pick<MerchantApplication, "business" | "processing"> & Partial<Pick<MerchantApplication, "quoteConfig">>,
): Promise<{ synced: boolean }> {
  if (!companyId) return { synced: false };
  // The quote basis's ticket first (what the rate was priced on), else the
  // processing record's. Only a positive number reaches the number-typed
  // property — anything else is left out, never sent, so it can't fail the
  // whole PATCH and take the legal fields down with it.
  const ticket = Number(app.quoteConfig?.avgTicket ?? app.processing?.avgTicket);
  try {
    await updateCompanyMerchantDetails(companyId, {
      legalName: app.business?.legalName,
      legalStreet: app.business?.address,
      legalCity: app.business?.city,
      previousProcessor: app.processing?.currentProcessor,
      mcc: app.processing?.mcc,
      averageTicket: ticket > 0 ? String(ticket) : null,
    });
    return { synced: true };
  } catch (err) {
    console.error("HubSpot company details sync failed", companyId, err);
    return { synced: false };
  }
}

/**
 * Push the billing contact to HubSpot — "add billing contact" / "overwrite
 * the billing contact in hs" (2026-10-13). Best-effort, like the company sync
 * above: the prospect row is already saved, and a HubSpot hiccup here must
 * never undo it.
 *
 * Two shapes, chosen by whether the rep picked an existing contact:
 *  - No `existingContactId` (the rep typed a brand-new person): find-or-create
 *    by email, reusing `ensureQuoteContact` VERBATIM (hubspot.ts:1925) — the
 *    exact function the quote's signer contact already uses. Not a second
 *    search-then-create implementation next to it.
 *  - `existingContactId` set (the rep picked someone off the dropdown —
 *    `mergeDealAndCompanyContacts`'s list, reused rather than a new portal-wide
 *    search): read that contact's CURRENT record fresh, diff it against what
 *    the rep is submitting, and PATCH only the fields that differ and are
 *    non-blank. That is the "overwrite" half — narrow by construction, since
 *    an unchanged field never enters the patch and a blank one can't clobber
 *    something HubSpot already had. `email` is excluded from the diff/patch
 *    entirely (see `updateContactDetails`'s own comment).
 */
async function syncBillingContact(
  billingContact: OwnerContact | null | undefined,
  existingContactId: string | null | undefined,
): Promise<void> {
  if (!billingContact || !billingContact.email.trim()) return;
  try {
    if (existingContactId) {
      const current = await getContactById(existingContactId);
      if (current) {
        const patch: ContactDetailsPatch = {};
        const firstName = billingContact.firstName.trim();
        const lastName = billingContact.lastName.trim();
        const title = billingContact.title.trim();
        const phone = billingContact.phone.trim();
        if (firstName && firstName !== (current.firstName ?? "")) patch.firstname = firstName;
        if (lastName && lastName !== (current.lastName ?? "")) patch.lastname = lastName;
        if (title && title !== (current.jobTitle ?? "")) patch.jobtitle = title;
        if (phone && phone !== (current.phone ?? "")) patch.phone = phone;
        await updateContactDetails(existingContactId, patch);
        return;
      }
      // The id the rep picked no longer resolves (deleted/merged in HubSpot
      // since the dropdown loaded) — fall through to find-or-create by email
      // rather than silently dropping the billing contact.
    }
    await ensureQuoteContact({
      firstName: billingContact.firstName,
      lastName: billingContact.lastName,
      email: billingContact.email,
      phone: billingContact.phone,
    });
  } catch (err) {
    console.error("HubSpot billing contact sync failed", existingContactId ?? "(new)", err);
  }
}

/**
 * Mirror the rep's quote note onto the HubSpot deal's "Billing Notes" card —
 * the `billing_notes` deal property (product owner, 2026-10-14).
 *
 * This REPLACES a note engagement that was authored by the rep and
 * @-mentioned QUOTE_NOTE_WATCHER (Elizabeth Phillips). The mention was the
 * only thing that notified her, and a property notifies nobody, so that is
 * the deliberate trade: the note is now where she reads it on the deal record
 * instead of arriving as an alert. `createDealNote`, the mention markup it
 * built and the `resolveSender` owner lookup that kept the rep as author were
 * all deleted with it; see `setDealBillingNotes` for what is left and for how
 * to get an alert back (a HubSpot-side workflow, needing nothing from here).
 *
 * Best-effort, like the company sync above: the quote is already saved, and a
 * note is a RECORD of a decision rather than a precondition for one — a
 * missing scope must not stop a rep quoting.
 *
 * Only on CHANGE, and only when there is a deal to put it on. A property
 * overwrites rather than accumulating, so re-posting an unchanged note is
 * merely a wasted call rather than the pile of duplicates it was under the
 * old append-only note — but it is still a write to AIO's live CRM on every
 * save, so the guard stays. The trade-off runs the other way for a note
 * written before the deal existed: it is kept on the row and reaches HubSpot
 * the next time the rep edits it, which is the same bargain `deliverLeadLink`
 * strikes — the rep's own copy is never lost, even when the push is.
 */
async function mirrorQuoteNote(
  app: Pick<MerchantApplication, "id" | "hubspotDealId" | "quoteNote" | "quoteLines" | "quoteType">,
  previous: string | null,
): Promise<void> {
  const note = (app.quoteNote ?? "").trim();
  if (!note || note === (previous ?? "").trim()) return;
  if (!app.hubspotDealId) return;

  // The delay is what makes this note mandatory, so it is what the note has
  // to open with — a reason with no number beside it is a sentence nobody can
  // check. A quote billing exactly when its plan says to needs no preamble:
  // the card is already labelled "Billing Notes", so one would only push the
  // rep's actual sentence further down a one-line property.
  //
  // Measured exactly as `quoteNoteBlockers` measures it — recurring lines
  // only, against the PLAN's own default — so the record can't describe a
  // deviation the rep was never asked about, or miss one they were.
  const quoteType = quoteTypeOf(app.quoteType);
  const recurring = (app.quoteLines ?? []).filter(l => l.billingFrequency !== "one_time");
  const delay = longestBillingDelayDays(recurring);
  const expected = planDefaultBillingDelayDays(quoteType);
  const text = recurring.length && delay !== expected
    ? `${describeDelayDeviation(delay, expected)}. The rep's reason: ${note}`
    : note;

  try {
    await setDealBillingNotes(app.hubspotDealId, text);
  } catch (err) {
    console.error("HubSpot billing notes push failed", app.id, app.hubspotDealId, err);
  }
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
      /** The deal's contacts first, then the company's, each best association label first. The rep picks one. */
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
    // The deal's own contacts lead; the company's follow underneath.
    const [dealContacts, companyContacts] = await Promise.all([
      listDealContacts(resolution.deal.id),
      listCompanyContacts(companyId),
    ]);
    const contacts = mergeDealAndCompanyContacts(dealContacts, companyContacts);
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

// ── Floor enforcement: ON, server-side, as of this change ───────────────────
// Deleted 2026-10-06 along with the margin target it checked — rates became
// the pricing input (see QuoteRates), a rep types 2.49% and whatever margin
// that leaves is whatever it leaves, and nothing refused a quote for being
// under one. That stood until 2026-10-09 ("card rate minimums are needed"),
// which reversed it — but only the CLIENT side was ever reconnected
// (rep/prospects/new/page.tsx's hardBlocks, EditQuotePanel's `disabled`). The
// write paths here were never updated to match, so a stale client, a direct
// Server Action call, or any caller that skips the browser entirely could
// still save a rate under AIO's minimum. This closes that gap.
//
// `marginFloorBlockers` (pricing.ts) is the one check, called from both
// `createProspectAction` and `saveQuoteConfigurationAction` below against a
// `RoleScopedPricing` fetched through `getPricingPreviewAction` — the exact
// function both rep-facing forms already call for their own (now redundant,
// but harmless) client-side check. Nothing here derives a second number.
//
// Scoped PER ROLE, not against one shared "true" number, same as the deleted
// guard was: admins are held to the true floor (they already see true numbers
// everywhere else), reps to the PADDED one — because a refusal is an oracle.
// A rep calling this Server Action directly, refused against the TRUE floor,
// could binary-search the margin (refuse, refuse, succeed) and recover AIO's
// true minimum to arbitrary precision. The padded floor is always ≥ the true
// floor, so refusing reps against it is strictly stricter, never looser, and
// the refusal message never states the number either way — see
// `marginFloorBlockers`'s doc comment.

// No fee overrides are persisted on an application (they only ever lived in
// the wizard's ephemeral PricingStep state — see EditQuotePanel's identical
// ZERO_FEES), so the floor is checked against zero rather than guessing at
// what the original proposal used.
const ZERO_FEE_OVERRIDES = { monthlyFee: 0, perTxnFee: 0, cpPerTxnFee: 0, cnpPerTxnFee: 0 };

/**
 * Refuses when `quoteRates` don't clear AIO's margin floor for this volume,
 * leave AIO under `MIN_MONTHLY_PROCESSING_REVENUE` a month on this merchant
 * (2026-10-15), OR undercut AIO's wholesale cost by less than the admin-set
 * minimum (2026-10-15, "add floor for rate (wholesale + minimum), editable in
 * settings") — the shared guard both `createProspectAction` and
 * `saveQuoteConfigurationAction` call. Three independent tests off ONE
 * preview: each is measured on a different margin and none implies another,
 * so a quote has to pass all three. All three are reported together rather
 * than one at a time, so a rep raising a rate to clear one doesn't then
 * discover the next.
 *
 * A no-op with no basis to check (no statement, no rep-entered
 * volume/ticket): the same `hasFloorBasis`/`hasVolumeBasis` condition the two
 * client forms already gate their own preview on, because there is no floor to
 * clear until there's a volume to clear it against — a config-less or
 * rate-less quote goes out as a rate the customer's own statement will later
 * be priced against.
 */
async function assertRateAboveFloor(
  rated: boolean,
  analysis: StatementAnalysis | null,
  quoteConfig: QuoteConfig | null,
  quoteRates: QuoteRates | null | undefined,
  pricingModel: PricingModel,
  cardNotPresentOnly: boolean = false
): Promise<void> {
  if (!rated || !(analysis || quoteConfig)) return;
  const pricing = await getPricingPreviewAction({
    analysis,
    quoteConfig: analysis ? null : quoteConfig,
    quoteRates: quoteRates ?? DEFAULT_QUOTE_RATES,
    pricingModel,
    feeOverrides: ZERO_FEE_OVERRIDES,
    activeTier: null,
    // All card-not-present when they only take orders online, so the floor is
    // cleared against the rate being quoted rather than against a 95%
    // card-present blend that can never happen.
    cardPresentPct: cardNotPresentOnly ? 0 : null,
    // Same signal, for the wholesale-plus-minimum floor: a hidden,
    // un-editable card-present lane has nothing to refuse (see
    // `minimumCardPresentRate` in pricing.ts).
    cardNotPresentOnly,
  });
  const blockers = [
    ...marginFloorBlockers(pricing), ...monthlyRevenueFloorBlockers(pricing), ...minRateFloorBlockers(pricing),
  ];
  if (blockers.length) throw new Error(blockers.join(" "));
}

async function deriveQuoteLines(
  quoteType: QuoteType,
  picks: QuotePick[],
  channels: string[],
  adjustments: QuoteAdjustments,
  /**
   * The rep's note, checked here because a long billing delay is only
   * visible once the lines are built — the adjustments alone don't say which
   * of them are recurring. Server-side like every other limit: the browser's
   * copy of this rule is a courtesy.
   */
  note?: string | null
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

  // Every limit is read server-side, never taken from the browser: they are
  // the only things standing between a rep's discount, delay or quantity and
  // an ACH mandate nobody can amend.
  const [maxDiscountPercent, limits] = await Promise.all([getMaxDiscountPercent(), getQuoteLimits()]);
  const built = buildQuote(quoteType, lines, channels, catalog.all, adjustments, maxDiscountPercent, limits);
  const blockers = [...built.blockers, ...quoteNoteBlockers(built.quoteLines, note, quoteType)];
  if (blockers.length) throw new Error(blockers.join(" "));

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
  // Who AIO bills, if different from ownerContact (2026-10-13, "add billing
  // contact"). Optional and independent of the signer: see `billingContact`'s
  // own comment on MerchantApplication. `billingContactId`, when set, is the
  // HubSpot contact the rep picked off the dropdown (mergeDealAndCompanyContacts'
  // list) rather than typed fresh — it's what lets `syncBillingContact` PATCH
  // that contact's record instead of searching by email.
  billingContact?: OwnerContact | null;
  billingContactId?: string | null;
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
  // run through /api/analyze), or neither — in which case the quote shows the
  // priced lines and no rate, because the customer is never asked for a
  // statement (2026-10-13). When both exist the analysis wins for pricing;
  // quoteConfig stays as what the rep quoted on.
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
  /**
   * The rep's note on this quote. Optional, and REQUIRED when the first
   * charge doesn't sit on the plan's own default — `deriveQuoteLines` refuses
   * without one (see `quoteNoteBlockers`). Mirrored onto the HubSpot deal below.
   */
  quoteNote?: string | null;
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
  /** Whether the legal name / previous processor / MCC reached the HubSpot Company. */
  companySync: { synced: boolean };
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
  // Read off the PICKS, not the plan alone. A marketing quote whose Website
  // takes online orders sells through it, so its rate half is real and must be
  // kept — the rep form shows those inputs for exactly the same reason.
  const quoteType: QuoteType = quoteTypeOf(input.quoteType);
  const rated = quoteHasProcessing(quoteType, input.picks ?? [], input.adjustments);

  const quoteConfig =
    rated && input.quoteConfig && input.quoteConfig.monthlyVolume > 0 && input.quoteConfig.avgTicket > 0
      ? input.quoteConfig
      : null;
  const analysis = rated ? input.analysis ?? null : null;
  // Server mirror of the rep form's hard block (product owner, 2026-10-18):
  // a processing quote with no basis is quoted the flat standard rate, off the
  // rate card and past every margin floor. At CREATION only — a saved quote
  // reopened in EditQuotePanel can't take a ticket, so enforcing it on save
  // would freeze every older row that never had one.
  if (rated && !analysis && !quoteConfig) {
    throw new Error("Enter the monthly volume and average ticket — the card rate is priced off both.");
  }

  // Server-side mirror of the rep form's own floor check — see the comment
  // above `assertRateAboveFloor` and the 2026-10-09 decision recorded above
  // `ZERO_FEE_OVERRIDES`.
  await assertRateAboveFloor(
    rated, analysis, quoteConfig, input.quoteRates, input.pricingModel,
    processesCardNotPresentOnly(quoteType, input.picks ?? [], input.adjustments)
  );

  const quoteNote = (input.quoteNote ?? "").trim() || null;
  const { quoteLines, orderPoints } = await deriveQuoteLines(
    quoteType, input.picks ?? [], input.channels ?? [], input.adjustments ?? {}, quoteNote
  );

  // The same predicate the customer-facing render uses, so a quote can't be
  // marked "sent" when it would draw as nothing. On a marketing-only quote the
  // lines ARE the quote, so they're what makes it sendable.
  // Rates don't affect WHETHER a quote renders, only what it says — so null
  // here is the honest answer rather than a dropped value.
  const hasQuote = hasQuoteBasis({
    quoteType, analysis, quoteConfig, quoteRates: null, targetMargin: null, pricingModel: null, quoteLines,
  });

  // A LINK WITHOUT A QUOTE IS NOT SENDABLE (2026-10-15, product owner: "there
  // is no situation where the rep hasnt made the quote because they cant send
  // the initial link without making it"). That was the intent all along but
  // nothing enforced it — an All-in-One quote with nothing picked, no declared
  // channels and no volume resolves `none_needed` for its platform line,
  // derives zero lines, has no rate basis, and sailed through every existing
  // block. The merchant then received a link to "your quote is on its way".
  //
  // It matters more now that confirmation is the publish trigger: the merchant
  // is being asked to confirm their details so a quote can be built, and there
  // has to be a quote to build. Blocking here also makes the lead page's
  // "still preparing" branch unreachable for new rows, which is why that
  // branch is kept rather than deleted — rows created before today can still
  // be in that state.
  if (!hasQuote) {
    throw new Error(
      "This quote has nothing on it yet — pick the products or enter a monthly volume and average ticket before sending the link."
    );
  }

  const app: MerchantApplication = {
    id: `prospect_${now.getTime()}`,
    ownerUserId: effective.userId,
    customerUserId: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    // The link goes out with a quote already on it when the rep supplied a
    // basis or priced any lines; otherwise it opens on "your rep is preparing
    // your quote" — there is nothing for the customer to do until there is.
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
    // Nothing is confirmed and nothing is published at send time — the
    // merchant does both, from their own link. See the note above the
    // delivery block.
    detailsConfirmedAt: null,
    quoteNote,
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
    billingContact: input.billingContact ?? null,
    processing: input.processing ?? null,
    agreement: null,
  };

  await postgresStorage.saveApplication({ userId: effective.userId, role: effective.role }, app);

  // NOTHING IS PUBLISHED HERE (2026-10-15, product owner). The 10/13 reversal
  // that published the HubSpot quote at this exact point has itself been
  // reversed: a published quote cannot be edited, replaced or voided, so
  // publishing before the merchant has confirmed their own details froze the
  // rep's typo of a billing contact or an address onto a document nobody can
  // amend — and froze the rep out of their own quote the instant they sent
  // the link. The merchant now confirms at `/lead/[token]/confirm`, and THAT
  // is what opens the door (`/api/lead/[token]/checkout`). Until they do, this
  // quote stays editable, which is the point.

  // Best-effort — a failed resolution just means the email goes out without
  // the rep's name on it.
  const rep = await resolveReplyToRep(app.ownerUserId);

  // Best-effort from here — the prospect row is already saved, so a Resend or
  // Twilio hiccup must not undo it or block the response. The rep always has
  // the raw link to send by hand regardless of how these come back.
  const { emailResult, smsResult } = await deliverLeadLink(
    app.ownerContact!.email,
    link.url,
    app.business?.dba || app.business?.legalName,
    app.ownerContact!.phone,
    app.ownerContact!.altEmail,
    rep,
  );
  const companySync = await syncCompanyDetails(input.hubspotCompanyId, app);
  await syncBillingContact(input.billingContact, input.billingContactId);
  await mirrorQuoteNote(app, null);

  return { app, linkUrl: link.url, emailResult, smsResult, companySync };
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
 * Refuses once the merchant has confirmed their details (`detailsConfirmedAt`),
 * which is what publishes the quote, and goes on refusing at every later
 * marker. `quoteLines`/`quoteConfig` are frozen
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
  /**
   * The rep's note on this quote. Undefined keeps whatever the row already
   * has — a caller that doesn't offer the box must not erase one. Required
   * when the first charge doesn't sit on the plan's own default
   * (`quoteNoteBlockers`).
   */
  quoteNote?: string | null;
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

  // CONFIRMATION beats both of the others as the freeze point (2026-10-15).
  // The merchant confirming their own details is what BUILDS the HubSpot
  // quote, so it is strictly the earliest of the three markers: confirm →
  // publishedAt (seconds later) → quoteAcceptedAt (days later, when they sign
  // and pay). Checked first because it is the one that names what actually
  // happened — "the customer confirmed" rather than "a document exists" —
  // and because in the seconds between the two, or if the publish itself
  // failed and is waiting to be retried, `publishedAt` alone would let an
  // edit through on a quote the merchant has already signed off.
  //
  // This is also the promise the rep is given right up until this moment:
  // until the customer confirms, the quote is theirs to change.
  if (app.detailsConfirmedAt) {
    throw new Error(
      "The customer confirmed their details on " + new Date(app.detailsConfirmedAt).toLocaleDateString() +
      " and this quote is frozen — confirming is what published it to HubSpot, and a published " +
      "quote can't be edited, replaced or voided through the API. Start a new quote instead of " +
      "editing this one."
    );
  }

  // Published beats accepted as the freeze point. The quote goes out BEFORE
  // the merchant accepts it (acceptance is them signing and paying it on
  // HubSpot), so there is a window — sometimes days long — where the document
  // is live and unamendable but `quoteAcceptedAt` is still null. Editing our
  // copy in that window would silently desynchronize it from the one the
  // merchant is actually looking at. Kept beneath the confirmation check
  // above rather than replaced by it: rows published under the old
  // publish-at-send rule have no `detailsConfirmedAt` at all.
  if (app.hubspotIds?.publishedAt) {
    throw new Error(
      "This quote was sent to the merchant on " + new Date(app.hubspotIds.publishedAt).toLocaleDateString() +
      " and is frozen — a published HubSpot quote can't be edited, replaced or voided through " +
      "the API, so our copy has to keep matching the document they're signing. Start a new quote " +
      "instead of editing this one."
    );
  }

  const quoteType: QuoteType = quoteTypeOf(input.quoteType);

  const quoteConfig =
    input.quoteConfig && input.quoteConfig.monthlyVolume > 0 && input.quoteConfig.avgTicket > 0
      ? input.quoteConfig
      : app.quoteConfig;

  // Whether this quote carries a rate at all — same predicate EditQuotePanel
  // uses for its own floor preview. The statement isn't resubmitted on a save
  // (only the wizard's upload step sets it), so `app.analysis` is the basis,
  // same as `EditQuotePanel`'s `previewAnalysis`.
  const rated = quoteHasProcessing(quoteType, input.picks ?? [], input.adjustments ?? {});
  await assertRateAboveFloor(
    rated, app.analysis ?? null, quoteConfig ?? null,
    input.quoteRates ?? app.quoteRates ?? DEFAULT_QUOTE_RATES, input.pricingModel,
    processesCardNotPresentOnly(quoteType, input.picks ?? [], input.adjustments ?? {})
  );

  const quoteNote = input.quoteNote === undefined
    ? app.quoteNote ?? null
    : (input.quoteNote ?? "").trim() || null;
  const { quoteLines, orderPoints } = await deriveQuoteLines(
    quoteType, input.picks ?? [], input.channels ?? [], input.adjustments ?? {}, quoteNote
  );

  // A draft HubSpot quote from an earlier, failed publish is now describing a
  // quote that no longer exists. `buildAndPublishBillingQuote` pairs its saved
  // line-item ids with the CURRENT lines by position, so leaving them in place
  // would publish the old prices under the new quote. Forget them — and the
  // draft they hang off — so the next publish builds from what was just saved.
  let hubspotIds = app.hubspotIds;
  const staleDraft = hubspotIds && (hubspotIds.quoteId || hubspotIds.lineItemIds?.length);
  if (hubspotIds && staleDraft && JSON.stringify(quoteLines) !== JSON.stringify(app.quoteLines ?? [])) {
    // `publishedAt` being null does not prove the quote is a draft (a crash
    // between HubSpot's ack and our write leaves exactly that), so ask HubSpot.
    // Unknown is treated like "not a draft": abandoning a quote that might be
    // live is how a merchant ends up with two.
    if (hubspotIds.quoteId) {
      let status: string | null;
      try {
        const snapshot = await getQuoteSnapshot(hubspotIds.quoteId);
        status = snapshot ? snapshot.status : "DRAFT";
      } catch {
        throw new Error(
          "Couldn't confirm with HubSpot that this quote is still a draft, so it can't be edited right now. Try again in a moment."
        );
      }
      if (status && status !== "DRAFT") {
        throw new Error(
          `This quote already exists in HubSpot as ${status} and can't be edited from here. Check it in HubSpot before changing anything.`
        );
      }
    }
    for (const id of hubspotIds.lineItemIds ?? []) {
      try {
        await deleteQuoteLineItem(id);
      } catch (err) {
        // Orphaned line items are litter, not a hazard — they belong to no quote.
        console.error("saveQuoteConfigurationAction: could not delete stale line item", id, err);
      }
    }
    hubspotIds = { ...hubspotIds, quoteId: null, quoteTemplateId: null, lineItemIds: null, lastSyncError: null, lastSyncErrorAt: null };
  }

  const updated: MerchantApplication = {
    ...app,
    hubspotIds,
    quoteType,
    quoteConfig,
    quoteLines,
    orderPoints,
    quoteNote,
    quoteRates: input.quoteRates ?? app.quoteRates ?? DEFAULT_QUOTE_RATES,
    pricingModel: input.pricingModel,
    updatedAt: new Date().toISOString(),
  };
  await postgresStorage.saveApplication(scope, updated);
  await mirrorQuoteNote(updated, app.quoteNote ?? null);
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
  await syncCompanyDetails(updated.tenantLink?.hubspotCompanyId, updated);
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

  // Best-effort, same posture as every other lookup in this file — a failed
  // resolution just means this resend reads like every one sent before today.
  const rep = await resolveReplyToRep(updated.ownerUserId);

  const { emailResult, smsResult } = await deliverLeadLink(
    email,
    linkUrl,
    merchantName,
    updated.ownerContact?.phone,
    updated.ownerContact?.altEmail,
    rep,
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
export async function analysisFromQuoteConfigAction(
  config: QuoteConfig,
  /**
   * 0 for a merchant who takes orders online and has nothing on site, so the
   * synthesised split matches the rate they were actually quoted — see
   * `analysisFromQuoteConfig`'s own parameter. Omitted keeps the standing
   * 95% card-present assumption.
   */
  cardPresentPct?: number | null
): Promise<StatementAnalysis> {
  const effective = await getEffectiveRole();
  if (!effective) throw new Error("Not authenticated");
  if (!(config.avgTicket > 0) || !(config.monthlyVolume > 0)) {
    throw new Error("Enter both average ticket and monthly volume.");
  }
  return analysisFromQuoteConfig(config, cardPresentPct);
}
