import { describe, it, expect, vi, beforeEach } from "vitest";

// The settlement-derived KYC backstop. Retiring the Adyen webhook removed the
// only automatic path to adyen_approved; this one infers it from ground truth
// (the merchant settled money, so Adyen approved them) rather than from a
// status field AIO doesn't expose.

type Row = { id: string; stage: string };

let selectRows: Row[] = [];
const updates: Array<{ patch: Record<string, unknown> }> = [];

const db = {
  select: () => ({ from: () => ({ where: async () => selectRows }) }),
  update: () => ({
    set: (patch: Record<string, unknown>) => ({
      where: async () => {
        updates.push({ patch });
        return { rowCount: 1 };
      },
    }),
  }),
};

vi.mock("@/lib/db/client", () => ({ db }));

const { advanceApprovedFromSettlement } = await import("@/lib/aio/approvedFromSettlement");
const { STAGE_RANK } = await import("@/lib/stages");

beforeEach(() => {
  selectRows = [];
  updates.length = 0;
});

describe("advanceApprovedFromSettlement", () => {
  it("does nothing when the report named no tenants", async () => {
    expect(await advanceApprovedFromSettlement([])).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("advances a merchant that is settling money", async () => {
    selectRows = [{ id: "app-1", stage: "adyen_kyc_pending" }];
    expect(await advanceApprovedFromSettlement(["5217"])).toBe(1);
    expect(updates[0].patch.stage).toBe("adyen_approved");
  });

  it("is forward-only — an already-approved merchant is left alone", async () => {
    selectRows = [{ id: "app-1", stage: "adyen_approved" }];
    expect(await advanceApprovedFromSettlement(["5217"])).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("never resurrects a closed-lost deal, even though it settled", async () => {
    // closed_lost outranks adyen_approved, so a naive shouldAdvance check
    // would read "advance" as moving INTO closed_lost. Un-losing a merchant is
    // a human's call, not a side effect of a nightly report.
    expect(STAGE_RANK.closed_lost).toBeGreaterThan(STAGE_RANK.adyen_approved);
    selectRows = [{ id: "app-1", stage: "closed_lost" }];
    expect(await advanceApprovedFromSettlement(["5217"])).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("de-duplicates tenant numbers — a report has one row per day per tenant", async () => {
    selectRows = [{ id: "app-1", stage: "adyen_kyc_pending" }];
    await advanceApprovedFromSettlement(["5217", "5217", "5217"]);
    expect(updates).toHaveLength(1);
  });

  it("ignores empty tenant numbers rather than querying for them", async () => {
    expect(await advanceApprovedFromSettlement(["", ""])).toBe(0);
  });

  it("advances several merchants in one pass", async () => {
    selectRows = [
      { id: "app-1", stage: "adyen_kyc_pending" },
      { id: "app-2", stage: "merchant_filling" },
      { id: "app-3", stage: "adyen_approved" },
    ];
    expect(await advanceApprovedFromSettlement(["5217", "5218", "5219"])).toBe(2);
  });
});
