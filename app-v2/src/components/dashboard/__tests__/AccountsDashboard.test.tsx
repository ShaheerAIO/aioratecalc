// @vitest-environment jsdom
//
// Component-level coverage for the accounts dashboard:
//  - linkTenantCompanyAction's dealCompanyRepaired / dealCompanyMismatch —
//    outcomes that were previously computed correctly and shown to nobody.
//    The mismatch in particular needs a human, so it must render as a
//    persistent banner, not a dismissable alert().
//  - the 2026-11-11 revamp (phases 1 + 2): filter tabs with counts, default
//    sort by last edited, one status + one next-step button per row, the
//    debug/diagnostic controls hidden, and Approve never shown to a rep.
//
// Same module-boundary-mock idiom as the Server Action tests, with
// @testing-library/react doing the rendering.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import type { MerchantApplication } from "@/types/merchant";
import type { TenantLinkResult } from "@/lib/actions/applications";

const listApplicationsAction = vi.fn();
const listRepsAction = vi.fn();
const sendMerchantOnboardingLinkAction = vi.fn();
const markApplicationClosedLostAction = vi.fn();
const searchTenantCompaniesAction = vi.fn();
const linkTenantCompanyAction = vi.fn();
const unlinkTenantCompanyAction = vi.fn();

vi.mock("@/lib/actions/applications", () => ({
  listApplicationsAction,
  listRepsAction,
  sendMerchantOnboardingLinkAction,
  markApplicationClosedLostAction,
  searchTenantCompaniesAction,
  linkTenantCompanyAction,
  unlinkTenantCompanyAction,
}));

const resendLeadLinkAction = vi.fn();
const sendDraftAction = vi.fn();
vi.mock("@/lib/actions/prospects", () => ({ resendLeadLinkAction, sendDraftAction }));
const approveQuoteAction = vi.fn();
vi.mock("@/lib/actions/quoteApproval", () => ({ approveQuoteAction }));

// Stubbed so their own action/server-only import chains don't need to be
// dragged into this test. The editor stub renders a marker so "Finish quote"
// opening it is observable; BillingPanel has its own test.
vi.mock("@/components/rep/EditQuotePanel", () => ({ default: () => <div>Quote editor</div> }));
vi.mock("../BillingPanel", () => ({
  BillingPanel: () => null,
  BillingDetails: () => <div>Billing details stub</div>,
}));

// No App Router mounted under vitest.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/rep",
  useSearchParams: () => new URLSearchParams(),
}));

const { AccountsDashboard } = await import("../AccountsDashboard");

const REP_ID = "rep-1";
const ADMIN_ID = "admin-1";

const linked: MerchantApplication["tenantLink"] = {
  hubspotCompanyId: "co-1", companyName: "Acme Co", tenantRef: null,
  adyenAccountHolderId: null, linkedAt: "2026-09-21T00:00:00.000Z", linkedByUserId: REP_ID,
};

