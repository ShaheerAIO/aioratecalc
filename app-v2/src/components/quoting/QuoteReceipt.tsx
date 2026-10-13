"use client";

import {
  describeBillingStart,
  isCompedService,
  lineListAmount,
  lineNetAmount,
} from "@/lib/quoting";
import { lineHardwareCommission, quoteHardwareCommission } from "@/lib/commission";
import { fmt$, fmtCycle, fmtFrequency } from "@/lib/utils";
import type { QuoteLine, QuoteTotals } from "@/types/merchant";
import styles from "./ProductConfigurator.module.css";

type Props = {
  lines: QuoteLine[];
  totals: QuoteTotals;
  packageSavings: number;
  discountTotal: number;
  dueAtCheckout: number;
  /** Set when the $0.50 pre-authorization is on the quote. */
  preAuthAmount: number | null;
};

/**
 * The quote, read as a receipt: every line, then the subtotal it belongs to.
 * One-time and recurring stay in separate groups — they are different units
 * and are never added into one number.
 */
export default function QuoteReceipt({
  lines, totals, packageSavings, discountTotal, dueAtCheckout, preAuthAmount,
}: Props) {
  const oneTime = lines.filter(l => l.billingFrequency === "one_time");

  // Hardware-only, one-time-line rep commission (lib/commission.ts) — never
  // the RSM figure and never the underlying cost, both of which are
  // admin-only. Computed over every line; `quoteHardwareCommission` itself
  // ignores recurring ones. Shown only when at least one line produced a
  // real figure — with no commission data loaded in the catalog (the state
  // today, 2026-10-13), this is false and the row is simply absent, rather
  // than a misleading $0.00.
  const hardware = quoteHardwareCommission(lines);
  const hasHardwareCommission = hardware.perLine.some(l => l.rep != null);

  return (
    <div className={styles.panel}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Quote Totals</h2>
        <p className={styles.sectionNote}>
          Every line, then what it adds up to. One-time and recurring charges stay in their own totals.
        </p>
      </div>

      {oneTime.length > 0 && (
        <ReceiptGroup title="Due once" subtotal={fmt$(totals.oneTime)} lines={oneTime} />
      )}

      {totals.recurring.map(r => (
        <ReceiptGroup
          key={r.frequency}
          title={`Per ${fmtFrequency(r.frequency)}`}
          subtotal={`${fmt$(r.amount)}/${fmtCycle(r.frequency)}`}
          lines={lines.filter(l => l.billingFrequency === r.frequency)}
        />
      ))}

      {packageSavings > 0 && (
        <div className={styles.totalRow}>
          <span className={styles.totalLabel}>Package savings</span>
          <span className={styles.totalValue} data-tone="discount">−{fmt$(packageSavings)}</span>
        </div>
      )}
      {discountTotal > 0 && (
        <div className={styles.totalRow}>
          <span className={styles.totalLabel}>Discounts applied</span>
          <span className={styles.totalValue} data-tone="discount">−{fmt$(discountTotal)}</span>
        </div>
      )}
      {hasHardwareCommission && (
        <div className={styles.totalRow}>
          <span className={styles.totalLabel}>Hardware commission (est.)</span>
          {/* Never clamped — a package-covered line sits at 100% off, so its
              margin, and the commission on it, is negative by construction.
              fmt$ renders a negative figure with its own minus sign, so this
              is NOT prefixed with "−" the way the discount rows above are. */}
          <span
            className={styles.totalValue}
            data-tone="commission"
            data-sign={hardware.rep < 0 ? "negative" : undefined}
          >
            {fmt$(hardware.rep)}
          </span>
        </div>
      )}
      <div className={styles.totalRow}>
        <span className={styles.totalLabel}>Due at checkout</span>
        <span className={styles.totalValue}>{fmt$(dueAtCheckout)}</span>
      </div>
      <div className={styles.totalRow} data-emphasis="true">
        <span className={styles.totalLabel}>All recurring, monthly equivalent</span>
        <span className={styles.totalValue}>{fmt$(totals.monthlyEquivalent)}/mo</span>
      </div>
      {preAuthAmount != null && (
        <p className={styles.sectionNote}>
          Nothing else is charged at checkout, so a {fmt$(preAuthAmount)} card pre-authorization is
          added automatically. It can&apos;t be edited or removed — it&apos;s what lets the billing
          start be delayed.
        </p>
      )}
    </div>
  );
}

function ReceiptGroup({ title, subtotal, lines }: { title: string; subtotal: string; lines: QuoteLine[] }) {
  return (
    <div className={styles.receiptGroup}>
      <div className={styles.receiptGroupTitle}>{title}</div>
      {lines.map((line, i) => (
        <ReceiptLine key={`${line.hubspotProductId}-${i}`} line={line} />
      ))}
      <div className={styles.receiptSubtotal}>
        <span>Subtotal</span>
        <span>{subtotal}</span>
      </div>
    </div>
  );
}

function ReceiptLine({ line }: { line: QuoteLine }) {
  const discounted = (line.discountPercent ?? 0) > 0;
  const tag = line.coveredByPackage ? "In package" : isCompedService(line) ? "Included" : null;
  const cycle = line.billingFrequency === "one_time" ? "" : `/${fmtCycle(line.billingFrequency)}`;
  // Hardware commission is ONE-TIME lines only (lib/commission.ts) — a
  // recurring line never gets a figure here. Only the rep's own number: RSM
  // commission and the underlying cost are admin-only and never rendered in
  // this component.
  const commission = line.billingFrequency === "one_time" ? lineHardwareCommission(line) : null;

  return (
    <div className={styles.receiptLine}>
      <div className={styles.receiptName}>
        {line.name}
        {tag && <span className={styles.receiptTag}>{tag}</span>}
      </div>
      <div className={styles.receiptMeta}>
        {line.qty} × {fmt$(line.unitPrice)}{cycle}
        {line.billingStart && ` · ${describeBillingStart(line.billingStart)}`}
      </div>
      {/* Rendered only when there's a real figure — null means "no cost or no
          rate on file", not "zero commission", so it's omitted rather than
          shown as $0.00 or a dash. */}
      {commission?.rep != null && (
        <div
          className={styles.receiptCommission}
          data-sign={commission.rep < 0 ? "negative" : undefined}
        >
          Your est. commission: {fmt$(commission.rep)}
        </div>
      )}
      <div className={styles.receiptAmount}>
        {discounted && <span className={styles.strike}>{fmt$(lineListAmount(line))}</span>}{" "}
        <span>{fmt$(lineNetAmount(line))}</span>
      </div>
    </div>
  );
}
