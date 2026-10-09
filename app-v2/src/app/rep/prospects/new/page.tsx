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
import { DecimalField, MoneyField } from "@/components/rep/NumberField";
import {
  mergeChannels,
  mergeReviewPrefill,
  NO_REVIEW_PREFILL_APPLIED,
  type AppliedReviewFields,
} from "@/lib/prefillMerge";
import { stripBlanks, validateOnboardingFields } from "@/lib/onboardingValidation";
import { getPricingPreviewAction } from "@/lib/actions/pricing";
import { ORDER_POINT_CHANNELS, quoteHasProcessing } from "@/lib/quoting";
import { fmt$ } from "@/lib/utils";
import { DEFAULT_QUOTE_RATES, MAX_PLAUSIBLE_CARD_RATE, SELECTABLE_PRICING_MODELS } from "@/types/merchant";
import type { BusinessInfo, OwnerContact, ProcessingInfo, PricingModel, QuoteAdjustments, QuoteRates, QuoteType, StatementAnalysis } from "@/types/merchant";
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
  legalName: "", dba: "", bizType: "llc", address: "", city: "", state: "", zip: "",
  phone: "", website: "", yearsInBusiness: "", annualRevenue: "",
};
const BLANK_OWNER: OwnerContact = { firstName: "", lastName: "", title: "", email: "", phone: "" };
const BLANK_PROCESSING: ProcessingInfo = {
  monthlyVolume: "", avgTicket: "", cardPresentPct: "95", mcc: "", businessDescription: "",
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
  // The four lanes collapse to one "x% + $y on every card" line until the rep
  // asks for them, or until they stop agreeing — then the grid stays open so a
  // lane that differs is never hidden behind a single figure.
  const [perCardOpen, setPerCardOpen]   = useState(false);
  // "Yes, $1.2M a month really is their volume." Reset by any edit to it.
  const [volumeConfirmed, setVolumeConfirmed] = useState(false);
  // The server's role-scoped view of what the typed rates earn. Reps see a
  // PADDED floor and never the number itself — this component only ever reads
  // the booleans, and `belowMarginFloor` is the one that refuses the send.
  const [floorCheck, setFloorCheck] = useState<{ belowMarginFloor: boolean } | null>(null);
  const [detailsOpen, setDetailsOpen]   = useState(false);
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
  const [quoteType, setQuoteType] = useState<QuoteType>("all_in_one");
  const [picks, setPicks]       = useState<ProductPick[]>([]);
  const [adjustments, setAdjustments] = useState<QuoteAdjustments>({});
  const [channels, setChannels] = useState<string[]>([]);
  const [channelsApplied, setChannelsApplied] = useState<string[]>([]);
  const [quote, setQuote]       = useState<ConfiguredQuote | null>(null);

  // A marketing-only quote has no processing behind it: no rate, no margin
  // target, no statement, no processing details in Review. The server drops
  // those fields for this type too — this is just not asking for them.
  // Whether this quote carries a RATE. Not the same as "is this a POS deal":
  // a marketing merchant whose Website takes online orders sells through it,
  // so they get the ticket/volume inputs, the statement upload and a quoted
  // rate — while still getting none of the POS hardware, install lines or
  // ordering points.
  const rated = quoteHasProcessing(quoteType, picks, adjustments);

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


  // Optional statement upload — the rep path through the same /api/analyze
  // route the proposal wizard uses. When it succeeds the analysis rides along
  // on the application, so the customer opens the link to a prepared quote.
  const [file, setFile]             = useState<File | null>(null);
  const [analysis, setAnalysis]     = useState<StatementAnalysis | null>(null);
  const [analyzing, setAnalyzing]   = useState(false);
  const [dragOver, setDragOver]     = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // A required line — the platform tier, or one of the always-included services
  // — is owed but the catalog didn't yield it. Blocks the save rather than
  // quietly shipping a quote with a hole in it; the server refuses it too.
  const quoteBlockers = quote?.blockers ?? [];

  const handleFile = (f: File) => {
    setFile(f);
    setAnalysis(null);
    setError(null);
    setAnalyzing(true);
    const r = new FileReader();
    r.onload = async e => {
      try {
        const fileData = (e.target!.result as string).split(",")[1];
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileData, mediaType: f.type }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Analysis failed");
        setAnalysis(data.analysis as StatementAnalysis);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Analysis failed");
        setFile(null);
      }
      setAnalyzing(false);
    };
    r.readAsDataURL(f);
  };

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

  const missingWarnings: string[] = [];
  if (!business.address.trim()) missingWarnings.push("street address");
  if (!business.city.trim()) missingWarnings.push("city");
  if (!business.state.trim()) missingWarnings.push("state");
  if (!business.zip.trim()) missingWarnings.push("ZIP");

  // ONE copy of the volume and the ticket: the processing record's. They used
  // to be asked twice — once under Processing Details, once as the quote basis
  // — and stored apart. A basis needs both; one alone (HubSpot often has the
  // volume and never the ticket) just means the customer uploads a statement.
  const ticket = rated ? parseFloat(processing.avgTicket) || 0 : 0;
  const volume = rated ? parseFloat(processing.monthlyVolume) || 0 : 0;
  const basisHalfSet = (ticket > 0) !== (volume > 0);
  const volumeLooksHigh = volume >= IMPLAUSIBLE_MONTHLY_VOLUME;

  const hardBlocks: string[] = [];
  if (!deal || !hubspotCompany) hardBlocks.push("Open this quote from its HubSpot deal before sending the link.");
  if (!business.legalName.trim()) hardBlocks.push("Enter the legal business name — HubSpot doesn't have it, and it's saved back to the company.");
  if (!ownerContact.email.trim()) hardBlocks.push("Enter the customer's contact email.");
  hardBlocks.push(...malformedMessages);
  hardBlocks.push(...quoteBlockers);
  if (floorCheck?.belowMarginFloor) {
    hardBlocks.push(
      "The card rate is below the minimum AIO can process this volume at. Raise it, or ask an admin to review the margin policy."
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
  // Only askable with a volume behind it — a statement, or the rep's own
  // volume/ticket. With neither there is no floor to clear, and the quote goes
  // out as a rate the customer's own statement will later be priced against.
  const hasFloorBasis = !!analysis || (volume > 0 && ticket > 0);
  useEffect(() => {
    if (!rated || !hasFloorBasis) { setFloorCheck(null); return; }
    let cancelled = false;
    const handle = setTimeout(() => {
      getPricingPreviewAction({
        analysis,
        quoteConfig: analysis ? null : { monthlyVolume: volume, avgTicket: ticket },
        quoteRates,
        pricingModel,
        feeOverrides: { monthlyFee: 0, perTxnFee: 0, cpPerTxnFee: 0, cnpPerTxnFee: 0 },
        activeTier: null,
      })
        .then(p => { if (!cancelled) setFloorCheck({ belowMarginFloor: p.belowMarginFloor }); })
        // A preview that can't be fetched must not block the send: the rep
        // would have no way to clear a blocker whose cause is a network error.
        .catch(() => { if (!cancelled) setFloorCheck(null); });
    }, 200);
    return () => { cancelled = true; clearTimeout(handle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rated, volume, ticket, analysis, quoteRates, pricingModel]);

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
        quoteRates, pricingModel, quoteType,
        quoteConfig: ticket > 0 && volume > 0 ? { avgTicket: ticket, monthlyVolume: volume } : null,
        analysis: rated ? analysis : null,
        // Only the picks cross the wire — prices and the tier are re-derived
        // server-side against the live catalog.
        picks,
        channels,
        adjustments,
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
    setFile(null); setAnalysis(null); setPerCardOpen(false); setDetailsOpen(false);
    setQuoteType("all_in_one"); setPicks([]); setChannels([]); setChannelsApplied([]); setQuote(null);
    setAdjustments({});
    setLinkUrl(null); setEmailSent(false); setSmsSent(false); setCompanySynced(true); setCopied(false); setError(null);
    clearDeal();
    setBusiness(BLANK_BUSINESS); setOwnerContact(BLANK_OWNER); setProcessing(BLANK_PROCESSING);
    setPrefill(null); setReviewApplied(NO_REVIEW_PREFILL_APPLIED); appliedRef.current = { review: NO_REVIEW_PREFILL_APPLIED, channels: [] };
  };

  // Matches the server's gate (hasQuoteBasis): a statement with no readable
  // volume is not a quote, so don't promise the customer one. On a
  // marketing-only quote the lines are the quote — there's no rate to have.
  const hasQuote = rated
    ? (analysis?.totalVolume ?? 0) > 0 || (ticket > 0 && volume > 0)
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
              Share this link with <strong>{merchantName}</strong> — they&apos;ll upload their own
              statement and get an instant quote, no account needed.
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

  // The rate line reads as one figure while all four lanes agree, which is
  // the normal 2-tier quote. Once they differ the per-card grid stays open:
  // collapsing it would show one number and charge four.
  const ratesUniform =
    quoteRates.cardNotPresentRate === quoteRates.cardPresentRate &&
    quoteRates.amexCardPresentRate === quoteRates.cardPresentRate &&
    quoteRates.amexCardNotPresentRate === quoteRates.cardPresentRate;
  const perCardShown = perCardOpen || !ratesUniform;
  const setEveryLane = (percent: number) => {
    const r = percent / 100;
    setQuoteRates({ ...quoteRates, cardPresentRate: r, cardNotPresentRate: r, amexCardPresentRate: r, amexCardNotPresentRate: r });
  };
  const oneRate = () => {
    setEveryLane(quoteRates.cardPresentRate * 100);
    setPerCardOpen(false);
  };

  // What the drawer holds, counted so its label says how much of it HubSpot
  // already answered. bizType and the yes/no questions always carry a value,
  // so counting them would report a form as further along than it is.
  const detailFields = [
    business.legalName, business.dba, business.address, business.city, business.state, business.zip,
    business.phone, business.website, business.yearsInBusiness,
    ownerContact.firstName, ownerContact.lastName, ownerContact.title, ownerContact.phone,
    ...(rated ? [processing.mcc, processing.currentProcessor] : []),
  ];
  const knownCount = detailFields.filter(v => v?.trim()).length;
  const merchantBlocked = !business.legalName.trim() || malformedMessages.length > 0;
  const openDetails = () => {
    setDetailsOpen(true);
    requestAnimationFrame(() => document.getElementById("merchant-details")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const dealContacts = contacts.filter(c => c.source === "deal");
  const companyContacts = contacts.filter(c => c.source !== "deal");
  const displayName = merchantName || hubspotCompany?.name || "";

  const statement = (
    <div
      className={`${styles.dropzone} ${styles.statementBox}`}
      data-state={analyzing ? "busy" : analysis ? "done" : dragOver ? "dragging" : undefined}
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
      onClick={() => { if (!analyzing) fileRef.current?.click(); }}
    >
      <input
        ref={fileRef} type="file" accept=".pdf,image/*" className={styles.fileInput}
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
      />
      {analyzing ? (
        <p className={styles.dropzoneTitle}>Reading {file?.name}…</p>
      ) : analysis ? (
        <>
          <p className={styles.dropzoneTitle} data-state="done">✓ {file?.name}</p>
          <p className={styles.dropzoneSubtitle}>Quote priced on this statement · click to replace</p>
        </>
      ) : (
        <>
          <p className={styles.dropzoneTitle}>Drop their statement</p>
          <p className={styles.dropzoneSubtitle}>PDF or image · prices the quote on their real numbers, overriding the volume and ticket above</p>
        </>
      )}
    </div>
  );

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

      <div className={styles.rateLine}>
        {perCardShown ? (
          <span className={styles.rateHint}>Set per card type</span>
        ) : (
          <>
            <span className={styles.affix}>
              <DecimalField
                value={Number(pct(quoteRates.cardPresentRate))}
                max={MAX_PLAUSIBLE_CARD_RATE * 100}
                onChange={setEveryLane}
                className={styles.rateInput}
                aria-label="Rate on every card, percent"
              />
              <span aria-hidden="true">%</span>
            </span>
            <span className={styles.rateHint}>+</span>
            <span className={styles.affix}>
              <span aria-hidden="true">$</span>
              <DecimalField
                value={quoteRates.perTransactionFee}
                onChange={perTransactionFee => setQuoteRates({ ...quoteRates, perTransactionFee })}
                className={styles.rateInput}
                aria-label="Per-transaction fee, dollars"
              />
            </span>
            <span className={styles.rateHint}>on every card</span>
          </>
        )}
        <button
          type="button"
          className={styles.linkBtn}
          onClick={() => (perCardShown ? oneRate() : setPerCardOpen(true))}
        >
          {perCardShown ? "Use one rate for every card" : "Set per card type"}
        </button>
      </div>
      {perCardShown && <RateFields value={quoteRates} onChange={setQuoteRates} hideNote />}

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
            <DecimalField
              value={parseFloat(processing.avgTicket) || 0}
              onChange={n => setProcessing({ ...processing, avgTicket: n ? String(n) : "" })}
              className={styles.rateInput}
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
      <p className={styles.prefillNote}>
        {analysis
          ? "The statement sets the volume their savings are figured on."
          : basisHalfSet
            ? `Add the ${volume > 0 ? "average ticket" : "monthly volume"} too — until both are set, the customer uploads a statement before they see a quote.`
            : hasQuote
              ? "The customer opens the link straight to this quote."
              : "Optional. Leave blank and the customer uploads a statement before they see a quote."}
      </p>
      {statement}
    </section>
  );

  const documentRate = rated && (
    <div className={styles.docRate}>
      <span className={styles.docRateLabel}>Card processing</span>
      <span className={styles.docRateValue}>
        {ratesUniform
          ? `${pct(quoteRates.cardPresentRate)}% + ${fmt$(quoteRates.perTransactionFee)} per transaction`
          : `${pct(quoteRates.cardPresentRate)}% in person · ${pct(quoteRates.cardNotPresentRate)}% online · Amex ${pct(quoteRates.amexCardPresentRate)}% / ${pct(quoteRates.amexCardNotPresentRate)}% · + ${fmt$(quoteRates.perTransactionFee)}`}
      </span>
      <span className={styles.docRateNote}>
        {analysis && (analysis.totalVolume ?? 0) > 0
          ? `Savings figured on their statement (${fmt$(analysis.totalVolume)}/mo)`
          : hasQuote
            ? `On about ${fmt$(volume)}/mo at a ${fmt$(ticket)} average ticket`
            : "They upload a statement to see their savings"}
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
      <button onClick={submit} disabled={saving || analyzing || hardBlocks.length > 0} className={`${styles.btnPrimary} ${styles.btnBlock}`}>
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

      <section id="merchant-details" className={styles.details}>
        <button
          type="button"
          className={styles.detailsToggle}
          aria-expanded={detailsOpen}
          aria-controls="merchant-details-body"
          onClick={() => setDetailsOpen(o => !o)}
        >
          <svg
            className={styles.detailsChevron}
            viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 5l7 7-7 7" />
          </svg>
          <span className={styles.detailsTitle}>Merchant details</span>
          <span className={styles.detailsMeta} data-warn={merchantBlocked ? "true" : undefined}>
            {merchantBlocked && !business.legalName.trim()
              ? "Legal name needed"
              : `${knownCount} of ${detailFields.length} known`}
          </span>
          <span className={styles.detailsNote}>The customer completes the rest on their onboarding form.</span>
        </button>
        {detailsOpen && (
          <div id="merchant-details-body" className={styles.detailsBody}>
            <MerchantDetailsForm
              business={business}
              ownerContact={ownerContact}
              processing={processing}
              applied={reviewApplied}
              showProcessing={rated}
              onBusinessChange={setBusiness}
              onOwnerChange={setOwnerContact}
              onProcessingChange={setProcessing}
            />
            {missingWarnings.length > 0 && (
              <p className={styles.prefillNote}>
                The customer will have to fill these in themselves: {missingWarnings.join(", ")}.
              </p>
            )}
          </div>
        )}
      </section>

      <ProductConfigurator
        layout="document"
        /* This is the only host that STARTS a quote, so it is the only one
           that gets the plan's opening position — the kit preselected and the
           60-day billing start. The panels that reopen a saved quote must not:
           an empty one there means a rate-only quote somebody built that way
           on purpose. */
        seedPlanDefaults
        quoteType={quoteType}
        picks={picks}
        channels={channels}
        onQuoteTypeChange={setQuoteType}
        onPicksChange={setPicks}
        onChannelsChange={setChannels}
        onDerivedChange={setQuote}
        adjustments={adjustments}
        onAdjustmentsChange={setAdjustments}
        buildSlot={ratePanel || undefined}
        documentHeader={
          <div className={styles.docHead}>
            <p className={styles.eyebrow}>Live quote · what {ownerContact.firstName.trim() || "the customer"} will see</p>
            <p className={styles.docTitle}>{displayName || "Merchant"}</p>
          </div>
        }
        documentRate={documentRate || undefined}
        documentFooter={documentFooter}
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
