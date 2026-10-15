"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createProspectAction, openProspectFromDealAction } from "@/lib/actions/prospects";
import ProductConfigurator, {
  type ConfiguredQuote,
  type ProductPick,
} from "@/components/quoting/ProductConfigurator";
import MerchantDetailsForm from "@/components/rep/MerchantDetailsForm";
import RateFields from "@/components/rep/RateFields";
import RateSuggestion from "@/components/rep/RateSuggestion";
import { DecimalMoneyField, MoneyField } from "@/components/rep/NumberField";
import {
  mergeChannels,
  mergeReviewPrefill,
  NO_REVIEW_PREFILL_APPLIED,
  type AppliedReviewFields,
} from "@/lib/prefillMerge";
import { stripBlanks, validateOnboardingFields } from "@/lib/onboardingValidation";
import { getPricingPreviewAction } from "@/lib/actions/pricing";
// Type-only — erased at build, never bundles pricing.ts's runtime code (the
// true MARGIN_REQS table) into this client page. See the comment on
// `floorCheck` below and the one on `marginFloorBlockers`'s hand-copied
// wording a few lines down, which explains why this file can't import
// pricing.ts for anything but its types.
import type { RoleScopedPricing } from "@/lib/pricing";
import { ORDER_POINT_CHANNELS, processesCardNotPresentOnly, quoteHasProcessing } from "@/lib/quoting";
import { fmt$ } from "@/lib/utils";
import {
  DEFAULT_CARD_PRESENT_PCT, DEFAULT_QUOTE_RATES, MIN_MONTHLY_PROCESSING_REVENUE, SELECTABLE_PRICING_MODELS,
} from "@/types/merchant";
import type { BusinessInfo, OwnerContact, ProcessingInfo, PricingModel, QuoteAdjustments, QuoteRates, QuoteType } from "@/types/merchant";
import type { ProspectPrefill } from "@/lib/hubspotPrefill";
import { buildProspectPrefillForContact, contactOptionLabel } from "@/lib/hubspotPrefill";
import type { HubspotCompanyProfile, HubspotContact, HubspotDeal } from "@/lib/adapters/hubspot";
import styles from "./prospects-new.module.css";

// A stored fraction as the percent a rep reads: 0.029 → "2.90". Always two
// decimals (2026-10-09) — trailing zeros used to be stripped, so 2.50% read
// "2.5" and 3.00% read "3", which is three shapes for one kind of number in
// the field where a tenfold typo hides best.
const pct = (f: number) => (f * 100).toFixed(2);

/**
 * A monthly volume this far above the top of AIO's margin table is almost
 * always an extra zero on a $120k restaurant, not a $1.2M one. Confirmed once
 * rather than refused, because some of them are real.
 */
const IMPLAUSIBLE_MONTHLY_VOLUME = 1_000_000;

/**
 * A monthly figure restated as the ANNUAL one, which is the number a rep can
 * sanity-check against the restaurant in front of them.
 *
 * It is monthly × 12. The first version of this divided the monthly figure by
 * a million and called the result "a year", so $1,234,567/month read as
 * "1.2M a year" — off by the twelve months and by the units, and wrong in the
 * direction that makes an implausible figure look reasonable, on the one
 * control whose whole job is to catch an implausible figure.
 */
const annualVolumeLabel = (monthly: number) => {
  const yearly = monthly * 12;
  return yearly >= 1_000_000_000
    ? `$${(yearly / 1_000_000_000).toFixed(1)}B`
    : `$${(yearly / 1_000_000).toFixed(1)}M`;
};

const BLANK_BUSINESS: BusinessInfo = {
  legalName: "", dba: "", bizType: "", address: "", city: "", state: "", zip: "",
  phone: "", website: "", yearsInBusiness: "", annualRevenue: "",
};
const BLANK_OWNER: OwnerContact = { firstName: "", lastName: "", title: "", email: "", phone: "" };
const BLANK_PROCESSING: ProcessingInfo = {
  // String(round(... * 100)), not a second "95" literal — see
  // DEFAULT_CARD_PRESENT_PCT's doc comment for why this used to disagree with
  // pricing.ts and PricingStep.tsx.
  monthlyVolume: "", avgTicket: "", cardPresentPct: String(Math.round(DEFAULT_CARD_PRESENT_PCT * 100)), mcc: "", businessDescription: "",
  previouslyTerminated: "no", bankruptcy: "no", currentProcessor: "",
};

