"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getRevenueReportAction } from "@/lib/actions/revenue";
import { monthOverMonth, type RevenueReport } from "@/lib/revenueView";
import { fmt$, fmtPct2 } from "@/lib/utils";
import styles from "./AdminDashboard.module.css";

// THE MONEY VIEW — what AIO actually earned, as opposed to what the merchant
// saves, which is the only money figure /admin showed before this.
//
// The source is `merchant_monthly_actuals`: settled Adyen volume and AIO's
// commission on it, ingested nightly from the payments accounting report. It
// has been filling up since the actuals cron shipped and nothing read it.
//
// It is PROCESSING COMMISSION ONLY. Platform fees, hardware and services are
// billed through HubSpot and are not in this table, so the caption says so
// rather than letting a reader take one line for the whole business. Empty
// until real tenants settle real money — which is the honest answer to "where
// would I see this if the accounts weren't fake", not a bug to paper over with
// a projection.

function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  const date = new Date(Number(y), Number(m) - 1, 1);
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/** A month-over-month delta, or a dash when there is nothing to compare to. */
function Delta({ current, previous }: { current: number; previous: number | null | undefined }) {
  const change = monthOverMonth(current, previous);
  if (change === null) {
    return <div className={`${styles.revenueCardDelta} ${styles.deltaNone}`}>No prior month</div>;
  }
  const up = change >= 0;
  return (
    <div className={`${styles.revenueCardDelta} ${up ? styles.deltaUp : styles.deltaDown}`}>
      {up ? "▲" : "▼"} {Math.abs(change * 100).toFixed(1)}% vs last month
    </div>
  );
}

export default function RevenuePanel() {
  const [report, setReport] = useState<RevenueReport | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // One read serves every month — see getRevenueReportAction — so switching
  // months below is local, not another round trip.
  useEffect(() => {
    let cancelled = false;
    getRevenueReportAction(month)
      .then(r => { if (!cancelled) { setReport(r); setError(null); } })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "Could not load revenue"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [month]);

  const cols = "1fr 130px 110px 130px 110px";

  if (loading) return <div className={styles.panel}><div className={styles.emptyState}>Loading revenue…</div></div>;
  if (error)   return <div className={styles.panel}><div className={styles.emptyState}>{error}</div></div>;

  if (!report || report.months.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.emptyState}>
          No settled revenue yet. This fills in from Adyen&rsquo;s settlement reports once live
          merchants start processing — one row per merchant per month, with AIO&rsquo;s commission
          on each.
        </div>
      </div>
    );
  }

  const selected = report.selected!;

  return (
    <>
      <div className={styles.revenueHead}>
        <p className={styles.revenueCaption}>
          Settled processing volume and AIO&rsquo;s commission on it, read back from Adyen&rsquo;s
          settlement reports — money that moved, not quoted or projected. Platform fees, hardware
          and services bill through HubSpot and are <strong>not</strong> included here.
        </p>
        <select
          className={styles.monthSelect}
          value={selected.month}
          onChange={e => setMonth(e.target.value)}
          aria-label="Month"
        >
          {report.months.map(m => (
            <option key={m.month} value={m.month}>{monthLabel(m.month)}</option>
          ))}
        </select>
      </div>

      <div className={styles.revenueCards}>
        <div className={styles.revenueCard}>
          <div className={styles.revenueCardValue}>{fmt$(selected.aioCommission)}</div>
          <div className={styles.revenueCardLabel}>AIO Commission</div>
          <Delta current={selected.aioCommission} previous={report.previous?.aioCommission} />
        </div>
        <div className={styles.revenueCard}>
          <div className={styles.revenueCardValue}>{fmt$(selected.grossVolume)}</div>
          <div className={styles.revenueCardLabel}>Processed Volume</div>
          <Delta current={selected.grossVolume} previous={report.previous?.grossVolume} />
        </div>
        <div className={styles.revenueCard}>
          <div className={styles.revenueCardValue}>
            {selected.grossVolume > 0 ? fmtPct2(selected.aioCommission / selected.grossVolume) : "—"}
          </div>
          <div className={styles.revenueCardLabel}>Effective Take Rate</div>
          <div className={`${styles.revenueCardDelta} ${styles.deltaNone}`}>
            {selected.transactionCount.toLocaleString()} transactions
          </div>
        </div>
        <div className={styles.revenueCard}>
          <div className={styles.revenueCardValue}>{selected.merchants}</div>
          <div className={styles.revenueCardLabel}>Merchants Settling</div>
          <Delta current={selected.merchants} previous={report.previous?.merchants} />
        </div>
      </div>

      <div className={styles.panel}>
        <div className={styles.tableHeader} style={{ gridTemplateColumns: cols }}>
          {["Merchant", "Volume", "Txns", "AIO Commission", "Take Rate"].map(h => (
            <div key={h} className={styles.tableHeaderCell}>{h}</div>
          ))}
        </div>
        {report.merchants.map(r => {
          const name = r.merchantName ?? (
            // A tenant that settles money but matches no EasyOB application:
            // real revenue, no name. Shown rather than dropped, or the totals
            // above would not add up to the rows below.
            <span className={styles.unattributed}>Unattributed tenant</span>
          );
          return (
            <div key={r.tenantNumber} className={styles.tableRow} style={{ gridTemplateColumns: cols }}>
              <div className={styles.tableCell} data-label="Merchant">
                <div className={styles.repName}>
                  {r.applicationId
                    ? <Link href={`/admin?view=accounts&app=${r.applicationId}`}>{name}</Link>
                    : name}
                </div>
                <div className={styles.tenantRef}>Tenant {r.tenantNumber}</div>
              </div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Volume">{fmt$(r.grossVolume)}</div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Txns">{r.transactionCount.toLocaleString()}</div>
              <div className={`${styles.tableCell} ${styles.numeric} ${styles.success}`} data-label="AIO Commission">{fmt$(r.aioCommission)}</div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Take Rate">
                {r.effectiveRate === null ? "—" : fmtPct2(r.effectiveRate)}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
