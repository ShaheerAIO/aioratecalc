"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { getCommissionReportAction } from "@/lib/actions/commissions";
import { fmt$, fmtPct2 } from "@/lib/utils";
import type { DealCommissionRow, CommissionDataGaps } from "@/lib/billing/commissionReport";
import styles from "./AdminDashboard.module.css";

// THE FULL PICTURE — everything that moved OFF PricingStep/EditQuotePanel on
// 2026-10-13 ("the only thing to display [to a rep] is the margin... the
// other stuff calculate it and store it in an admin only view somewhere").
// Admin only — enforced in getCommissionReportAction (throws for anyone
// else), not by this component hiding a button.
//
// Default columns are the product owner's own ask (2026-10-13): "why are
// there like 8 diff values on that table it should be like two. Total rev
// and total take rate." The four FLOOR columns (the true margin-floor
// enforcement basis CLAUDE.md says a rep must never see — safe here, this
// whole chain is admin-gated) are real and still needed for debugging a
// refused quote, so they live behind "Show cost basis" rather than being
// deleted — collapsed by default instead of competing with the two numbers
// that actually matter day to day.
//
// HARDWARE commission here is PER-PRODUCT, read from the HubSpot product
// library's `cost_to_rep`/`rep_commission`/`rsm_commission` and snapshotted
// onto each quote line at quote time (lib/commission.ts). The "needs
// attention" box below is the most useful thing on this panel while that
// catalog is still mostly unpopulated (2026-10-13: 0 of 39 active products
// carry a commission rate) — it says WHICH products still need a cost or a
// rate, instead of every deal just reading "$0, nothing to see."

function dash(v: number | null | undefined): string {
  return v == null ? "—" : fmt$(v);
}
function dashPct(v: number | null | undefined): string {
  return v == null ? "—" : fmtPct2(v);
}

const BASE_COLS = "1fr 110px 90px 120px 110px 100px 100px 110px 110px";
const FLOOR_COLS = " 110px 100px 100px 120px";

const BASE_HEADERS: { label: string; title: string }[] = [
  { label: "Merchant", title: "A dash elsewhere with a note under the name means this deal's stored card rate is implausible — ARR/commission were skipped rather than computed off a likely typo." },
  { label: "Total Rev/mo", title: "(CP Rate × Monthly Volume) + ((Monthly Volume ÷ Avg Ticket) × Txn Fee) — the product owner's 10/13 wholesale formula. Drives payment_processing_arr and commission." },
  { label: "Take Rate", title: "Total Rev/mo ÷ Monthly Volume." },
  { label: "Processing ARR", title: "What's written to HubSpot's payment_processing_arr at acceptance — appliedTargetMargin × monthly volume × 12." },
  { label: "Total ARR (est.)", title: "Processing ARR + estimated recurring ARR from this quote's own line items (not a live HubSpot saas_revenue read) — the denominator for Signing/Activation." },
  { label: "Signing (est.)", title: "5% of Total ARR (est.), paid at signing." },
  { label: "Activation (est.)", title: "5% of Total ARR (est.), paid at activation." },
  { label: "Rep HW Comm.", title: "(Price after discount − cost) × rate, one-time lines only. Dash means no cost/rate on file for this line, not a measured zero." },
  { label: "RSM HW Comm.", title: "Same formula as Rep HW Comm., at the RSM's own rate." },
];

const FLOOR_HEADERS: { label: string; title: string }[] = [
  { label: "AIO Rev/mo", title: "Revenue over true interchange — the margin-floor enforcement basis." },
  { label: "Proc. Cost", title: "True Adyen cost rate for this volume." },
  { label: "Net Margin", title: "Applied target margin − Proc. Cost — what a quote is actually refused against." },
  { label: "True Floor/mo", title: "The true minimum profitable margin floor for this deal's volume tier. Never shown to reps." },
];

