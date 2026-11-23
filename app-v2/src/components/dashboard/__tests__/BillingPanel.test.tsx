// @vitest-environment jsdom
//
// The billing panel after the 2026-11-11 dashboard revamp: the debug and
// escape-hatch controls ("Skip Billing (Debug)", "Publish Quote Now") stay in
// the code but are not rendered for anyone, and the raw HubSpot ids, the sync
// error text and the subscription rows moved to the admin-only
// BillingDetails disclosure.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { EMPTY_HUBSPOT_IDS, type HubspotIds, type MerchantApplication } from "@/types/merchant";

vi.mock("@/lib/actions/applications", () => ({ getApplicationAction: vi.fn() }));
vi.mock("@/lib/actions/billing", () => ({ retryOneTimeInvoiceAction: vi.fn(), sendQuoteAction: vi.fn() }));
vi.mock("@/lib/actions/debugBilling", () => ({ bypassBillingAction: vi.fn() }));

const { BillingPanel, BillingDetails } = await import("../BillingPanel");

const ids = (o: Partial<HubspotIds> = {}): HubspotIds => ({ ...EMPTY_HUBSPOT_IDS, ...o });

const app = (over: Partial<MerchantApplication> = {}): MerchantApplication =>
  ({
    id: "app-1",
    ownerUserId: "rep-1",
    stage: "quote_sent",
    quoteAcceptedAt: null,
    quoteLines: [{ hubspotProductId: "p1", name: "AIO", qty: 1, unitPrice: 99, billingFrequency: "monthly", productType: "Software" }],
    tenantLink: {
      hubspotCompanyId: "co-1", companyName: "Acme", tenantRef: null, adyenAccountHolderId: null,
      linkedAt: "2026-09-01T00:00:00.000Z", linkedByUserId: "rep-1",
    },
    hubspotIds: null,
    hubspotInvoice: null,
    ...over,
  }) as unknown as MerchantApplication;

afterEach(() => cleanup());

describe("BillingPanel", () => {
  for (const isAdmin of [false, true]) {
    it(`renders neither Skip Billing nor Publish Quote Now (${isAdmin ? "admin" : "rep"}, bypass flag on)`, () => {
      // An unpublished, sendable quote: exactly where both used to appear.
      render(
        <BillingPanel
          app={app({ hubspotIds: ids({ quoteId: "q-555" }) })}
          canManage
          onUpdated={() => {}}
          debugBillingBypass
          isAdmin={isAdmin}
        />,
      );
      expect(screen.getByText("Not published yet")).toBeTruthy();
      expect(screen.queryByText(/skip billing/i)).toBeNull();
      expect(screen.queryByText(/publish quote now/i)).toBeNull();
      // The raw quote id is an admin diagnostic now.
      expect(screen.queryByText("q-555")).toBeNull();
    });
  }

  it("shows a rep the sync failure without the raw error", () => {
    render(
      <BillingPanel
        app={app({ hubspotIds: ids({ quoteId: "q-1", lastSyncError: "HTTP 400 VALIDATION_ERROR on line 3" }) })}
        canManage
        onUpdated={() => {}}
      />,
    );
    expect(screen.getByText("HubSpot sync failed")).toBeTruthy();
    expect(screen.queryByText(/VALIDATION_ERROR/)).toBeNull();
  });

  it("keeps the signature, payment and the customer payment link", () => {
    render(
      <BillingPanel
        app={app({
          hubspotIds: ids({
            quoteId: "q-1", publishedAt: "2026-11-01T00:00:00.000Z", esignStatus: "SIGNED",
            paymentStatus: "PENDING", quoteLink: "https://customers.example/q",
          }),
        })}
        canManage
        onUpdated={() => {}}
      />,
    );
    expect(screen.getByText("Signed")).toBeTruthy();
    expect(screen.getByText("PENDING")).toBeTruthy();
    expect(screen.getByText("https://customers.example/q")).toBeTruthy();
  });
});

describe("BillingDetails (admin)", () => {
  it("holds the quote id and the full sync error, open when something failed", () => {
    const { container } = render(
      <BillingDetails app={app({ hubspotIds: ids({ quoteId: "q-1", lastSyncError: "HTTP 400 VALIDATION_ERROR" }) })} />,
    );
    expect(screen.getByText("q-1")).toBeTruthy();
    expect(screen.getByText("HTTP 400 VALIDATION_ERROR")).toBeTruthy();
    expect(container.querySelector("details")?.open).toBe(true);
  });

  it("renders nothing when there is no HubSpot billing record", () => {
    const { container } = render(<BillingDetails app={app()} />);
    expect(container.innerHTML).toBe("");
  });
});
