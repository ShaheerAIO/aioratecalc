import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MerchantApplication } from "@/types/merchant";

// getMyQuoteAction is a Server Action, so its collaborators are stubbed here:
// the session it trusts, and the storage adapter that enforces ownership. What
// the test is actually asserting is which of them it asks, and with what.
const auth = vi.fn();
const getApplicationForCustomer = vi.fn();

vi.mock("@/lib/auth", () => ({ auth, signIn: vi.fn() }));
// next-auth's entrypoint reaches for next/server, which doesn't resolve outside
// the Next build. Only AuthError is used from it, and only by the login action.
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/storage/postgresAdapter", () => ({ postgresStorage: { getApplicationForCustomer } }));
vi.mock("@/lib/adapters/email", () => ({ sendMagicLinkEmail: vi.fn() }));
vi.mock("@/lib/adapters/check", () => ({
  checkEnvironment: vi.fn(), createCheckCompany: vi.fn(),
  createCheckOnboardLink: vi.fn(), getCheckOnboardStatus: vi.fn(),
}));
vi.mock("@/lib/adapters/hubspot", () => ({ pushToHubSpot: vi.fn() }));

const { getMyQuoteAction } = await import("@/lib/actions/customer");

const CUSTOMER_SESSION = { user: { id: "cust-1", role: "customer" } };

// Only the columns a quote is built from matter here; the rest of the row is
// deliberately absent so a leak would show up as undefined rather than pass.
const app = (over: Partial<MerchantApplication> = {}) => ({
  id: "app-1",
  quoteConfig: { avgTicket: 40, monthlyVolume: 100_000 },
  quoteLines: null,
  orderPoints: null,
  targetMargin: 0.008,
  pricingModel: "2-tier",
  analysis: null,
  ...over,
}) as MerchantApplication;

beforeEach(() => {
  auth.mockReset();
  getApplicationForCustomer.mockReset();
});

describe("getMyQuoteAction — authorization", () => {
  // THE ONE THAT MATTERS. The id is attacker-controlled; the user id is not.
  // Scoping happens in getApplicationForCustomer (WHERE id = ? AND
  // customer_user_id = ?), so the action must hand it the *session's* user id
  // and never anything derived from the argument.
  it("scopes the lookup to the session's own customer id", async () => {
    auth.mockResolvedValue(CUSTOMER_SESSION);
    getApplicationForCustomer.mockResolvedValue(app());

    await getMyQuoteAction("app-1");

    expect(getApplicationForCustomer).toHaveBeenCalledWith("cust-1", "app-1");
  });

  it("returns nothing for an application that isn't the caller's", async () => {
    auth.mockResolvedValue(CUSTOMER_SESSION);
    // What the adapter does with someone else's id: no row matches the scope.
    getApplicationForCustomer.mockResolvedValue(null);

    expect(await getMyQuoteAction("someone-elses-app")).toBeNull();
  });

  it("refuses a caller with no session at all", async () => {
    auth.mockResolvedValue(null);
    await expect(getMyQuoteAction("app-1")).rejects.toThrow("Not authenticated");
    expect(getApplicationForCustomer).not.toHaveBeenCalled();
  });

  it("refuses a signed-in rep or admin — this is the customer's own view", async () => {
    for (const role of ["rep", "admin"]) {
      auth.mockResolvedValue({ user: { id: "staff-1", role } });
      await expect(getMyQuoteAction("app-1")).rejects.toThrow("Not authenticated");
    }
    expect(getApplicationForCustomer).not.toHaveBeenCalled();
  });
});

describe("getMyQuoteAction — no quote basis", () => {
  beforeEach(() => auth.mockResolvedValue(CUSTOMER_SESSION));

  it("returns null when the row has neither a statement nor configs", async () => {
    getApplicationForCustomer.mockResolvedValue(app({ quoteConfig: null, analysis: null }));
    expect(await getMyQuoteAction("app-1")).toBeNull();
  });

  it("returns null when the configs carry no volume to price", async () => {
    getApplicationForCustomer.mockResolvedValue(app({ quoteConfig: { avgTicket: 40, monthlyVolume: 0 } }));
    expect(await getMyQuoteAction("app-1")).toBeNull();
  });
});

describe("getMyQuoteAction — what the customer gets back", () => {
  beforeEach(() => auth.mockResolvedValue(CUSTOMER_SESSION));

  it("returns the same projection the lead link builds", async () => {
    getApplicationForCustomer.mockResolvedValue(app({
      quoteLines: [{
        hubspotProductId: "217526517443", name: "AIO Platform (1 to 5 Order Points)",
        qty: 1, unitPrice: 99, billingFrequency: "weekly", productType: "Software",
      }],
      orderPoints: { hardware: {}, channels: ["website"], total: 1 },
    }));

    const quote = (await getMyQuoteAction("app-1"))!;
    // Narrowed off `basis`: the products-basis variant (marketing-only) has no
    // rate fields at all.
    if (quote.basis === "products") throw new Error("expected a rated quote");
    expect(quote.basis).toBe("config");
    expect(quote.monthlyVolume).toBe(100_000);
    expect(quote.lines).toHaveLength(1);
    // Weekly stays weekly; the monthly figure is the equivalent, not a recast.
    expect(quote.lineTotals).toEqual({
      oneTime: 0,
      recurring: [{ frequency: "weekly", amount: 99 }],
      monthlyEquivalent: 99 * (52 / 12),
    });
    expect(quote.orderPoints).toEqual({ hardware: {}, channels: ["website"], total: 1 });
  });

  it("carries no margin, cost, floor or raw analysis across the boundary", async () => {
    getApplicationForCustomer.mockResolvedValue(app());
    const quote = (await getMyQuoteAction("app-1"))!;

    expect(Object.keys(quote).sort()).toEqual([
      "annualSavings", "averageTicket", "basis", "currentEffectiveRate", "currentMonthlyCost",
      "effectiveRate", "lineTotals", "lines", "monthlySavings", "monthlyVolume", "orderPoints",
      "projectedAnnualCost", "projectedMonthlyCost", "savingsPct",
    ]);
    const serialized = JSON.stringify(quote);
    for (const forbidden of ["margin", "Margin", "floor", "Floor", "adyen", "Adyen", "cost", "bps", "interchange", "aioRevenue"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
