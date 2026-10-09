"use client";

import { useEffect, useMemo, useState } from "react";
import { analysisFromQuoteConfigAction, saveQuoteConfigurationAction } from "@/lib/actions/prospects";
import { getSettingsAction } from "@/lib/actions/applications";
import { getPricingPreviewAction } from "@/lib/actions/pricing";
import ProductConfigurator, { type ConfiguredQuote, type ProductPick } from "@/components/quoting/ProductConfigurator";
import RateFields from "@/components/rep/RateFields";
import { adjustmentsFromQuoteLines, picksFromQuoteLines, quoteHasProcessing, quoteTypeOf } from "@/lib/quoting";
import { fmt$ } from "@/lib/utils";
import { DEFAULT_QUOTE_RATES, SELECTABLE_PRICING_MODELS } from "@/types/merchant";
import type { AppSettings, MerchantApplication, PricingModel, ProcessorTier, QuoteAdjustments, QuoteRates, QuoteType, StatementAnalysis } from "@/types/merchant";
import type { FeeOverrides, RoleScopedPricing } from "@/lib/pricing";

type Props = {
  app: MerchantApplication;
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
 * computation: reps only ever see the server's pillowed floor/cost view, and
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
export default function EditQuotePanel({ app, onSaved, onCancel }: Props) {
  const savedQuoteType = quoteTypeOf(app.quoteType);
  const [quoteType, setQuoteType] = useState<QuoteType>(savedQuoteType);
  const [picks, setPicks] = useState<ProductPick[]>(picksFromQuoteLines(app.quoteLines, savedQuoteType));
  const [channels, setChannels] = useState<string[]>(app.orderPoints?.channels ?? []);
  // Read off the SAVED lines, derived ones included — a comped install lives
  // on a derived line, and picksFromQuoteLines drops those by design.
  const [adjustments, setAdjustments] = useState<QuoteAdjustments>(
    adjustmentsFromQuoteLines(app.quoteLines, savedQuoteType)
  );
  const [quote, setQuote] = useState<ConfiguredQuote | null>(null);

  const [quoteRates, setQuoteRates] = useState<QuoteRates>(app.quoteRates ?? DEFAULT_QUOTE_RATES);
  const [pricingModel, setPricingModel] = useState<PricingModel>(app.pricingModel ?? "2-tier");

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [pricing, setPricing] = useState<RoleScopedPricing | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whether this quote carries a RATE — which on a marketing plan depends on
  // whether its Website takes online orders, not on the plan alone. Everything
  // below hangs off this: the margin control, the rate preview, and whether an
  // empty picker is a legitimate quote.
  const rated = quoteHasProcessing(quoteType, picks, adjustments);

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
    analysisFromQuoteConfigAction(app.quoteConfig).then(a => {
      if (!cancelled) setConfigAnalysis(a);
    }).catch(() => { if (!cancelled) setConfigAnalysis(null); });
    return () => { cancelled = true; };
    // app.analysis/app.quoteConfig are fixed for the panel's lifetime (this
    // surface edits products/margin/type, not the statement or config), so
    // they're read via closure rather than added as dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const previewAnalysis = app.analysis ?? configAnalysis;
  const canPreview = rated && !!previewAnalysis;

  const activeProcessor = settings?.processors?.find(p => p.isDefault) ?? settings?.processors?.[0] ?? null;
  const activeTier: ProcessorTier | null =
    activeProcessor?.tiers?.find(t => t.isDefault) ?? activeProcessor?.tiers?.[0] ?? null;

  // Debounced re-preview, same 150ms shoulder as PricingStep — the server
  // computes the pillowed floor/cost view; this component never derives it.
  useEffect(() => {
    if (!canPreview) { setPricing(null); return; }
    const handle = setTimeout(() => {
      getPricingPreviewAction({
        analysis: previewAnalysis!,
        quoteRates,
        pricingModel,
        feeOverrides: ZERO_FEES,
        activeTier,
      }).then(setPricing).catch(() => setPricing(null));
    }, 150);
    return () => clearTimeout(handle);
    // previewAnalysis is a derived value (app.analysis, or the once-fetched
    // configAnalysis), not a ref-stable dependency worth excluding — include it.
  }, [canPreview, previewAnalysis, quoteRates, pricingModel, activeTier]);

  // Reported, never enforced — floor enforcement went with the margin input on
  // 2026-10-06. A rate under the floor warns the rep and still saves.
  const belowFloor = pricing?.belowCostFloor ?? false;
  const belowMin = pricing?.belowMarginFloor ?? false;
  const blockers = quote?.blockers ?? [];

  // Below the minimum margin REFUSES the save (2026-10-09, "card rate minimums
  // are needed"), where it used to be a note the rep could read past. Below
  // COST stays a warning: it is the sharper of the two, but it is measured
  // against the processor tier on file, which a rep can't fix from here.
  const disabled = saving || blockers.length > 0 || belowMin || (!rated && !picks.length);

  const save = async () => {
    if (disabled) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await saveQuoteConfigurationAction({
        applicationId: app.id,
        quoteType,
        picks,
        channels,
        quoteRates,
        pricingModel,
        quoteConfig: app.quoteConfig,
      });
      onSaved(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this quote");
    }
    setSaving(false);
  };

  // Frozen — the same two rules saveQuoteConfigurationAction enforces
  // server-side, shown here so a rep never fills out a form the save call is
  // just going to refuse. PUBLISHED is checked first and is the earlier of the
  // two: the rep sends the quote before the merchant signs it, so there is a
  // window where the document is live and unamendable but nothing is accepted
  // yet, and "accepted" copy would be wrong for it.
  const frozen = app.hubspotIds?.publishedAt
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
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
      />

      {rated && (
        <div style={{ padding: 16, border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8 }}>
          {/* Same as the prospect form: one sellable model means nothing to
              pick, and a lone pill reads as a broken control. The rate fields
              below are the two tiers. Returns if the list ever grows. */}
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
            <RateFields value={quoteRates} onChange={setQuoteRates} />
            {!canPreview && hasVolumeBasis && (
              <p style={{ opacity: 0.7, fontSize: 13, marginTop: 6 }}>
                Loading preview…
              </p>
            )}
            {!canPreview && !hasVolumeBasis && (
              <p style={{ opacity: 0.7, fontSize: 13, marginTop: 6 }}>
                No statement or volume/ticket basis on file for this account, so there&apos;s nothing
                to project these rates against yet — they still set what the customer&apos;s own
                upload will be priced at.
              </p>
            )}
            {canPreview && pricing && (
              <div style={{ marginTop: 10, fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>
                <div>Projected fees: <strong>{fmt$(pricing.projectedMonthlyFees)}/mo</strong></div>
                <div>AIO revenue: <strong>{fmt$(pricing.aioRevenue)}/mo</strong></div>
                {belowFloor && (
                  <div style={{ color: "var(--danger, #e5484d)" }}>
                    Below cost — AIO loses money on this deal at this rate. Not blocked, but don&rsquo;t
                    send it without asking.
                  </div>
                )}
                {belowMin && (
                  <div style={{ color: "var(--danger, #e5484d)" }}>
                    Below AIO&rsquo;s minimum margin for this volume. Raise the card rate to save
                    this quote.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {error && <div style={{ color: "var(--danger, #e5484d)" }}>{error}</div>}
      {blockers.length > 0 && <div style={{ color: "var(--danger, #e5484d)" }}>{blockers.join(" ")}</div>}

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={save} disabled={disabled} style={{ opacity: disabled ? 0.6 : 1 }}>
          {saving ? "Saving…" : "Save Quote"}
        </button>
        <button onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </div>
  );
}
