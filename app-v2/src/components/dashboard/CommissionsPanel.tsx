"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getCommissionReportAction } from "@/lib/actions/commissions";
import { fmt$, fmtPct2 } from "@/lib/utils";
import type { DealCommissionRow, CommissionDataGaps } from "@/lib/billing/commissionReport";
import styles from "./AdminDashboard.module.css";

// THE FULL PICTURE — everything that moved OFF PricingStep/EditQuotePanel on
// 2026-10-13 ("the only thing to display [to a rep] is the margin... the
// other stuff calculate it and store it in an admin only view somewhere").
// AIO Revenue, processor cost, net margin and the TRUE floor are the exact
// numbers CLAUDE.md says a rep must never receive — safe here because this
// whole action chain is admin-gated (getCommissionReportAction throws for
// anyone else), not because the UI merely hides a button.
//
// HARDWARE commission here is PER-PRODUCT, read from the HubSpot product
// library's `cost_to_rep`/`rep_commission`/`rsm_commission` and snapshotted
// onto each quote line at quote time (lib/commission.ts). There is no more
// global rate to set here — that design (migration 0022's `commission_policy`,
// a single admin-typed bps number applied to a margin nobody could compute)
// is superseded; see the SUPERSEDED comment in lib/actions/pricing.ts. As of
// 2026-10-13 the catalog itself is the blocker (0 of 39 active products carry
// a commission rate), which is why the "needs attention" section below is the
// most useful thing on this panel right now — it says WHICH products still
// need a cost or a rate, instead of every deal just reading "$0, nothing to
// see."

function dash(v: number | null | undefined): string {
  return v == null ? "—" : fmt$(v);
}
function dashPct(v: number | null | undefined): string {
  return v == null ? "—" : fmtPct2(v);
}

