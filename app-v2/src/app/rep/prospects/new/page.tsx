"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createProspectAction, getHubspotCompanyForProspectAction } from "@/lib/actions/prospects";
import { searchTenantCompaniesAction } from "@/lib/actions/applications";
import ProductConfigurator, {
  type ConfiguredQuote,
  type ProductPick,
} from "@/components/quoting/ProductConfigurator";
import DealPicker, { type ResolvedDeal } from "@/components/rep/DealPicker";
import ReviewSection from "@/components/rep/ReviewSection";
import {
  mergeChannels,
  mergeReviewPrefill,
  NO_REVIEW_PREFILL_APPLIED,
  type AppliedReviewFields,
} from "@/lib/prefillMerge";
import { stripBlanks, validateOnboardingFields } from "@/lib/onboardingValidation";
import { ORDER_POINT_CHANNELS, isProcessingQuote } from "@/lib/quoting";
import { fmtPct2 } from "@/lib/utils";
import type { BusinessInfo, OwnerContact, ProcessingInfo, PricingModel, QuoteAdjustments, QuoteType, StatementAnalysis } from "@/types/merchant";
import type { ProspectPrefill } from "@/lib/hubspotPrefill";
import type { TenantCompany } from "@/lib/adapters/hubspot";
import styles from "./prospects-new.module.css";