function NewProspectFlow() {
  const searchParams = useSearchParams();
  // THE entry point. Every HubSpot deal carries an `easyob_link` pointing here
  // with its own id; the company is read OFF the deal, so there is no company
  // parameter to trust and no picker to disagree with it. A link that predates
  // this still carries ?hubspotCompanyId= — harmless and ignored.
  const hubspotDealId = searchParams.get("hubspotDealId");

  const [quoteRates, setQuoteRates] = useState<QuoteRates>(DEFAULT_QUOTE_RATES);
  const [pricingModel, setPricingModel] = useState<PricingModel>("2-tier");
  // "Yes, $1.2M a month really is their volume." Reset by any edit to it.
  const [volumeConfirmed, setVolumeConfirmed] = useState(false);
  // The server's role-scoped view of what the typed rates earn. Reps see a
  // PADDED floor and never the floor itself — `belowMarginFloor` is the one
  // boolean that refuses the send. `appliedTargetMargin`/`projectedCommission`
  // are kept too (2026-10-13 — "show the rep their margin on the quote
  // receipt"): both are already rep-safe on `RoleScopedPricing` (see its doc
  // comment — the margin is AIO's own forecast, not a secret, and the
  // commission is derived from it), so holding onto them here is no wider
  // than what this page already fetches.
  // `monthlyProcessingRevenue`/`processingArr`/`belowMonthlyRevenueFloor` are
  // the 2026-10-15 addition — rep-safe for the same reason the two above are
  // (see RoleScopedPricing's own doc comments), and they have to come from
  // here rather than from a local calculation because the wholesale table
  // they're built on sits behind pricing.ts.
  const [floorCheck, setFloorCheck] = useState<Pick<
    RoleScopedPricing,
    | "belowMarginFloor" | "appliedTargetMargin" | "projectedCommission"
    | "monthlyProcessingRevenue" | "processingArr" | "belowMonthlyRevenueFloor"
  > | null>(null);
  const [linkUrl, setLinkUrl]           = useState<string | null>(null);
  const [emailSent, setEmailSent]       = useState(false);
  const [smsSent, setSmsSent]           = useState(false);
  const [companySynced, setCompanySynced] = useState(true);
  const [copied, setCopied]             = useState(false);
  const [saving, setSaving]             = useState(false);
  const [error, setError]               = useState<string | null>(null);

  // Product configurator. The quote type, picks and channels are owned here;
  // the lines, ordering-point count and derived platform/service lines they
  // imply come back derived. Declared above the HubSpot block because the
  // prefill seeds `channels`.
  // NULL until the rep clicks a plan card. A new quote used to open on
  // all_in_one, which showed a highlighted plan over an empty cart whenever the
  // cart behind it failed to seed — and claimed an offer nobody had made.
  const [quoteType, setQuoteType] = useState<QuoteType | null>(null);
  const [picks, setPicks]       = useState<ProductPick[]>([]);
  const [adjustments, setAdjustments] = useState<QuoteAdjustments>({});
  // The rep's note on this quote — required once a first charge is held past
  // the plan's own 60 days, and mirrored onto the HubSpot deal on save.
  const [quoteNote, setQuoteNote] = useState("");
  const [channels, setChannels] = useState<string[]>([]);
  const [channelsApplied, setChannelsApplied] = useState<string[]>([]);
  const [quote, setQuote]       = useState<ConfiguredQuote | null>(null);

  // A marketing-only quote has no processing behind it: no rate, no margin
  // target, no processing details in Review. The server drops those fields
  // for this type too — this is just not asking for them.
  // Whether this quote carries a RATE. Not the same as "is this a POS deal":
  // a marketing merchant whose Website takes online orders sells through it,
  // so they get the ticket/volume inputs and a quoted rate — while still
  // getting none of the POS hardware, install lines or ordering points.
  const rated = quoteType !== null && quoteHasProcessing(quoteType, picks, adjustments);
  // Every sale is online, so there is no card-present rate to show anywhere
  // on this page — not in the boxes, not on the document preview.
  const cnpOnly = quoteType !== null && processesCardNotPresentOnly(quoteType, picks, adjustments);

  // ── Review What We Know — Business/OwnerContact/Processing, fully editable,
  // prefilled from the company on the deal — see prospects.ts's
  // createProspectAction for why the rep's own edits win over a server-side
  // re-merge on submit.
  const [business, setBusiness] = useState<BusinessInfo>(BLANK_BUSINESS);
  const [ownerContact, setOwnerContact] = useState<OwnerContact>(BLANK_OWNER);
  const [processing, setProcessing] = useState<ProcessingInfo>(BLANK_PROCESSING);
  const [reviewApplied, setReviewApplied] = useState<AppliedReviewFields>(NO_REVIEW_PREFILL_APPLIED);

  // The deal this quote is being built on, and the company HubSpot says it
  // belongs to. One load sets both — they are never chosen separately, so they
  // can never disagree.
  const [deal, setDeal]                     = useState<HubspotDeal | null>(null);
  const [hubspotCompany, setHubspotCompany] = useState<HubspotCompanyProfile | null>(null);
  const [dealNotice, setDealNotice]         = useState<string | null>(null);
  const [dealLoading, setDealLoading]       = useState(false);
  const [prefill, setPrefill]               = useState<ProspectPrefill | null>(null);
  // Every contact on the deal's company, and which one this quote is for. A
  // company with several has no "owner contact" we can honestly prefill, so
  // the rep picks (see ReviewSection's dropdown); only a company with exactly
  // one contact arrives with it already chosen.
  const [contacts, setContacts]                 = useState<HubspotContact[]>([]);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);

  // The Billing contact (2026-10-13) — optional, and separate from the owner
  // contact above: who AIO bills doesn't have to be who signs the quote (see
  // the constraint in CLAUDE.md on ownerContact.email staying the one and
  // only signer). Shares the SAME deal+company contact list the "Quote for"
  // dropdown reads from `contacts` above — no second portal-wide search.
  const [billingContactId, setBillingContactId] = useState<string | null>(null);
  const [billingContact, setBillingContact]     = useState<OwnerContact>(BLANK_OWNER);
  // The billing contact exactly as it was loaded from HubSpot when picked —
  // never touched after that — so MerchantDetailsForm can tell "the rep
  // edited this real contact" from "nothing's changed" and warn only in the
  // first case. Null whenever no existing contact is selected (including
  // "Same as owner contact", which clears billingContactId — see the
  // checkbox's own comment in MerchantDetailsForm.tsx for why).
  const [billingContactLoaded, setBillingContactLoaded] = useState<OwnerContact | null>(null);

  const selectBillingContact = (id: string | null) => {
    setBillingContactId(id);
    if (!id) { setBillingContactLoaded(null); return; } // "New contact" — leave whatever's already typed alone.
    const contact = contacts.find(c => c.id === id);
    if (!contact) { setBillingContactLoaded(null); return; }
    const loaded: OwnerContact = {
      firstName: contact.firstName ?? "", lastName: contact.lastName ?? "", title: "",
      email: contact.email ?? "", phone: contact.phone ?? "",
    };
    setBillingContact(loaded);
    setBillingContactLoaded(loaded);
  };

  // Latest form values, so applying a prefill from an async callback merges
  // against what's on screen now rather than whatever was there when the fetch
  // started. Same ref-mirror trick ProductConfigurator uses for its emit.
  const formRef    = useRef({ business, ownerContact, processing, channels });
  const appliedRef = useRef({ review: reviewApplied, channels: channelsApplied });
  useEffect(() => {
    formRef.current = { business, ownerContact, processing, channels };
    appliedRef.current = { review: reviewApplied, channels: channelsApplied };
  });

  // THE RULE (see prefillMerge.ts): HubSpot owns a field until the rep types in
  // it. Switching deals therefore REPLACES the previous company's values —
  // they were recorded as HubSpot's — while anything the rep typed survives.
  // Passing null (deal cleared / unreadable) withdraws what HubSpot filled.
  const applyPrefill = useCallback((next: ProspectPrefill | null) => {
    const { business: curBiz, ownerContact: curOwner, processing: curProc, channels: curChannels } = formRef.current;
    const merged = mergeReviewPrefill({ business: curBiz, ownerContact: curOwner, processing: curProc }, appliedRef.current.review, next);
    const channelsMerged = mergeChannels(curChannels, appliedRef.current.channels, next?.channels ?? []);

    setBusiness(merged.values.business);
    setOwnerContact(merged.values.ownerContact);
    setProcessing(merged.values.processing);
    setReviewApplied(merged.applied);
    setChannels(channelsMerged.channels);
    setChannelsApplied(channelsMerged.applied);
    setPrefill(next);

    // Kept in step immediately so two prefills in a row can't merge against a
    // pre-render snapshot.
    formRef.current = { business: merged.values.business, ownerContact: merged.values.ownerContact, processing: merged.values.processing, channels: channelsMerged.channels };
    appliedRef.current = { review: merged.applied, channels: channelsMerged.applied };
  }, []);

  // THE one load. A deal id in, and the deal + its company + the prefill all
  // come back together — see openProspectFromDealAction. Used by both entry
  // points, the deep link and the paste field, so neither can set up a state
  // the other couldn't.
  const dealRequestRef = useRef<string | null>(null);

  const loadDeal = useCallback((dealIdOrUrl: string) => {
    const key = dealIdOrUrl.trim();
    if (!key) return;
    dealRequestRef.current = key;
    setDealLoading(true);
    setDealNotice(null);
    openProspectFromDealAction(key)
      .then(res => {
        if (dealRequestRef.current !== key) return;
        if (!res.ok) {
          setDeal(null);
          setHubspotCompany(null);
          setContacts([]);
          setSelectedContactId(null);
          applyPrefill(null);
          setDealNotice(res.message);
          return;
        }
        setDeal(res.deal);
        setHubspotCompany(res.company);
        setContacts(res.contacts);
        setSelectedContactId(res.selectedContactId);
        applyPrefill(res.prefill);
      })
      .catch(e => {
        if (dealRequestRef.current !== key) return;
        setDealNotice(e instanceof Error ? e.message : "Could not reach HubSpot");
      })
      .finally(() => { if (dealRequestRef.current === key) setDealLoading(false); });
  }, [applyPrefill]);

  useEffect(() => {
    if (hubspotDealId) loadDeal(hubspotDealId);
  }, [hubspotDealId, loadDeal]);

  // The one way in without a deep link. NOT a picker: `getDealById` is a direct
  // GET, so unlike the old list-and-search it can't offer the wrong company's
  // deal and can't lag behind a deal created a minute ago. It exists for the
  // window between a rep creating a deal in HubSpot and the nightly cron
  // stamping its EasyOB link.
  const [dealInput, setDealInput] = useState("");

  const clearDeal = () => {
    dealRequestRef.current = null;
    setDeal(null);
    setHubspotCompany(null);
    setContacts([]);
    setSelectedContactId(null);
    setDealNotice(null);
    setDealInput("");
    setDealLoading(false);
    applyPrefill(null);
  };

  // The rep's pick from the contact dropdown. Re-applies the prefill with that
  // contact: HubSpot-filled owner fields are replaced by the new person's (or
  // cleared, for "no one"), while anything the rep typed themselves stays.
  const selectContact = (id: string | null) => {
    setSelectedContactId(id);
    applyPrefill(buildProspectPrefillForContact(hubspotCompany, contacts, id));
  };


  // A required line — the platform tier, or one of the always-included services
  // — is owed but the catalog didn't yield it. Blocks the save rather than
  // quietly shipping a quote with a hole in it; the server refuses it too.
  const quoteBlockers = quote?.blockers ?? [];

  // ── Block on malformed, warn on missing ─────────────────────────────────
  // A malformed value is worse than an absent one — it reaches the customer as
  // fact and 422s Adyen later — so it blocks. A merely missing (but otherwise
  // fine) address/city/state/zip only warns: the customer fills it in
  // themselves downstream, and this list IS the value of the step — it tells
  // the rep exactly how much work they're pushing onto the customer.
  // validateOnboardingFields is reused verbatim (see stripBlanks' doc comment
  // in onboardingValidation.ts) — no rule is duplicated here.
  const malformedErrors = validateOnboardingFields(stripBlanks({ business, ownerContact }));
  const malformedMessages = Object.values(malformedErrors);

  // The OPERATING address, which is the one HubSpot can supply. The legal
  // address is expected to be blank here — it is asked for on the customer's
  // own onboarding form, where it's required — so warning about it would
  // warn on every single prospect.
  const missingWarnings: string[] = [];
  if (!(business.dbaAddress ?? "").trim()) missingWarnings.push("street address");
  if (!(business.dbaCity ?? "").trim()) missingWarnings.push("city");
  if (!(business.dbaState ?? "").trim()) missingWarnings.push("state");
  if (!(business.dbaZip ?? "").trim()) missingWarnings.push("ZIP");

  // ONE copy of the volume and the ticket: the processing record's. They used
  // to be asked twice — once under Processing Details, once as the quote basis
  // — and stored apart. A basis needs both; one alone (HubSpot often has the
  // volume and never the ticket) just means the quote goes out with priced
  // lines and no rate, same as leaving both blank.
  const ticket = rated ? parseFloat(processing.avgTicket) || 0 : 0;
  const volume = rated ? parseFloat(processing.monthlyVolume) || 0 : 0;
  const basisHalfSet = (ticket > 0) !== (volume > 0);
  const volumeLooksHigh = volume >= IMPLAUSIBLE_MONTHLY_VOLUME;

  const hardBlocks: string[] = [];
  if (!deal || !hubspotCompany) hardBlocks.push("Open this quote from its HubSpot deal before sending the link.");
  if (!quoteType) hardBlocks.push("Pick a plan — it sets the platform fee and what can go on the quote.");
  if (!business.legalName.trim()) hardBlocks.push("Enter the legal business name — HubSpot doesn't have it, and it's saved back to the company.");
  if (!ownerContact.email.trim()) hardBlocks.push("Enter the customer's contact email.");
  hardBlocks.push(...malformedMessages);
  hardBlocks.push(...quoteBlockers);
  if (floorCheck?.belowMarginFloor) {
    // Kept as the SAME SENTENCE as the server refusal
    // (marginFloorBlockers, lib/pricing.ts) by hand, not by a shared call —
    // checked, not assumed: pricing.ts carries no "use server" directive, so
    // unlike the Server Actions this file already imports (createProspectAction,
    // getPricingPreviewAction, which compile down to an RPC stub), calling
    // marginFloorBlockers directly would bundle pricing.ts's plain module code
    // — MARGIN_REQS, the true minMargin table, included — into this client
    // page. That's exactly what DEFAULT_CARD_PRESENT_PCT and
    // MAX_PLAUSIBLE_CARD_RATE were moved out of pricing.ts to avoid (see their
    // doc comments in types/merchant.ts). So this is a literal, not a call —
    // if marginFloorBlockers' wording changes, this one has to change by hand
    // to match, and it must never imply an admin can do anything about it:
    // the margin-padding editor was deleted 2026-10-12 and there is no
    // override today (see marginFloorBlockers' doc comment).
    hardBlocks.push(
      "The card rate is below the minimum AIO can process this volume at. Raise the rate to send this quote."
    );
  }
  // The $10-a-month minimum (2026-10-15). A SECOND refusal, independent of the
  // one above — different margin, neither implies the other, and the server
  // re-runs both (`assertRateAboveFloor`). Unlike that one this message can
  // name its own figures: see `monthlyRevenueFloorBlockers` in pricing.ts for
  // why stating this number is safe, and why the sentence has to allow that
  // raising the rate may not be enough.
  if (floorCheck?.belowMonthlyRevenueFloor) {
    hardBlocks.push(
      `At this rate AIO earns ${fmt$(floorCheck.monthlyProcessingRevenue ?? 0)} a month on this ` +
      `merchant's processing, under the ${fmt$(MIN_MONTHLY_PROCESSING_REVENUE)} minimum. Raise the ` +
      `card rate, or this merchant is too small to process for.`
    );
  }
  // A LINK WITHOUT A QUOTE IS NOT SENDABLE (2026-10-15, product owner: "there
  // is no situation where the rep hasnt made the quote because they cant send
  // the initial link without making it"). Nothing enforced that before — an
  // All-in-One quote with nothing picked, no declared channels and no volume
  // resolves `none_needed` for its platform line and derives zero lines, so
  // the merchant got a link to "your quote is on its way".
  //
  // The condition is `hasQuoteBasis`'s, restated rather than called: that
  // helper lives in leadQuote.ts, which imports pricing.ts, and pulling
  // MARGIN_REQS and the true floor table into this client bundle is the exact
  // hazard the margin-floor block above is written the long way to avoid. A
  // fresh prospect has no statement, so its basis is either priced lines or
  // the rep's own volume AND ticket — and `createProspectAction` runs the real
  // `hasQuoteBasis` server-side regardless.
  if ((quote?.quoteLines.length ?? 0) === 0 && !(rated && volume > 0 && ticket > 0)) {
    hardBlocks.push(
      "This quote has nothing on it yet — pick the products, or enter a monthly volume and average ticket."
    );
  }
  // A confirmation, not a veto — but it has to be answered, or it is a banner
  // nobody reads. One click clears it, and the whole quote is priced on this
  // number: the rate, the savings and the floor above.
  if (volumeLooksHigh && !volumeConfirmed) {
    hardBlocks.push(`Confirm the monthly volume — ${fmt$(volume)} a month is unusually high for a restaurant.`);
  }


  // ── The card-rate minimum ─────────────────────────────────────────────────
  // A rate is too low when it doesn't clear AIO's margin floor for THIS
  // merchant's volume, which is a server-side question: the true floor lives
  // in pricing.ts and reps are shown a padded one, so the browser is told
  // "yes" or "no" and never the figure. Floor enforcement was dropped on
  // 2026-10-06 when rates replaced the margin input, leaving nothing to stop a
  // rep quoting under cost; "card rate minimums are needed" (2026-10-09) is
  // that decision reversed, against the same table it always used.
  //
  // Only askable with a volume behind it — the rep's own volume/ticket entry.
  // There's no statement path any more on either side (2026-10-13: the rep box
  // is gone here, and the customer was never given one to begin with), so with
  // neither set there is no floor to clear and the quote goes out with priced
  // lines and no rate at all.
  const hasFloorBasis = volume > 0 && ticket > 0;
  useEffect(() => {
    if (!rated || !hasFloorBasis) { setFloorCheck(null); return; }
    let cancelled = false;
    const handle = setTimeout(() => {
      getPricingPreviewAction({
        quoteConfig: { monthlyVolume: volume, avgTicket: ticket },
        quoteRates,
        pricingModel,
        feeOverrides: { monthlyFee: 0, perTxnFee: 0, cpPerTxnFee: 0, cnpPerTxnFee: 0 },
        activeTier: null,
        // Online-only: all of the volume is card-not-present, so the margin
        // and the floor are figured on the rate actually being quoted.
        cardPresentPct: cnpOnly ? 0 : null,
      })
        .then(p => {
          if (!cancelled) {
            setFloorCheck({
              belowMarginFloor: p.belowMarginFloor,
              appliedTargetMargin: p.appliedTargetMargin,
              projectedCommission: p.projectedCommission,
              monthlyProcessingRevenue: p.monthlyProcessingRevenue,
              processingArr: p.processingArr,
              belowMonthlyRevenueFloor: p.belowMonthlyRevenueFloor,
            });
          }
        })
        // A preview that can't be fetched must not block the send: the rep
        // would have no way to clear a blocker whose cause is a network error.
        .catch(() => { if (!cancelled) setFloorCheck(null); });
    }, 200);
    return () => { cancelled = true; clearTimeout(handle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rated, cnpOnly, volume, ticket, quoteRates, pricingModel]);

  const submit = async () => {
    if (hardBlocks.length) {
      setError(hardBlocks.join(" "));
      return;
    }
    if (!rated && !picks.length) {
      setError("A marketing-only quote needs at least one marketing product on it.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { linkUrl, emailResult, smsResult, companySync } = await createProspectAction({
        business, ownerContact, processing: rated ? processing : null,
        // Only sent when an email is actually on it — a blank "New contact"
        // section the rep never touched means no billing contact at all,
        // same as today.
        billingContact: billingContact.email.trim() ? billingContact : null,
        billingContactId,
        quoteRates, pricingModel, quoteType: quoteType!,
        quoteConfig: ticket > 0 && volume > 0 ? { avgTicket: ticket, monthlyVolume: volume } : null,
        // Only the picks cross the wire — prices and the tier are re-derived
        // server-side against the live catalog.
        picks,
        channels,
        adjustments,
        quoteNote,
        hubspotCompanyId: hubspotCompany!.id,
        // Always "existing": this page no longer creates deals. The deal came
        // from HubSpot and the server re-resolves it through the same
        // resolveDealForCompany that validated it on the way in.
        deal: { mode: "existing", dealId: deal!.id },
      });
      setLinkUrl(linkUrl);
      setEmailSent(emailResult.sent);
      setSmsSent(smsResult?.sent ?? false);
      setCompanySynced(companySync.synced);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create prospect");
    }
    setSaving(false);
  };

  const reset = () => {
    setQuoteRates(DEFAULT_QUOTE_RATES); setPricingModel("2-tier");
    setQuoteType(null); setPicks([]); setChannels([]); setChannelsApplied([]); setQuote(null);
    setAdjustments({});
    setLinkUrl(null); setEmailSent(false); setSmsSent(false); setCompanySynced(true); setCopied(false); setError(null);
    clearDeal();
    setBusiness(BLANK_BUSINESS); setOwnerContact(BLANK_OWNER); setProcessing(BLANK_PROCESSING);
    setBillingContactId(null); setBillingContact(BLANK_OWNER); setBillingContactLoaded(null);
    setPrefill(null); setReviewApplied(NO_REVIEW_PREFILL_APPLIED); appliedRef.current = { review: NO_REVIEW_PREFILL_APPLIED, channels: [] };
  };

  // Matches the server's gate (hasQuoteBasis): no volume/ticket on a rated
  // quote is not a basis for a rate, so don't promise the customer one. On a
  // marketing-only quote the lines are the quote — there's no rate to have.
  const hasQuote = rated
    ? (ticket > 0 && volume > 0)
    : picks.length > 0;

  const merchantName = business.dba || business.legalName;
  const altEmail = ownerContact.altEmail?.trim() ?? "";
  const recipients = [ownerContact.email.trim(), altEmail].filter(Boolean).join(" and ");
  const prefilledChannels = channelsApplied.map(
    id => ORDER_POINT_CHANNELS.find(c => c.id === id)?.label ?? id
  );


  if (linkUrl) {
    return (
      <div className={styles.successWrap}>
        <div className={styles.successMark}>✓</div>
        <h1 className={styles.successTitle}>Prospect Created</h1>
        <p className={styles.successBody}>
          {hasQuote ? (
            <>
              Share this link with <strong>{merchantName}</strong> — their quote is already
              prepared, so they see it the moment they open it.
            </>
          ) : (
            <>
              Share this link with <strong>{merchantName}</strong> — add their monthly volume and
              average ticket above whenever you have them, and their rate will appear on the quote.
            </>
          )}
        </p>
        <div className={`${styles.panel} ${styles.linkRow}`}>
          <code className={styles.linkCode}>{linkUrl}</code>
          <button
            onClick={() => { navigator.clipboard.writeText(linkUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
            className={styles.btnCopy}
            data-copied={copied}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <p className={styles.prefillNote}>
          {emailSent
            ? `Emailed to ${recipients}.`
            : "Email delivery isn't configured yet — send this link yourself."}
        </p>
        {ownerContact.phone && (
          <p className={styles.prefillNote}>
            {smsSent ? `Texted to ${ownerContact.phone}.` : "Text delivery isn't configured yet — send this link yourself."}
          </p>
        )}
        {!companySynced && (
          <p className={styles.prefillNote}>
            The legal name, processor and MCC didn&apos;t reach the HubSpot company — enter them there by hand.
          </p>
        )}
        <button onClick={reset} className={styles.btnGhost}>
          Create Another
        </button>
      </div>
    );
  }

  // What the card holds, counted so its header says how much of it HubSpot
  // already answered. bizType and the yes/no questions always carry a value,
  // so counting them would report a form as further along than it is.
  const detailFields = [
    business.legalName, business.dba,
    business.dbaAddress, business.dbaCity, business.dbaState, business.dbaZip,
    business.phone, business.website, business.yearsInBusiness,
    ownerContact.firstName, ownerContact.lastName, ownerContact.title, ownerContact.phone,
    ...(rated ? [processing.mcc, processing.currentProcessor] : []),
  ];
  const knownCount = detailFields.filter(v => v?.trim()).length;
  const merchantBlocked = !business.legalName.trim() || malformedMessages.length > 0;
  // The card is always open now, so this only has to bring it into view.
  const openDetails = () =>
    document.getElementById("merchant-details")?.scrollIntoView({ behavior: "smooth", block: "start" });

  const dealContacts = contacts.filter(c => c.source === "deal");
  const companyContacts = contacts.filter(c => c.source !== "deal");
  const displayName = merchantName || hubspotCompany?.name || "";
  // The Billing section's "use existing contact" dropdown — the exact same
  // roster as "Quote for" above, just restated as the plain {id, label}
  // shape MerchantDetailsForm takes (so it stays HubSpot-adapter-unaware).
  const billingContactOptions = contacts.map(c => ({ id: c.id, label: contactOptionLabel(c) }));

  // Sits under the plan cards: a processing quote's rate is part of the plan
  // being sold, so it's set where the plan is, not in a panel of its own.
  const ratePanel = rated && (
    <section className={styles.rateBlock} aria-labelledby="rate-head">
      <h3 id="rate-head" className={styles.blockHead}>Card rate</h3>

      {/* Nothing to pick while 2-tier is the only sellable model. The picker
          comes back on its own if SELECTABLE_PRICING_MODELS ever grows. */}
      {SELECTABLE_PRICING_MODELS.length > 1 && (
        <div className={styles.modelRow}>
          {SELECTABLE_PRICING_MODELS.map(m => (
            <button key={m} onClick={() => setPricingModel(m)} className={styles.modelPill} data-active={pricingModel === m}>
              {m.replace("-", " ")}
            </button>
          ))}
        </div>
      )}

      {/* The basis comes FIRST, above the rates (2026-10-15, product owner:
          "move monthly volume and avg ticket to sit above the rates"). They
          are what the rate is read off — the matrix picks a card-present rate
          from this volume and this ticket, and the revenue readout underneath
          is figured on them — so the panel now runs in the order the numbers
          are decided rather than putting its inputs under its outputs. */}
      <div className={styles.basisRow}>
        <label className={styles.field}>
          <span className={styles.label}>Monthly volume</span>
          <span className={styles.affix}>
            <span aria-hidden="true">$</span>
            <MoneyField
              value={processing.monthlyVolume}
              onChange={monthlyVolume => {
                setProcessing({ ...processing, monthlyVolume });
                // Re-asked whenever the figure changes, so correcting it to
                // another implausible one is questioned again.
                setVolumeConfirmed(false);
              }}
              placeholder="100,000" className={styles.rateInput}
              aria-label="Monthly card volume, dollars"
            />
          </span>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Average ticket</span>
          <span className={styles.affix}>
            <span aria-hidden="true">$</span>
            <DecimalMoneyField
              value={processing.avgTicket}
              onChange={avgTicket => setProcessing({ ...processing, avgTicket })}
              placeholder="22.50" className={styles.rateInput}
              aria-label="Average ticket, dollars"
            />
          </span>
        </label>
      </div>

      {/* A volume this large is nearly always an extra zero. Confirmed once,
          not refused — some restaurants really do run $1.2M a month, and the
          whole quote is priced on this number. */}
      {volumeLooksHigh && !volumeConfirmed && (
        <div className={styles.volumeCheck} role="alert">
          <span>
            {fmt$(volume)} a month is {annualVolumeLabel(volume)} a year — is that right?
            The rate, the savings and the margin floor are all figured on it.
          </span>
          <button type="button" className={styles.linkBtn} onClick={() => setVolumeConfirmed(true)}>
            Yes, that&apos;s right
          </button>
        </div>
      )}

      {/* Card present is rep-editable; card not present is locked to AIO's
          rate card and renders disabled — see RateFields.tsx. There's no
          "one rate for every card" collapse any more (2026-10-13): that
          relied on being able to set the CNP lane to match, which locking it
          rules out. */}
      {/* freshQuote: this page always starts a new quote at the flat
          standard rate, often before a volume/ticket basis exists — see
          RateFields.tsx's doc comment on that prop. */}
      <RateFields value={quoteRates} onChange={setQuoteRates} hideNote freshQuote cardNotPresentOnly={cnpOnly} />
      {/* Sits under the boxes rather than above them: the rep reads the rate
          they're quoting first, and what the card would have said second. It
          now ALWAYS applies what it suggests (2026-10-13, "get rid of the
          'use it' and make it always override") — see RateSuggestion.tsx. */}
      <RateSuggestion
        monthlyVolume={volume}
        avgTicket={ticket}
        value={quoteRates}
        onChange={setQuoteRates}
      />

      {/* What the rate the rep just typed is worth to AIO (2026-10-15, product
          owner: "show montly revenue and yearly arr in the card rate box").
          Directly under the boxes, because it is the one thing on this screen
          that moves when they change — and because the $10 minimum below is
          otherwise a refusal with nothing to steer by.

          Both figures come from the SERVER's role-scoped preview, never
          derived here: the wholesale table they're built on lives behind
          pricing.ts, which a client page must not import (see `floorCheck`). */}
      {floorCheck?.monthlyProcessingRevenue != null && (
        <div className={styles.revenueRow} data-below={floorCheck.belowMonthlyRevenueFloor || undefined}>
          <span className={styles.revenueCell}>
            <span className={styles.revenueLabel}>AIO monthly revenue</span>
            <span className={styles.revenueValue}>{fmt$(floorCheck.monthlyProcessingRevenue)}</span>
          </span>
          <span className={styles.revenueCell}>
            <span className={styles.revenueLabel}>Yearly ARR</span>
            <span className={styles.revenueValue}>{fmt$(floorCheck.processingArr ?? 0)}</span>
          </span>
        </div>
      )}
      {floorCheck?.belowMonthlyRevenueFloor && (
        <p className={styles.revenueFloorNote} role="alert">
          Under the {fmt$(MIN_MONTHLY_PROCESSING_REVENUE)} a month AIO processes for. Raise the
          card-present rate, or this merchant is too small to board.
        </p>
      )}

      <p className={styles.prefillNote}>
        {basisHalfSet
          ? `Add the ${volume > 0 ? "average ticket" : "monthly volume"} too — until both are set, this quote has no rate on it.`
          : hasQuote
            ? "The customer opens the link straight to this quote."
            : "Optional. Leave both blank and this quote has no rate on it — the customer sees whatever's already priced, or that the quote is still being prepared if nothing is."}
      </p>
    </section>
  );

  const documentRate = rated && (
    <div className={styles.docRate}>
      <span className={styles.docRateLabel}>Card processing</span>
      {/* "card present" / "card not present", never "in person" / "online"
          (2026-10-14): a cashier keying a card in by hand is standing in
          front of the customer and is still card-not-present, so the
          in-person framing names the wrong thing. One vocabulary everywhere
          a rate is shown. */}
      {/* ONE LANE PER LINE (product owner, 2026-10-14). Run together and
          separated by middots, the two rates were a single sentence that
          broke wherever the column happened to end — and splitting that
          sentence in a fixed place only moved the break. A lane is a row:
          what it is on the left, what it costs on the right, the same shape
          the rate editor on the other side of this screen uses. The
          per-transaction fee is restated on each row rather than hoisted out
          — it applies to both, and a merchant reading one row should see the
          whole price of that lane. */}
      <div className={styles.docRateRows}>
        {!cnpOnly && (
          <div className={styles.docRateRow}>
            <span className={styles.docRateLane}>Card present</span>
            <span className={styles.docRateValue}>
              {pct(quoteRates.cardPresentRate)}% + {fmt$(quoteRates.perTransactionFee)} per transaction
            </span>
          </div>
        )}
        <div className={styles.docRateRow}>
          <span className={styles.docRateLane}>Card not present</span>
          <span className={styles.docRateValue}>
            {pct(quoteRates.cardNotPresentRate)}% + {fmt$(quoteRates.perTransactionFee)} per transaction
          </span>
        </div>
      </div>
      <span className={styles.docRateNote}>
        {cnpOnly
          ? "They take orders online and nowhere else, so every sale is card-not-present."
          : hasQuote
            ? `On about ${fmt$(volume)}/mo at a ${fmt$(ticket)} average ticket`
            : "Add their monthly volume and average ticket above to quote this"}
      </span>
    </div>
  );

  const documentFooter = (
    <div className={styles.sendBlock}>
      {hardBlocks.length > 0 && (
        <div className={styles.blocks}>
          <p className={styles.blocksTitle}>Before you can send</p>
          <ul>
            {hardBlocks.map(b => <li key={b}>{b}</li>)}
          </ul>
          {merchantBlocked && (
            <button type="button" className={styles.linkBtn} onClick={openDetails}>
              Open merchant details
            </button>
          )}
        </div>
      )}
      {error && <div className={styles.error}>{error}</div>}
      <button onClick={submit} disabled={saving || hardBlocks.length > 0} className={`${styles.btnPrimary} ${styles.btnBlock}`}>
        {saving ? "Creating…" : hasQuote ? "Create Quote Link →" : "Create Link →"}
      </button>
      {ownerContact.email.trim() && (
        <p className={styles.sendNote}>
          Emailed to {recipients}
          {ownerContact.phone.trim() ? ` and texted to ${ownerContact.phone.trim()}` : ""}.
        </p>
      )}
    </div>
  );

  return (
    <div className={styles.workspace}>
      {/* The merchant, reduced to what the quote needs: who it's for and where
          it goes. Everything else HubSpot knows (or doesn't) is in the drawer
          below, because the customer completes it on their own onboarding
          form and none of it changes the price. */}
      <header className={styles.merchantBar}>
        <div className={styles.identity}>
          <p className={styles.eyebrow} data-empty={!dealLoading && !deal ? "true" : undefined}>
            {dealLoading
              ? "Loading HubSpot deal…"
              : deal && hubspotCompany
                ? `HubSpot deal · ${deal.name} · ${deal.stageLabel ?? "no stage"}`
                : "No HubSpot deal linked"}
            {deal && (
              <button type="button" className={styles.linkBtn} onClick={clearDeal}>Change</button>
            )}
          </p>
          <h1 className={styles.merchantName}>{displayName || "New quote link"}</h1>
        </div>

        {!deal && !dealLoading && (
          <div className={styles.dealPaste}>
            <label className={styles.field}>
              <span className={styles.label}>Open from the EasyOB Link on the deal, or paste it here</span>
              <input
                value={dealInput}
                onChange={e => setDealInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); loadDeal(dealInput); } }}
                placeholder="https://app.hubspot.com/…/record/0-3/12345 or 12345"
                className={styles.input}
              />
            </label>
            <button
              type="button"
              className={`${styles.btnGhost} ${styles.btnSm}`}
              disabled={!dealInput.trim()}
              onClick={() => loadDeal(dealInput)}
            >
              Open deal
            </button>
          </div>
        )}
          <div className={styles.recipient}>
            {contacts.length > 0 && (
              <label className={styles.field}>
                <span className={styles.label}>Quote for</span>
                <select
                  value={selectedContactId ?? ""}
                  onChange={e => selectContact(e.target.value || null)}
                  className={styles.input}
                >
                  <option value="">{contacts.length > 1 ? "Select a contact…" : "Enter manually"}</option>
                  {dealContacts.length > 0 && companyContacts.length > 0 ? (
                    <>
                      <optgroup label="On this deal">
                        {dealContacts.map(c => <option key={c.id} value={c.id}>{contactOptionLabel(c)}</option>)}
                      </optgroup>
                      <optgroup label="On the company">
                        {companyContacts.map(c => <option key={c.id} value={c.id}>{contactOptionLabel(c)}</option>)}
                      </optgroup>
                    </>
                  ) : (
                    contacts.map(c => <option key={c.id} value={c.id}>{contactOptionLabel(c)}</option>)
                  )}
                </select>
              </label>
            )}
            <label className={styles.field}>
              <span className={styles.label}>Send to</span>
              <input
                type="email"
                value={ownerContact.email}
                onChange={e => setOwnerContact({ ...ownerContact, email: e.target.value })}
                placeholder="owner@business.com"
                className={styles.input}
              />
            </label>
            <label className={`${styles.field} ${styles.altEmail}`}>
              <span className={styles.label}>Also send to <em>(optional)</em></span>
              <input
                type="email"
                value={ownerContact.altEmail ?? ""}
                onChange={e => setOwnerContact({ ...ownerContact, altEmail: e.target.value })}
                placeholder="partner@business.com"
                className={styles.input}
              />
            </label>
          </div>
      </header>

      {dealNotice && <div className={styles.error}>{dealNotice}</div>}

      {/* A card, not a drawer (product owner, 2026-10-12). Folded away, the
          legal name — the one hard block on this page the rep alone can clear
          — sat behind a click, and the count on the header was the only hint
          anything was missing. */}
      <section id="merchant-details" className={styles.details}>
        <div className={styles.detailsHead}>
          <h2 className={styles.detailsTitle}>Merchant details</h2>
          <span className={styles.detailsMeta} data-warn={merchantBlocked ? "true" : undefined}>
            {merchantBlocked && !business.legalName.trim()
              ? "Legal name needed"
              : `${knownCount} of ${detailFields.length} known`}
          </span>
          <span className={styles.detailsNote}>The customer completes the rest on their onboarding form.</span>
        </div>
        <div className={styles.detailsBody}>
          <MerchantDetailsForm
            business={business}
            ownerContact={ownerContact}
            processing={processing}
            applied={reviewApplied}
            showProcessing={rated}
            onBusinessChange={setBusiness}
            onOwnerChange={setOwnerContact}
            onProcessingChange={setProcessing}
            contactOptions={billingContactOptions}
            billingContactId={billingContactId}
            billing={billingContact}
            billingContactLoaded={billingContactLoaded}
            onBillingContactIdChange={selectBillingContact}
            onBillingChange={setBillingContact}
          />
          {missingWarnings.length > 0 && (
            <p className={styles.prefillNote}>
              The customer will have to fill these in themselves: {missingWarnings.join(", ")}.
            </p>
          )}
        </div>
      </section>

      <ProductConfigurator
        layout="document"
        /* This is the only host that STARTS a quote, so it is the only one
           that can be sitting on no plan at all — everything else reopens one
           that was already chosen. Clicking a card is what seeds its kit, its
           included hardware and the 60-day billing start. */
        quoteType={quoteType}
        picks={picks}
        channels={channels}
        onQuoteTypeChange={setQuoteType}
        onPicksChange={setPicks}
        onChannelsChange={setChannels}
        onDerivedChange={setQuote}
        adjustments={adjustments}
        onAdjustmentsChange={setAdjustments}
        note={quoteNote}
        onNoteChange={setQuoteNote}
        buildSlot={ratePanel || undefined}
        documentHeader={
          <div className={styles.docHead}>
            <p className={styles.eyebrow}>Live quote · what {ownerContact.firstName.trim() || "the customer"} will see</p>
            <p className={styles.docTitle}>{displayName || "Merchant"}</p>
          </div>
        }
        documentRate={documentRate || undefined}
        documentFooter={documentFooter}
        // NOTE: this host renders ProductConfigurator with layout="document"
        // — the "Live quote · what the customer will see" mirror — which
        // builds its own totals block and never renders QuoteReceipt (the
        // panels-layout side panel this prop feeds). So passing it here
        // plumbs the already-fetched preview through end to end, but has no
        // visible effect on THIS host today. Deliberately not rendering it
        // inside the document mirror itself: that block is a stand-in for
        // what the merchant's own quote page shows, and AIO's margin has no
        // business appearing inside something framed that way, even though
        // nothing here is reachable by an actual customer. See this task's
        // final report for the follow-up this implies.
        pricingPreview={floorCheck}
      />
      {prefilledChannels.length > 0 && (
        <p className={styles.prefillNote}>
          Ordering channels ticked from HubSpot: {prefilledChannels.join(", ")}.
        </p>
      )}
    </div>
  );
}

export default function NewProspectPage() {
  return (
    <Suspense>
      <NewProspectFlow />
    </Suspense>
  );
}
