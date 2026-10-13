import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MerchantApplication } from "@/types/merchant";

// resendLeadLinkAction — the dashboard send/resend quote-link path. Token
// reuse is covered by customerLink.test.ts; what's under test here is that
// the action is not gated on stage, an existing token, or a contact email,
// and that delivery is best-effort on top of the same persist helper the
// wizard uses.

const getEffectiveRole = vi.fn();
const getApplication = vi.fn();
const saveApplication = vi.fn();
const sendLeadLinkEmail = vi.fn();
const sendLeadLinkSms = vi.fn();
const resolveSender = vi.fn();

vi.mock("@/lib/auth/getEffectiveRole", () => ({ getEffectiveRole }));
vi.mock("@/lib/storage/postgresAdapter", () => ({
  postgresStorage: { getApplication, saveApplication },
}));
vi.mock("@/lib/adapters/email", () => ({ sendLeadLinkEmail }));
vi.mock("@/lib/adapters/sms", () => ({ sendLeadLinkSms }));
vi.mock("@/lib/actions/catalog", () => ({ listQuotableProductsAction: vi.fn() }));
vi.mock("@/lib/adapters/hubspot", () => ({
  listCompanyContacts: vi.fn(),
  getCompanyProfile: vi.fn(),
}));
// prospects.ts now imports getActivePaddingPolicy for the role-scoped floor
// guard (assertMarginAboveFloor) — mocked so the real module (which pulls in
// the server-only db client) is never loaded here. This suite doesn't
// exercise that guard at all (resendLeadLinkAction never calls it).
vi.mock("@/lib/actions/pricing", () => ({
  getActivePaddingPolicy: vi.fn().mockResolvedValue({
    paddingPct: 0.5, paddingMinMrrAdd: 0, paddingAdyenCostHide: true,
  }),
  getMaxDiscountPercent: vi.fn().mockResolvedValue(50),
  getQuoteLimits: vi.fn().mockResolvedValue({ unitCaps: {}, maxBillingDelayDays: 90 }),
}));
// prospects.ts now imports resolveDealForCompany for the Company & Deal
// picker — mocked so the real module (which pulls in the server-only db
// client) is never loaded here. This suite doesn't exercise deal resolution
// at all (resendLeadLinkAction never calls it).
vi.mock("@/lib/hubspotDeal", () => ({ resolveDealForCompany: vi.fn() }));
// prospects.ts now also imports buildAndPublishBillingQuote (10/13, the
// publish-at-send reversal) for createProspectAction's publishAtSend —
// mocked for the same reason as the two above (it pulls in the server-only
// db client). resendLeadLinkAction never calls buildAndPublishBillingQuote
// itself, but it DOES call resolveSender (via resolveReplyToRep, same file)
// to resolve a reply-to rep for the resend email — see "can the email go
// through the sales rep?" in the 10/13 list. Defaulted to a clean refusal so
// every pre-existing test here reads like it did before that feature existed
// (no rep resolved, so no reply-to/display-name on the email); the dedicated
// reply-to tests below override it per case.
vi.mock("@/lib/billing/publishBillingQuote", () => ({ buildAndPublishBillingQuote: vi.fn(), resolveSender }));

const { resendLeadLinkAction } = await import("@/lib/actions/prospects");

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

const app = (over: Partial<MerchantApplication> = {}): MerchantApplication =>
  ({
    id: "app-1",
    ownerUserId: "rep-1",
    customerUserId: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    stage: "quote_sent",
    hubspotDealId: null,
    tenantLink: null,
    adyenIds: null,
    adyenOnboardingUrl: null,
    checkIds: null,
    foodbuyIds: null,
    hubspotIds: null,
    quoteType: "full_pos",
    quoteConfig: { monthlyVolume: 10000, avgTicket: 50 },
    quoteLines: null,
    orderPoints: null,
    quoteAcceptedAt: null,
    targetMargin: 0.008,
    pricingModel: "2-tier",
    customerLinkToken: "tok-live",
    customerLinkPurpose: "lead_upload",
    customerLinkSentAt: "2026-08-01T00:00:00.000Z",
    customerLinkExpiresAt: FUTURE,
    analysis: null,
    proposal: null,
    business: {
      legalName: "Test Co LLC", dba: "Test Co", bizType: "llc", address: "",
      city: "", state: "", zip: "", phone: "", website: "",
      yearsInBusiness: "", annualRevenue: "",
    },
    ownerContact: {
      firstName: "Jane", lastName: "Doe", title: "Owner",
      email: "jane@testco.com", phone: "555-0101",
    },
    processing: null,
    agreement: null,
    ...over,
  }) as MerchantApplication;

