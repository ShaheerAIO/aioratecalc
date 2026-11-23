"use client";

import { useEffect, useMemo, useState } from "react";
import { analysisFromQuoteConfigAction, saveQuoteConfigurationAction } from "@/lib/actions/prospects";
import { getSettingsAction } from "@/lib/actions/applications";
import { getPricingPreviewAction } from "@/lib/actions/pricing";
import ProductConfigurator, { type ConfiguredQuote, type ProductPick } from "@/components/quoting/ProductConfigurator";
import RateFields from "@/components/rep/RateFields";
import RateSuggestion from "@/components/rep/RateSuggestion";
import { standardQuoteRates } from "@/lib/standardRates";
import {
  adjustmentsFromQuoteLines, picksFromQuoteLines, processesCardNotPresentOnly, quoteHasProcessing, quoteTypeOf,
} from "@/lib/quoting";
import { fmt$, fmtPct2 } from "@/lib/utils";
import styles from "./EditQuotePanel.module.css";
import {
  averageTicketOf, DEFAULT_QUOTE_RATES, MIN_MONTHLY_PROCESSING_REVENUE, SELECTABLE_PRICING_MODELS,
} from "@/types/merchant";
import type { AppSettings, MerchantApplication, PricingModel, ProcessorTier, QuoteAdjustments, QuoteRates, QuoteType, StatementAnalysis } from "@/types/merchant";
import type { FeeOverrides, RoleScopedPricing } from "@/lib/pricing";

type Props = {
  app: MerchantApplication;
  isAdmin?: boolean;
  onSaved: (app: MerchantApplication) => void;
  onCancel: () => void;
};


// No fee overrides are persisted on the application today (they only ever
// lived in the wizard's ephemeral PricingStep state), so a re-preview here
// starts at zero rather than guessing at what the original proposal used.
const ZERO_FEES: FeeOverrides = { monthlyFee: 0, perTxnFee: 0, cpPerTxnFee: 0, cnpPerTxnFee: 0 };

/**
 * Rework an already-saved quote from the account detail view — the surface
 * `saveQuoteConfigurationAction` was missing a second call site for. Reuses
 * that action as-is: the browser only ever sends picks/channels/margin/model,
 * and quoteLines are re-derived server-side against the live catalog.
 *
 * Rehydrates the configurator with `picksFromQuoteLines` — exactly what the
 * wizard does when it resumes a saved application — so the platform fee and
 * the three always-included services come back OUT of the picks. Without
 * that, reopening a quote would let a rep hand-add a second platform line or
 * a second $999 install alongside the ones the server re-derives.
 *
 * The margin preview goes through `getPricingPreviewAction`, never a local
 * computation: reps only ever see the server's role-scoped floor/cost view, and
 * this component must not become a second place that leaks the true numbers.
 * When there's no statement on file but the account does have a rep-entered
 * quoteConfig (volume + ticket), `analysisFromQuoteConfigAction` (server-side,
 * same helper the wizard's statement-less path uses) turns that into a
 * previewable analysis — the panel never imports `analysisFromQuoteConfig`
 * itself, since that lives in pricing.ts alongside the true MARGIN_REQS table
 * and pulling it into a client bundle would ship AIO's true floors to the
 * browser. Only when there is truly no basis at all (no statement, no usable
 * quoteConfig) does the margin control degrade to a plain slider with no
 * floor feedback — the save is still safe in that case: saveQuoteConfigurationAction
 * has nothing to floor a below-cost margin against either, and says so.
 */
