"use client";

import { useState, useEffect, Fragment, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { getSettingsAction, saveApplicationAction, getApplicationAction } from "@/lib/actions/applications";
import {
  issueCustomerQuoteLinkAction,
  saveApplicationDetailsAction,
  saveQuoteConfigurationAction,
} from "@/lib/actions/prospects";
import StartStep      from "./StartStep";
import AnalysisStep   from "@/components/rep/AnalysisStep";
import PricingStep, { type PricingOutcome } from "@/components/rep/PricingStep";
import ProposalStep   from "@/components/rep/ProposalStep";
import ApplyStep      from "@/components/rep/ApplyStep";
import ProductConfigurator, { type ConfiguredQuote, type ProductPick } from "@/components/quoting/ProductConfigurator";
import { picksFromQuoteLines, quoteTypeOf } from "@/lib/quoting";
import type {
  MerchantApplication, StatementAnalysis, Processor, ProcessorTier, AppSettings, QuoteConfig,
  QuoteType,
} from "@/types/merchant";
import styles from "./proposals-new.module.css";

// Products sits between Pricing and Proposal: every step the rep INPUTS comes
// before every step they SHOW, so the deal row is complete (rates, margin,
// hardware, tier) by the time the proposal is on screen and the link is one
// click away.
const STEPS = ["Start", "Analysis", "Pricing", "Products", "Proposal", "Details"] as const;
type Step = 0 | 1 | 2 | 3 | 4 | 5;

function newApp(): MerchantApplication {
  return {
    id: `app_${Date.now()}`,
    ownerUserId: "", // stamped from the session by saveApplicationAction on first save
    customerUserId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stage: "analysis",
    hubspotDealId: null,
    dealLink: null,
    demo: null,
    tenantLink: null,
    adyenIds: null,
    adyenOnboardingUrl: null,
    aioTenant: null,
    checkIds: null,
    foodbuyIds: null,
    hubspotIds: null,
    quoteType: "full_pos",
    quoteConfig: null,
    quoteLines: null,
    orderPoints: null,
    quoteAcceptedAt: null,
    targetMargin: null,
    pricingModel: null,
    customerLinkToken: null,
    customerLinkPurpose: null,
    customerLinkSentAt: null,
    customerLinkExpiresAt: null,
    analysis: null,
    proposal: null,
    business: null,
    ownerContact: null,
    processing: null,
    agreement: null,
  };
}

// Which step to reopen a saved application at, based on how far it got.
// The pricing step's live inputs still aren't persisted mid-flight, so an app
// with an analysis but no proposal reopens at Analysis and the rep re-runs
// Pricing from there.
function stepForApp(app: MerchantApplication): Step {
  if (app.analysis && app.proposal) return 4; // Proposal
  if (app.analysis) return 1;                 // Analysis
  return 0;                                   // Start
}

function NewProposalFlow() {
  const searchParams = useSearchParams();
  const resumeId = searchParams.get("id");

  const [step, setStep]           = useState<Step>(0);
  const [app, setApp]             = useState<MerchantApplication>(newApp());
  const [settings, setSettings]   = useState<AppSettings | null>(null);
  const [loading, setLoading]     = useState<boolean>(!!resumeId);

  // What the rep decided in the pricing step. Held here (not left to die in
  // PricingStep's state, as it used to) so it can be persisted with the picks.
  const [outcome, setOutcome]     = useState<PricingOutcome | null>(null);

  // Product configurator — the parent owns the type and picks, the server owns
  // the money. Marketing-only isn't offered here: this wizard starts from a
  // statement analysis, and a marketing quote has no processing behind it.
  const [quoteType, setQuoteType] = useState<QuoteType>("full_pos");
  const [picks, setPicks]         = useState<ProductPick[]>([]);
  const [channels, setChannels]   = useState<string[]>([]);
  const [quote, setQuote]         = useState<ConfiguredQuote | null>(null);

  const [busy, setBusy]           = useState(false);
  const [error, setError]         = useState<string | null>(null);

  // The terminus: the /lead/{token} URL the rep sends the merchant.
  const [linkUrl, setLinkUrl]     = useState<string | null>(null);
  const [copied, setCopied]       = useState(false);

  useEffect(() => {
    getSettingsAction().then(s => setSettings(s)).catch(() => {});
  }, []);

  // Resume an existing application when arriving with ?id=… (from the dashboard).
  useEffect(() => {
    if (!resumeId) return;
    let cancelled = false;
    setLoading(true);
    getApplicationAction(resumeId)
      .then(existing => {
        if (cancelled) return;
        if (existing) {
          setApp(existing);
          setStep(stepForApp(existing));
          // Rehydrate the configurator from what was quoted, or a rep who
          // reopens a deal and steps back through Products would re-derive it
          // from an empty picker and wipe the hardware. Derived lines (the
          // platform fee, the three always-included services) are dropped —
          // they aren't picks, they come back from the quote type and count.
          setQuoteType(quoteTypeOf(existing.quoteType));
          setPicks(picksFromQuoteLines(existing.quoteLines));
          setChannels(existing.orderPoints?.channels ?? []);
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [resumeId]);

  const activeProcessor: Processor | null =
    settings?.processors?.find(p => p.isDefault) ?? settings?.processors?.[0] ?? null;
  const activeTier: ProcessorTier | null =
    activeProcessor?.tiers?.find(t => t.isDefault) ?? activeProcessor?.tiers?.[0] ?? null;

  const handleStarted = async (analysis: StatementAnalysis, quoteConfig: QuoteConfig | null) => {
    const updated: MerchantApplication = {
      ...app, analysis, quoteConfig, stage: "analysis", updatedAt: new Date().toISOString(),
    };
    const saved = await saveApplicationAction(updated);
    setApp(saved);
    setStep(1);
  };

  const handleProposal = async (result: PricingOutcome) => {
    setOutcome(result);
    const updated: MerchantApplication = {
      ...app, proposal: result.proposal, stage: "proposal_ready", updatedAt: new Date().toISOString(),
    };
    const saved = await saveApplicationAction(updated);
    setApp(saved);
    setStep(3);
  };

  // A tier is owed but the catalog didn't yield it — the biggest recurring line
  // would go missing. Same block the prospect form applies, and the server
  // refuses it too.
  const blockers = quote?.blockers ?? [];

  // The one write of the quoting half. The browser sends the quote type, picks
  // and channels; prices, the ordering-point count and every derived line are
  // computed server-side against the live catalog.
  const handleProducts = async () => {
    if (blockers.length) {
      setError(blockers.join(" "));
      return;
    }
    // On a resumed application the pricing step hasn't been re-run this
    // session, so fall back to what was already persisted.
    const targetMargin = outcome?.targetMargin ?? app.targetMargin;
    const pricingModel = outcome?.pricingModel ?? app.pricingModel;
    if (targetMargin == null || pricingModel == null) { setStep(4); return; }

    setBusy(true);
    setError(null);
    try {
      const saved = await saveQuoteConfigurationAction({
        applicationId: app.id,
        quoteType,
        picks,
        channels,
        targetMargin,
        pricingModel,
        quoteConfig: app.quoteConfig,
      });
      setApp(saved);
      setStep(4);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not price this quote");
    }
    setBusy(false);
  };

  const sendCustomerLink = async (from: MerchantApplication) => {
    setBusy(true);
    setError(null);
    try {
      const { app: saved, linkUrl: url } = await issueCustomerQuoteLinkAction(from.id);
      setApp(saved);
      setLinkUrl(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the customer link");
    }
    setBusy(false);
  };

  // The Details step is pre-fill for the customer's own onboarding form, so it
  // is saved field-by-field rather than through the blind full-row upsert —
  // that would round-trip this tab's copy of the quote lines over the ones the
  // server just derived.
  const handleDetailsSaved = async (updated: MerchantApplication) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await saveApplicationDetailsAction({
        applicationId: updated.id,
        business: updated.business,
        ownerContact: updated.ownerContact,
        processing: updated.processing,
        // Pass-through, never an origin: the Details step captures no consent,
        // so this is whatever the record already held. Sending it back rather
        // than null is what stops a rep reopening the deal from erasing consent
        // the merchant has since given. See lib/consent.ts.
        agreement: updated.agreement,
      });
      setApp(saved);
      await sendCustomerLink(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the business details");
      setBusy(false);
    }
  };

  const reset = () => {
    setApp(newApp());
    setOutcome(null);
    setPicks([]);
    setChannels([]);
    setQuote(null);
    setLinkUrl(null);
    setCopied(false);
    setError(null);
    setStep(0);
  };

  if (loading) {
    return <div className={styles.page}><p style={{ padding: "2rem", opacity: 0.6 }}>Loading proposal…</p></div>;
  }

  // Terminus — the same place /rep/prospects/new ends: a link to hand the
  // merchant, who opens it to this quote, accepts, and onboards themselves.
  if (linkUrl) {
    const merchant = app.business?.dba || app.business?.legalName || app.analysis?.merchantName || "the merchant";
    return (
      <div className={styles.successWrap}>
        <div className={styles.successMark}>✓</div>
        <h1 className={styles.successTitle}>Quote Ready to Send</h1>
        <p className={styles.successBody}>
          Share this link with <strong>{merchant}</strong> — their quote is already prepared, so they
          see it the moment they open it, accept it, and onboard themselves. The link is good for 14 days.
        </p>
        <div className={`${styles.linkPanel} ${styles.linkRow}`}>
          <code className={styles.linkCode}>{linkUrl}</code>
          <button
            onClick={() => { navigator.clipboard.writeText(linkUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
            className={styles.btnCopy}
            data-copied={copied}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        {error && <div className={styles.error}>{error}</div>}
        <p className={styles.successNote}>
          Merchants who won&apos;t self-serve can still be handed straight to Adyen KYC instead:
          open this account on the dashboard and use &ldquo;Send Onboarding Link&rdquo;. That replaces
          the quote link above.
        </p>
        <button onClick={reset} className={styles.btnGhost}>Start Another</button>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {/* Step indicator */}
      <div className={styles.stepperRow}>
        <div className={styles.stepper}>
          {STEPS.map((name, i) => {
            const done   = i < step;
            const active = i === step;
            return (
              <Fragment key={name}>
                {i > 0 && <div className={styles.connector} data-done={i <= step} />}
                <button
                  disabled={i > step}
                  onClick={() => i < step ? setStep(i as Step) : undefined}
                  data-state={active ? "active" : done ? "done" : "pending"}
                  data-clickable={i < step}
                  className={styles.step}
                >
                  <span className={styles.stepCircle}>{done ? "✓" : i + 1}</span>
                  <span className={styles.stepLabel}>{name}</span>
                </button>
              </Fragment>
            );
          })}
        </div>
      </div>

      {/* Step content */}
      {step === 0 && <StartStep onStarted={handleStarted} />}
      {step === 1 && app.analysis && (
        <AnalysisStep
          analysis={app.analysis}
          activeProcessor={activeProcessor}
          activeTier={activeTier}
          onBack={() => setStep(0)}
          onContinue={() => setStep(2)}
        />
      )}
      {step === 2 && app.analysis && (
        <PricingStep
          analysis={app.analysis}
          activeProcessor={activeProcessor}
          activeTier={activeTier}
          onBack={() => setStep(1)}
          onProposal={handleProposal}
        />
      )}
      {step === 3 && (
        <div className={styles.productsWrap}>
          <h1 className={styles.productsTitle}>Products &amp; Hardware</h1>
          <p className={styles.productsSubtitle}>
            What the merchant is buying alongside the rate. The platform fee follows the ordering-point
            count automatically, and any quote with products on it also carries the network, install
            and training — leave everything at zero for a rate-only quote.
          </p>
          <ProductConfigurator
            quoteType={quoteType}
            picks={picks}
            channels={channels}
            selectableTypes={["full_pos", "food_truck"]}
            onQuoteTypeChange={setQuoteType}
            onPicksChange={setPicks}
            onChannelsChange={setChannels}
            onDerivedChange={setQuote}
          />
          {error && <div className={styles.error}>{error}</div>}
          <div className={styles.stepActions}>
            <button className={styles.btnGhost} onClick={() => setStep(2)}>← Adjust Pricing</button>
            <button className={styles.btnPrimary} disabled={busy || blockers.length > 0} onClick={handleProducts}>
              {busy ? "Pricing…" : "Continue to Proposal →"}
            </button>
          </div>
        </div>
      )}
      {step === 4 && app.analysis && app.proposal && (
        <>
          {error && <div className={styles.errorFloating}>{error}</div>}
          <ProposalStep
            analysis={app.analysis}
            proposal={app.proposal}
            onBack={() => setStep(3)}
            onApply={() => setStep(5)}
            onSendLink={() => sendCustomerLink(app)}
            sendingLink={busy}
            onNewProposal={reset}
          />
        </>
      )}
      {step === 5 && (
        <>
          {error && <div className={styles.errorFloating}>{error}</div>}
          <ApplyStep
            app={app}
            onSaved={handleDetailsSaved}
            onBack={() => setStep(4)}
            onSkip={() => sendCustomerLink(app)}
          />
        </>
      )}
    </div>
  );
}

export default function NewProposalPage() {
  return (
    <Suspense>
      <NewProposalFlow />
    </Suspense>
  );
}