beforeEach(() => {
  vi.clearAllMocks();
  getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep" });
  getApplication.mockResolvedValue(app());
  saveApplication.mockResolvedValue(undefined);
  sendLeadLinkEmail.mockResolvedValue({ sent: true, devUrl: null });
  sendLeadLinkSms.mockResolvedValue({ sent: true, devUrl: null });
  resolveSender.mockResolvedValue({ ok: false, code: "no_rep_email" });
});

describe("resendLeadLinkAction", () => {
  it("reuses a live token, emails and texts it, and never mints a second URL", async () => {
    const result = await resendLeadLinkAction("app-1");

    expect(result.linkUrl).toContain("/lead/tok-live");
    expect(result.emailResult).toEqual({ sent: true, devUrl: null });
    expect(result.smsResult).toEqual({ sent: true, devUrl: null });
    expect(sendLeadLinkEmail).toHaveBeenCalledWith(
      "jane@testco.com",
      expect.stringContaining("/lead/tok-live"),
      "Test Co",
    );
    expect(sendLeadLinkSms).toHaveBeenCalledWith("555-0101", expect.stringContaining("/lead/tok-live"));
    expect(saveApplication).toHaveBeenCalledWith(
      { userId: "rep-1", role: "rep" },
      expect.objectContaining({ customerLinkToken: "tok-live", customerLinkPurpose: "lead_upload" }),
    );
  });

  it("mints a fresh token when the existing one has expired", async () => {
    getApplication.mockResolvedValue(app({ customerLinkExpiresAt: PAST }));

    const result = await resendLeadLinkAction("app-1");

    expect(result.linkUrl).not.toContain("tok-live");
    expect(result.app.customerLinkToken).not.toBe("tok-live");
    expect(sendLeadLinkEmail).toHaveBeenCalledWith(
      "jane@testco.com",
      result.linkUrl,
      "Test Co",
    );
  });

  it("skips SMS when no phone is on file, without treating that as a failure", async () => {
    getApplication.mockResolvedValue(app({
      ownerContact: { firstName: "Jane", lastName: "Doe", title: "Owner", email: "jane@testco.com", phone: "" },
    }));

    const result = await resendLeadLinkAction("app-1");

    expect(result.smsResult).toBeNull();
    expect(sendLeadLinkSms).not.toHaveBeenCalled();
    expect(result.emailResult.sent).toBe(true);
  });

  it("still returns the URL when email delivery throws — the row is already saved", async () => {
    sendLeadLinkEmail.mockRejectedValue(new Error("Resend 429"));

    const result = await resendLeadLinkAction("app-1");

    expect(result.emailResult).toEqual({ sent: false, devUrl: expect.stringContaining("/lead/tok-live") });
    expect(result.linkUrl).toContain("/lead/tok-live");
  });

  it("lets an admin resend another rep's account", async () => {
    getEffectiveRole.mockResolvedValue({ userId: "admin-1", role: "admin" });
    getApplication.mockResolvedValue(app({ ownerUserId: "rep-1" }));

    await resendLeadLinkAction("app-1");

    expect(getApplication).toHaveBeenCalledWith({ userId: "admin-1", role: "admin" }, "app-1");
    expect(sendLeadLinkEmail).toHaveBeenCalled();
  });

  it("throws when the scoped read returns nothing (other-rep, or missing)", async () => {
    getApplication.mockResolvedValue(null);
    await expect(resendLeadLinkAction("app-1")).rejects.toThrow("Application not found");
    expect(sendLeadLinkEmail).not.toHaveBeenCalled();
  });

  it("mints a token on an account that never had one", async () => {
    getApplication.mockResolvedValue(app({
      customerLinkToken: null,
      customerLinkPurpose: null,
      stage: "analysis",
    }));

    const result = await resendLeadLinkAction("app-1");

    expect(result.app.customerLinkToken).toBeTruthy();
    expect(result.app.customerLinkPurpose).toBe("lead_upload");
    expect(result.app.stage).toBe("quote_sent");
    expect(result.linkUrl).toContain("/lead/");
    expect(sendLeadLinkEmail).toHaveBeenCalled();
  });

  it("still issues a link on a closed-lost account, without changing its stage", async () => {
    getApplication.mockResolvedValue(app({ stage: "closed_lost" }));

    const result = await resendLeadLinkAction("app-1");

    expect(result.app.stage).toBe("closed_lost");
    expect(result.linkUrl).toContain("/lead/tok-live");
    expect(sendLeadLinkEmail).toHaveBeenCalled();
  });

  it("returns the URL without emailing when no contact email is on file", async () => {
    getApplication.mockResolvedValue(app({
      ownerContact: { firstName: "Jane", lastName: "Doe", title: "Owner", email: "", phone: "555-0101" },
    }));

    const result = await resendLeadLinkAction("app-1");

    expect(result.linkUrl).toContain("/lead/tok-live");
    expect(result.emailResult.sent).toBe(false);
    expect(sendLeadLinkEmail).not.toHaveBeenCalled();
    expect(sendLeadLinkSms).not.toHaveBeenCalled();
    expect(saveApplication).toHaveBeenCalled();
  });

  it("throws when nobody is signed in", async () => {
    getEffectiveRole.mockResolvedValue(null);
    await expect(resendLeadLinkAction("app-1")).rejects.toThrow("Not authenticated");
  });
});