export default function EditQuotePanel({ app, isAdmin, onSaved, onCancel }: Props) {
  const savedQuoteType = quoteTypeOf(app.quoteType);
  const [quoteType, setQuoteType] = useState<QuoteType>(savedQuoteType);
  const [picks, setPicks] = useState<ProductPick[]>(picksFromQuoteLines(app.quoteLines, savedQuoteType));
  const [channels, setChannels] = useState<string[]>(app.orderPoints?.channels ?? []);
  // Read off the SAVED lines, derived ones included — a comped install lives
  // on a derived line, and picksFromQuoteLines drops those by design.
  const [adjustments, setAdjustments] = useState<QuoteAdjustments>(
    adjustmentsFromQuoteLines(app.quoteLines)
  );
  const [quote, setQuote] = useState<ConfiguredQuote | null>(null);
  // Reopened from the row, so a rep editing an existing quote sees the reason
  // they already wrote rather than being asked for it again.
  const [quoteNote, setQuoteNote] = useState(app.quoteNote ?? "");

  const [quoteRates, setQuoteRates] = useState<QuoteRates>(app.quoteRates ?? DEFAULT_QUOTE_RATES);
  const [cpAdjustBps, setCpAdjustBps] = useState(0);
  const [cpAdjustRange, setCpAdjustRange] = useState<{ min: number; max: number } | null>(null);
  const [pricingModel, setPricingModel] = useState<PricingModel>(app.pricingModel ?? "2-tier");
  // The "Standard rates" toggle (2026-11-11), and what it replaced: the rates
  // and adjustment immediately before it was turned on, restored when it is
  // turned off. Null whenever it is off.
  const [beforeStandard, setBeforeStandard] = useState<{ rates: QuoteRates; adjustBps: number } | null>(null);

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [pricing, setPricing] = useState<RoleScopedPricing | null>(null);

  const [saving, setSaving] = useState(false);
  // AIO's policy CNP (from RateFields); any other CNP needs admin approval.
  const [policyCnp, setPolicyCnp] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Held until the rep dismisses the notice, so the parent can't close the panel over it.
  const [pendingSaved, setPendingSaved] = useState<{ app: MerchantApplication; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ON applies the flat standard card. With a basis on file, RateSuggestion
  // holds CP = card + adjustment, so the 2.49% is set as an adjustment
  // against the card's figure (as a typed rate is) — it stays 2.49% and the
  // range check still judges it. OFF puts back exactly what was there.
  const toggleStandardRates = (on: boolean) => {
    if (on) {
      if (policyCnp === null) return;
      const standard = standardQuoteRates(policyCnp);
      const cardBps = Math.round(quoteRates.cardPresentRate * 10000) - cpAdjustBps;
      setBeforeStandard({ rates: quoteRates, adjustBps: cpAdjustBps });
      setCpAdjustBps(Math.round(standard.cardPresentRate * 10000) - cardBps);
      setQuoteRates(standard);
    } else if (beforeStandard) {
      setQuoteRates(beforeStandard.rates);
      setCpAdjustBps(beforeStandard.adjustBps);
      setBeforeStandard(null);
    }
  };
  // A rate the rep types while it is on turns it off and KEEPS the typed
  // rate (there is nothing to restore over a deliberate edit).
  const onRateFieldsChange = (next: QuoteRates) => {
    setQuoteRates(next);
    setBeforeStandard(null);
  };

  // Whether this quote carries a RATE — which on a marketing plan depends on
  // whether its Website takes online orders, not on the plan alone. Everything
  // below hangs off this: the margin control, the rate preview, and whether an
  // empty picker is a legitimate quote.
  const rated = quoteHasProcessing(quoteType, picks);
  // Online ordering and nothing on site: no card-present rate to show.
  const cnpOnly = processesCardNotPresentOnly(quoteType, picks);

  // Whether there's ANY volume basis to preview or floor-check a margin
  // against — a statement, or a rep-entered volume/ticket config. Neither
  // means there's genuinely nothing to compute against yet (see the doc
  // comment above); this only tells "loading a preview" apart from "there is
  // no preview to load".
  const hasVolumeBasis = rated && !!(app.analysis || (app.quoteConfig && app.quoteConfig.monthlyVolume > 0 && app.quoteConfig.avgTicket > 0));

  const [configAnalysis, setConfigAnalysis] = useState<StatementAnalysis | null>(null);

  useEffect(() => {
    getSettingsAction().then(setSettings).catch(() => {});
  }, []);

  // Derive a previewable analysis from quoteConfig once, when there's no
  // statement on file — see the doc comment above for why this goes through
  // the server action rather than calling analysisFromQuoteConfig directly.
  useEffect(() => {
    if (app.analysis || !app.quoteConfig || !(app.quoteConfig.monthlyVolume > 0) || !(app.quoteConfig.avgTicket > 0)) {
      setConfigAnalysis(null);
      return;
    }
    let cancelled = false;
    // `cnpOnly` is the one input here that is NOT fixed for the panel's
    // lifetime: ticking online ordering, or adding a kiosk to a marketing
    // quote, changes the card mix this analysis is synthesised on, and with
    // it the margin and the floor. So it re-derives on that, and only that.
    analysisFromQuoteConfigAction(app.quoteConfig, cnpOnly ? 0 : null).then(a => {
      if (!cancelled) setConfigAnalysis(a);
    }).catch(() => { if (!cancelled) setConfigAnalysis(null); });
    return () => { cancelled = true; };
    // app.analysis/app.quoteConfig are fixed for the panel's lifetime (this
    // surface edits products/margin/type, not the statement or config), so
    // they're read via closure rather than added as dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cnpOnly]);

  const previewAnalysis = app.analysis ?? configAnalysis;
  const canPreview = rated && !!previewAnalysis;

  const activeProcessor = settings?.processors?.find(p => p.isDefault) ?? settings?.processors?.[0] ?? null;
  const activeTier: ProcessorTier | null =
    activeProcessor?.tiers?.find(t => t.isDefault) ?? activeProcessor?.tiers?.[0] ?? null;

  // Debounced re-preview, same 150ms shoulder as PricingStep — the server
  // computes the role-scoped floor/cost view; this component never derives it.
  // `recurringArr` comes off the configurator's own live totals (annualised),
  // so the projected commission shown below reflects this quote's platform
  // fee too, not processing margin alone — the one thing PricingStep can't
  // know yet because no products are configured at that point in the wizard.
  const recurringArr = quote ? Math.round(quote.totals.monthlyEquivalent * 12) || null : null;
  useEffect(() => {
    if (!canPreview) { setPricing(null); return; }
    const handle = setTimeout(() => {
      getPricingPreviewAction({
        analysis: previewAnalysis!,
        quoteRates,
        pricingModel,
        feeOverrides: ZERO_FEES,
        activeTier,
        recurringArr,
      }).then(setPricing).catch(() => setPricing(null));
    }, 150);
    return () => clearTimeout(handle);
    // previewAnalysis is a derived value (app.analysis, or the once-fetched
    // configAnalysis), not a ref-stable dependency worth excluding — include it.
  }, [canPreview, previewAnalysis, quoteRates, pricingModel, activeTier, recurringArr]);

  // Reported, never enforced — floor enforcement went with the margin input on
  // 2026-10-06. A rate under the floor warns the rep and still saves.
  const belowFloor = pricing?.belowCostFloor ?? false;
  const belowMin = pricing?.belowMarginFloor ?? false;
  // The $10-a-month minimum on AIO's own processing revenue (2026-10-15).
  // Refuses the save like `belowMin`, and for the same reason — but it is a
  // SEPARATE test on a separate margin, so a quote has to clear both. See
  // `monthlyRevenueFloorBlockers` (pricing.ts).
  const belowRevenueFloor = pricing?.belowMonthlyRevenueFloor ?? false;
  const blockers = quote?.blockers ?? [];

  // Below the minimum margin REFUSES the save (2026-10-09, "card rate minimums
  // are needed"), where it used to be a note the rep could read past. Below
  // COST stays a warning: it is the sharper of the two, but it is measured
  // against the processor tier on file, which a rep can't fix from here.
  // Below the margin or revenue floor, past a cap, or off-policy CNP are admin
  // overrides now (2026-11-02), not refusals; only hard blockers disable Save.
  const disabled = saving || blockers.length > 0 || (!rated && !quote?.quoteLines.length);

  const approvalReasons: string[] = [];
  for (const o of quote?.overrides ?? []) approvalReasons.push(o.message);
  if (rated) {
    if (belowMin) approvalReasons.push("Card-present rate is below the minimum margin");
    if (belowRevenueFloor) approvalReasons.push(`AIO revenue on this merchant is under ${fmt$(MIN_MONTHLY_PROCESSING_REVENUE)} a month`);
    if (!cnpOnly && cpAdjustRange && (cpAdjustBps < cpAdjustRange.min || cpAdjustBps > cpAdjustRange.max)) {
      approvalReasons.push("Card-present rate adjustment is outside the allowed range");
    }
    if (policyCnp !== null && Math.round(quoteRates.cardNotPresentRate * 10000) !== Math.round(policyCnp * 10000)) {
      approvalReasons.push("Card-not-present rate differs from AIO's standard rate");
    }
  }
  const needsApproval = approvalReasons.length > 0;

  const requestSave = () => {
    if (disabled) return;
    if (needsApproval) { setConfirming(true); return; }
    void save();
  };

  const save = async () => {
    if (disabled) return;
    setConfirming(false);
    setSaving(true);
    setError(null);
    try {
      const updated = await saveQuoteConfigurationAction({
        applicationId: app.id,
        quoteType,
        quoteNote,
        picks,
        channels,
        // The per-line discounts and billing starts. Missing from this call
        // until 2026-10-18, so the server rebuilt every edited quote without
        // them: the plan's 45-day start vanished and the save was refused for
        // billing "at checkout", and any discount set here was dropped.
        adjustments,
        quoteRates,
        pricingModel,
        quoteConfig: app.quoteConfig,
      });
      if (updated.quoteStatus === "pending_approval") {
        setPendingSaved({ app: updated, message: "Sent to admins for approval. The merchant's link is paused until it's approved." });
      } else if (isAdmin && updated.quoteStatus === "approved" && (updated.quoteApproval?.overrides?.length ?? 0) > 0) {
        setPendingSaved({ app: updated, message: "Saved and approved." });
      } else onSaved(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this quote");
    }
    setSaving(false);
  };

  // Frozen — the same three rules saveQuoteConfigurationAction enforces
  // server-side, shown here so a rep never fills out a form the save call is
  // just going to refuse.
  //
  // CONFIRMED is checked first because it is the earliest of the three
  // (2026-10-15): the merchant confirming their own details is what BUILDS the
  // HubSpot quote, so confirmation → published (seconds later) → accepted
  // (days later, when they sign and pay). It also names what actually
  // happened, which is the half a rep can act on — "the customer confirmed"
  // rather than "a document exists" — and it covers the gap where a publish
  // is still in flight or waiting to be retried, during which `publishedAt`
  // alone would offer an edit on a quote the merchant has signed off.
  //
  // The other two stay beneath it rather than being replaced by it: rows
  // published under the old publish-at-send rule have no confirmation at all.
  const frozen = app.detailsConfirmedAt
    ? {
        title: `Customer confirmed their details ${new Date(app.detailsConfirmedAt).toLocaleDateString()} — locked.`,
        body: "Confirming is what published this quote to HubSpot, and a published quote can't be edited, replaced or voided through the API. Start a new quote instead of editing this one.",
      }
    : app.hubspotIds?.publishedAt
    ? {
        title: `Quote sent ${new Date(app.hubspotIds.publishedAt).toLocaleDateString()} — locked.`,
        body: "A published HubSpot quote can't be edited, replaced or voided through the API, so our copy has to keep matching the document the merchant is signing. Start a new quote instead of editing this one.",
      }
    : app.quoteAcceptedAt
      ? {
          title: `Quote accepted ${new Date(app.quoteAcceptedAt).toLocaleDateString()} — locked.`,
          body: "The accepted quote is frozen: it records what the merchant was actually quoted, and a published HubSpot billing quote can't be edited or voided through the API. Start a new quote instead of editing this one.",
        }
      : null;

  if (frozen) {
    return (
      <div style={{ padding: 16, background: "var(--warning-bg, rgba(255,193,7,0.08))", borderRadius: 8 }}>
        <strong>{frozen.title}</strong>
        <p style={{ margin: "8px 0 0", opacity: 0.85 }}>{frozen.body}</p>
      </div>
    );
  }

  const saveLabel = saving
    ? "Saving…"
    : needsApproval ? (isAdmin ? "Save & approve" : "Submit for approval") : "Save Quote";

  return (
    <div className={styles.panel}>
      {/* Say the window is OPEN, rather than letting an unlocked form imply
          it: the customer confirming their details is what ends it. */}
      <p className={styles.openNote}>
        Not confirmed by the customer yet, so this quote can still change. Nothing has been sent to HubSpot.
      </p>
      <ProductConfigurator
        quoteType={quoteType}
        picks={picks}
        channels={channels}
        rail="inline"
        onQuoteTypeChange={setQuoteType}
        onPicksChange={setPicks}
        onChannelsChange={setChannels}
        onDerivedChange={setQuote}
        adjustments={adjustments}
        onAdjustmentsChange={setAdjustments}
        note={quoteNote}
        onNoteChange={setQuoteNote}
      />

      {rated && (
        <div className={styles.rateCard}>
          {SELECTABLE_PRICING_MODELS.length > 1 && (
            <>
              <div style={{ marginBottom: 8, fontWeight: 600 }}>Pricing Model</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {SELECTABLE_PRICING_MODELS.map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setPricingModel(m)}
                    data-active={pricingModel === m}
                    style={{
                      padding: "6px 12px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.15)",
                      background: pricingModel === m ? "var(--accent, #f9674e)" : "transparent",
                      color: pricingModel === m ? "#fff" : "inherit", cursor: "pointer",
                    }}
                  >
                    {m.replace("-", " ")}
                  </button>
                ))}
              </div>
            </>
          )}

          <div>
            {/* "Standard rates" (2026-11-11) toggles the flat standard card on
                and back off — see `toggleStandardRates`. Volume isn't editable
                here, so unlike prospect creation there are no boxes to hide
                and no requirement to waive. */}
            <RateFields value={quoteRates} onChange={onRateFieldsChange} cardNotPresentOnly={cnpOnly} adjustBps={cpAdjustBps} onAdjustBps={setCpAdjustBps} adjustRange={cpAdjustRange} onPolicyCnp={setPolicyCnp} standardRates={beforeStandard !== null} onStandardRatesChange={toggleStandardRates} />
            {/* Used to deliberately skip auto-apply here ("these rates were
                already chosen and saved"). OVERRIDDEN 2026-10-13 ("get rid of
                the 'use it' and make it always override") — RateSuggestion no
                longer has a gate to opt out of at all, so reopening a saved
                quote can now change its rates to match the live rate card.
                This is safe against the one thing it must never touch: a
                PUBLISHED (or accepted) quote never reaches this line —
                `frozen`, above, returns a locked notice before this component
                tree (and therefore RateFields/RateSuggestion) ever mounts, so
                there is no path from here back through that freeze. */}
            <RateSuggestion
              monthlyVolume={previewAnalysis?.totalVolume ?? 0}
              avgTicket={previewAnalysis ? averageTicketOf(previewAnalysis) : 0}
              value={quoteRates}
              onChange={setQuoteRates}
              adjustmentBps={cpAdjustBps}
              onAdjustRangeChange={setCpAdjustRange}
              onAdjustmentChange={setCpAdjustBps}
              adoptSaved={!!app.quoteRates}
            />
            {!canPreview && hasVolumeBasis && <p className={styles.muted}>Loading preview…</p>}
            {!canPreview && !hasVolumeBasis && (
              <p className={styles.muted}>
                No statement or volume/ticket basis on file for this account, so there&apos;s nothing
                to project these rates against yet. They still set what the customer&apos;s own
                upload will be priced at.
              </p>
            )}
            {canPreview && pricing && (
              // The fee projection the merchant sees anyway, the margin %, what
              // the rate is worth to AIO (monthly and as ARR, i.e.
              // `payment_processing_arr`), and the rep's commission. All from
              // the server's role-scoped preview; this panel derives none.
              // Breaching a floor is said once, in the approval box below.
              <div className={styles.stats}>
                <div>
                  <div className={styles.statLabel}>Projected fees</div>
                  <div className={styles.statValue}>{fmt$(pricing.projectedMonthlyFees)}/mo</div>
                </div>
                <div>
                  <div className={styles.statLabel}>Margin</div>
                  <div className={styles.statValue} data-bad={belowMin}>
                    {pricing.appliedTargetMargin == null ? "—" : fmtPct2(pricing.appliedTargetMargin)}
                  </div>
                </div>
                {pricing.monthlyProcessingRevenue != null && (
                  <div>
                    <div className={styles.statLabel}>AIO revenue · ARR</div>
                    <div className={styles.statValue} data-bad={belowRevenueFloor}>
                      {fmt$(pricing.monthlyProcessingRevenue)}/mo · {fmt$(pricing.processingArr ?? 0)}
                    </div>
                  </div>
                )}
                <div>
                  <div className={styles.statLabel}>Your commission (est.)</div>
                  <div className={styles.statValue}>
                    {pricing.projectedCommission.total == null ? "—" : `${fmt$(pricing.projectedCommission.total)}/yr`}
                  </div>
                </div>
              </div>
            )}
            {canPreview && belowFloor && (
              <div className={styles.warn} style={{ marginTop: 10 }}>
                Below cost: AIO loses money on this deal at this rate. Not blocked, but don&rsquo;t
                send it without asking.
              </div>
            )}
          </div>
        </div>
      )}

      {error && <div className={styles.warn}>{error}</div>}
      {blockers.length > 0 && <div className={styles.warn}>{blockers.join(" ")}</div>}

      {needsApproval && !pendingSaved && (
        <div className={styles.approval} data-testid="approval-summary">
          <div className={styles.approvalTitle}>
            {isAdmin ? "Outside AIO's limits: saving approves it" : "Outside AIO's limits: needs admin approval"}
          </div>
          <ul>{approvalReasons.map(r => <li key={r}>{r}</li>)}</ul>
        </div>
      )}

      {pendingSaved ? (
        <div role="status" data-testid="pending-approval-notice" className={styles.done}>
          <span>{pendingSaved.message}</span>
          <button type="button" className={styles.btnPrimary} onClick={() => onSaved(pendingSaved.app)}>Done</button>
        </div>
      ) : (
        <div className={styles.footer}>
          <button type="button" className={styles.btnGhost} onClick={onCancel} disabled={saving}>Cancel</button>
          <button
            type="button"
            className={needsApproval ? styles.btnApprove : styles.btnPrimary}
            onClick={requestSave}
            disabled={disabled}
          >
            {saveLabel}
          </button>
        </div>
      )}

      {confirming && (
        <div className={styles.overlay}>
          <div role="dialog" aria-modal="true" aria-labelledby="approval-title" className={styles.dialog}>
            <h3 id="approval-title" className={styles.dialogTitle}>
              {isAdmin ? "Approve this quote yourself?" : "Send this quote for approval?"}
            </h3>
            <p>
              {isAdmin
                ? "This quote is outside AIO's limits. Saving it records your approval, and it can go to the merchant as normal."
                : "This quote is outside AIO's limits. It will be saved, and an admin has to approve it before the merchant can see it. You'll get an email once it's approved."}
            </p>
            <ul>{approvalReasons.map(r => <li key={r}>{r}</li>)}</ul>
            <div className={styles.dialogActions}>
              <button type="button" className={styles.btnGhost} onClick={() => setConfirming(false)}>Keep editing</button>
              <button type="button" className={styles.btnApprove} onClick={() => void save()}>
                {isAdmin ? "Save & approve" : "Submit for approval"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
