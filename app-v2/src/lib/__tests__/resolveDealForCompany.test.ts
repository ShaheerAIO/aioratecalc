import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HubspotDeal } from "@/lib/adapters/hubspot";

// resolveDealForCompany — the adoption service's one entry point. Under test:
// every refusal code, and the two halves of the "one deal, one application"
// invariant (already_adopted on adopt; ambiguous on create).

const getDealById = vi.fn();
const listDealsForCompany = vi.fn();
const createDeal = vi.fn();

// Partial: the three network calls are stubbed, but `isAtOrPastClosedWon` and
// the stage table under it are pure and are exactly what the "past Closed
// Won" refusal is being tested through.
vi.mock("@/lib/adapters/hubspot", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/adapters/hubspot")>()),
  getDealById, listDealsForCompany, createDeal,
}));

const where = vi.fn();
const from = vi.fn(() => ({ where }));
const select = vi.fn(() => ({ from }));
vi.mock("@/lib/db/client", () => ({ db: { select } }));
vi.mock("@/lib/db/schema", () => ({ merchantApplications: { id: "id", hubspotDealId: "hubspot_deal_id" } }));

const { resolveDealForCompany, findApplicationsByDealId } = await import("@/lib/hubspotDeal");

const COMPANY_ID = "334295287484";

function deal(over: Partial<HubspotDeal> = {}): HubspotDeal {
  return {
    id: "deal-1",
    name: "Torta Palace / Deal - 1",
    pipelineId: "default",
    stageId: "2717103849",
    stageLabel: "Discovery Meeting",
    amount: 12000,
    createdAt: "2026-09-01T00:00:00.000Z",
    closed: false,
    won: false,
    companyIds: [COMPANY_ID],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  where.mockResolvedValue([]); // no other application has adopted this deal, by default
});

describe("findApplicationsByDealId", () => {
  it("returns the ids of every application row carrying this deal id", async () => {
    where.mockResolvedValue([{ id: "app-1" }, { id: "app-2" }]);
    expect(await findApplicationsByDealId("deal-1")).toEqual(["app-1", "app-2"]);
  });

  it("is empty when nothing carries this deal id", async () => {
    where.mockResolvedValue([]);
    expect(await findApplicationsByDealId("deal-1")).toEqual([]);
  });
});

