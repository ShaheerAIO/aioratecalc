import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HubspotIds, MerchantApplication } from "@/types/merchant";

// /customer/applications/[id]/billing, exercised as a route handler. What's
// under test is the read-or-refresh rule: this route must NOT mint a fresh link
// per click the way the Adyen and Check /continue routes do, so the assertions
// pin "an existing stored link is re-served without calling HubSpot at all".

const auth = vi.fn();
const getApplicationForCustomer = vi.fn();
const updateApplicationAsCustomer = vi.fn();
const getQuoteSnapshot = vi.fn();

vi.mock("@/lib/auth", () => ({ auth, signIn: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/storage/postgresAdapter", () => ({
  postgresStorage: { getApplicationForCustomer, updateApplicationAsCustomer },
}));
vi.mock("@/lib/adapters/hubspot", () => ({ getQuoteSnapshot }));

const { GET } = await import("@/app/customer/applications/[id]/billing/route");

const CUSTOMER_SESSION = { user: { id: "cust-1", role: "customer" } };
const ID = "app-1";
const REQ_URL = `http://localhost:5001/customer/applications/${ID}/billing`;
const QUOTE_LINK = "https://customers.aioapp.com/abcdef123";

const HUBSPOT_IDS: HubspotIds = {
  quoteId: "q-1",
  quoteTemplateId: "tpl-1",
  lineItemIds: ["li-1"],
  contactId: "c-1",
  quoteLink: null,
  publishedAt: null,
  paymentStatus: null,
  paymentDate: null,
  subscriptions: null,
  subscriptionStatus: null,
  syncedAt: null,
  lastSyncError: null,
  lastSyncErrorAt: null,
};

const app = (hubspotIds: HubspotIds | null): MerchantApplication =>
  ({ id: ID, hubspotIds } as MerchantApplication);

const get = () => GET({ url: REQ_URL } as never, { params: Promise.resolve({ id: ID }) });

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  auth.mockReset();
  getApplicationForCustomer.mockReset();
  updateApplicationAsCustomer.mockReset();
  getQuoteSnapshot.mockReset();
  auth.mockResolvedValue(CUSTOMER_SESSION);
  updateApplicationAsCustomer.mockImplementation(async () => app(HUBSPOT_IDS));
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => errorSpy.mockRestore());

const location = (res: Response) => res.headers.get("location");

describe("the billing route's session gate", () => {
  it("sends a signed-out visitor to the customer login", async () => {
    auth.mockResolvedValue(null);
    expect(location(await get())).toBe("http://localhost:5001/customer/login");
    expect(getApplicationForCustomer).not.toHaveBeenCalled();
  });

  it("sends a non-customer session to the customer login", async () => {
    auth.mockResolvedValue({ user: { id: "rep-1", role: "rep" } });
    expect(location(await get())).toBe("http://localhost:5001/customer/login");
  });

  it("sends an id that isn't theirs back to the dashboard", async () => {
    getApplicationForCustomer.mockResolvedValue(null);
    expect(location(await get())).toBe("http://localhost:5001/customer");
  });
});

describe("the billing route's three branches", () => {
  it("refuses a quote that was never published, without calling HubSpot", async () => {
    getApplicationForCustomer.mockResolvedValue(app({ ...HUBSPOT_IDS, publishedAt: null }));
    expect(location(await get())).toBe(
      `http://localhost:5001/customer/applications/${ID}?error=quote_not_ready`
    );
    expect(getQuoteSnapshot).not.toHaveBeenCalled();
    expect(updateApplicationAsCustomer).not.toHaveBeenCalled();
  });

  it("refuses when there is no HubSpot quote at all", async () => {
    getApplicationForCustomer.mockResolvedValue(app(null));
    expect(location(await get())).toBe(
      `http://localhost:5001/customer/applications/${ID}?error=quote_not_ready`
    );
    expect(getQuoteSnapshot).not.toHaveBeenCalled();
  });

  it("re-serves a stored link WITHOUT minting or re-reading anything", async () => {
    getApplicationForCustomer.mockResolvedValue(
      app({ ...HUBSPOT_IDS, publishedAt: "2026-08-20T00:00:00.000Z", quoteLink: QUOTE_LINK })
    );
    expect(location(await get())).toBe(QUOTE_LINK);
    // The whole point of §7.3: hs_quote_link is public_access and predictable,
    // so re-serving it is correct and a per-click refresh would be waste.
    expect(getQuoteSnapshot).not.toHaveBeenCalled();
    expect(updateApplicationAsCustomer).not.toHaveBeenCalled();
  });

  it("re-reads and persists the link when publish's read-after-write came back empty", async () => {
    getApplicationForCustomer.mockResolvedValue(
      app({ ...HUBSPOT_IDS, publishedAt: "2026-08-20T00:00:00.000Z", quoteLink: null })
    );
    getQuoteSnapshot.mockResolvedValue({
      quoteId: "q-1", status: "PENDING_APPROVAL", quoteLink: QUOTE_LINK,
      paymentStatus: "PENDING", paymentDate: null,
    });

    expect(location(await get())).toBe(QUOTE_LINK);
    expect(getQuoteSnapshot).toHaveBeenCalledWith("q-1");
    const patch = updateApplicationAsCustomer.mock.calls[0][2];
    expect(patch.hubspotIds.quoteLink).toBe(QUOTE_LINK);
    expect(patch.hubspotIds.paymentStatus).toBe("PENDING");
    expect(patch.hubspotIds.syncedAt).toBeTruthy();
    expect(patch.hubspotIds.lastSyncError).toBeNull();
  });
});

describe("the billing route when HubSpot is unhappy", () => {
  const published = () =>
    getApplicationForCustomer.mockResolvedValue(
      app({ ...HUBSPOT_IDS, publishedAt: "2026-08-20T00:00:00.000Z", quoteLink: null })
    );

  it("shows a neutral error and persists the real one for the rep", async () => {
    published();
    getQuoteSnapshot.mockRejectedValue(new Error("HubSpot quote q-1 read failed (401): expired token"));

    const res = await get();
    // Never a raw HubSpot error in the customer's URL.
    expect(location(res)).toBe(`http://localhost:5001/customer/applications/${ID}?error=billing_link`);
    const patch = updateApplicationAsCustomer.mock.calls[0][2];
    expect(patch.hubspotIds.lastSyncError).toContain("expired token");
    expect(patch.hubspotIds.lastSyncErrorAt).toBeTruthy();
    // The link itself is untouched — nothing was learned about it.
    expect(patch.hubspotIds.quoteLink).toBeNull();
  });

  it("treats a published quote with no link yet as a failure, not a redirect to nowhere", async () => {
    published();
    getQuoteSnapshot.mockResolvedValue({
      quoteId: "q-1", status: "APPROVED", quoteLink: null, paymentStatus: "PENDING", paymentDate: null,
    });

    expect(location(await get())).toBe(
      `http://localhost:5001/customer/applications/${ID}?error=billing_link`
    );
    expect(updateApplicationAsCustomer.mock.calls[0][2].hubspotIds.lastSyncError).toContain("no hs_quote_link");
  });

  it("still redirects the customer when even the error write fails", async () => {
    published();
    getQuoteSnapshot.mockRejectedValue(new Error("boom"));
    updateApplicationAsCustomer.mockRejectedValue(new Error("db down"));

    expect(location(await get())).toBe(
      `http://localhost:5001/customer/applications/${ID}?error=billing_link`
    );
  });
});
