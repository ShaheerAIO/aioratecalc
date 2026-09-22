// @vitest-environment jsdom
//
// Component-level coverage for the two outcomes this task made visible that
// were previously computed correctly and shown to nobody:
//   1. linkTenantCompanyAction's dealCompanyRepaired / dealCompanyMismatch —
//      the mismatch in particular needs a human, so it must render as a
//      persistent banner, not a dismissable alert().
//   2. The rep's manual demo-held override (markDemoHeldAction /
//      clearDemoHeldAction) — the primary path, since HubSpot only tags
//      ~1.5% of portal meetings "Demo".
//
// This is the first component-render test in this codebase (everything else
// under src/lib/__tests__ tests pure functions or Server Actions with mocked
// storage/adapters at the module boundary) — the same module-boundary-mock
// idiom is used here, just with @testing-library/react doing the rendering
// instead of calling an action directly.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { MerchantApplication } from "@/types/merchant";
import type { TenantLinkResult } from "@/lib/actions/applications";

const listApplicationsAction = vi.fn();
const listSubmissionsAction = vi.fn();
const listRepsAction = vi.fn();
const sendMerchantOnboardingLinkAction = vi.fn();
const markApplicationClosedLostAction = vi.fn();
const setTenantNumberAction = vi.fn();
const searchTenantCompaniesAction = vi.fn();
const linkTenantCompanyAction = vi.fn();
const unlinkTenantCompanyAction = vi.fn();
const markDemoHeldAction = vi.fn();
const clearDemoHeldAction = vi.fn();

vi.mock("@/lib/actions/applications", () => ({
  listApplicationsAction,
  listSubmissionsAction,
  listRepsAction,
  sendMerchantOnboardingLinkAction,
  markApplicationClosedLostAction,
  setTenantNumberAction,
  searchTenantCompaniesAction,
  linkTenantCompanyAction,
  unlinkTenantCompanyAction,
  markDemoHeldAction,
  clearDemoHeldAction,
}));

const resendLeadLinkAction = vi.fn();
vi.mock("@/lib/actions/prospects", () => ({ resendLeadLinkAction }));

// Out of scope for this task (owned by another agent / unrelated to the two
// outcomes under test) — stubbed out so their own action/server-only import
// chains don't need to be dragged into this test.
vi.mock("@/components/rep/EditQuotePanel", () => ({ default: () => null }));
vi.mock("../BillingPanel", () => ({ BillingPanel: () => null }));

// AccountsDashboard reads/writes ?tab= via next/navigation — there's no App
// Router mounted under vitest, so it's stubbed the same way any Next app
// stubs it in a non-Next test harness.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/rep",
  useSearchParams: () => new URLSearchParams(),
}));

const { AccountsDashboard } = await import("../AccountsDashboard");

const REP_ID = "rep-1";

const baseApp = (over: Partial<MerchantApplication> = {}): MerchantApplication =>
  ({
    id: "app-1",
    ownerUserId: REP_ID,
    customerUserId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    stage: "proposal_sent",
    hubspotDealId: "deal-1",
    dealLink: null,
    demo: null,
    tenantLink: null,
    adyenIds: null,
    adyenOnboardingUrl: null,
    checkIds: null,
    foodbuyIds: null,
    hubspotIds: null,
    quoteType: null,
    quoteConfig: null,
    quoteLines: null,
    orderPoints: null,
    quoteAcceptedAt: null,
    targetMargin: null,
    pricingModel: null,
    customerLinkToken: null,
    customerLinkPurpose: null,
    customerLinkSentAt: null,
    customerLinkExpiresAt: null,
    analysis: null,
    proposal: null,
    business: { dba: "Torta Palace", legalName: "Torta Palace LLC" },
    ownerContact: null,
    processing: null,
    agreement: null,
    ...over,
  }) as unknown as MerchantApplication;

// Opens the split detail view for the (only) row in the table.
async function openDetail() {
  render(<AccountsDashboard role="rep" userId={REP_ID} />);
  const row = await screen.findByText("Torta Palace");
  fireEvent.click(row);
  await screen.findByText(/HubSpot Tenant/i);
}

beforeEach(() => {
  vi.clearAllMocks();
  listApplicationsAction.mockResolvedValue([baseApp()]);
  listSubmissionsAction.mockResolvedValue([]);
  listRepsAction.mockResolvedValue([]);
  vi.spyOn(window, "alert").mockImplementation(() => {});
  vi.spyOn(window, "confirm").mockImplementation(() => true);
});

afterEach(() => cleanup());

