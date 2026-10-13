"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getCommissionReportAction } from "@/lib/actions/commissions";
import { getHardwareCommissionPolicy, updateHardwareCommissionPolicyAction } from "@/lib/actions/pricing";
import { fmt$, fmtPct2 } from "@/lib/utils";
import type { DealCommissionRow } from "@/lib/billing/commissionReport";
import styles from "./AdminDashboard.module.css";

// THE FULL PICTURE — everything that moved OFF PricingStep/EditQuotePanel on
// 2026-10-13 ("the only thing to display [to a rep] is the margin... the
// other stuff calculate it and store it in an admin only view somewhere").
// AIO Revenue, processor cost, net margin and the TRUE floor are the exact
// numbers CLAUDE.md says a rep must never receive — safe here because this
// whole action chain is admin-gated (getCommissionReportAction throws for
// anyone else), not because the UI merely hides a button.
//
// The hardware commission rate lives here too (a plain number input, not a
// separate settings page): it's the one knob on commission_policy, it starts
// unset, and every row below shows $0.00 for it until an admin sets a rate —
// see lib/commission.ts for why that's structurally true regardless of the
// rate (no hardware cost data exists anywhere in this codebase yet).

function dash(v: number | null | undefined): string {
  return v == null ? "—" : fmt$(v);
}
function dashPct(v: number | null | undefined): string {
  return v == null ? "—" : fmtPct2(v);
}

export default function CommissionsPanel() {
  const [rows, setRows] = useState<DealCommissionRow[] | null>(null);
  const [hardwareBps, setHardwareBps] = useState<number | null>(null);
  const [rateInput, setRateInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    Promise.all([getCommissionReportAction(), getHardwareCommissionPolicy()])
      .then(([report, policy]) => {
        setRows(report);
        setHardwareBps(policy.hardwareCommissionBps);
        setRateInput(policy.hardwareCommissionBps == null ? "" : (policy.hardwareCommissionBps / 100).toString());
        setError(null);
      })
      .catch(e => setError(e instanceof Error ? e.message : "Could not load commissions"));
  };

  useEffect(load, []);

  const saveRate = async () => {
    setSaving(true);
    setError(null);
    try {
      const bps = rateInput.trim() === "" ? null : Math.round(parseFloat(rateInput) * 100);
      await updateHardwareCommissionPolicyAction(Number.isNaN(bps as number) ? null : bps);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the hardware commission rate");
    }
    setSaving(false);
  };

  const cols = "1fr 110px 110px 100px 100px 110px 110px 110px 110px 110px";

  return (
    <>
      <div className={styles.revenueHead}>
        <p className={styles.revenueCaption}>
          The full per-deal picture that moved off the rep-facing pricing screens on 2026-10-13: AIO
          Revenue, processor cost, net margin, the true margin floor, and the commission split (10% of
          total ARR — 5% at signing, 5% at activation). Admin only.
        </p>
        <p className={styles.revenueCaption}>
          <strong>Recurring ARR, total ARR, and both commission figures below are ESTIMATES</strong> —
          built from this quote&rsquo;s own line items, not a live read of HubSpot&rsquo;s actual{" "}
          <code>saas_revenue</code>. They can and do differ from what actually gets written to the deal:
          the real write (behind <code>COMMISSION_WRITEBACK_ENABLED</code>, off today) reads
          HubSpot&rsquo;s own <code>saas_revenue</code> at the moment of acceptance instead of estimating
          it — see lib/billing/commissionWriteback.ts.
        </p>
      </div>

      <div className={styles.panel} style={{ marginBottom: "var(--space-md, 16px)" }}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Hardware commission rate</h2>
        </div>
        <p className={styles.revenueCaption}>
          A percentage of hardware MARGIN (price minus cost). Unset by default — every row&rsquo;s
          hardware commission shows $0.00 until a rate is saved here, and even then it stays $0.00
          today: EasyOB has no hardware COST data anywhere (the catalog carries HubSpot&rsquo;s list
          price only), so there is no margin to apply this rate to yet. See lib/commission.ts.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
          <input
            type="number" step="0.01" min="0" max="100"
            placeholder="unset"
            value={rateInput}
            onChange={e => setRateInput(e.target.value)}
            style={{ width: 100 }}
            aria-label="Hardware commission rate, percent"
          />
          <span>%</span>
          <button type="button" onClick={saveRate} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          <span style={{ opacity: 0.7, fontSize: 13 }}>
            {hardwareBps == null ? "Currently unset." : `Currently ${(hardwareBps / 100).toFixed(2)}%.`}
          </span>
        </div>
      </div>

      {error && <div className={styles.emptyState}>{error}</div>}

      {rows === null && !error && <div className={styles.panel}><div className={styles.emptyState}>Loading commissions…</div></div>}

      {rows && rows.length === 0 && (
        <div className={styles.panel}>
          <div className={styles.emptyState}>
            Nothing to report yet — no application has a statement, a rep-entered volume/ticket, or
            any quote lines to compute a commission basis from.
          </div>
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className={styles.panel}>
          <div className={styles.tableHeader} style={{ gridTemplateColumns: cols }}>
            {[
              "Merchant", "AIO Rev/mo", "Proc. Cost", "Net Margin", "True Floor/mo",
              "Processing ARR", "Recurring ARR (est.)", "Signing (est.)", "Activation (est.)", "Hardware",
            ].map(h => (
              <div key={h} className={styles.tableHeaderCell}>{h}</div>
            ))}
          </div>
          {rows.map(r => (
            <div key={r.applicationId} className={styles.tableRow} style={{ gridTemplateColumns: cols }}>
              <div className={styles.tableCell} data-label="Merchant">
                <Link href={`/admin?view=accounts&app=${r.applicationId}`}>{r.merchantName ?? "Unnamed account"}</Link>
                <div className={styles.tenantRef}>{r.stage}{r.quoteAcceptedAt ? " · accepted" : ""}</div>
              </div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="AIO Rev/mo">{dash(r.aioRevenue)}</div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Proc. Cost">{dashPct(r.processorCostRate)}</div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Net Margin">{dashPct(r.netMarginRate)}</div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="True Floor/mo">{dash(r.trueMarginFloor)}</div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Processing ARR">{dash(r.processingArr)}</div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Recurring ARR">{dash(r.recurringArr)}</div>
              <div className={`${styles.tableCell} ${styles.numeric} ${styles.success}`} data-label="Signing">{dash(r.signingCommission)}</div>
              <div className={`${styles.tableCell} ${styles.numeric} ${styles.success}`} data-label="Activation">{dash(r.activationCommission)}</div>
              <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Hardware">{fmt$(r.hardwareCommission)}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
