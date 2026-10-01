// Phase G — the money view's shaping, pure and network-free.
//
// `merchant_monthly_actuals` has been ingested from Adyen's settlement reports
// since the actuals cron shipped, and until now NOTHING read it: /admin showed
// merchant volume and merchant savings, which are what the MERCHANT gets, and
// never a figure for what AIO earns. This is the other half.
//
// WHAT THE NUMBERS ARE. `grossVolume` and `aioCommission` come off the
// settlement report itself — money that actually moved, not a projection off a
// quote. `aioCommission` is AIO's processing commission only: platform fees,
// hardware and services are billed through HubSpot and are not in this table.
// The page says so, because a revenue figure people take for "all of it" when
// it is one line is worse than no figure.
//
// Pure on purpose, like quoting.ts and billingView.ts: the action does the
// query and the join, this does the arithmetic, and the arithmetic is tested
// without a database.

/** One row of merchant_monthly_actuals, with whatever we know about the tenant. */
export type ActualsRow = {
  tenantNumber: string;
  month: string; // "YYYY-MM"
  grossVolume: number;
  transactionCount: number;
  aioCommission: number;
  /** The merchant's name, when an application claims this tenant number. */
  merchantName: string | null;
  /** The application this tenant belongs to, for a link through to the account. */
  applicationId: string | null;
};

export type MonthTotals = {
  month: string;
  grossVolume: number;
  transactionCount: number;
  aioCommission: number;
  /** How many tenants settled anything at all this month. */
  merchants: number;
};

export type MerchantRevenueRow = {
  tenantNumber: string;
  merchantName: string | null;
  applicationId: string | null;
  grossVolume: number;
  transactionCount: number;
  aioCommission: number;
  /** aioCommission ÷ grossVolume. Null when nothing settled — never 0, which
   *  reads as "we earned nothing on real volume" rather than "no volume". */
  effectiveRate: number | null;
  /** grossVolume ÷ transactionCount, null on no transactions, same reasoning. */
  avgTicket: number | null;
};

export type RevenueReport = {
  /** Newest first — the month everyone actually wants is the latest one. */
  months: MonthTotals[];
  /** The selected month's per-merchant breakdown, biggest commission first. */
  merchants: MerchantRevenueRow[];
  /** Which month `merchants` describes. Null when there is no data at all. */
  selectedMonth: string | null;
  /** Totals for the selected month, or zeros when there is nothing. */
  selected: MonthTotals | null;
  /** The same month a year... no: the month before the selected one, for the
   *  delta. Null when the selected month is the earliest we hold. */
  previous: MonthTotals | null;
};

function sortMonthsDesc(a: string, b: string): number {
  return b.localeCompare(a); // "YYYY-MM" sorts lexicographically
}

/** Month totals across every tenant, newest month first. */
export function monthlyTotals(rows: ActualsRow[]): MonthTotals[] {
  const byMonth = new Map<string, MonthTotals>();
  for (const r of rows) {
    const t = byMonth.get(r.month) ?? {
      month: r.month, grossVolume: 0, transactionCount: 0, aioCommission: 0, merchants: 0,
    };
    t.grossVolume += r.grossVolume;
    t.transactionCount += r.transactionCount;
    t.aioCommission += r.aioCommission;
    // One row per (tenant, month) — the table's unique index guarantees it —
    // so counting rows IS counting merchants, with no set to carry around.
    t.merchants += 1;
    byMonth.set(r.month, t);
  }
  return [...byMonth.values()].sort((a, b) => sortMonthsDesc(a.month, b.month));
}

/** One month's rows as a per-merchant table, biggest commission first. */
export function merchantRows(rows: ActualsRow[], month: string): MerchantRevenueRow[] {
  return rows
    .filter(r => r.month === month)
    .map(r => ({
      tenantNumber: r.tenantNumber,
      merchantName: r.merchantName,
      applicationId: r.applicationId,
      grossVolume: r.grossVolume,
      transactionCount: r.transactionCount,
      aioCommission: r.aioCommission,
      effectiveRate: r.grossVolume > 0 ? r.aioCommission / r.grossVolume : null,
      avgTicket: r.transactionCount > 0 ? r.grossVolume / r.transactionCount : null,
    }))
    .sort((a, b) => b.aioCommission - a.aioCommission);
}

/**
 * The whole view, from the raw joined rows.
 *
 * `month` picks which one to break down; anything absent or unknown falls back
 * to the newest month we hold, so the page with no query string opens on the
 * answer people came for.
 */
export function buildRevenueReport(rows: ActualsRow[], month?: string | null): RevenueReport {
  const months = monthlyTotals(rows);
  if (months.length === 0) {
    return { months, merchants: [], selectedMonth: null, selected: null, previous: null };
  }

  const known = months.find(m => m.month === month);
  const selected = known ?? months[0];
  const index = months.indexOf(selected);
  // months is newest-first, so the NEXT entry is the previous month.
  const previous = months[index + 1] ?? null;

  return {
    months,
    merchants: merchantRows(rows, selected.month),
    selectedMonth: selected.month,
    selected,
    previous,
  };
}

/**
 * Month-over-month change as a fraction, or null when it can't be stated.
 *
 * Null rather than 0 or Infinity when the earlier month is zero or missing:
 * "up ∞%" and "no change" are both lies about a merchant's first month, and a
 * blank is the honest rendering of "there is nothing to compare against".
 */
export function monthOverMonth(current: number, previous: number | null | undefined): number | null {
  if (previous == null || previous === 0) return null;
  return (current - previous) / previous;
}
