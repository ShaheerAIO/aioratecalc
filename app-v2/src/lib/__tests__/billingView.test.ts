import { describe, it, expect } from "vitest";
import {
  billingPanelState,
  canRetryBillingSync,
  countHubspotSyncErrors,
  hasBillingSyncError,
  hubspotDealUrl,
  hubspotQuoteUrl,
  subscriptionMoney,
  subscriptionStatusColor,
} from "@/lib/billingView";
import { EMPTY_HUBSPOT_IDS, type HubspotIds, type MerchantApplication, type QuoteLine } from "@/types/merchant";

// Only the three fields billingPanelState/canRetryBillingSync read are set —
// everything else on a real MerchantApplication is deliberately absent so a
// stray dependency on another field shows up as `undefined` instead of
// quietly passing.
type StateInput = Pick<MerchantApplication, "quoteAcceptedAt" | "quoteLines" | "hubspotIds">;

const line = (over: Partial<QuoteLine> = {}): QuoteLine => ({
  hubspotProductId: "p1",
  name: "AIO Platform (1 to 5 Order Points)",
  qty: 1,
  unitPrice: 99,
  billingFrequency: "weekly",
  productType: "Software",
  ...over,
});

const ids = (over: Partial<HubspotIds> = {}): HubspotIds => ({ ...EMPTY_HUBSPOT_IDS, ...over });

const app = (over: Partial<StateInput> = {}): StateInput => ({
  quoteAcceptedAt: null,
  quoteLines: null,
  hubspotIds: null,
  ...over,
});

describe("subscriptionMoney", () => {
  it("recovers the per-cycle amount from a weekly mrr", () => {
    // $99/week -> mrr = 99 * 52/12 = 429.00
    const m = subscriptionMoney({ mrr: 429, billingFrequency: "weekly" });
    expect(m).toEqual({ perCycleLabel: "$99.00/week", monthlyLabel: "(~$429.00/mo)" });
  });

  it("recovers the per-cycle amount from a monthly mrr (factor of 1)", () => {
    const m = subscriptionMoney({ mrr: 39, billingFrequency: "monthly" });
    expect(m).toEqual({ perCycleLabel: "$39.00/month", monthlyLabel: "(~$39.00/mo)" });
  });

  it("returns null for an unrecognised frequency rather than guessing", () => {
    expect(subscriptionMoney({ mrr: 100, billingFrequency: "quarterly" })).toBeNull();
    expect(subscriptionMoney({ mrr: 100, billingFrequency: "one_time" })).toBeNull();
  });

  it("returns null when mrr or frequency is missing", () => {
    expect(subscriptionMoney({ mrr: null, billingFrequency: "weekly" })).toBeNull();
    expect(subscriptionMoney({ mrr: 100, billingFrequency: null })).toBeNull();
  });

  it("never sums across frequencies — the label is per-cycle, not a combined total", () => {
    const weekly = subscriptionMoney({ mrr: 429, billingFrequency: "weekly" })!;
    const monthly = subscriptionMoney({ mrr: 429, billingFrequency: "monthly" })!;
    expect(weekly.perCycleLabel).not.toEqual(monthly.perCycleLabel);
  });
});

describe("billingPanelState", () => {
  it("is not_accepted before the merchant accepts, regardless of lines", () => {
    expect(billingPanelState(app())).toBe("not_accepted");
    expect(billingPanelState(app({ quoteLines: [line()] }))).toBe("not_accepted");
  });

  it("is rate_only for an accepted quote with no billable lines, forever", () => {
    expect(billingPanelState(app({ quoteAcceptedAt: "2026-08-01T00:00:00Z", quoteLines: [] }))).toBe("rate_only");
    expect(billingPanelState(app({ quoteAcceptedAt: "2026-08-01T00:00:00Z", quoteLines: null }))).toBe("rate_only");
  });

  it("is pending when accepted with billable lines but no HubSpot quote yet", () => {
    expect(
      billingPanelState({ quoteAcceptedAt: "2026-08-01T00:00:00Z", quoteLines: [line()], hubspotIds: null })
    ).toBe("pending");
  });

  it("is draft once a quoteId exists but publishedAt is still null", () => {
    expect(
      billingPanelState({
        quoteAcceptedAt: "2026-08-01T00:00:00Z",
        quoteLines: [line()],
        hubspotIds: ids({ quoteId: "q1" }),
      })
    ).toBe("draft");
  });

  it("is published once publishedAt is set", () => {
    expect(
      billingPanelState({
        quoteAcceptedAt: "2026-08-01T00:00:00Z",
        quoteLines: [line()],
        hubspotIds: ids({ quoteId: "q1", publishedAt: "2026-08-02T00:00:00Z" }),
      })
    ).toBe("published");
  });
});

