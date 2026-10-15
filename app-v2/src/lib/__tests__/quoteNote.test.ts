import { describe, it, expect } from "vitest";
import { quoteNoteBlockers, planDefaultBillingDelayDays } from "@/lib/quoting";
import type { BillingStart, QuoteLine } from "@/types/merchant";

// `quoteNoteBlockers` — why a quote bills when it bills.
//
// Widened on 2026-10-15 ("if billing delay is not 60 days that should force
// rep to put note as well") from the 2026-10-12 rule it started as, which
// only asked about delays LONGER than the plan's 60 days. Pulling the first
// charge forward is now a deviation too. These tests are the guard on the
// three things that makes easy to get wrong: it compares against the PLAN's
// own default rather than a flat 60, it reads recurring lines only, and a
// quote with nothing recurring on it is exempt.

const NOTE = "Owner asked to be billed once the second location opens.";

const line = (over: Partial<QuoteLine> = {}): QuoteLine => ({
  hubspotProductId: "p1",
  name: "All-in-One Platform",
  quantity: 1,
  unitPrice: 399,
  billingFrequency: "monthly",
  ...over,
} as QuoteLine);

const days = (n: number): BillingStart => ({ mode: "days", days: n });

describe("quoteNoteBlockers", () => {
  it("asks for nothing when a POS plan bills on its own 60 days", () => {
    expect(quoteNoteBlockers([line({ billingStart: days(60) })], null, "all_in_one")).toEqual([]);
  });

  it("asks for a note when the first charge is held LONGER than the plan's default", () => {
    const [msg] = quoteNoteBlockers([line({ billingStart: days(90) })], null, "all_in_one");
    expect(msg).toMatch(/90 days/);
    expect(msg).toMatch(/60-day default/);
    expect(msg).toMatch(/Elizabeth Phillips/);
  });

  // The half the 2026-10-15 change added. Before it, a rep could take the
  // plan's 60 days off entirely and nobody was asked why.
  it("asks for a note when the first charge is pulled FORWARD to checkout", () => {
    const [msg] = quoteNoteBlockers([line({ billingStart: null })], null, "all_in_one");
    expect(msg).toMatch(/at checkout/);
    expect(msg).toMatch(/60-day default/);
  });

  it("asks for a note for a delay SHORTER than the default but not zero", () => {
    expect(quoteNoteBlockers([line({ billingStart: days(30) })], null, "all_in_one")).toHaveLength(1);
  });

  it("takes a real note as the answer, and refuses one too short to be one", () => {
    expect(quoteNoteBlockers([line({ billingStart: days(90) })], NOTE, "all_in_one")).toEqual([]);
    expect(quoteNoteBlockers([line({ billingStart: days(90) })], "ok", "all_in_one")).toHaveLength(1);
  });

  // A flat "must be 60" would have demanded a note on every marketing quote
  // ever sent, for billing exactly when its own plan says to.
  it("measures a marketing quote against ITS plan's default, which is checkout", () => {
    expect(planDefaultBillingDelayDays("marketing_only")).toBe(0);
    expect(quoteNoteBlockers([line({ billingStart: null })], null, "marketing_only")).toEqual([]);
    expect(quoteNoteBlockers([line({ billingStart: days(60) })], null, "marketing_only")).toHaveLength(1);
  });

  // A one-time line can't carry a billing start at all (HubSpot refuses to
  // publish one that does), so its structural 0 must never read as "this
  // quote bills at checkout".
  it("ignores one-time lines, which have no billing schedule to move", () => {
    const lines = [
      line({ billingStart: days(60) }),
      line({ hubspotProductId: "p2", name: "POS Unit", billingFrequency: "one_time" }),
    ];
    expect(quoteNoteBlockers(lines, null, "all_in_one")).toEqual([]);
  });

  it("exempts a quote with nothing recurring on it — a rate-only quote has no lines at all", () => {
    expect(quoteNoteBlockers([], null, "all_in_one")).toEqual([]);
    expect(quoteNoteBlockers(
      [line({ hubspotProductId: "p2", name: "POS Unit", billingFrequency: "one_time" })],
      null,
      "all_in_one"
    )).toEqual([]);
  });

  // The same scalar the rep-facing "Billing starts" control and the HubSpot
  // preamble read. A rep who seeds the plan's 60 days and then adds a monthly
  // line has a quote whose longest delay is still 60.
  it("judges the LONGEST recurring delay, not each line separately", () => {
    const lines = [line({ billingStart: days(60) }), line({ hubspotProductId: "p2", billingStart: null })];
    expect(quoteNoteBlockers(lines, null, "all_in_one")).toEqual([]);
  });
});
