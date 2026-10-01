"use client";

import { fmt$, fmtPct, fmtPct2 } from "@/lib/utils";
import { calcAdyenCost } from "@/lib/pricing";
import type { StatementAnalysis, Processor, ProcessorTier } from "@/types/merchant";
import styles from "./AnalysisStep.module.css";

type Props = {
  analysis: StatementAnalysis;
  activeProcessor: Processor | null;
  activeTier: ProcessorTier | null;
  onBack: () => void;
  onContinue: () => void;
};

// category color preserves the old T.blue/T.gold/T.green data-encoding for
// the 3-way fee split bar-chart segments — mapped 1:1 onto the new semantic
// tokens (info/warning/success), not accent.
const CAT_INFO    = { color: "var(--info)", cls: "cat--info" } as const;
const CAT_WARNING = { color: "var(--warning)", cls: "cat--warning" } as const;
const CAT_SUCCESS = { color: "var(--success)", cls: "cat--success" } as const;

export default function AnalysisStep({ analysis, activeProcessor, activeTier, onBack, onContinue }: Props) {
  const vol = analysis.totalVolume || 1;

  const feeRows = activeTier
    ? (() => {
        const adyenCost = calcAdyenCost(activeTier, analysis.totalVolume, analysis.totalTransactions);
        const adyenRate = adyenCost / (analysis.totalVolume || 1);
        const myMarkup  = Math.max(0, (analysis.processorFees || 0) - adyenCost);
        return [
          { name: "Interchange", note: analysis.interchangeNotShown ? "Back-calculated: total − markup − other" : "Card network cost — non-negotiable", amt: analysis.interchangeFees, rate: analysis.interchangeRate, ...CAT_INFO },
          { name: `${activeProcessor?.name} Cost`, note: "Acquirer cost: processing + txn + scheme", amt: adyenCost, rate: adyenRate, ...CAT_WARNING },
          { name: "Your Markup", note: "Processor markup above interchange & acquirer", amt: myMarkup, rate: myMarkup / (analysis.totalVolume || 1), ...CAT_SUCCESS },
          { name: "Other Fees", note: "Monthly, PCI, misc. — pure margin", amt: analysis.otherFees, rate: (analysis.otherFees || 0) / (analysis.totalVolume || 1), ...CAT_SUCCESS },
        ];
      })()
    : [
        { name: "Interchange", note: analysis.interchangeNotShown ? "Back-calculated from statement total" : "Pass-through", amt: analysis.interchangeFees, rate: analysis.interchangeRate, ...CAT_INFO },
        { name: "Processor Markup", note: "Where savings are found", amt: analysis.processorFees, rate: analysis.processorMarkup, ...CAT_WARNING },
        { name: "Other Fees", note: "Monthly, PCI, misc. — pure margin", amt: analysis.otherFees, rate: (analysis.otherFees || 0) / (analysis.totalVolume || 1), ...CAT_SUCCESS },
      ];

  const confidenceClass = analysis.confidence === "high" ? styles["confidence--high"] : analysis.confidence === "medium" ? styles["confidence--medium"] : styles["confidence--low"];

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>{analysis.merchantName || "Merchant"} — Analysis</h1>
          <p className={styles.metaLine}>
            {analysis.processingMonth} · {analysis.currentProcessorName} · Confidence:{" "}
            <span className={confidenceClass}>{analysis.confidence}</span>
          </p>
        </div>
        <div className={styles.modelBadge}>
          {analysis.currentPricingModel?.replace("-", " ").toUpperCase()}
        </div>
      </div>

      {/* IC+ back-calculated banner */}
      {analysis.interchangeNotShown && (
        <div className={styles.infoBanner}>
          <span className={styles.infoBannerIcon}>ℹ️</span>
          <div>
            <div className={styles.infoBannerTitle}>
              IC+ Statement — Interchange Back-Calculated ({analysis.currentProcessorName})
            </div>
            <div className={styles.infoBannerBody}>
              This statement shows total fees but does not itemize interchange separately.
              Markup was calculated from stated rates ({fmtPct2(analysis.statedMarkupRate)} + ${(analysis.statedPerTxnFee || 0).toFixed(2)}/txn).
              <strong> Interchange = total fees − markup − other fees</strong>.
            </div>
          </div>
        </div>
      )}

      {/* Key metrics */}
      <div className={styles.metricsGrid}>
        {[
          { label: "Monthly Volume", val: fmt$(analysis.totalVolume) },
          { label: "Total Fees", val: fmt$(analysis.totalFees), accent: true },
          { label: "Effective Rate", val: fmtPct2(analysis.effectiveRate), accent: true },
          { label: "Avg Ticket", val: fmt$(analysis.averageTicket) },
        ].map(m => (
          <div key={m.label} className={`${styles.metricCard} ${m.accent ? styles["metricCard--accent"] : ""}`}>
            <div className={`${styles.metricValue} ${m.accent ? styles["metricValue--accent"] : ""}`}>{m.val}</div>
            <div className={styles.metricLabel}>{m.label}</div>
          </div>
        ))}
      </div>

      {/* Two readings of one statement, side by side: what they PAY on the
          left, what they PROCESS on the right. Collapses to one column below
          64rem — see .columns. */}
      <div className={styles.columns}>
        <div className={styles.column}>

          {/* Fee structure */}
          <div className={styles.feeSplitSection}>
            <h2 className={styles.sectionTitle}>Fee Structure — 3-Way Split</h2>
            <div className={styles.panel}>
              {feeRows.map(r => (
                <div key={r.name} className={styles.feeRow}>
                  <div>
                    <span className={`${styles.feeName} ${styles[r.cls]}`}>{r.name}</span>
                    <div className={styles.feeNote}>{r.note}</div>
                  </div>
                  <div className={styles.feeAmt}>{fmt$(r.amt)}</div>
                  <div className={styles.feeRate}>{fmtPct(r.rate)}</div>
                  <div className={styles.barTrack}>
                    <div className={styles.barFill} style={{ background: r.color, width: `${Math.min(((r.amt || 0) / (analysis.totalFees || 1)) * 100, 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>

        <div className={styles.column}>

          {/* Highlight box */}
          <div className={styles.highlightPanel}>
            <div>
              <div className={styles.highlightLabel}>Total Gross Margin Above Interchange</div>
              <div className={styles.highlightValue}>{fmtPct2(analysis.currentMargin || 0)}</div>
              <div className={styles.highlightSub}>Everything the merchant pays above interchange</div>
            </div>
            <div className={styles.highlightStats}>
              {[
                { val: fmt$((analysis.processorFees || 0) + (analysis.otherFees || 0)), lbl: "Monthly Gross" },
                { val: fmt$(((analysis.processorFees || 0) + (analysis.otherFees || 0)) * 12), lbl: "Annual Gross" },
              ].map((s, i) => (
                <div key={i} className={styles.highlightStat}>
                  <div className={styles.highlightStatValue}>{s.val}</div>
                  <div className={styles.highlightStatLabel}>{s.lbl}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Volume mix */}
          <div className={styles.volumeSection}>
            <h2 className={styles.sectionTitle}>Volume Mix</h2>
            <div className={styles.volumeGrid}>
              {[
                { label: "Card Present", pct: analysis.cardPresentPct, amt: analysis.cardPresentVolume },
                { label: "Card Not Present", pct: analysis.cardNotPresentPct, amt: analysis.cardNotPresentVolume },
                { label: "Reward Cards", pct: analysis.rewardCardPct, amt: vol * (analysis.rewardCardPct || 0) },
                { label: "Corporate Cards", pct: analysis.corporateCardPct, amt: vol * (analysis.corporateCardPct || 0) },
              ].map(m => (
                <div key={m.label} className={styles.volumeCard}>
                  <div className={styles.volumeLabel}>{m.label}</div>
                  <div className={styles.volumePct}>{fmtPct2(m.pct || 0)}</div>
                  <div className={styles.volumeAmt}>{fmt$(m.amt)}</div>
                </div>
              ))}
            </div>
          </div>

          {analysis.notes && (
            <div className={styles.notesBox}>
              <strong>AI Notes:</strong> {analysis.notes}
            </div>
          )}

        </div>
      </div>

      <div className={styles.actions}>
        <button className={styles.btnGhost} onClick={onBack}>← Re-upload</button>
        <button className={styles.btnPrimary} onClick={onContinue}>Select Pricing Model →</button>
      </div>
    </div>
  );
}