const baseApp = (over: Partial<MerchantApplication> = {}): MerchantApplication =>
  ({
    id: "app-1",
    ownerUserId: REP_ID,
    customerUserId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    lastEditedAt: null,
    stage: "proposal_sent",
    hubspotDealId: "deal-1",
    dealLink: null,
    tenantLink: null,
    adyenIds: null,
    adyenOnboardingUrl: null,
    aioTenant: null,
    checkIds: null,
    foodbuyIds: null,
    hubspotIds: null,
    quoteStatus: null,
    quoteApproval: null,
    quoteType: null,
    quoteConfig: null,
    quoteLines: null,
    orderPoints: null,
    quoteAcceptedAt: null,
    detailsConfirmedAt: null,
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

const named = (id: string, dba: string, over: Partial<MerchantApplication> = {}) =>
  baseApp({ id, business: { dba, legalName: `${dba} LLC` } as MerchantApplication["business"], ...over });

const contact = { firstName: "Priya", lastName: "Shah", title: "", email: "priya@example.com", phone: "" };
const approval = {
  overrides: [{ kind: "cp_rate" as const, message: "Card-present rate is below the limit", value: 1, limit: 2 }],
  fingerprint: "f", requestedAt: "2026-11-01T00:00:00.000Z", requestedByUserId: REP_ID,
};

// One account per status, in the shapes lib/accountStatus.ts reads.
const everyStatus = (): MerchantApplication[] => [
  named("a-draft", "Draft Diner", { stage: "prospect_created", quoteStatus: "draft" }),
  named("a-appr", "Approval Grill", { stage: "prospect_created", quoteStatus: "pending_approval", quoteApproval: approval }),
  named("a-ready", "Ready Ramen", { stage: "prospect_created", quoteStatus: "approved", quoteApproval: { ...approval, approvedAt: "2026-11-02T00:00:00.000Z" } }),
  named("a-sent", "Sent Sushi", { stage: "quote_sent", customerLinkPurpose: "lead_upload", customerLinkToken: "tok" }),
  named("a-signed", "Signed Subs", { stage: "quote_accepted", quoteAcceptedAt: "2026-11-03T00:00:00.000Z", ownerContact: contact }),
  named("a-onb", "Onboard Oyster", { stage: "merchant_link_sent", quoteAcceptedAt: "2026-11-03T00:00:00.000Z", ownerContact: contact }),
  named("a-fill", "Filling Falafel", { stage: "merchant_filling", quoteAcceptedAt: "2026-11-03T00:00:00.000Z", ownerContact: contact }),
  named("a-live", "Live Lasagna", { stage: "adyen_approved", quoteAcceptedAt: "2026-11-03T00:00:00.000Z" }),
  named("a-lost", "Lost Lobster", { stage: "closed_lost" }),
];

const tabButton = (label: string) =>
  screen.getAllByRole("tab").find(t => t.textContent?.startsWith(label))!;
const rowFor = (name: string) =>
  screen.getAllByTestId("account-row").find(r => r.textContent?.includes(name))!;
const rowNames = () =>
  screen.getAllByTestId("account-row").map(r => within(r).getAllByRole("button")[0].textContent);

// Opens the split detail view for the (only) row in the table.
async function openDetail(role: "rep" | "admin" = "rep") {
  render(<AccountsDashboard role={role} userId={role === "rep" ? REP_ID : ADMIN_ID} />);
  await screen.findAllByRole("tab");
  fireEvent.click(tabButton("All"));
  const row = await screen.findByText("Torta Palace");
  fireEvent.click(row);
  await screen.findByText("HubSpot company");
}

beforeEach(() => {
  vi.clearAllMocks();
  listApplicationsAction.mockResolvedValue([baseApp()]);
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
      app: baseApp({ tenantLink: linked }),
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

describe("filter tabs", () => {
  it("counts every tab by status and opens a rep on Needs me", async () => {
    listApplicationsAction.mockResolvedValue(everyStatus());
    render(<AccountsDashboard role="rep" userId={REP_ID} />);
    await screen.findByText("Draft Diner");

    const count = (label: string) => tabButton(label).textContent!.slice(label.length);
    expect(screen.getAllByRole("tab")[0].textContent).toMatch(/^Needs me/);
    expect(count("Needs me")).toBe("2");
    expect(count("Needs approval")).toBe("1");
    expect(count("Sent")).toBe("2");
    expect(count("Onboarding")).toBe("2");
    expect(count("Live")).toBe("1");
    expect(count("All")).toBe("9");

    expect(tabButton("Needs me").getAttribute("aria-selected")).toBe("true");
    expect(rowNames().sort()).toEqual(["Draft Diner", "Ready Ramen"]);
  });

  it("filters to the clicked tab; closed lost only shows under All", async () => {
    listApplicationsAction.mockResolvedValue(everyStatus());
    render(<AccountsDashboard role="rep" userId={REP_ID} />);
    await screen.findByText("Draft Diner");

    fireEvent.click(tabButton("Sent"));
    expect(rowNames().sort()).toEqual(["Sent Sushi", "Signed Subs"]);

    fireEvent.click(tabButton("Onboarding"));
    expect(rowNames().sort()).toEqual(["Filling Falafel", "Onboard Oyster"]);

    for (const label of ["Needs me", "Needs approval", "Sent", "Onboarding", "Live"]) {
      fireEvent.click(tabButton(label));
      expect(screen.queryByText("Lost Lobster")).toBeNull();
    }
    fireEvent.click(tabButton("All"));
    expect(screen.getByText("Lost Lobster")).toBeTruthy();
  });

  it("counts follow the search box", async () => {
    listApplicationsAction.mockResolvedValue(everyStatus());
    render(<AccountsDashboard role="rep" userId={REP_ID} />);
    await screen.findByText("Draft Diner");
    fireEvent.change(screen.getByPlaceholderText(/search name/i), { target: { value: "ramen" } });
    expect(tabButton("All").textContent).toBe("All1");
    expect(tabButton("Needs me").textContent).toBe("Needs me1");
  });
});

describe("sorting", () => {
  const drafts = () => [
    named("d-old", "Old Edit", { stage: "prospect_created", quoteStatus: "draft", lastEditedAt: "2026-10-01T00:00:00.000Z", analysis: { totalVolume: 90_000 } as MerchantApplication["analysis"] }),
    named("d-new", "Newest Edit", { stage: "prospect_created", quoteStatus: "draft", lastEditedAt: "2026-11-10T00:00:00.000Z", analysis: { totalVolume: 10_000 } as MerchantApplication["analysis"] }),
    // No lastEditedAt: falls back to createdAt.
    named("d-created", "Created Only", { stage: "prospect_created", quoteStatus: "draft", lastEditedAt: null, createdAt: "2026-10-15T00:00:00.000Z", analysis: { totalVolume: 50_000 } as MerchantApplication["analysis"] }),
  ];

  it("defaults to most recently edited, falling back to createdAt", async () => {
    listApplicationsAction.mockResolvedValue(drafts());
    render(<AccountsDashboard role="rep" userId={REP_ID} />);
    await screen.findByText("Old Edit");
    expect(screen.getByRole("button", { name: "Last edited" }).getAttribute("aria-pressed")).toBe("true");
    expect(rowNames()).toEqual(["Newest Edit", "Created Only", "Old Edit"]);
  });

  it("sorts by volume and by name", async () => {
    listApplicationsAction.mockResolvedValue(drafts());
    render(<AccountsDashboard role="rep" userId={REP_ID} />);
    await screen.findByText("Old Edit");
    fireEvent.click(screen.getByRole("button", { name: "Volume" }));
    expect(rowNames()).toEqual(["Old Edit", "Created Only", "Newest Edit"]);
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(rowNames()).toEqual(["Created Only", "Newest Edit", "Old Edit"]);
  });
});

describe("next-step buttons", () => {
  const nextButton = (name: string) => {
    const buttons = within(rowFor(name)).queryAllByRole("button");
    return buttons.length > 1 ? buttons[buttons.length - 1] : null;
  };

  it("labels each row from its status (rep)", async () => {
    listApplicationsAction.mockResolvedValue(everyStatus());
    render(<AccountsDashboard role="rep" userId={REP_ID} />);
    await screen.findByText("Draft Diner");
    fireEvent.click(tabButton("All"));

    expect(nextButton("Draft Diner")?.textContent).toBe("Finish quote");
    expect(nextButton("Approval Grill")?.textContent).toBe("Waiting on admin");
    expect((nextButton("Approval Grill") as HTMLButtonElement).disabled).toBe(true);
    expect(nextButton("Ready Ramen")?.textContent).toBe("Send quote");
    expect(nextButton("Sent Sushi")?.textContent).toBe("Resend quote link");
    expect(nextButton("Signed Subs")?.textContent).toBe("Send onboarding link");
    expect(nextButton("Onboard Oyster")?.textContent).toBe("Resend onboarding link");
    // Resending from a later onboarding stage would drag the deal back to
    // merchant_link_sent, so the row offers View instead.
    expect(nextButton("Filling Falafel")?.textContent).toBe("View");
    expect(nextButton("Live Lasagna")?.textContent).toBe("View");
    expect(nextButton("Lost Lobster")).toBeNull();
  });

  it("shows status badges instead of raw stage names", async () => {
    listApplicationsAction.mockResolvedValue(everyStatus());
    render(<AccountsDashboard role="rep" userId={REP_ID} />);
    await screen.findByText("Draft Diner");
    fireEvent.click(tabButton("All"));
    expect(within(rowFor("Sent Sushi")).getByText("Sent")).toBeTruthy();
    expect(within(rowFor("Filling Falafel")).getByText("Filling in form")).toBeTruthy();
    expect(screen.queryByText("quote sent")).toBeNull();
    expect(screen.queryByText("merchant filling")).toBeNull();
  });

  it("Finish quote opens the account with the quote editor open", async () => {
    listApplicationsAction.mockResolvedValue(everyStatus());
    render(<AccountsDashboard role="rep" userId={REP_ID} />);
    await screen.findByText("Draft Diner");
    fireEvent.click(nextButton("Draft Diner")!);
    expect(await screen.findByText("Quote editor")).toBeTruthy();
  });

  it("Resend quote link confirms, then calls the existing resend action", async () => {
    listApplicationsAction.mockResolvedValue(everyStatus());
    resendLeadLinkAction.mockResolvedValue({
      app: everyStatus()[3], linkUrl: "https://x/lead/tok", emailResult: { sent: false, devUrl: null }, smsResult: null,
    });
    render(<AccountsDashboard role="rep" userId={REP_ID} />);
    await screen.findByText("Draft Diner");
    fireEvent.click(tabButton("Sent"));
    fireEvent.click(nextButton("Sent Sushi")!);
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(resendLeadLinkAction).toHaveBeenCalledWith("a-sent"));
    expect(await screen.findByText("https://x/lead/tok")).toBeTruthy();
  });

  it("does nothing when the send confirm is cancelled", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    listApplicationsAction.mockResolvedValue(everyStatus());
    render(<AccountsDashboard role="rep" userId={REP_ID} />);
    await screen.findByText("Draft Diner");
    fireEvent.click(nextButton("Ready Ramen")!);
    expect(sendDraftAction).not.toHaveBeenCalled();
  });
});

describe("approval is admin-only", () => {
  it("a rep sees Waiting on admin and no Approve button anywhere", async () => {
    listApplicationsAction.mockResolvedValue(everyStatus());
    render(<AccountsDashboard role="rep" userId={REP_ID} />);
    await screen.findByText("Draft Diner");
    fireEvent.click(tabButton("Needs approval"));
    fireEvent.click(screen.getByText("Approval Grill"));
    await screen.findByText("Waiting on an admin");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect((screen.getByRole("button", { name: "Waiting on admin" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Admin")).toBeNull();
    expect(screen.queryByText("Billing details stub")).toBeNull();
    // The owning rep still sees what the approval is for.
    expect(screen.getAllByText("Card-present rate is below the limit")).toHaveLength(1);
  });

  it("an admin gets Approve on the row, and ONE approval card with reasons, requester and the button", async () => {
    listApplicationsAction.mockResolvedValue(everyStatus());
    listRepsAction.mockResolvedValue([{ id: REP_ID, name: "Maya Rep", email: "maya@example.com" }]);
    approveQuoteAction.mockResolvedValue({});
    render(<AccountsDashboard role="admin" userId={ADMIN_ID} />);
    await screen.findByText("Draft Diner");
    expect(within(rowFor("Approval Grill")).getByRole("button", { name: "Approve" })).toBeTruthy();

    fireEvent.click(screen.getByText("Approval Grill"));
    await screen.findByText("Approve the over-limit pricing");
    // Reason, requester and button live in the one card; no second approval block.
    expect(screen.getAllByText("Card-present rate is below the limit")).toHaveLength(1);
    expect(screen.getByText(/Requested by Maya Rep/)).toBeTruthy();
    expect(screen.queryByText("Needs your approval")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(approveQuoteAction).toHaveBeenCalledWith("a-appr"));
  });
});

describe("hidden debug and diagnostic controls", () => {
  const provisioned = () => baseApp({
    stage: "merchant_filling",
    quoteAcceptedAt: "2026-11-03T00:00:00.000Z",
    aioTenant: { businessId: "4242", locationId: "77", environment: "prod" } as unknown as MerchantApplication["aioTenant"],
    adyenIds: { tenantNumber: "4242", legalEntityId: "LE123", environment: "live" } as MerchantApplication["adyenIds"],
  });

  for (const role of ["rep", "admin"] as const) {
    it(`does not render provider ids, Skip Billing or Publish Quote Now for a ${role}`, async () => {
      listApplicationsAction.mockResolvedValue([provisioned()]);
      await openDetail(role);
      expect(screen.getByText("Onboarding", { selector: "h3" })).toBeTruthy();
      expect(screen.queryByText(/provider ids/i)).toBeNull();
      expect(screen.queryByText("LE123")).toBeNull();
      expect(screen.queryByText(/skip billing/i)).toBeNull();
      expect(screen.queryByText(/publish quote now/i)).toBeNull();
    });
  }

  it("keeps raw HubSpot and account ids away from a rep", async () => {
    listApplicationsAction.mockResolvedValue([baseApp({ tenantLink: linked, hubspotDealId: "deal-123" })]);
    await openDetail("rep");
    expect(screen.queryByText("deal-123")).toBeNull();
    expect(screen.queryByText(/Account app-1/)).toBeNull();
  });
});
