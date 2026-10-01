import { describe, it, expect } from "vitest";
import {
  buildRevenueReport, merchantRows, monthOverMonth, monthlyTotals, type ActualsRow,
} from "@/lib/revenueView";

const row = (over: Partial<ActualsRow> & Pick<ActualsRow, "tenantNumber" | "month">): ActualsRow => ({
  grossVolume: 0,
  transactionCount: 0,
  aioCommission: 0,
  merchantName: null,
  applicationId: null,
  ...over,
});

const ROWS: ActualsRow[] = [
  row({ tenantNumber: "1024", month: "2026-08", grossVolume: 100_000, transactionCount: 2_500, aioCommission: 800, merchantName: "Papa Noodle", applicationId: "app-1" }),
  row({ tenantNumber: "1025", month: "2026-08", grossVolume: 40_000, transactionCount: 1_000, aioCommission: 340, merchantName: "Sushi Gen", applicationId: "app-2" }),
  row({ tenantNumber: "1024", month: "2026-09", grossVolume: 120_000, transactionCount: 3_000, aioCommission: 960, merchantName: "Papa Noodle", applicationId: "app-1" }),
  row({ tenantNumber: "1099", month: "2026-09", grossVolume: 10_000, transactionCount: 400, aioCommission: 90, merchantName: null, applicationId: null }),
];

describe("monthlyTotals", () => {
  it("sums each month across tenants and counts the merchants that settled", () => {
    expect(monthlyTotals(ROWS)).toEqual([
      { month: "2026-09", grossVolume: 130_000, transactionCount: 3_400, aioCommission: 1_050, merchants: 2 },
      { month: "2026-08", grossVolume: 140_000, transactionCount: 3_500, aioCommission: 1_140, merchants: 2 },
    ]);
  });

  it("returns newest first, so the month people came for is the first row", () => {
    expect(monthlyTotals(ROWS).map(m => m.month)).toEqual(["2026-09", "2026-08"]);
  });

  it("is empty, not zeroed, when nothing has settled", () => {
    expect(monthlyTotals([])).toEqual([]);
  });
});

describe("merchantRows", () => {
  it("breaks one month down, biggest commission first", () => {
    const rows = merchantRows(ROWS, "2026-09");
    expect(rows.map(r => r.tenantNumber)).toEqual(["1024", "1099"]);
    expect(rows[0].aioCommission).toBe(960);
  });

  it("derives the effective rate and average ticket", () => {
    const [papa] = merchantRows(ROWS, "2026-09");
    expect(papa.effectiveRate).toBeCloseTo(960 / 120_000, 10);
    expect(papa.avgTicket).toBeCloseTo(40, 10);
  });

  it("leaves an unattributed tenant's name null rather than inventing one", () => {
    const orphan = merchantRows(ROWS, "2026-09").find(r => r.tenantNumber === "1099")!;
    expect(orphan.merchantName).toBeNull();
    expect(orphan.applicationId).toBeNull();
  });

  // A zero rate reads as "we earned nothing on real volume", which is a
  // completely different (and alarming) claim from "nothing settled".
  it("reports a rate and ticket of NULL, never 0, when there is no volume", () => {
    const empty = merchantRows([row({ tenantNumber: "7", month: "2026-09" })], "2026-09");
    expect(empty[0].effectiveRate).toBeNull();
    expect(empty[0].avgTicket).toBeNull();
  });
});

describe("buildRevenueReport", () => {
  it("opens on the newest month when none is asked for", () => {
    const r = buildRevenueReport(ROWS);
    expect(r.selectedMonth).toBe("2026-09");
    expect(r.selected!.aioCommission).toBe(1_050);
    expect(r.merchants).toHaveLength(2);
  });

  it("honours a month that exists and falls back to the newest for one that doesn't", () => {
    expect(buildRevenueReport(ROWS, "2026-08").selectedMonth).toBe("2026-08");
    expect(buildRevenueReport(ROWS, "1999-01").selectedMonth).toBe("2026-09");
    expect(buildRevenueReport(ROWS, null).selectedMonth).toBe("2026-09");
  });

  it("offers the month BEFORE the selected one as the comparison", () => {
    const r = buildRevenueReport(ROWS, "2026-09");
    expect(r.previous!.month).toBe("2026-08");
    // The earliest month we hold has nothing behind it.
    expect(buildRevenueReport(ROWS, "2026-08").previous).toBeNull();
  });

  it("is entirely empty rather than partly fabricated when nothing has settled", () => {
    expect(buildRevenueReport([])).toEqual({
      months: [], merchants: [], selectedMonth: null, selected: null, previous: null,
    });
  });
});

describe("monthOverMonth", () => {
  it("states a real change as a fraction, in both directions", () => {
    expect(monthOverMonth(120, 100)).toBeCloseTo(0.2, 10);
    expect(monthOverMonth(80, 100)).toBeCloseTo(-0.2, 10);
  });

  it("is null when there is nothing to compare against — never ∞, never 0", () => {
    expect(monthOverMonth(500, 0)).toBeNull();
    expect(monthOverMonth(500, null)).toBeNull();
    expect(monthOverMonth(500, undefined)).toBeNull();
  });
});
