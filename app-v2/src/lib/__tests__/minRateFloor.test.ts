import { describe, it, expect } from "vitest";
import {
  derivePricingForRole, minRateFloorBlockers, DEFAULT_MIN_RATE_MARGIN_BPS, type PaddingConfig,
} from "@/lib/pricing";
import { DEFAULT_QUOTE_RATES, type QuoteRates, type StatementAnalysis } from "@/types/merchant";

// The wholesale-plus-minimum card-present rate floor (product owner,
// 2026-10-15: "add floor for rate (wholesale + minimum), editable in
// settings"). A THIRD floor, sibling of the $10/mo minimum
// (monthlyRevenueFloorBlockers): same wholesale basis (wholesalePctFor,
// lib/wholesale.ts), but a RATE test rather than a dollar test, so it binds
// on a merchant of any size where the $10/mo floor only binds on small ones.
// Independent of `belowMarginFloor`, which is a rate test against a padded,
// undisclosed interchange-based table.

const NO_FEES = { monthlyFee: 0, perTxnFee: 0, cpPerTxnFee: 0, cnpPerTxnFee: 0 };
const NO_PADDING: PaddingConfig = { paddingPct: 0, paddingMinMrrAdd: 0, paddingAdyenCostHide: false };

/** A merchant at `volume` a month on a $40 average ticket — the 2.08% wholesale column. */
const at = (volume: number): StatementAnalysis => ({
  totalVolume: volume,
  totalTransactions: volume / 40,
  interchangeRate: 0.018,
  icEstimated: false,
  cardPresentPct: 0.9,
  cardNotPresentPct: 0.1,
  cardPresentVolume: volume * 0.9,
  cardNotPresentVolume: volume * 0.1,
} as StatementAnalysis);

const cp = (rate: number): QuoteRates => ({ ...DEFAULT_QUOTE_RATES, cardPresentRate: rate });

const preview = (
  analysis: StatementAnalysis,
  rates: QuoteRates = DEFAULT_QUOTE_RATES,
  minRateMarginBps: number | null = DEFAULT_MIN_RATE_MARGIN_BPS,
  cardNotPresentOnly = false
) =>
  derivePricingForRole(
    analysis, rates, "2-tier", NO_FEES, "rep", null, NO_PADDING, null, minRateMarginBps, cardNotPresentOnly
  );

describe("the wholesale-plus-minimum card-present rate floor", () => {
  it("computes the minimum as wholesale-at-this-ticket plus the admin margin", () => {
    // $40 ticket -> the $50 column ($40 – $49.99), 2.43% wholesale (Oct 2026 Table B); +25bps admin minimum -> 2.68%.
    const p = preview(at(100_000), cp(0.0275), 25);
    expect(p.minCardPresentRate).toBeCloseTo(0.0268, 6);
    expect(p.belowMinRateFloor).toBe(false); // 2.75% clears 2.68%
    expect(minRateFloorBlockers(p)).toEqual([]);
  });

  it("refuses a rate below the floor and names the minimum rate", () => {
    const p = preview(at(100_000), cp(0.02), 25); // 2.00% < 2.68%
    expect(p.belowMinRateFloor).toBe(true);
    const [msg] = minRateFloorBlockers(p);
    expect(msg).toContain("2.68%");
    expect(msg).toMatch(/Raise the rate/);
  });

  it("clears exactly at the floor, never above it by construction", () => {
    const p = preview(at(100_000), cp(0.0270), 25);
    expect(p.belowMinRateFloor).toBe(false);
  });

  // The floor SHIPS OFF (product owner, 2026-10-15). Not 0 bps: 0 means "never
  // below wholesale", and AIO's own rate card sits below the wholesale table in
  // 48 of its 81 cells, so 0 would have refused most of what the card suggests.
  // See DEFAULT_MIN_RATE_MARGIN_BPS in pricing.ts.
  it("is OFF when no minimum has been set — no floor, not a zero floor", () => {
    expect(DEFAULT_MIN_RATE_MARGIN_BPS).toBeNull();
    const p = derivePricingForRole(at(100_000), cp(0.02), "2-tier", NO_FEES, "rep", null, NO_PADDING);
    // 2.00% is under the $40 column's 2.08% wholesale, and is still allowed.
    expect(p.minCardPresentRate).toBeNull();
    expect(p.belowMinRateFloor).toBe(false);
    expect(minRateFloorBlockers(p)).toEqual([]);
  });

  it("switches on the moment an admin sets a minimum", () => {
    const p = preview(at(100_000), cp(0.02), 0);
    // 0bps minimum = wholesale itself (2.43%); 2.00% is below it.
    expect(p.minCardPresentRate).toBeCloseTo(0.0243, 6);
    expect(p.belowMinRateFloor).toBe(true);
  });

  it("holds reps and admins to the identical figure — this one is not padded", () => {
    const rep = preview(at(100_000), cp(0.02), 25);
    const admin = derivePricingForRole(at(100_000), cp(0.02), "2-tier", NO_FEES, "admin", null, NO_PADDING, null, 25);
    expect(admin.minCardPresentRate).toBe(rep.minCardPresentRate);
    expect(admin.belowMinRateFloor).toBe(rep.belowMinRateFloor);
  });

  // A card-not-present-only quote hides the whole card-present lane and
  // nothing on it is rep-editable (processesCardNotPresentOnly, quoting.ts) —
  // this floor must not refuse a rate the rep can't see or change.
  it("does not refuse a card-not-present-only quote, whatever the hidden rate is", () => {
    const p = preview(at(100_000), cp(0.0001), 25, true);
    expect(p.minCardPresentRate).toBeNull();
    expect(p.belowMinRateFloor).toBe(false);
    expect(minRateFloorBlockers(p)).toEqual([]);
  });

  describe("says nothing when there is no basis to judge", () => {
    it("no average ticket (no transactions to derive one from)", () => {
      const p = preview({ ...at(100_000), totalTransactions: 0 }, cp(0.001), 25);
      expect(p.minCardPresentRate).toBeNull();
      expect(p.belowMinRateFloor).toBe(false);
    });

    // A rate past MAX_PLAUSIBLE_CARD_RATE is a decimal point in the wrong
    // place, not a floor question — same posture `projectedProcessingRevenue`
    // takes for the identical reason.
    it("an implausible quoted rate", () => {
      const p = preview(at(100_000), cp(0.2), 25);
      expect(p.minCardPresentRate).toBeNull();
      expect(p.belowMinRateFloor).toBe(false);
    });
  });
});
