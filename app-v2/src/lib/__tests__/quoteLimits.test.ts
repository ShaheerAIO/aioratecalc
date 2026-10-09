import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAX_APPROVED_DELAY_DAYS,
  MAX_BILLING_DELAY_DAYS,
  PLAN_DEFAULT_BILLING_DELAY_DAYS,
  POS_COMPANIONS,
  adjustmentBlockers,
  companionsFor,
  planDefaultBillingStart,
} from "@/lib/quoting";
import type { QuoteLine, QuoteType } from "@/types/merchant";

const line = (over: Partial<QuoteLine> = {}): QuoteLine => ({
  hubspotProductId: "335283119838",
  name: "All-in-One Platform",
  qty: 1,
  unitPrice: 399,
  billingFrequency: "monthly",
  productType: "Software",
  ...over,
});

/** A yyyy-MM-dd date `days` from today, the way a rep's date picker produces one. */
const inDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe("the billing-delay ceiling", () => {
  it("allows a delay up to the ceiling", () => {
    const at = line({ billingStart: { mode: "days", days: DEFAULT_MAX_APPROVED_DELAY_DAYS } });
    expect(adjustmentBlockers([at], 50)).toEqual([]);
  });

  it("refuses one past it, and says an admin can raise it", () => {
    const over = line({ billingStart: { mode: "days", days: DEFAULT_MAX_APPROVED_DELAY_DAYS + 1 } });
    const blockers = adjustmentBlockers([over], 50);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("Admin → Quote limits");
  });

  it("measures a DATE against the same ceiling, so it isn't the way around it", () => {
    // Without this a rep picks "On a date" six months out and the ceiling
    // never fires — which is exactly the decision it exists to put in front
    // of an admin.
    const far = line({ billingStart: { mode: "date", date: inDays(200) } });
    expect(adjustmentBlockers([far], 50)).toHaveLength(1);

    const near = line({ billingStart: { mode: "date", date: inDays(30) } });
    expect(adjustmentBlockers([near], 50)).toEqual([]);
  });

  it("reads a date in the past as 'bills at checkout', not as a negative delay", () => {
    const past = line({ billingStart: { mode: "date", date: inDays(-30) } });
    expect(adjustmentBlockers([past], 50)).toEqual([]);
  });

  it("takes the admin's ceiling, and never lets it exceed HubSpot's own", () => {
    const at120 = line({ billingStart: { mode: "days", days: 120 } });
    expect(adjustmentBlockers([at120], 50, 180)).toEqual([]);
    expect(adjustmentBlockers([at120], 50, 60)).toHaveLength(1);

    // HubSpot refuses a start further out than MAX_BILLING_DELAY_DAYS, so an
    // admin raising the ceiling past it changes nothing — the day count is
    // still refused, by the range check rather than the policy one.
    const beyondHubspot = line({ billingStart: { mode: "days", days: MAX_BILLING_DELAY_DAYS + 1 } });
    expect(adjustmentBlockers([beyondHubspot], 50, 10_000)).toHaveLength(1);
  });

  it("still refuses a malformed delay, whatever the ceiling is", () => {
    const fractional = line({ billingStart: { mode: "days", days: 2.5 } });
    expect(adjustmentBlockers([fractional], 50)).toHaveLength(1);
    const nonsense = line({ billingStart: { mode: "date", date: "2026-02-31" } });
    expect(adjustmentBlockers([nonsense], 50)).toHaveLength(1);
  });
});

describe("the billing start a plan opens with", () => {
  it("gives the two POS plans 60 days", () => {
    for (const plan of ["all_in_one", "order_pay_only"] as const) {
      expect(planDefaultBillingStart(plan)).toEqual({
        mode: "days", days: PLAN_DEFAULT_BILLING_DELAY_DAYS,
      });
    }
  });

  it("gives the marketing plans none — they bill from checkout", () => {
    for (const plan of ["marketing_only", "marketing_term"] as const) {
      expect(planDefaultBillingStart(plan)).toBeNull();
    }
  });

  it("opens inside the ceiling, so a brand-new quote is never born blocked", () => {
    const start = planDefaultBillingStart("all_in_one")!;
    expect(adjustmentBlockers([line({ billingStart: start })], 50)).toEqual([]);
  });
});

describe("what a POS carries with it", () => {
  const POS = "217445755632";
  const POS_WITH_DISPLAY = "223452690130";
  const AMS1 = "223511653105";
  const DISPLAY = "318736467644";
  const DRAWER = "222497165011";

  it("moves the terminal, the display and the drawer with a plain POS", () => {
    expect(companionsFor(POS).map(c => c.hubspotProductId).sort())
      .toEqual([AMS1, DISPLAY, DRAWER].sort());
  });

  it("gives the POS-with-display no SECOND display", () => {
    // That SKU has one in the box. Adding another bills the merchant twice
    // for the same screen.
    const ids = companionsFor(POS_WITH_DISPLAY).map(c => c.hubspotProductId);
    expect(ids).not.toContain(DISPLAY);
    expect(ids.sort()).toEqual([AMS1, DRAWER].sort());
  });

  it("carries nothing along for a product that isn't a POS", () => {
    expect(companionsFor(AMS1)).toEqual([]);
    expect(companionsFor("260674226888")).toEqual([]); // Mega Kiosk
  });

  it("never names a companion as its own trigger, which would loop", () => {
    const companionIds = new Set<string>(POS_COMPANIONS.map(c => c.hubspotProductId));
    for (const companion of POS_COMPANIONS) {
      for (const trigger of companion.withProductIds as readonly string[]) {
        expect(companionIds.has(trigger)).toBe(false);
      }
    }
  });
});

describe("plan defaults are complete", () => {
  it("answers for every quote type, so a new plan can't be silently skipped", () => {
    const all: QuoteType[] = ["all_in_one", "order_pay_only", "marketing_only", "marketing_term"];
    for (const plan of all) {
      expect(() => planDefaultBillingStart(plan)).not.toThrow();
    }
  });
});