const MODELS: PricingModel[] = ["flat-rate", "2-tier", "interchange-plus"];

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
  const hubspotCompanyId = searchParams.get("hubspotCompanyId");

  const [avgTicket, setAvgTicket]       = useState("");
  const [monthlyVolume, setMonthlyVolume] = useState("");
  const [targetMargin, setTargetMargin] = useState(0.008);
  const [pricingModel, setPricingModel] = useState<PricingModel>("2-tier");
  // Shoulder-surfing guard: the margin target is AIO-internal, so it stays shut
  // until the rep opens it. The default above still applies while collapsed.
  const [internalOpen, setInternalOpen] = useState(false);
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
  const [quoteType, setQuoteType] = useState<QuoteType>("full_pos");
  const [picks, setPicks]       = useState<ProductPick[]>([]);
  const [adjustments, setAdjustments] = useState<QuoteAdjustments>({});
  const [channels, setChannels] = useState<string[]>([]);
  const [channelsApplied, setChannelsApplied] = useState<string[]>([]);
  const [quote, setQuote]       = useState<ConfiguredQuote | null>(null);

  // A marketing-only quote has no processing behind it: no rate, no margin
  // target, no statement, no processing details in Review. The server drops
  // those fields for this type too — this is just not asking for them.
  const rated = isProcessingQuote(quoteType);

  // ── Review What We Know — Business/OwnerContact/Processing, fully editable,
  // prefilled from whatever HubSpot company is linked. Company is now a
  // required part of this form (see the Company & Deal section below) rather
  // than an optional deep-link enrichment — see prospects.ts's
  // createProspectAction for why the rep's own edits win over a server-side
  // re-merge on submit.
  const [business, setBusiness] = useState<BusinessInfo>(BLANK_BUSINESS);
  const [ownerContact, setOwnerContact] = useState<OwnerContact>(BLANK_OWNER);
  const [processing, setProcessing] = useState<ProcessingInfo>(BLANK_PROCESSING);
  const [reviewApplied, setReviewApplied] = useState<AppliedReviewFields>(NO_REVIEW_PREFILL_APPLIED);

  const [hubspotCompany, setHubspotCompany]   = useState<TenantCompany | null>(null);
  const [hubspotNotice, setHubspotNotice]     = useState<string | null>(null);
  const [prefill, setPrefill]                 = useState<ProspectPrefill | null>(null);
  const [prefillLoading, setPrefillLoading]   = useState(false);

  // The deal picked (or created) for the linked company — see DealPicker.
  // Cleared whenever the company changes, since a deal belongs to exactly one
  // company and a stale resolution from a previous company must not survive
  // the switch.
  const [dealResolved, setDealResolved] = useState<ResolvedDeal | null>(null);

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
  // it. Switching companies therefore REPLACES the previous company's values —
  // they were recorded as HubSpot's — while anything the rep typed survives.
  // Passing null (company cleared / unreadable) withdraws what HubSpot filled.
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

  useEffect(() => {
    if (!hubspotCompanyId) return;
    let cancelled = false;
    getHubspotCompanyForProspectAction(hubspotCompanyId)
      .then(res => {
        if (cancelled) return;
        if (res.company) {
          setHubspotCompany(res.company);
          setDealResolved(null);
          applyPrefill(res.prefill);
        }
        if (res.error) setHubspotNotice(res.error);
      })
      .catch(e => { if (!cancelled) setHubspotNotice(e instanceof Error ? e.message : "Could not reach HubSpot"); });
    return () => { cancelled = true; };
  }, [hubspotCompanyId, applyPrefill]);

  // HubSpot deprecated classic CRM cards, so there's no "start from HubSpot"
  // button anymore — the flow inverts: start here, find the company. This is
  // a second way to set the SAME `hubspotCompany` state the deep link sets;
  // everything downstream (prefill, badges, deal picker, submit) is shared.
  const [hubspotQuery, setHubspotQuery]         = useState("");
  const [hubspotResults, setHubspotResults]     = useState<TenantCompany[]>([]);
  const [hubspotSearching, setHubspotSearching] = useState(false);
  const [hubspotSearchError, setHubspotSearchError] = useState<string | null>(null);

  useEffect(() => {
    const q = hubspotQuery.trim();
    if (q.length < 2) { setHubspotResults([]); setHubspotSearching(false); setHubspotSearchError(null); return; }
    setHubspotSearching(true);
    let cancelled = false;
    const t = setTimeout(() => {
      searchTenantCompaniesAction(q)
        .then(r => { if (!cancelled) { setHubspotResults(r); setHubspotSearchError(null); } })
        .catch(e => { if (!cancelled) { setHubspotResults([]); setHubspotSearchError(e instanceof Error ? e.message : "Could not reach HubSpot"); } })
        .finally(() => { if (!cancelled) setHubspotSearching(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [hubspotQuery]);

  // The search result is only a TenantCompany — the prefill needs the full
  // profile plus the owner contact, so the picker takes the same server round
  // trip the deep link does. The badge appears immediately from the search row;
  // the prefill lands when the read returns.
  // Two picks in quick succession: the loser's response must not land on top of
  // the winner's prefill.
  const prefillRequestRef = useRef<string | null>(null);

  const selectHubspotCompany = (company: TenantCompany) => {
    setHubspotCompany(company);
    setHubspotNotice(null);
    setHubspotQuery("");
    setHubspotResults([]);
    setDealResolved(null);
    setPrefillLoading(true);
    prefillRequestRef.current = company.id;
    getHubspotCompanyForProspectAction(company.id)
      .then(res => {
        if (prefillRequestRef.current !== company.id) return;
        applyPrefill(res.prefill);
        if (res.error) setHubspotNotice(res.error);
      })
      .catch(e => {
        if (prefillRequestRef.current === company.id) {
          setHubspotNotice(e instanceof Error ? e.message : "Could not reach HubSpot");
        }
      })
      .finally(() => { if (prefillRequestRef.current === company.id) setPrefillLoading(false); });
  };

  const clearHubspotCompany = () => {
    setHubspotCompany(null);
    setHubspotNotice(null);
    setDealResolved(null);
    prefillRequestRef.current = null;
    setPrefillLoading(false);
    applyPrefill(null);
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
  if (!hubspotCompany) hardBlocks.push("Link a HubSpot company before sending this link.");
  if (hubspotCompany && !dealResolved) hardBlocks.push("Pick or create a HubSpot deal for this company.");
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
        targetMargin, pricingModel, quoteType,
        quoteConfig: ticket > 0 && volume > 0 ? { avgTicket: ticket, monthlyVolume: volume } : null,
        analysis: rated ? analysis : null,
        // Only the picks cross the wire — prices and the tier are re-derived
        // server-side against the live catalog.
        picks,
        channels,
        adjustments,
        hubspotCompanyId: hubspotCompany!.id,
        deal: dealResolved!.choice,
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
    setTargetMargin(0.008); setPricingModel("2-tier");
    setAvgTicket(""); setMonthlyVolume(""); setFile(null); setAnalysis(null);
    setQuoteType("full_pos"); setPicks([]); setChannels([]); setChannelsApplied([]); setQuote(null);
    setAdjustments({});
    setLinkUrl(null); setEmailSent(false); setSmsSent(false); setCopied(false); setError(null);
    setHubspotCompany(null); setHubspotNotice(null); setDealResolved(null);
    setBusiness(BLANK_BUSINESS); setOwnerContact(BLANK_OWNER); setProcessing(BLANK_PROCESSING);
    setPrefill(null); setReviewApplied(NO_REVIEW_PREFILL_APPLIED); appliedRef.current = { review: NO_REVIEW_PREFILL_APPLIED, channels: [] };
    setHubspotQuery(""); setHubspotResults([]); setHubspotSearchError(null);
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
        Find the company and its deal in HubSpot, confirm what it already knows about the merchant,
        then set a margin target and either prepare the quote yourself or send the link bare and let
        them upload their own statement. Either way they see a quote at exactly this margin, with no
        cost breakdown and no account required.
      </p>

      {/* ── Section 1: Company & Deal ────────────────────────────────────── */}
      <div className={styles.panel}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Company &amp; Deal</h2>
          <p className={styles.sectionNote}>
            Both are required — the customer link rides on the HubSpot deal the rep already owns,
            rather than EasyOB minting a duplicate.
          </p>
        </div>

        {hubspotCompany ? (
          <p className={styles.hubspotBadge}>
            Linked to HubSpot company: <strong>{hubspotCompany.name}</strong> ({hubspotCompany.id})
            <button type="button" className={styles.hubspotBadgeClear} onClick={clearHubspotCompany} aria-label="Remove HubSpot link">
              ×
            </button>
          </p>
        ) : (
          <div className={styles.field}>
            <label className={styles.label}>Search HubSpot companies</label>
            <input
              type="search"
              value={hubspotQuery}
              onChange={e => setHubspotQuery(e.target.value)}
              placeholder="Search HubSpot companies…"
              className={styles.input}
            />
            {hubspotSearchError && (
              <div className={styles.error}>Couldn&apos;t search HubSpot ({hubspotSearchError}).</div>
            )}
            {!hubspotSearchError && hubspotQuery.trim().length >= 2 && (
              <div className={styles.hubspotResults}>
                {hubspotSearching && <div className={styles.hubspotResultMeta}>Searching…</div>}
                {!hubspotSearching && hubspotResults.length === 0 && (
                  <div className={styles.hubspotResultMeta}>No matching companies.</div>
                )}
                {hubspotResults.map(c => (
                  <button
                    key={c.id}
                    type="button"
                    className={styles.hubspotResultRow}
                    onClick={() => selectHubspotCompany(c)}
                  >
                    <span className={styles.hubspotResultName}>{c.name}</span>
                    <span className={styles.hubspotResultMeta}>{c.id}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {hubspotNotice && (
          <div className={styles.error}>
            {hubspotCompany
              ? `Couldn't read this company's details from HubSpot (${hubspotNotice}) — nothing was prefilled below.`
              : `Couldn't load that HubSpot company (${hubspotNotice}).`}
          </div>
        )}
        {prefillLoading && <p className={styles.prefillNote}>Loading details from HubSpot…</p>}

        {hubspotCompany && (
          <div className={styles.row}>
            <DealPicker
              companyId={hubspotCompany.id}
              companyName={hubspotCompany.name}
              defaultDealName={merchantName || hubspotCompany.name}
              resolved={dealResolved}
              onResolved={setDealResolved}
            />
          </div>
        )}
      </div>

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
      />
      {missingWarnings.length > 0 && (
        <p className={styles.prefillNote}>
          The customer will have to fill these in themselves: {missingWarnings.join(", ")}.
        </p>
      )}

      {/* ── Section 3: Quote ─────────────────────────────────────────────── */}
      {/* A marketing-only quote has no processing behind it, so there
          is nothing to price against a statement — the products ARE the quote. */}
      {rated && (
      <div className={styles.panel}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Prepare the Quote (optional)</h2>
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

      {rated && (
      <div className={styles.panel}>
        <label className={styles.label}>Pricing Model</label>
        <div className={styles.modelRow}>
          {MODELS.map(m => (
            <button key={m} onClick={() => setPricingModel(m)} className={styles.modelPill} data-active={pricingModel === m}>
              {m.replace("-", " ")}
            </button>
          ))}
        </div>
        {/* Rep-only. Collapsed by default and showing no figure in the header:
            the rep often has the laptop turned toward the merchant. */}
        <button
          type="button"
          className={styles.disclosureBtn}
          aria-expanded={internalOpen}
          aria-controls="prospect-internal"
          onClick={() => setInternalOpen(o => !o)}
        >
          AIO Internal
          <span className={styles.disclosureChevron} aria-hidden="true">▾</span>
        </button>
        {internalOpen && (
          <div id="prospect-internal" className={styles.disclosureBody}>
            <div className={styles.marginRow}>
              <span className={styles.marginLabel}>Margin Target</span>
              <span className={styles.marginValue}>{fmtPct2(targetMargin)}</span>
            </div>
            <input
              type="range" min="0.001" max="0.04" step="0.0005"
              value={targetMargin}
              onChange={e => setTargetMargin(parseFloat(e.target.value))}
            />
          </div>
        )}
      </div>
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
