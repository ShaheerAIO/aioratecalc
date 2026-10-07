"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createProspectAction, openProspectFromDealAction } from "@/lib/actions/prospects";
import ProductConfigurator, {
  type ConfiguredQuote,
  type ProductPick,
} from "@/components/quoting/ProductConfigurator";
import ReviewSection from "@/components/rep/ReviewSection";
import RateFields from "@/components/rep/RateFields";
import {
  mergeChannels,
  mergeReviewPrefill,
  NO_REVIEW_PREFILL_APPLIED,
  type AppliedReviewFields,
} from "@/lib/prefillMerge";
import { stripBlanks, validateOnboardingFields } from "@/lib/onboardingValidation";
import { ORDER_POINT_CHANNELS, quoteHasProcessing } from "@/lib/quoting";
import { DEFAULT_QUOTE_RATES, SELECTABLE_PRICING_MODELS } from "@/types/merchant";
import type { BusinessInfo, OwnerContact, ProcessingInfo, PricingModel, QuoteAdjustments, QuoteRates, QuoteType, StatementAnalysis } from "@/types/merchant";
import type { ProspectPrefill } from "@/lib/hubspotPrefill";
import { buildProspectPrefillForContact } from "@/lib/hubspotPrefill";
import type { HubspotCompanyProfile, HubspotContact, HubspotDeal } from "@/lib/adapters/hubspot";
import styles from "./prospects-new.module.css";

const BLANK_BUSINESS: BusinessInfo = {
  legalName: "", dba: "", bizType: "llc", address: "", city: "", state: "", zip: "",
  phone: "", website: "", yearsInBusiness: "", annualRevenue: "",
};
const BLANK_OWNER: OwnerContact = { firstName: "", lastName: "", title: "", email: "", phone: "" };
const BLANK_PROCESSING: ProcessingInfo = {
  monthlyVolume: "", avgTicket: "", cardPresentPct: "", mcc: "", businessDescription: "",
  previouslyTerminated: "no", bankruptcy: "no", currentProcessor: "",
};

