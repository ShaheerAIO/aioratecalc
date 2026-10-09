"use client";

import { useState, useEffect, useMemo } from "react";
import { getPricingPreviewAction } from "@/lib/actions/pricing";
import { fmt$, fmtPct2 } from "@/lib/utils";
import { DEFAULT_QUOTE_RATES, SELECTABLE_PRICING_MODELS } from "@/types/merchant";
import type { StatementAnalysis, ProposalOutput, Processor, ProcessorTier, PricingModel, QuoteRates } from "@/types/merchant";
import RateFields from "./RateFields";
import type { FeeOverrides, RoleScopedPricing } from "@/lib/pricing";
import styles from "./PricingStep.module.css";

type Tone = "info" | "warning" | "success";

/**
 * Everything the rep decided here, not just the generated prose. The wizard
 * used to receive only the ProposalOutput, so the rates and model the rep
 * actually chose died with this component's state — and the customer's quote
 * was then priced at the default instead.
 */
export type PricingOutcome = {
  proposal: ProposalOutput;
  quoteRates: QuoteRates;
  pricingModel: PricingModel;
  cardPresentPct: number;
  feeOverrides: FeeOverrides;
};

type Props = {
  analysis: StatementAnalysis;
  activeProcessor: Processor | null;
  activeTier: ProcessorTier | null;
  onBack: () => void;
  onProposal: (outcome: PricingOutcome) => void;
};

// tone preserves the old T.blue/T.gold/T.green data-encoding per model —
// mapped 1:1 onto the new semantic tokens (info/warning/success), not accent.
const MODEL_INFO: Record<PricingModel, { name: string; desc: string; tone: Tone }> = {
  "flat-rate": { name: "Flat Rate", desc: "One rate for all card types. Simple and predictable — best for high-volume retail.", tone: "info" },
  "2-tier": { name: "2-Tier", desc: "Separate card-present and card-not-present rates. Best for mixed-environment merchants.", tone: "warning" },
  "interchange-plus": { name: "Interchange Plus", desc: "Cost + fixed markup above interchange. Most transparent — ideal for large merchants.", tone: "success" },
};

const TONE_BORDER: Record<Tone, string> = { info: "var(--info)", warning: "var(--warning)", success: "var(--success)" };
const TONE_BG: Record<Tone, string> = { info: "var(--info-bg)", warning: "var(--warning-bg)", success: "var(--success-bg)" };
const TONE_CLASS: Record<Tone, string> = { info: styles["value--info"], warning: styles["value--warning"], success: styles["value--success"] };

// Only 2-tier is offered — see SELECTABLE_PRICING_MODELS. MODEL_INFO keeps all
// three, and every rate-preview and fee-override branch below still handles
// them: the engine prices models this screen no longer offers, and a stored
// proposal can still carry one.

