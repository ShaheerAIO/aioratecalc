// @vitest-environment jsdom
//
// Component coverage for the 2026-10-13 rebuild: the default table shows the
// two numbers the product owner asked for (plus ARR/commission context), the
// four Floor columns stay out of the DOM until "Show cost basis" is clicked,
// and toggling reveals them without a second network round trip.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { DealCommissionRow, CommissionDataGaps } from "@/lib/billing/commissionReport";

const getCommissionReportAction = vi.fn();
vi.mock("@/lib/actions/commissions", () => ({ getCommissionReportAction }));

const { default: CommissionsPanel } = await import("../CommissionsPanel");

const row = (over: Partial<DealCommissionRow> = {}): DealCommissionRow => ({
  applicationId: "app-1",
  merchantName: "Torta Palace",
  stage: "proposal_sent",
  quoteAcceptedAt: null,
  aioRevenue: 500,
  processorCostRate: 0.018,
  netMarginRate: 0.008,
  trueMarginFloor: 400,
  totalRevenue: 600,
  totalTakeRate: 0.025,
  wholesaleMargin: 0.007,
  implausibleRate: null,
  processingArr: 7200,
  recurringArr: 2400,
  totalArr: 9600,
  signingCommission: 480,
  activationCommission: 480,
  repHardwareCommission: 120,
  rsmHardwareCommission: 60,
  ...over,
});

const noGaps: CommissionDataGaps = { missingCost: [], zeroCost: [], recurringWithRate: [] };

beforeEach(() => {
  vi.clearAllMocks();
  getCommissionReportAction.mockResolvedValue({ rows: [row()], gaps: noGaps });
});

afterEach(() => cleanup());

describe("CommissionsPanel", () => {
  it("renders the default columns and not the floor columns", async () => {
    render(<CommissionsPanel />);
    await screen.findByText("Torta Palace");

    expect(screen.getByText("Total Rev/mo")).toBeTruthy();
    expect(screen.getByText("Take Rate")).toBeTruthy();
    expect(screen.getByText("Processing ARR")).toBeTruthy();
    expect(screen.getByText("Total ARR (est.)")).toBeTruthy();
    expect(screen.getByText("Signing (est.)")).toBeTruthy();
    expect(screen.getByText("Activation (est.)")).toBeTruthy();
    expect(screen.getByText("Rep HW Comm.")).toBeTruthy();
    expect(screen.getByText("RSM HW Comm.")).toBeTruthy();

    expect(screen.queryByText("AIO Rev/mo")).toBeNull();
    expect(screen.queryByText("Proc. Cost")).toBeNull();
    expect(screen.queryByText("Net Margin")).toBeNull();
    expect(screen.queryByText("True Floor/mo")).toBeNull();
  });

  it("reveals the floor columns once 'Show cost basis' is toggled on", async () => {
    render(<CommissionsPanel />);
    await screen.findByText("Torta Palace");

    fireEvent.click(screen.getByText("Show cost basis"));

    expect(screen.getByText("AIO Rev/mo")).toBeTruthy();
    expect(screen.getByText("Proc. Cost")).toBeTruthy();
    expect(screen.getByText("Net Margin")).toBeTruthy();
    expect(screen.getByText("True Floor/mo")).toBeTruthy();
    expect(getCommissionReportAction).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Hide cost basis"));
    expect(screen.queryByText("AIO Rev/mo")).toBeNull();
  });

  it("shows a compressed empty state when there is nothing to report", async () => {
    getCommissionReportAction.mockResolvedValue({ rows: [], gaps: noGaps });
    render(<CommissionsPanel />);
    expect(await screen.findByText(/Nothing to report yet/i)).toBeTruthy();
  });
});