export default function CommissionsPanel() {
  const [rows, setRows] = useState<DealCommissionRow[] | null>(null);
  const [gaps, setGaps] = useState<CommissionDataGaps | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    getCommissionReportAction()
      .then(report => {
        setRows(report.rows);
        setGaps(report.gaps);
        setError(null);
      })
      .catch(e => setError(e instanceof Error ? e.message : "Could not load commissions"));
  };

  useEffect(load, []);

  const hasGaps = gaps !== null && (gaps.missingCost.length > 0 || gaps.zeroCost.length > 0 || gaps.recurringWithRate.length > 0);

  const cols = "1fr 110px 110px 100px 100px 120px 110px 110px 110px 130px 100px 110px 110px 110px";

  return (
    <>
      <div className={styles.revenueHead}>
        <p className={styles.revenueCaption}>
          The full per-deal picture that moved off the rep-facing pricing screens on 2026-10-13: AIO
          Revenue, processor cost, net margin, the true margin floor, the processing commission split
          (10% of total ARR — 5% at signing, 5% at activation), and per-product hardware commission.
          Admin only.
        </p>
        <p className={styles.revenueCaption}>
          <strong>There are TWO different margins below, columns labelled &ldquo;Floor:&rdquo; vs
          &ldquo;Wholesale:&rdquo;, and they do not agree — by design, not by bug.</strong> The{" "}
          <strong>Floor</strong> columns (AIO Rev/mo, Proc. Cost, Net Margin, True Floor/mo) are revenue
          over actual INTERCHANGE, the same basis that enforces the margin floor a quote can be refused
          against. The <strong>Wholesale</strong> columns (Total Rev/mo, Take Rate, Margin) are the
          product owner&rsquo;s 10/13 formula — one blended CP rate and flat per-transaction fee against
          a ticket-indexed wholesale table — and are what actually drives <code>payment_processing_arr</code>{" "}
          and therefore commission. On one live row these diverged by 0.7 points of margin. Don&rsquo;t
          read one as a sanity check on the other.
        </p>
        <p className={styles.revenueCaption}>
          <strong>A dash in the Wholesale columns with a note under the merchant name</strong> means this
          deal&rsquo;s stored card rate exceeds the plausibility ceiling — the ARR/commission figures were
          skipped rather than computed off a typo (e.g. 20.00% entered instead of 2.00%), since that
          number would otherwise pay a real commission on a fat-fingered rate.
        </p>
        <p className={styles.revenueCaption}>
          <strong>Recurring ARR, total ARR, and the two processing-commission figures below are
          ESTIMATES</strong> — built from this quote&rsquo;s own line items, not a live read of
          HubSpot&rsquo;s actual <code>saas_revenue</code>. They can and do differ from what actually
          gets written to the deal: the real write (behind <code>COMMISSION_WRITEBACK_ENABLED</code>,
          off today) reads HubSpot&rsquo;s own <code>saas_revenue</code> at the moment of acceptance
          instead of estimating it — see lib/billing/commissionWriteback.ts.
        </p>
        <p className={styles.revenueCaption}>
          <strong>Rep/RSM hardware commission is the real formula</strong> — (price after discount −
          cost) × rate — over each product&rsquo;s own <code>cost_to_rep</code>/<code>rep_commission</code>/
          <code>rsm_commission</code> from the HubSpot product library, one-time lines only. A dash
          means no cost and rate are on file for that line, not a measured zero.
        </p>
      </div>

      {error && <div className={styles.emptyState}>{error}</div>}

      {gaps && hasGaps && (
        <div className={styles.panel} style={{ marginBottom: "var(--space-md, 16px)", borderColor: "var(--warning)" }}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Needs attention — hardware commission catalog gaps</h2>
          </div>
          <p className={styles.revenueCaption}>
            Hardware commission is computed per product from the HubSpot product library. These are the
            products on file across every deal that leave that computation incomplete or questionable.
          </p>
          {gaps.missingCost.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <strong>No cost on file ({gaps.missingCost.length})</strong> — these lines contribute no
              commission at all until a &ldquo;Cost to Rep&rdquo; is entered.
              <div style={{ opacity: 0.85, fontSize: 13, marginTop: 4 }}>{gaps.missingCost.join(", ")}</div>
            </div>
          )}
          {gaps.zeroCost.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <strong>Costed at a literal $0 ({gaps.zeroCost.length})</strong> — honoured as a real
              zero, so the entire sale price pays commission. Almost certainly means nobody has entered
              a real cost yet, not that the product truly costs nothing.
              <div style={{ opacity: 0.85, fontSize: 13, marginTop: 4 }}>{gaps.zeroCost.join(", ")}</div>
            </div>
          )}
          {gaps.recurringWithRate.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <strong>Recurring product carrying a commission rate ({gaps.recurringWithRate.length})</strong> —
              hardware commission is one-time-dollars only, so these rates are excluded from every total.
              Likely a misconfigured product.
              <div style={{ opacity: 0.85, fontSize: 13, marginTop: 4 }}>{gaps.recurringWithRate.join(", ")}</div>
            </div>
          )}
        </div>
      )}

      {rows === null && !error && <div className={styles.panel}><div className={styles.emptyState}>Loading commissions…</div></div>}

      {rows && rows.length === 0 && (
        <div className={styles.panel}>
          <div className={styles.emptyState}>
            Nothing to report yet — no application has a statement, a rep-entered volume/ticket, any
            quote lines to compute a commission basis from, or any hardware line with both a cost and a
            rate on file.
          </div>
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className={styles.panel}>
          <div className={styles.tableHeader} style={{ gridTemplateColumns: cols }}>
            {[
              "Merchant",
              "Floor: AIO Rev/mo", "Floor: Proc. Cost", "Floor: Net Margin", "Floor: True Floor/mo",
              "Wholesale: Total Rev/mo", "Wholesale: Take Rate", "Wholesale: Margin",
              "Processing ARR", "Recurring ARR (est.)", "Signing (est.)", "Activation (est.)",
              "Rep HW Comm.", "RSM HW Comm.",
            ].map(h => (
              <div key={h} className={styles.tableHeaderCell}>{h}</div>
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
                      {" · stored rate "}{fmtPct2(r.implausibleRate)}{" implausible — Wholesale/ARR skipped"}
                    </span>
                  )}
                </div>
              </div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Floor: AIO Rev/mo">{dash(r.aioRevenue)}</div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Floor: Proc. Cost">{dashPct(r.processorCostRate)}</div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Floor: Net Margin">{dashPct(r.netMarginRate)}</div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Floor: True Floor/mo">{dash(r.trueMarginFloor)}</div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Wholesale: Total Rev/mo">{dash(r.totalRevenue)}</div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Wholesale: Take Rate">{dashPct(r.totalTakeRate)}</div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Wholesale: Margin">{dashPct(r.wholesaleMargin)}</div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Processing ARR">{dash(r.processingArr)}</div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Recurring ARR">{dash(r.recurringArr)}</div>
              <div className={`${styles.tableCell} ${styles.numeric} ${styles.success}`} data-label="Signing">{dash(r.signingCommission)}</div>
              <div className={`${styles.tableCell} ${styles.numeric} ${styles.success}`} data-label="Activation">{dash(r.activationCommission)}</div>
              <div className={`${styles.tableCell} ${styles.numeric} ${styles.success}`} data-label="Rep HW Comm.">{dash(r.repHardwareCommission)}</div>
              <div className={`${styles.tableCell} ${styles.numeric} ${styles.success}`} data-label="RSM HW Comm.">{dash(r.rsmHardwareCommission)}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