function NewProspectFlow() {
  const searchParams = useSearchParams();
  // THE entry point. Every HubSpot deal carries an `easyob_link` pointing here
  // with its own id; the company is read OFF the deal, so there is no company
  // parameter to trust and no picker to disagree with it. A link that predates
  // this still carries ?hubspotCompanyId= — harmless and ignored.
  const hubspotDealId = searchParams.get("hubspotDealId");

  const [avgTicket, setAvgTicket]       = useState("");
  const [monthlyVolume, setMonthlyVolume] = useState("");
  const [quoteRates, setQuoteRates] = useState<QuoteRates>(DEFAULT_QUOTE_RATES);
  const [pricingModel, setPricingModel] = useState<PricingModel>("2-tier");
  // Shoulder-surfing guard: the margin target is AIO-internal, so it stays shut
  // until the rep opens it. The default above still applies while collapsed.
  const [linkUrl, setLinkUrl]           = useState<string | null>(null);
  const [emailSent, setEmailSent]       = useState(false);
  const [smsSent, setSmsSent]           = useState(false);
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
  // a marketing merchant who adds the Website sells through it, so they get
  // the ticket/volume inputs, the statement upload and a quoted rate — while
  // still getting none of the POS hardware, install lines or ordering points.
  const rated = quoteHasProcessing(quoteType, picks);

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

  const hardBlocks: string[] = [];
  if (!deal || !hubspotCompany) hardBlocks.push("Open this quote from its HubSpot deal before sending the link.");
  if (!business.legalName.trim()) hardBlocks.push("Enter the legal business name.");
  if (!ownerContact.email.trim()) hardBlocks.push("Enter the customer's contact email.");
  hardBlocks.push(...malformedMessages);
  hardBlocks.push(...quoteBlockers);

  const submit = async () => {
    const ticket = rated ? parseFloat(avgTicket) || 0 : 0;
    const volume = rated ? parseFloat(monthlyVolume) || 0 : 0;
    if ((ticket > 0) !== (volume > 0)) {
      setError("Enter both average ticket and monthly volume, or neither.");
      return;
    }
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
      const { linkUrl, emailResult, smsResult } = await createProspectAction({
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create prospect");
    }
    setSaving(false);
  };

  const reset = () => {
    setQuoteRates(DEFAULT_QUOTE_RATES); setPricingModel("2-tier");
    setAvgTicket(""); setMonthlyVolume(""); setFile(null); setAnalysis(null);
    setQuoteType("all_in_one"); setPicks([]); setChannels([]); setChannelsApplied([]); setQuote(null);
    setAdjustments({});
    setLinkUrl(null); setEmailSent(false); setSmsSent(false); setCopied(false); setError(null);
    clearDeal();
    setBusiness(BLANK_BUSINESS); setOwnerContact(BLANK_OWNER); setProcessing(BLANK_PROCESSING);
    setPrefill(null); setReviewApplied(NO_REVIEW_PREFILL_APPLIED); appliedRef.current = { review: NO_REVIEW_PREFILL_APPLIED, channels: [] };
  };

  // Matches the server's gate (hasQuoteBasis): a statement with no readable
  // volume is not a quote, so don't promise the customer one. On a
  // marketing-only quote the lines are the quote — there's no rate to have.
  const hasQuote = rated
    ? (analysis?.totalVolume ?? 0) > 0 || (parseFloat(avgTicket) > 0 && parseFloat(monthlyVolume) > 0)
    : picks.length > 0;

  const merchantName = business.dba || business.legalName;
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
          {emailSent ? `Emailed to ${ownerContact.email}.` : "Email delivery isn't configured yet — send this link yourself."}
        </p>
        {ownerContact.phone && (
          <p className={styles.prefillNote}>
            {smsSent ? `Texted to ${ownerContact.phone}.` : "Text delivery isn't configured yet — send this link yourself."}
          </p>
        )}
        <button onClick={reset} className={styles.btnGhost}>
          Create Another
        </button>
      </div>
    );
  }

  return (
    <div className={styles.main}>
      <h1 className={styles.headerTitle}>Send Customer a Quote Link</h1>
      <p className={styles.headerSubtitle}>
        Confirm what HubSpot already knows about this merchant, then set a margin target and either
        prepare the quote yourself or send the link bare and let them upload their own statement.
        Either way they see a quote at exactly this margin, with no cost breakdown and no account
        required.
      </p>

      {/* ── Section 1: The deal ──────────────────────────────────────────────
          A quote belongs to a deal, so the deal is where it starts. There is
          nothing to choose here on purpose: the company is whatever HubSpot
          says is on the deal, which is the only answer that can't attach a
          merchant's quote to a stranger's record.

          COLLAPSED BY DEFAULT. Arriving from the EasyOB Link on the deal is the
          normal path, and on that path this panel has nothing left to ask — it
          was taking the top of the page to restate an answer the rep already
          gave. With no deal on it the summary says so in the accent colour,
          and the hard block at the bottom of the page names the fix. */}
      {/* Collapsed by default, and uncontrolled — no `open` prop and no state.
          The normal path arrives from the EasyOB Link with the deal already
          resolved, so there is nothing to ask; the summary says which deal it
          is, and the rep opens the row on the rare occasion they need to
          change it. */}
      <details className={styles.dealPanel}>
        {/* The heading IS the control — clicking anywhere on this row opens
            the card. The chevron sits against the title rather than out at the
            far edge, so the two read as one thing to click. */}
        <summary className={styles.dealSummary}>
          <span className={styles.dealSummaryTitle}>HubSpot Deal</span>
          {/* An SVG rather than a "▾" glyph: the character renders far smaller
              than its font-size implies and sits off the baseline, so it can't
              be scaled up to the size this affordance needs. */}
          <svg
            className={styles.dealSummaryChevron}
            viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M5 9l7 7 7-7" />
          </svg>
          <span className={styles.dealSummaryValue} data-empty={!dealLoading && !deal ? "true" : undefined}>
            {dealLoading
              ? "Loading…"
              : deal && hubspotCompany
                ? `${deal.name} · ${hubspotCompany.name}`
                : "Not linked yet"}
          </span>
        </summary>

        <div className={styles.dealBody}>
          <p className={styles.sectionNote}>
            Open this page from the <strong>EasyOB Link</strong> on the deal in HubSpot. The
            customer link rides on that deal, and the company on it is what ties the merchant to
            their AIO tenant.
          </p>

          {deal && hubspotCompany ? (
            <p className={styles.hubspotBadge}>
              <strong>{deal.name}</strong> · {deal.stageLabel ?? "no stage"} — {hubspotCompany.name}{" "}
              ({hubspotCompany.id})
              <button type="button" className={styles.hubspotBadgeClear} onClick={clearDeal} aria-label="Use a different deal">
                ×
              </button>
            </p>
          ) : !dealLoading && (
            <div className={styles.field}>
              <label className={styles.label}>Paste the HubSpot deal link or id</label>
              <input
                value={dealInput}
                onChange={e => setDealInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); loadDeal(dealInput); } }}
                placeholder="https://app.hubspot.com/…/record/0-3/12345 or 12345"
                className={styles.input}
              />
              <button
                type="button"
                className={`${styles.btnGhost} ${styles.btnSm}`}
                disabled={!dealInput.trim()}
                onClick={() => loadDeal(dealInput)}
              >
                Open this deal
              </button>
            </div>
          )}

          {dealNotice && <div className={styles.error}>{dealNotice}</div>}
        </div>
      </details>

      {/* ── Section 2: Review What We Know ───────────────────────────────── */}
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Review What We Know</h2>
        <p className={styles.sectionNote}>
          Prefilled from HubSpot where a field is badged &ldquo;from HubSpot&rdquo; — everything here
          is editable, and whatever you change wins.
        </p>
      </div>
      <ReviewSection
        business={business}
        ownerContact={ownerContact}
        processing={processing}
        applied={reviewApplied}
        showProcessing={rated}
        onBusinessChange={setBusiness}
        onOwnerChange={setOwnerContact}
        onProcessingChange={setProcessing}
        contacts={contacts}
        selectedContactId={selectedContactId}
        onContactSelect={selectContact}
      />
      {missingWarnings.length > 0 && (
        <p className={styles.prefillNote}>
          The customer will have to fill these in themselves: {missingWarnings.join(", ")}.
        </p>
      )}

      {/* ── Section 3: Quote ─────────────────────────────────────────────── */}
      {/* A marketing-only quote has no processing behind it, so there
          is nothing to price against a statement — the products ARE the quote.

          The rates and the ticket/volume basis are ONE panel as of 2026-10-06.
          They were two, with the whole product configurator between them, so a
          rep set a rate on one screen and the volume it applies to on another
          and never saw the two together. The rule inside is what keeps
          "(optional)" attached to the basis alone: the rates always apply. */}
      {rated && (
      <div className={styles.panel}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Pricing</h2>
          <p className={styles.sectionNote}>
            What this merchant is charged, and what it&apos;s charged on.
          </p>
        </div>

        {/* Nothing to pick while 2-tier is the only sellable model, and a
            grid holding one option reads as a control that's broken rather
            than a decision already made. The rate fields below ARE the two
            tiers, so the model needs no separate statement. The picker comes
            back on its own if SELECTABLE_PRICING_MODELS ever grows. */}
        {SELECTABLE_PRICING_MODELS.length > 1 && (
          <>
            <label className={styles.label}>Pricing Model</label>
            <div className={styles.modelRow}>
              {SELECTABLE_PRICING_MODELS.map(m => (
                <button key={m} onClick={() => setPricingModel(m)} className={styles.modelPill} data-active={pricingModel === m}>
                  {m.replace("-", " ")}
                </button>
              ))}
            </div>
          </>
        )}

        {/* The quoted rates. Outside any AIO-internal disclosure, unlike the
            margin slider they replaced on 2026-10-06: a margin is an AIO
            number, a rate is what the merchant is quoted and will read on
            their own statement. */}
        <RateFields value={quoteRates} onChange={setQuoteRates} />

        <div className={styles.subhead}>
          <h3 className={styles.subheadTitle}>Quote basis (optional)</h3>
          <p className={styles.sectionNote}>
            Give us either the numbers or the statement and the customer opens the link straight to their
            quote. Leave both blank and they&apos;ll be asked to upload a statement first.
          </p>
        </div>

        <div className={styles.configRow}>
          <div className={styles.field}>
            <label className={styles.label}>Average Ticket</label>
            <input
              type="number" min="0" step="0.01" inputMode="decimal"
              value={avgTicket} onChange={e => setAvgTicket(e.target.value)}
              placeholder="35.00" className={styles.input}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Monthly Volume</label>
            <input
              type="number" min="0" step="100" inputMode="decimal"
              value={monthlyVolume} onChange={e => setMonthlyVolume(e.target.value)}
              placeholder="100000" className={styles.input}
            />
          </div>
        </div>

        <label className={styles.label}>Statement (optional — overrides the numbers above)</label>
        <div
          className={styles.dropzone}
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
            <p className={styles.dropzoneTitle}>Analyzing {file?.name}…</p>
          ) : analysis ? (
            <>
              <p className={styles.dropzoneTitle} data-state="done">✓ {file?.name}</p>
              <p className={styles.dropzoneSubtitle}>
                {analysis.merchantName || "Statement"} · read successfully · click to replace
              </p>
            </>
          ) : (
            <>
              <p className={styles.dropzoneTitle}>Drop their statement here or click to browse</p>
              <p className={styles.dropzoneSubtitle}>PDF or image · any processor format</p>
            </>
          )}
        </div>
      </div>
      )}

      <ProductConfigurator
        quoteType={quoteType}
        picks={picks}
        channels={channels}
        onQuoteTypeChange={setQuoteType}
        onPicksChange={setPicks}
        onChannelsChange={setChannels}
        onDerivedChange={setQuote}
        adjustments={adjustments}
        onAdjustmentsChange={setAdjustments}
      />
      {prefilledChannels.length > 0 && (
        <p className={styles.prefillNote}>
          Ordering channels ticked above from HubSpot: {prefilledChannels.join(", ")}.
        </p>
      )}

      {error && (
        <div className={styles.error}>
          {error}
        </div>
      )}

      <button onClick={submit} disabled={saving || analyzing || hardBlocks.length > 0} className={styles.btnPrimary}>
        {saving ? "Creating…" : hasQuote ? "Create Quote Link →" : "Create Link →"}
      </button>
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