export default function CommissionsPanel() {
  const [rows, setRows] = useState<DealCommissionRow[] | null>(null);
  const [gaps, setGaps] = useState<CommissionDataGaps | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCostBasis, setShowCostBasis] = useState(false);

  useEffect(() => {
    getCommissionReportAction()
      .then(report => {
        setRows(report.rows);
        setGaps(report.gaps);
        setError(null);
      })
      .catch(e => setError(e instanceof Error ? e.message : "Could not load commissions"));
  }, []);

  const hasGaps = gaps !== null && (gaps.missingCost.length > 0 || gaps.zeroCost.length > 0 || gaps.recurringWithRate.length > 0);

  const cols = showCostBasis ? BASE_COLS + FLOOR_COLS : BASE_COLS;
  const headers = showCostBasis ? [...BASE_HEADERS, ...FLOOR_HEADERS] : BASE_HEADERS;

  return (
    <>
      <div className={styles.revenueHead}>
        <p className={styles.revenueCaption}>
          Per-deal commission detail — AIO revenue, processing ARR, and the signing/activation/hardware
          splits that moved off the rep-facing pricing screens on 2026-10-13. Admin only. Hover a column
          header for how it&rsquo;s computed.
        </p>
        <button
          type="button"
          className={styles.toggleBtn}
          data-active={showCostBasis}
          onClick={() => setShowCostBasis(v => !v)}
        >
          {showCostBasis ? "Hide cost basis" : "Show cost basis"}
        </button>
      </div>

      {showCostBasis && (
        <p className={styles.revenueCaption}>
          The Floor columns are the true margin-floor enforcement basis — they disagree with Total
          Rev/mo and Take Rate by design. Don&rsquo;t read one as a sanity check on the other.
        </p>
      )}

      {error && <div className={styles.emptyState}>{error}</div>}

      {gaps && hasGaps && (
        <div className={styles.panel} style={{ marginBottom: "var(--space-md, 16px)", borderColor: "var(--warning)", padding: "var(--space-md) var(--space-lg)" }}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Needs attention — hardware commission gaps</h2>
          </div>
          <ul style={{ listStyle: "none", margin: "var(--space-xs) 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
            {gaps.missingCost.length > 0 && (
              <li title="These lines contribute no commission at all until a Cost to Rep is entered.">
                <strong>No cost on file ({gaps.missingCost.length}):</strong> {gaps.missingCost.join(", ")}
              </li>
            )}
            {gaps.zeroCost.length > 0 && (
              <li title="Honoured as a real zero — the entire sale price pays commission. Almost certainly nobody has entered a real cost yet.">
                <strong>Costed at a literal $0 ({gaps.zeroCost.length}):</strong> {gaps.zeroCost.join(", ")}
              </li>
            )}
            {gaps.recurringWithRate.length > 0 && (
              <li title="Hardware commission is one-time-dollars only, so these rates are excluded from every total. Likely a misconfigured product.">
                <strong>Recurring product carrying a rate ({gaps.recurringWithRate.length}):</strong> {gaps.recurringWithRate.join(", ")}
              </li>
            )}
          </ul>
        </div>
      )}

      {rows === null && !error && <div className={styles.panel}><div className={styles.emptyState}>Loading commissions…</div></div>}

      {rows && rows.length === 0 && (
        <div className={styles.panel}>
          <div className={styles.emptyState}>
            Nothing to report yet — no deals have a pricing basis or any hardware commission data.
          </div>
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className={styles.panel}>
          <div className={styles.tableHeader} style={{ gridTemplateColumns: cols }}>
            {headers.map(h => (
              <div key={h.label} className={styles.tableHeaderCell} title={h.title}>{h.label}</div>
            ))}
          </div>
          {rows.map(r => (
            <div key={r.applicationId} className={styles.tableRow} style={{ gridTemplateColumns: cols }}>
              <div className={styles.tableCell} data-label="Merchant">
                <Link href={`/admin?view=accounts&app=${r.applicationId}`}>{r.merchantName ?? "Unnamed account"}</Link>
                <div className={styles.tenantRef}>
                  {r.stage}{r.quoteAcceptedAt ? " · accepted" : ""}
                  {r.implausibleRate != null && (
                    <span style={{ color: "var(--warning)" }}>
                      {" · stored rate "}{fmtPct2(r.implausibleRate)}{" implausible — skipped"}
                    </span>
                  )}
                </div>
              </div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Total Rev/mo">{dash(r.totalRevenue)}</div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Take Rate">{dashPct(r.totalTakeRate)}</div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Processing ARR">{dash(r.processingArr)}</div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Total ARR (est.)">{dash(r.totalArr)}</div>
              <div className={`${styles.tableCell} ${styles.numeric} ${styles.success}`} data-label="Signing (est.)">{dash(r.signingCommission)}</div>
              <div className={`${styles.tableCell} ${styles.numeric} ${styles.success}`} data-label="Activation (est.)">{dash(r.activationCommission)}</div>
              <div className={`${styles.tableCell} ${styles.numeric} ${styles.success}`} data-label="Rep HW Comm.">{dash(r.repHardwareCommission)}</div>
              <div className={`${styles.tableCell} ${styles.numeric} ${styles.success}`} data-label="RSM HW Comm.">{dash(r.rsmHardwareCommission)}</div>
              {showCostBasis && (
                <>
                  <div className={`${styles.tableCell} ${styles.numeric}`} data-label="AIO Rev/mo">{dash(r.aioRevenue)}</div>
                  <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Proc. Cost">{dashPct(r.processorCostRate)}</div>
                  <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Net Margin">{dashPct(r.netMarginRate)}</div>
                  <div className={`${styles.tableCell} ${styles.numeric}`} data-label="True Floor/mo">{dash(r.trueMarginFloor)}</div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
