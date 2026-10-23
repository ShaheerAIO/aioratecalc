"use client";

import {
  describeBillingStart,
  isCompedService,
  lineListAmount,
  lineNetAmount,
} from "@/lib/quoting";
import {
  commissionSummary,
  LineCommissionNote,
  UnpricedNote,
} from "@/components/quoting/HardwareCommission";
import { fmt$, fmtCycle, fmtFrequency, fmtPct2 } from "@/lib/utils";
import type { QuoteLine, QuoteTotals } from "@/types/merchant";
// Type-only — erased at build, so this does NOT bundle MARGIN_REQS or any of
// pricing.ts's real tables into the client. See the hard constraint in the
// 2026-10-13 margin-on-the-receipt task: never import pricing.ts for its
// runtime code into a client component, only its types. PricingStep.tsx and
// EditQuotePanel.tsx already do exactly this.
import type { RoleScopedPricing } from "@/lib/pricing";
import styles from "./ProductConfigurator.module.css";

/**
 * The only slice of `getPricingPreviewAction`'s role-scoped result this
 * component is allowed to see — already redacted for a rep caller on
 * the server, never re-derived here. Exported so `ProductConfigurator` can
 * share the same shape rather than restate it.
 */
export type QuoteMarginPreview = Pick<RoleScopedPricing, "appliedTargetMargin" | "projectedCommission">;

type Props = {
  lines: QuoteLine[];
  totals: QuoteTotals;
  packageSavings: number;
  discountTotal: number;
  dueAtCheckout: number;
  /** Set when the $0.50 pre-authorization is on the quote. */
  preAuthAmount: number | null;
  /**
   * The rep's role-scoped margin preview for this quote (2026-10-13 ask:
   * "the only thing to display from the cole message is the margin, cuz
   * thats how reps see their commission"). Optional and absent by default —
   * a host that hasn't fetched a preview, or whose quote has no processing
   * rate (marketing-only) or no volume to price against, passes nothing and
   * the row is simply omitted, never a misleading 0.00%.
   */
  pricingPreview?: QuoteMarginPreview | null;
};

/**
 * The quote, read as a receipt: every line, then the subtotal it belongs to.
 * One-time and recurring stay in separate groups — they are different units
 * and are never added into one number.
 */
export default function QuoteReceipt({
  lines, totals, packageSavings, discountTotal, dueAtCheckout, preAuthAmount, pricingPreview,
}: Props) {
  const oneTime = lines.filter(l => l.billingFrequency === "one_time");

  // appliedTargetMargin is a plain `number` on RoleScopedPricing — never null
  // itself — so "not computable" is expressed by the CALLER omitting
  // `pricingPreview` entirely (no preview fetched: no volume, marketing-only,
  // network error), not by a null/zero field on it. See the prop doc comment.
  const margin = pricingPreview?.appliedTargetMargin;
  const projectedCommission = pricingPreview?.projectedCommission?.total;

  // Hardware-only, one-time-line rep commission (lib/commission.ts) — never
  // the RSM figure and never the underlying cost, both of which are
  // admin-only. Shown only when at least one line produced a real figure, so
  // a quote made entirely of products HubSpot hasn't priced yet says so
  // underneath rather than claiming a $0.00 commission.
  const hardware = commissionSummary(lines);

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
      {margin != null && (
        <div className={styles.totalRow}>
          <span className={styles.totalLabel}>Processing margin</span>
          <span className={styles.totalValue}>
            {fmtPct2(margin)}
            {projectedCommission != null && ` (est. ${fmt$(projectedCommission)}/yr)`}
          </span>
        </div>
      )}
      {hardware.hasFigure && (
        <div className={styles.totalRow}>
          <span className={styles.totalLabel}>Your hardware commission (est.)</span>
          {/* Never clamped: a discount the REP chooses can push a line below
              AIO's cost, which is what "Cost to Rep" means. Hardware AIO
              comps itself is excluded instead of counted as a loss — see
              `isPolicyComped`. fmt$ renders a negative with its own minus
              sign, so this is NOT prefixed with "−" the way the discount
              rows above are. */}
          <span
            className={styles.totalValue}
            data-tone="commission"
            data-sign={hardware.total < 0 ? "negative" : undefined}
          >
            {fmt$(hardware.total)}
          </span>
        </div>
      )}
      <UnpricedNote unpriced={hardware.unpriced} />
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
  // Either lever — a cash discount must strike through the list price too,
  // or the receipt shows full price beside a smaller total.
  const discounted = (line.discountPercent ?? 0) > 0 || (line.discountAmount ?? 0) > 0;
  const tag = line.coveredByPackage ? "In package" : isCompedService(line) ? "Included" : null;
  const cycle = line.billingFrequency === "one_time" ? "" : `/${fmtCycle(line.billingFrequency)}`;

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
      {/* Quiet for a line that earns nothing by design (recurring, in-plan,
          comped) — the tag beside the name already says why — and explicit
          for one HubSpot hasn't priced, which must not read as "earns
          nothing". See LineCommissionNote. */}
      <LineCommissionNote line={line} className={styles.receiptCommission} />
      <div className={styles.receiptAmount}>
        {discounted && <span className={styles.strike}>{fmt$(lineListAmount(line))}</span>}{" "}
        <span>{fmt$(lineNetAmount(line))}</span>
      </div>
    </div>
  );
}