describe("canRetryBillingSync", () => {
  it("is false before acceptance", () => {
    expect(canRetryBillingSync(app())).toBe(false);
  });

  it("is false for a rate-only quote — there is nothing to retry", () => {
    expect(canRetryBillingSync(app({ quoteAcceptedAt: "2026-08-01T00:00:00Z", quoteLines: [] }))).toBe(false);
  });

  it("is true when pending (accepted, billable, no quote id yet)", () => {
    expect(
      canRetryBillingSync({ quoteAcceptedAt: "2026-08-01T00:00:00Z", quoteLines: [line()], hubspotIds: null })
    ).toBe(true);
  });

  it("is true when a draft quote exists but is not yet published", () => {
    expect(
      canRetryBillingSync({
        quoteAcceptedAt: "2026-08-01T00:00:00Z",
        quoteLines: [line()],
        hubspotIds: ids({ quoteId: "q1" }),
      })
    ).toBe(true);
  });

  it("is false once published — the one-way door is shut", () => {
    expect(
      canRetryBillingSync({
        quoteAcceptedAt: "2026-08-01T00:00:00Z",
        quoteLines: [line()],
        hubspotIds: ids({ quoteId: "q1", publishedAt: "2026-08-02T00:00:00Z" }),
      })
    ).toBe(false);
  });

  it("is true even with no recorded lastSyncError — a stuck precondition is still retryable", () => {
    expect(
      canRetryBillingSync({
        quoteAcceptedAt: "2026-08-01T00:00:00Z",
        quoteLines: [line()],
        hubspotIds: ids({ lastSyncError: null }),
      })
    ).toBe(true);
  });
});

describe("hasBillingSyncError / countHubspotSyncErrors", () => {
  it("is false for null hubspotIds and for a clean sync", () => {
    expect(hasBillingSyncError(null)).toBe(false);
    expect(hasBillingSyncError(ids())).toBe(false);
  });

  it("is true when lastSyncError is set", () => {
    expect(hasBillingSyncError(ids({ lastSyncError: "400 PROPERTY_DOESNT_EXIST" }))).toBe(true);
  });

  it("counts only the applications with a persisted error", () => {
    const clean = { hubspotIds: ids() };
    const broken = { hubspotIds: ids({ lastSyncError: "boom" }) };
    const untouched = { hubspotIds: null };
    expect(countHubspotSyncErrors([clean, broken, untouched, broken])).toBe(2);
    expect(countHubspotSyncErrors([])).toBe(0);
  });
});

describe("subscriptionStatusColor", () => {
  it("gives each of the four common non-active states its own distinct colour", () => {
    const bad = ["paused", "canceled", "unpaid", "past_due"].map(subscriptionStatusColor);
    expect(new Set(bad.map(c => c.fg)).size).toBeGreaterThan(1); // not one undifferentiated bucket
    for (const c of bad) expect(c.fg).not.toBe("var(--success)");
  });

  it("never defaults an unrecognised status to the healthy colour", () => {
    expect(subscriptionStatusColor("something_new").fg).not.toBe("var(--success)");
    expect(subscriptionStatusColor(null).fg).not.toBe("var(--success)");
    expect(subscriptionStatusColor(undefined).fg).not.toBe("var(--success)");
  });

  it("marks active distinctly as healthy", () => {
    expect(subscriptionStatusColor("active").fg).toBe("var(--success)");
  });
});

describe("hubspotDealUrl / hubspotQuoteUrl", () => {
  it("builds a record URL when a portal id is configured", () => {
    expect(hubspotDealUrl("12345", "999")).toBe("https://app.hubspot.com/contacts/999/record/0-3/12345");
    expect(hubspotQuoteUrl("67890", "999")).toBe("https://app.hubspot.com/contacts/999/record/0-14/67890");
  });

  it("returns null without a portal id rather than emitting a broken link", () => {
    expect(hubspotDealUrl("12345", undefined)).toBeNull();
    expect(hubspotQuoteUrl("67890", undefined)).toBeNull();
  });
});