export default function PricingStep({ analysis, activeProcessor, activeTier, onBack, onProposal }: Props) {
  const [model, setModel]         = useState<PricingModel>("2-tier");
  // The quoted rates, which the rep edits directly. Seeded from the shared
  // default rather than from a server preview: there is no matrix to look one
  // up in, so the starting rate is a constant both sides already agree on.
  const [rates, setRates]         = useState<QuoteRates>(DEFAULT_QUOTE_RATES);
  const [cpPct, setCpPct]         = useState<number>(analysis.cardPresentPct && analysis.cardPresentPct > 0 ? analysis.cardPresentPct : 0.9);
  const [feeOverrides, setFees]   = useState<FeeOverrides>({ monthlyFee: 0, perTxnFee: 0, cpPerTxnFee: 0, cnpPerTxnFee: 0 });
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [pricing, setPricing]     = useState<RoleScopedPricing | null>(null);
  // Shoulder-surfing guard: everything that reveals AIO's margin, revenue, cost
  // basis or floor sits behind this and starts shut. The defaults above still
  // apply while it's collapsed, so a rep who never opens it still gets a quote.
  const [internalOpen, setInternalOpen] = useState(false);

  const vol = analysis.totalVolume || 1;

  // The rep's card-mix override, applied to the analysis so both the live preview
  // and the persisted proposal price off the same split.
  const effectiveAnalysis = useMemo(() => ({
    ...analysis,
    cardPresentPct: cpPct,
    cardNotPresentPct: 1 - cpPct,
    cardPresentVolume: (analysis.totalVolume || 0) * cpPct,
    cardNotPresentVolume: (analysis.totalVolume || 0) * (1 - cpPct),
  }), [analysis, cpPct]);

  // The projection (and the margin/cost-basis view, which is role-scoped and
  // padded for reps) is computed server-side — this component never sees or
  // derives AIO's true floor or cost itself. Debounced because the rate fields
  // fire on every keystroke.
  useEffect(() => {
    const handle = setTimeout(() => {
      getPricingPreviewAction({ analysis: effectiveAnalysis, quoteRates: rates, pricingModel: model, feeOverrides, activeTier })
        .then(setPricing)
        .catch(() => setPricing(null));
    }, 150);
    return () => clearTimeout(handle);
  }, [effectiveAnalysis, rates, model, feeOverrides, activeTier]);

  // No statement means nothing is known about what they pay today
  // (analysisFromQuoteConfig leaves totalFees at 0), so there is no savings
  // figure to show — showing one would be a fabricated negative.
  const hasCurrentCost = (analysis.totalFees || 0) > 0;
  const savings     = pricing ? (analysis.totalFees || 0) - pricing.projectedMonthlyFees : 0;
  // `belowMin` is ENFORCED again as of 2026-10-09 ("card rate minimums are
  // needed"), reversing the 2026-10-06 change that dropped floor enforcement
  // along with the margin input: between those dates a rep could quote under
  // the floor and the quote went out. Both are computed server-side from the
  // rates the rep typed, against a floor that is padded before they see it.
  //
  // `belowFloor` — under the true Adyen COST — stays a warning. It is the
  // sharper of the two, but it depends on the processor tier on file rather
  // than on anything this screen can change.
  const belowFloor  = pricing?.belowCostFloor ?? false;
  const belowMin    = pricing?.belowMarginFloor ?? false;
  const earnedMargin = pricing?.appliedTargetMargin ?? null;
  const aboveMax    = !!pricing && earnedMargin != null && earnedMargin > pricing.maxMargin;

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch("/api/proposal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analysis: effectiveAnalysis, pricingModel: model, quoteRates: rates, feeOverrides }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Proposal generation failed");
      onProposal({
        proposal: data.proposal,
        quoteRates: rates,
        pricingModel: model,
        cardPresentPct: cpPct,
        feeOverrides,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Proposal generation failed");
    }
    setLoading(false);
  };

  const setOverride = (k: keyof FeeOverrides, v: string) =>
    setFees(f => ({ ...f, [k]: parseFloat(v) || 0 }));

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Pricing</h1>
      <p className={styles.subtitle}>
        {hasCurrentCost ? (
          <>
            Currently paying <strong className={styles.subtitleAccent}>{fmtPct2(analysis.effectiveRate)}</strong> ({fmt$(analysis.totalFees)}/mo).{" "}
          </>
        ) : (
          <>No statement, so what they pay today is unknown — this quotes the AIO rate only.{" "}</>
        )}
        Merchant volume: <strong className={styles.subtitleStrong}>{fmt$(analysis.totalVolume)}/mo</strong>.
      </p>

      {/* Only the sellable models. With one of them this is a statement of what
          the quote is priced on rather than a choice — but it still renders,
          because the merchant is often looking at this screen and "2-Tier,
          card-present and card-not-present" is the thing being sold. */}
      <div className={styles.modelGrid}>
        {SELECTABLE_PRICING_MODELS.map(m => {
          const info = MODEL_INFO[m];
          const selected = model === m;
          return (
            <button
              key={m}
              type="button"
              onClick={() => setModel(m)}
              className={styles.modelCard}
              style={selected ? { borderColor: TONE_BORDER[info.tone], background: TONE_BG[info.tone] } : undefined}
            >
              <div className={styles.modelHeader}>
                <span className={styles.modelDot} style={selected ? { borderColor: TONE_BORDER[info.tone], background: TONE_BORDER[info.tone] } : undefined} />
                <span className={`${styles.modelName} ${selected ? TONE_CLASS[info.tone] : ""}`}>{info.name}</span>
              </div>
              <p className={styles.modelDesc}>{info.desc}</p>
            </button>
          );
        })}
      </div>

      <div className={styles.layout}>
        {/* Left: Rates preview */}
        <div>
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>Computed Rates</h2>
            {!pricing ? (
              <div className={styles.calculating}>Calculating…</div>
            ) : (
              <>
                {model === "flat-rate" && (
                  <div className={styles.rateGrid}>
                    <div className={styles.box}>
                      <div className={styles.boxLabel}>All Cards</div>
                      <div className={`${styles.boxValue} ${styles["value--info"]}`}>{fmtPct2(pricing.flatRate)}</div>
                      <div className={styles.boxSub}>+ ${(feeOverrides.perTxnFee || 0).toFixed(2)}/txn</div>
                    </div>
                  </div>
                )}
                {model === "2-tier" && (
                  /* All four, because all four are quoted. The per-transaction
                     fee is one number across every lane, so it reads under
                     each of them rather than being four separate figures. */
                  <div className={styles.rateGrid}>
                    {[
                      { lbl: "V/MC/Disc Card Present", val: pricing.cpRate, tone: styles["value--info"] },
                      { lbl: "V/MC/Disc Not Present", val: pricing.cnpRate, tone: styles["value--warning"] },
                      { lbl: "AMEX Card Present", val: pricing.amexCpRate, tone: styles["value--info"] },
                      { lbl: "AMEX Not Present", val: pricing.amexCnpRate, tone: styles["value--warning"] },
                    ].map(r => (
                      <div key={r.lbl} className={styles.box}>
                        <div className={styles.boxLabel}>{r.lbl}</div>
                        <div className={`${styles.boxValue} ${r.tone}`}>{fmtPct2(r.val)}</div>
                        <div className={styles.boxSub}>+ ${rates.perTransactionFee.toFixed(2)}/txn</div>
                      </div>
                    ))}
                  </div>
                )}
                {model === "interchange-plus" && (
                  <div className={styles.rateGrid}>
                    <div className={styles.box}>
                      <div className={styles.boxLabel}>Markup (BPS)</div>
                      <div className={`${styles.boxValue} ${styles["value--success"]}`}>{pricing.bps} BPS</div>
                      <div className={styles.boxSub}>above interchange</div>
                    </div>
                    <div className={styles.box}>
                      <div className={styles.boxLabel}>Per Transaction</div>
                      <div className={`${styles.boxValue} ${styles["value--info"]}`}>${(feeOverrides.perTxnFee || pricing.perTxnFee || 0).toFixed(2)}</div>
                      <div className={styles.boxSub}>auth fee</div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Fee projection */}
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>Fee Projection</h2>
            <div className={styles.projectionGrid}>
              {[
                { lbl: "Projected Fees", val: pricing ? fmt$(pricing.projectedMonthlyFees) : "—", tone: styles["value--info"] },
                hasCurrentCost
                  ? { lbl: "Monthly Savings", val: pricing ? fmt$(savings) : "—", tone: styles["value--success"] }
                  : { lbl: "Annual Fees", val: pricing ? fmt$(pricing.projectedMonthlyFees * 12) : "—", tone: styles["value--info"] },
                hasCurrentCost
                  ? { lbl: "Annual Savings", val: pricing ? fmt$(savings * 12) : "—", tone: styles["value--success"] }
                  : { lbl: "Savings", val: "No statement", tone: "" },
                { lbl: "New Effective Rate", val: pricing ? fmtPct2(pricing.projectedMonthlyFees / vol) : "—", tone: "" },
              ].map(m => (
                <div key={m.lbl} className={styles.box}>
                  <div className={`${styles.boxValue} ${styles["boxValue--metric"]} ${m.tone}`}>{m.val}</div>
                  <div className={styles.boxSub}>{m.lbl}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right: Controls */}
        <div className={styles.layoutSide}>
          {/* The quoted rates. NOT behind the AIO Internal disclosure below —
              these are the numbers the merchant is reading off the screen, and
              the rep edits them in front of them. */}
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>Rates</h2>
            <RateFields value={rates} onChange={setRates} />
          </div>

          {/* Margin target — AIO-internal, so it stays collapsed until the rep
              opens it, and the header carries no figure of its own. The rep
              often has the laptop turned toward the merchant. */}
          <div className={styles.panel}>
            <button
              type="button"
              className={styles.disclosureBtn}
              aria-expanded={internalOpen}
              aria-controls="pricing-internal"
              onClick={() => setInternalOpen(o => !o)}
            >
              AIO Internal
              <span className={styles.disclosureChevron} aria-hidden="true">▾</span>
            </button>
            {internalOpen && (
              <div id="pricing-internal" className={styles.disclosureBody}>
              {/* Margin is REPORTED here, not set. It stopped being an input
                  on 2026-10-06: the rep quotes a rate and this is what that
                  rate leaves over interchange. Nothing below blocks — the
                  floor is shown so a rep knows where they are, and a quote
                  under it still saves. */}
              <div className={styles.sliderHeader}>
                <span className={styles.sliderLabel}>Margin at this rate</span>
                <span className={styles.sliderValue}>{earnedMargin == null ? "—" : fmtPct2(earnedMargin)}</span>
              </div>
              {pricing && (
                <>
                  <div className={styles.miniRow}>
                    <span className={styles.miniRowLabel}>AIO Revenue</span>
                    <span className={`${styles.miniRowValue} ${styles["value--accent"]}`}>{fmt$(pricing.aioRevenue)}/mo</span>
                  </div>
                  {pricing.adyenCostRate != null && (
                    <>
                      <div className={styles.miniRow}>
                        <span className={styles.miniRowLabel}>− {activeProcessor?.name || "Processor"} Cost</span>
                        <span className={`${styles.miniRowValue} ${styles["value--warning"]}`}>{fmtPct2(pricing.adyenCostRate)}</span>
                      </div>
                      <div className={styles.miniRow}>
                        <span className={styles.miniRowLabel}>= Net Margin to AIO</span>
                        <span className={`${styles.miniRowValue} ${belowFloor ? styles["value--danger"] : styles["value--success"]}`}>{earnedMargin == null ? "—" : fmtPct2(earnedMargin - pricing.adyenCostRate)}</span>
                      </div>
                    </>
                  )}
                  {belowFloor && (
                    <div className={styles.alertDanger}>
                      <strong>Below cost.</strong> AIO loses money on this deal at this rate. Not blocked — but don&rsquo;t send it without asking.
                    </div>
                  )}
                  {belowMin && (
                    <div className={styles.alertDanger}>
                      <strong>Below margin floor.</strong> This rate earns less than AIO&rsquo;s minimum of {fmt$(pricing.marginFloor)}/mo at this volume. Raise it to generate the proposal.
                    </div>
                  )}
                  {aboveMax && (
                    <div className={styles.alertWarning}>
                      Above the ceiling of {fmtPct2(pricing.maxMargin)} for this volume tier — allowed, but the merchant may be overpaying.
                    </div>
                  )}
                </>
              )}
              </div>
            )}
          </div>

          {/* Card mix (CP/CNP split) — defaults 90/10, rep-adjustable */}
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>Card Mix</h2>
            <div className={styles.fieldGroup} style={{ marginTop: 0 }}>
              <label className={styles.fieldLabel}>Card Present (%)</label>
              <input
                type="number" min="0" max="100" step="1"
                value={Math.round(cpPct * 100)}
                onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) setCpPct(Math.min(1, Math.max(0, v / 100))); }}
                className={styles.input}
              />
            </div>
            <div className={styles.miniRow}>
              <span className={styles.miniRowLabel}>Card Not Present</span>
              <span className={styles.miniRowValue}>{Math.round((1 - cpPct) * 100)}%</span>
            </div>
          </div>

          {/* Fee overrides */}
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>Fee Overrides</h2>
            {model === "2-tier" ? (
              <>
                <div className={styles.fieldGroup} style={{ marginTop: 0 }}>
                  <label className={styles.fieldLabel}>CP Per-Txn ($)</label>
                  <input type="number" step="0.01" value={feeOverrides.cpPerTxnFee || ""} onChange={e => setOverride("cpPerTxnFee", e.target.value)} placeholder="0.10" className={styles.input} />
                </div>
                <div className={styles.fieldGroup}>
                  <label className={styles.fieldLabel}>CNP Per-Txn ($)</label>
                  <input type="number" step="0.01" value={feeOverrides.cnpPerTxnFee || ""} onChange={e => setOverride("cnpPerTxnFee", e.target.value)} placeholder="0.15" className={styles.input} />
                </div>
              </>
            ) : (
              <div className={styles.fieldGroup} style={{ marginTop: 0 }}>
                <label className={styles.fieldLabel}>Per-Txn ($)</label>
                <input type="number" step="0.01" value={feeOverrides.perTxnFee || ""} onChange={e => setOverride("perTxnFee", e.target.value)} placeholder="0.10" className={styles.input} />
              </div>
            )}
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>Monthly Fee ($)</label>
              <input type="number" step="1" value={feeOverrides.monthlyFee || ""} onChange={e => setOverride("monthlyFee", e.target.value)} placeholder="0" className={styles.input} />
            </div>
          </div>
        </div>
      </div>

      {error && <div className={styles.alertDanger} style={{ marginTop: "var(--space-md)" }}>{error}</div>}

      <div className={styles.actions}>
        <button className={styles.btnGhost} onClick={onBack}>← Re-analyze</button>
        <button
          className={styles.btnPrimary}
          style={{ opacity: (loading || !pricing) ? 0.6 : 1 }}
          disabled={loading || !pricing || belowMin}
          onClick={generate}
        >
          {loading ? "Preparing proposal…" : "Continue to Products →"}
        </button>
      </div>
    </div>
  );
}