describe("tenant-link repair outcomes", () => {
  it("renders a persistent warning naming the deal and the other company when a mismatch is found", async () => {
    searchTenantCompaniesAction.mockResolvedValue([{ id: "co-1", name: "Acme Co", tenantRef: null, adyenAccountHolderId: null }]);
    const result: TenantLinkResult = {
      app: baseApp(), // tenantLink stays null on the fixture — the mismatch banner doesn't depend on it
      dealCreated: false,
      dealCompanyMismatch: { dealId: "deal-other", otherCompanyIds: ["company-xyz"] },
      quotePublished: false,
    };
    linkTenantCompanyAction.mockResolvedValue(result);

    await openDetail();
    fireEvent.change(screen.getByPlaceholderText(/search hubspot companies/i), { target: { value: "Acme" } });
    fireEvent.click(await screen.findByText("Acme Co"));

    const warning = await screen.findByRole("alert");
    expect(warning.textContent).toContain("deal-other");
    expect(warning.textContent).toContain("company-xyz");
    expect(warning.textContent).toMatch(/resolve/i);
    expect(warning.textContent).toMatch(/hubspot/i);

    // Not an alert() the rep can dismiss and forget.
    expect(window.alert).not.toHaveBeenCalled();
  });

  it("says so when the orphaned deal was repaired, and shows no mismatch warning", async () => {
    searchTenantCompaniesAction.mockResolvedValue([{ id: "co-1", name: "Acme Co", tenantRef: null, adyenAccountHolderId: null }]);
    const result: TenantLinkResult = {
      app: baseApp({ tenantLink: {
        hubspotCompanyId: "co-1", companyName: "Acme Co", tenantRef: null,
        adyenAccountHolderId: null, linkedAt: "2026-09-21T00:00:00.000Z", linkedByUserId: REP_ID,
      } }),
      dealCreated: false,
      dealCompanyRepaired: true,
      quotePublished: false,
    };
    linkTenantCompanyAction.mockResolvedValue(result);

    await openDetail();
    fireEvent.change(screen.getByPlaceholderText(/search hubspot companies/i), { target: { value: "Acme" } });
    fireEvent.click(await screen.findByText("Acme Co"));

    await waitFor(() => expect(window.alert).toHaveBeenCalledWith(expect.stringMatching(/attached/i)));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("demo-held override", () => {
  it("shows the unlock consequence, marks the demo held, and reflects the result", async () => {
    markDemoHeldAction.mockResolvedValue(
      baseApp({ demo: {
        bookedAt: null, heldAt: "2026-09-21T10:00:00.000Z", source: "manual",
        meetingId: null, meetingTitle: null, outcome: null, markedByUserId: REP_ID,
        checkedAt: "2026-09-21T10:00:00.000Z", lastSyncError: null, lastSyncErrorAt: null,
      } })
    );

    await openDetail();
    expect(screen.getByText(/unlocks the customer/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /mark demo held/i }));

    expect(markDemoHeldAction).toHaveBeenCalledWith("app-1");
    await screen.findByText(/^Held/);
    expect(screen.getByText(/marked manually/i)).toBeTruthy();
  });

  it("confirms before undoing a held demo, and skips the call if declined", async () => {
    listApplicationsAction.mockResolvedValue([baseApp({ demo: {
      bookedAt: null, heldAt: "2026-09-21T10:00:00.000Z", source: "hubspot_meeting",
      meetingId: "m-1", meetingTitle: "Demo with Torta Palace", outcome: "COMPLETED",
      markedByUserId: null, checkedAt: "2026-09-21T10:00:00.000Z", lastSyncError: null, lastSyncErrorAt: null,
    } })]);
    (window.confirm as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);

    await openDetail();
    await screen.findByText(/^Held/);
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));

    expect(window.confirm).toHaveBeenCalled();
    expect(clearDemoHeldAction).not.toHaveBeenCalled();
  });

  it("undoes the held mark once confirmed, re-locking the view", async () => {
    listApplicationsAction.mockResolvedValue([baseApp({ demo: {
      bookedAt: null, heldAt: "2026-09-21T10:00:00.000Z", source: "manual",
      meetingId: null, meetingTitle: null, outcome: null, markedByUserId: REP_ID,
      checkedAt: "2026-09-21T10:00:00.000Z", lastSyncError: null, lastSyncErrorAt: null,
    } })]);
    clearDemoHeldAction.mockResolvedValue(baseApp({ demo: {
      bookedAt: null, heldAt: null, source: null,
      meetingId: null, meetingTitle: null, outcome: null,
      markedByUserId: null, checkedAt: "2026-09-21T11:00:00.000Z", lastSyncError: null, lastSyncErrorAt: null,
    } }));

    await openDetail();
    await screen.findByText(/^Held/);
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));

    expect(clearDemoHeldAction).toHaveBeenCalledWith("app-1");
    await screen.findByRole("button", { name: /mark demo held/i });
    expect(screen.getByText(/unlocks the customer/i)).toBeTruthy();
  });
});