// "can the email go through the sales rep?" (2026-10-13) — resendLeadLinkAction
// resolves a reply-to rep the same way createProspectAction does, via the
// shared resolveReplyToRep/resolveSender. Covered here rather than only in
// createProspect.test.ts because resendLeadLinkAction is a SEPARATE call site
// that shares deliverLeadLink, and a wiring mistake in one without the other
// is exactly the kind of drift CLAUDE.md warns about.
describe("resendLeadLinkAction — reply-to rep", () => {
  it("passes the verified rep as reply-to when resolveSender succeeds", async () => {
    resolveSender.mockResolvedValue({ ok: true, email: "rita@aioapp.com", firstName: "Rita", lastName: "Rep", ownerId: "161" });

    await resendLeadLinkAction("app-1");

    expect(resolveSender).toHaveBeenCalledWith("rep-1");
    expect(sendLeadLinkEmail).toHaveBeenCalledWith(
      "jane@testco.com", expect.stringContaining("/lead/tok-live"), "Test Co",
      undefined, { email: "rita@aioapp.com", name: "Rita Rep" },
    );
  });

  it("omits the rep entirely (same 3-arg call as before) when resolveSender refuses", async () => {
    resolveSender.mockResolvedValue({ ok: false, code: "not_a_portal_owner", repEmail: "rep@aioapp.com" });

    await resendLeadLinkAction("app-1");

    expect(sendLeadLinkEmail).toHaveBeenCalledWith(
      "jane@testco.com", expect.stringContaining("/lead/tok-live"), "Test Co",
    );
  });

  it("omits the rep when resolveSender itself throws — never blocks the resend", async () => {
    resolveSender.mockRejectedValue(new Error("HubSpot owner lookup 403"));

    const result = await resendLeadLinkAction("app-1");

    expect(result.emailResult.sent).toBe(true);
    expect(sendLeadLinkEmail).toHaveBeenCalledWith(
      "jane@testco.com", expect.stringContaining("/lead/tok-live"), "Test Co",
    );
  });
});
