import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HubspotIds } from "@/types/merchant";

// /api/lead/[token]/checkout — the merchant's own door to billing, and the
// one-way door with it.
//
// Two things are worth pinning here, because getting either wrong is expensive
// and invisible:
//
//  1. NOTHING FROM canPublishBillingQuote REACHES THE MERCHANT. Those messages
//     name AIO's internals ("link the tenant company", "grant
//     crm.objects.owners.read") and are addressed to a rep. The route answers
//     with a neutral code and persists the real reason on the account.
//  2. A PUBLISHED QUOTE IS NEVER PUBLISHED TWICE. The idempotent early return
//     must fire before the orchestrator is even reached.

const getLeadApplicationByToken = vi.fn();
const ensureDealForPublish = vi.fn();
const buildAndPublishBillingQuote = vi.fn();
const update = vi.fn();

vi.mock("@/lib/leadToken", () => ({ getLeadApplicationByToken }));
vi.mock("@/lib/billing/ensureDeal", () => ({ ensureDealForPublish }));
vi.mock("@/lib/billing/publishBillingQuote", () => ({ buildAndPublishBillingQuote }));
vi.mock("@/lib/db/schema", () => ({ merchantApplications: { id: "id" } }));
vi.mock("@/lib/db/client", () => ({
  db: { update: () => ({ set: (v: unknown) => ({ where: async () => update(v) }) }) },
}));

const { POST } = await import("@/app/api/lead/[token]/checkout/route");

const TOKEN = "tok-1";
const QUOTE_LINK = "https://customers.aioapp.com/abcdef123";

// rowToApp is NOT mocked — the route's job includes reading the row correctly,
// so the fixture is a real row shape and the real mapper runs over it.
const row = (over: Record<string, unknown> = {}) => ({
  id: "app-1",
  ownerUserId: "rep-1",
  customerUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  stage: "proposal_ready",
  hubspotDealId: "deal-1",
  dealLink: null,
  tenantLink: { hubspotCompanyId: "co-1" },
  adyenIds: null,
  adyenOnboardingUrl: null,
  aioTenant: null,
  checkIds: null,
  foodbuyIds: null,
  hubspotIds: null,
  quoteType: "full_pos",
  quoteConfig: { avgTicket: 30, monthlyVolume: 100000 },
  quoteLines: [{ name: "AIO Platform", hubspotProductId: "p-1", quantity: 1, unitPrice: 99, billingFrequency: "weekly" }],
  orderPoints: null,
  quoteAcceptedAt: null,
  targetMargin: 0.008,
  pricingModel: "2-tier",
  customerLinkToken: TOKEN,
  customerLinkPurpose: "lead_upload",
  customerLinkSentAt: new Date(),
  customerLinkExpiresAt: null,
  analysis: null,
  proposal: null,
  business: null,
  ownerContact: { email: "owner@merchant.com" },
  processing: null,
  agreement: null,
  ...over,
});

const published: HubspotIds = {
  quoteId: "q-1", quoteTemplateId: null, lineItemIds: null, contactId: null,
  quoteLink: QUOTE_LINK, publishedAt: "2026-09-25T10:00:00.000Z",
  paymentStatus: "PENDING", paymentDate: null, esignStatus: "PENDING_SIGNATURE",
  subscriptions: null, subscriptionStatus: null, syncedAt: null,
  lastSyncError: null, lastSyncErrorAt: null,
};

const post = () => POST({} as never, { params: Promise.resolve({ token: TOKEN }) });

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getLeadApplicationByToken.mockReset();
  ensureDealForPublish.mockReset();
  buildAndPublishBillingQuote.mockReset();
  update.mockReset();
  ensureDealForPublish.mockImplementation(async (app: unknown) => ({ ok: true, app, created: false }));
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => errorSpy.mockRestore());

describe("the merchant's checkout door", () => {
  it("publishes on demand and hands back the hosted quote URL", async () => {
    getLeadApplicationByToken.mockResolvedValue({ ok: true, row: row() });
    buildAndPublishBillingQuote.mockResolvedValue({
      status: "published", quoteId: "q-1", quoteLink: QUOTE_LINK, alreadyPublished: false,
    });

    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: QUOTE_LINK });
    expect(buildAndPublishBillingQuote).toHaveBeenCalledTimes(1);
  });

  it("re-serves an already-published link WITHOUT attempting a second publish", async () => {
    getLeadApplicationByToken.mockResolvedValue({ ok: true, row: row({ hubspotIds: published }) });

    const res = await post();
    expect(await res.json()).toEqual({ url: QUOTE_LINK });
    expect(buildAndPublishBillingQuote).not.toHaveBeenCalled();
    expect(ensureDealForPublish).not.toHaveBeenCalled();
  });

  it("asks the merchant to look again when the link hasn't populated yet", async () => {
    getLeadApplicationByToken.mockResolvedValue({ ok: true, row: row() });
    buildAndPublishBillingQuote.mockResolvedValue({
      status: "published", quoteId: "q-1", quoteLink: null, alreadyPublished: false,
    });

    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "link_pending" });
  });

  it("refuses a rate-only quote — that merchant accepts on the page itself", async () => {
    getLeadApplicationByToken.mockResolvedValue({ ok: true, row: row({ quoteLines: [] }) });

    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "rate_only" });
    expect(buildAndPublishBillingQuote).not.toHaveBeenCalled();
  });

  it("never leaks a precondition message to the merchant, and persists it for the rep", async () => {
    getLeadApplicationByToken.mockResolvedValue({ ok: true, row: row() });
    buildAndPublishBillingQuote.mockResolvedValue({
      status: "refused",
      reasons: [{
        code: "sender_unverified",
        message: 'grant "crm.objects.owners.read" to the EasyOB Billing private app',
      }],
    });

    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_ready" });

    // The reason went to the account, not to the customer.
    expect(update).toHaveBeenCalledTimes(1);
    const written = update.mock.calls[0][0] as { hubspotIds: HubspotIds };
    expect(written.hubspotIds.lastSyncError).toContain("crm.objects.owners.read");
    expect(written.hubspotIds.lastSyncErrorAt).toBeTruthy();
  });

  it("records a blocked deal creation too, and still says only not_ready", async () => {
    getLeadApplicationByToken.mockResolvedValue({ ok: true, row: row({ hubspotDealId: null }) });
    ensureDealForPublish.mockResolvedValue({
      ok: false,
      reasons: [{ code: "no_tenant_company", message: "Link the tenant company on the account" }],
    });

    const res = await post();
    expect(await res.json()).toEqual({ error: "not_ready" });
    const written = update.mock.calls[0][0] as { hubspotIds: HubspotIds };
    expect(written.hubspotIds.lastSyncError).toContain("Link the tenant company");
  });

  it("distinguishes an expired link from an invalid one", async () => {
    getLeadApplicationByToken.mockResolvedValue({ ok: false, reason: "expired" });
    expect((await post()).status).toBe(410);

    getLeadApplicationByToken.mockResolvedValue({ ok: false, reason: "invalid" });
    expect((await post()).status).toBe(404);
  });

  it("refuses when there is no quote to bill at all", async () => {
    getLeadApplicationByToken.mockResolvedValue({
      ok: true,
      row: row({ quoteLines: null, quoteConfig: null, analysis: null }),
    });

    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "no_quote" });
  });
});
