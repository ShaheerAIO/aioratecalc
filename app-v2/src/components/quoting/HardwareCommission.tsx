"use client";

// What the AE earns on this quote, said per line and then totalled — the
// 2026-10-14 ask ("add the commission for each line item of hardware, or
// anything else, for the AE to see"), landing the day HubSpot's product
// library became the source of truth for cost and commission rates.
//
// One module because BOTH rep-facing quote surfaces show it and they must not
// drift: `QuoteReceipt` (the panels layout, used by the proposal wizard and
// `EditQuotePanel`) and the document layout inside `ProductConfigurator`
// (`/rep/prospects/new`). The math itself is lib/commission.ts — nothing here
// computes money, it only decides what to say about the figure.
//
// THE REP'S OWN FIGURE ONLY. `lineHardwareCommission` also returns the RSM's
// cut and the underlying cost is one inversion away from either; the RSM
// number stays in the admin Commissions panel. Note that a rep who knows
// their own rate can already recover AIO's hardware cost from the figure
// below — documented and knowingly accepted (see `lineHardwareCommission`),
// unlike the margin floor, which is genuinely withheld.

import { lineHardwareCommission, quoteHardwareCommission } from "@/lib/commission";
import { fmt$ } from "@/lib/utils";
import type { QuoteLine } from "@/types/merchant";
import styles from "./ProductConfigurator.module.css";

/**
 * The per-line annotation. Renders NOTHING for a line that earns nothing by
 * design — a recurring line, or hardware AIO comps (in-plan, in-package,
 * comped install/training), both of which already carry a tag on the line
 * saying so. A dollar figure of $0.00 next to "In plan" would read as a
 * mistake rather than as the deal AIO chose to offer.
 *
 * It DOES render for a line with no cost or no rate on file, because that is
 * the one case an AE must not read as "this product earns nothing": POS Unit,
 * Customer Facing Display, mPOS and both tablets are unpriced in HubSpot as
 * of 2026-10-14, and three of those are on most quotes.
 */
export function LineCommissionNote({ line, className }: { line: QuoteLine; className?: string }) {
  const c = lineHardwareCommission(line);

  if (c.status === "recurring" || c.status === "included") return null;

  if (c.status === "no_cost" || c.status === "no_rate") {
    return (
      <div className={className} data-commission="unknown">
        {c.status === "no_cost" ? "No cost on file" : "No commission rate on file"} — commission not
        calculated
      </div>
    );
  }

  // A rate on only the RSM side leaves the rep's own figure null with nothing
  // useful to say about it, so the line stays quiet rather than explaining
  // somebody else's commission.
  if (c.rep == null) return null;

  return (
    <div className={className} data-sign={c.rep < 0 ? "negative" : undefined}>
      Your commission {fmt$(c.rep)}
    </div>
  );
}

export type CommissionSummary = {
  /** The rep's total across every line that produced a figure. */
  total: number;
  /** True when at least one line did — the gate for showing the total at all. */
  hasFigure: boolean;
  /** Distinct product names with no cost/rate on file, so nothing was counted. */
  unpriced: string[];
};

/**
 * The quote-level figure and what it had to leave out. `total` is NOT shown
 * when nothing produced a figure: $0.00 would claim this quote earns nothing,
 * when the truth may be that every product on it is still unpriced.
 */
export function commissionSummary(lines: QuoteLine[]): CommissionSummary {
  const hw = quoteHardwareCommission(lines);
  const unpriced = [
    ...new Set(
      hw.perLine.filter(l => l.status === "no_cost" || l.status === "no_rate").map(l => l.name)
    ),
  ];
  return {
    total: hw.rep,
    hasFigure: hw.perLine.some(l => l.rep != null),
    unpriced,
  };
}

/** The "N products aren't priced yet" footnote, or nothing when they all are. */
export function UnpricedNote({ unpriced }: { unpriced: string[] }) {
  if (unpriced.length === 0) return null;
  return (
    <p className={styles.commissionGap}>
      Not counted — no cost or rate in HubSpot yet: {unpriced.join(", ")}.
    </p>
  );
}