describe("resolveDealForCompany — mode: existing", () => {
  it("adopts a deal that's on the company, open, and unowned", async () => {
    getDealById.mockResolvedValue(deal());

    const result = await resolveDealForCompany({ companyId: COMPANY_ID, choice: { mode: "existing", dealId: "deal-1" } });

    expect(result).toEqual({ ok: true, deal: deal(), created: false });
  });

  it("refuses not_found when the deal doesn't exist", async () => {
    getDealById.mockResolvedValue(null);

    const result = await resolveDealForCompany({ companyId: COMPANY_ID, choice: { mode: "existing", dealId: "nope" } });

    expect(result).toEqual({ ok: false, code: "not_found", message: expect.stringContaining("nope") });
  });

  it("refuses wrong_company when the deal is on a different company", async () => {
    getDealById.mockResolvedValue(deal({ companyIds: ["999"] }));

    const result = await resolveDealForCompany({ companyId: COMPANY_ID, choice: { mode: "existing", dealId: "deal-1" } });

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("wrong_company");
  });

  it("refuses closed for a closed-lost deal", async () => {
    getDealById.mockResolvedValue(deal({ closed: true, won: false, stageId: "closedlost", stageLabel: "Closed Lost" }));

    const result = await resolveDealForCompany({ companyId: COMPANY_ID, choice: { mode: "existing", dealId: "deal-1" } });

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("closed");
  });

  it("refuses closed for a closed-won deal without allowClosedWon", async () => {
    getDealById.mockResolvedValue(deal({ closed: true, won: true, stageId: "closedwon", stageLabel: "Closed Won" }));

    const result = await resolveDealForCompany({ companyId: COMPANY_ID, choice: { mode: "existing", dealId: "deal-1" } });

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("closed");
  });

  it("allows a closed-won deal when allowClosedWon is set", async () => {
    getDealById.mockResolvedValue(deal({ closed: true, won: true, stageId: "closedwon", stageLabel: "Closed Won" }));

    const result = await resolveDealForCompany({
      companyId: COMPANY_ID,
      choice: { mode: "existing", dealId: "deal-1" },
      allowClosedWon: true,
    });

    expect(result.ok).toBe(true);
  });

  // AIO's pipeline runs Onboarding / Configuration / Deployment / Deal Active
  // AFTER Closed Won, and HubSpot flags all four `closed: false` — so before
  // 2026-10-12 a rep could start a quote for a merchant already signed, live
  // and being billed.
  it.each([
    ["2992070353", "Onboarding"],
    ["2986384064", "Configuration"],
    ["2986384063", "Deployment/Training"],
    ["3452539597", "Deal Active"],
  ])("refuses a deal parked past Closed Won at %s (%s)", async (stageId, stageLabel) => {
    getDealById.mockResolvedValue(deal({ closed: false, won: false, stageId, stageLabel }));

    const result = await resolveDealForCompany({ companyId: COMPANY_ID, choice: { mode: "existing", dealId: "deal-1" } });

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("closed");
    expect((result as { message: string }).message).toContain(stageLabel);
  });

  // allowClosedWon excuses Closed Won itself; it must not excuse a deal that
  // has gone on past it.
  it("still refuses a past-Closed-Won deal even with allowClosedWon", async () => {
    getDealById.mockResolvedValue(deal({ closed: false, won: false, stageId: "3452539597", stageLabel: "Deal Active" }));

    const result = await resolveDealForCompany({
      companyId: COMPANY_ID,
      choice: { mode: "existing", dealId: "deal-1" },
      allowClosedWon: true,
    });

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("closed");
  });

  it("lets a deal still working through the pipeline past", async () => {
    getDealById.mockResolvedValue(deal({ stageId: "2767738593", stageLabel: "Signed/Awaiting Payment Info" }));

    const result = await resolveDealForCompany({ companyId: COMPANY_ID, choice: { mode: "existing", dealId: "deal-1" } });

    expect(result.ok).toBe(true);
  });

  it("refuses already_adopted when another application already carries this deal id", async () => {
    getDealById.mockResolvedValue(deal());
    where.mockResolvedValue([{ id: "some-other-app" }]);

    const result = await resolveDealForCompany({ companyId: COMPANY_ID, choice: { mode: "existing", dealId: "deal-1" } });

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("already_adopted");
    // Names the OTHER application — a rep reading this needs to know which
    // account to go look at, not just that a conflict exists.
    expect((result as { message: string }).message).toContain("some-other-app");
  });

  it("does not refuse already_adopted for the application re-confirming its OWN deal", async () => {
    getDealById.mockResolvedValue(deal());
    where.mockResolvedValue([{ id: "app-1" }]); // the caller's own row

    const result = await resolveDealForCompany({
      companyId: COMPANY_ID,
      choice: { mode: "existing", dealId: "deal-1" },
      excludeApplicationId: "app-1",
    });

    expect(result.ok).toBe(true);
  });

  it("surfaces a HubSpot read failure as hubspot_error rather than throwing", async () => {
    getDealById.mockRejectedValue(new Error("HUBSPOT_BILLING_PRIVATE_APP_TOKEN is not set"));

    const result = await resolveDealForCompany({ companyId: COMPANY_ID, choice: { mode: "existing", dealId: "deal-1" } });

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("hubspot_error");
    expect((result as { message: string }).message).toContain("HUBSPOT_BILLING_PRIVATE_APP_TOKEN");
  });
});

describe("resolveDealForCompany — mode: create", () => {
  it("creates a deal when the company has none yet", async () => {
    listDealsForCompany.mockResolvedValue([]);
    createDeal.mockResolvedValue("deal-new");
    getDealById.mockResolvedValue(deal({ id: "deal-new" }));

    const result = await resolveDealForCompany({
      companyId: COMPANY_ID,
      choice: { mode: "create", dealName: "New Deal" },
    });

    expect(result).toEqual({ ok: true, deal: deal({ id: "deal-new" }), created: true });
    expect(createDeal).toHaveBeenCalledWith({ name: "New Deal", companyId: COMPANY_ID, amount: undefined });
  });

  it("refuses ambiguous, with candidates, when the company already has deals", async () => {
    const candidates = [deal(), deal({ id: "deal-2", name: "Torta Palace / Deal - 2" })];
    listDealsForCompany.mockResolvedValue(candidates);

    const result = await resolveDealForCompany({
      companyId: COMPANY_ID,
      choice: { mode: "create", dealName: "New Deal" },
    });

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("ambiguous");
    expect((result as { candidates?: HubspotDeal[] }).candidates).toEqual(candidates);
    expect(createDeal).not.toHaveBeenCalled();
  });

  it("surfaces a failed create as hubspot_error", async () => {
    listDealsForCompany.mockResolvedValue([]);
    createDeal.mockRejectedValue(new Error("403 Forbidden"));

    const result = await resolveDealForCompany({
      companyId: COMPANY_ID,
      choice: { mode: "create", dealName: "New Deal" },
    });

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("hubspot_error");
    expect((result as { message: string }).message).toContain("403 Forbidden");
  });
});
