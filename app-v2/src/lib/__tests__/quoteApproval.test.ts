import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MerchantApplication, QuoteRates } from "@/types/merchant";

// approveQuoteAction / getQuoteApprovalAction — the admin half of draft quotes
// + admin override approval (2026-11-02). Under test: admin only, only a
// quote waiting on approval, refused when the quote no longer matches what was
// asked about, the status it lands on (live again with a sent link, approved
// without), and the owning rep's email.

const getEffectiveRole = vi.fn();
const getApplication = vi.fn();
const saveApplication = vi.fn();
const sendQuoteApprovedEmail = vi.fn();
const getStaffRecipient = vi.fn();
const getRateMatrix = vi.fn();

vi.mock("@/lib/auth/getEffectiveRole", () => ({ getEffectiveRole }));
vi.mock("@/lib/storage/postgresAdapter", () => ({ postgresStorage: { getApplication, saveApplication } }));
vi.mock("@/lib/adapters/email", () => ({ sendQuoteApprovedEmail }));
vi.mock("@/lib/staff", () => ({ getStaffRecipient, listActiveAdminRecipients: vi.fn() }));
vi.mock("@/lib/actions/rateMatrix", () => ({ getRateMatrix }));
vi.mock("@/lib/marginReqsLoader", () => ({
  loadMarginReqs: vi.fn(async () => (await import("@/lib/pricing")).MARGIN_REQS),
}));
vi.mock("@/lib/actions/pricing", () => ({
  getMaxDiscountPercent: vi.fn().mockResolvedValue(50),
  getQuoteLimits: vi.fn().mockResolvedValue({ unitCaps: {}, discountCaps: {}, maxBillingDelayDays: 90 }),
  getPricingPreviewAction: vi.fn(),
}));

const { approveQuoteAction, getQuoteApprovalAction } = await import("@/lib/actions/quoteApproval");
const { evaluateQuoteOverrides, quoteFingerprint } = await import("@/lib/quoteEvaluation");

const RATE_CARD = {
  cardPresentBps: Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => 249)),
  cardNotPresentBps: 249,
  perTransactionFeeCents: 15,
};
// 2.99% card-not-present against a 2.49% policy: one cnp_rate override. No
// volume basis, so nothing card-present is judged.
const RATES: QuoteRates = {
  cardPresentRate: 0.0249, cardNotPresentRate: 0.0299, amexCardPresentRate: 0.0249,
  amexCardNotPresentRate: 0.0299, perTransactionFee: 0.15,
};

const base = (over: Partial<MerchantApplication> = {}): MerchantApplication =>
  ({
    id: "app-1",
    ownerUserId: "rep-1",
    quoteType: "all_in_one",
    quoteLines: null,
    quoteRates: RATES,
    quoteConfig: null,
    analysis: null,
    pricingModel: "2-tier",
    customerLinkToken: null,
    business: { legalName: "Torta Palace LLC", dba: "Torta Palace" },
    ...over,
  }) as MerchantApplication;

/** A rep's request, fingerprinted the way the save path fingerprints it. */
async function pending(over: Partial<MerchantApplication> = {}): Promise<MerchantApplication> {
  const row = base(over);
  const overrides = await evaluateQuoteOverrides(row);
  return {
    ...row,
    quoteStatus: "pending_approval",
    quoteApproval: {
      overrides, fingerprint: quoteFingerprint(row, overrides),
      requestedAt: "2026-11-01T00:00:00.000Z", requestedByUserId: "rep-1",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getEffectiveRole.mockResolvedValue({ userId: "admin-1", role: "admin", name: "Ada Admin" });
  getRateMatrix.mockResolvedValue(RATE_CARD);
  saveApplication.mockResolvedValue(undefined);
  sendQuoteApprovedEmail.mockResolvedValue({ sent: true, devUrl: null });
  getStaffRecipient.mockImplementation(async (id: string) => ({ id, email: `${id}@aioapp.com`, name: `Name ${id}` }));
});

describe("approveQuoteAction", () => {
  it("judges the fixture as one card-not-present override", async () => {
    const row = await pending();
    expect(row.quoteApproval!.overrides).toEqual([expect.objectContaining({ kind: "cnp_rate", value: 299, limit: 249 })]);
  });

  it("approves a never-sent draft as approved and emails the rep to send it", async () => {
    getApplication.mockResolvedValue(await pending());
    const result = await approveQuoteAction("app-1");

    expect(result).toMatchObject({ id: "app-1", quoteStatus: "approved", repNotified: true });
    const saved = saveApplication.mock.calls[0][1] as MerchantApplication;
    expect(saved.quoteStatus).toBe("approved");
    expect(saved.quoteApproval).toMatchObject({ requestedByUserId: "rep-1", approvedByUserId: "admin-1" });
    expect(saved.quoteApproval?.approvedAt).toEqual(expect.any(String));
    expect(sendQuoteApprovedEmail).toHaveBeenCalledWith({
      to: "rep-1@aioapp.com",
      merchantName: "Torta Palace",
      approverName: "Name admin-1",
      url: "http://localhost:3000/rep?account=app-1",
      linkLive: false,
    });
  });

  it("puts a quote whose link is already out back live (null), and says so", async () => {
    getApplication.mockResolvedValue(await pending({ customerLinkToken: "tok-live" }));
    const result = await approveQuoteAction("app-1");
    expect(result.quoteStatus).toBeNull();
    expect((saveApplication.mock.calls[0][1] as MerchantApplication).quoteStatus).toBeNull();
    expect(sendQuoteApprovedEmail.mock.calls[0][0].linkLive).toBe(true);
  });

  it("refuses when the quote changed since the request (stale fingerprint), saving nothing", async () => {
    const row = await pending();
    getApplication.mockResolvedValue({ ...row, quoteRates: { ...RATES, cardNotPresentRate: 0.0319 } });
    await expect(approveQuoteAction("app-1")).rejects.toThrow(/changed since approval was requested/);
    expect(saveApplication).not.toHaveBeenCalled();
    expect(sendQuoteApprovedEmail).not.toHaveBeenCalled();
  });

  it("refuses a non-admin", async () => {
    getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep", name: "Rita" });
    getApplication.mockResolvedValue(await pending());
    await expect(approveQuoteAction("app-1")).rejects.toThrow("Admin only");
    expect(saveApplication).not.toHaveBeenCalled();
  });

  it("refuses a quote that isn't waiting on approval", async () => {
    getApplication.mockResolvedValue({ ...(await pending()), quoteStatus: "draft" });
    await expect(approveQuoteAction("app-1")).rejects.toThrow(/isn't waiting on an approval/);
    expect(saveApplication).not.toHaveBeenCalled();
  });

  it("still approves when the rep's email fails — it is best-effort", async () => {
    sendQuoteApprovedEmail.mockRejectedValue(new Error("Graph down"));
    getApplication.mockResolvedValue(await pending());
    await expect(approveQuoteAction("app-1")).resolves.toMatchObject({ quoteStatus: "approved", repNotified: false });
    expect(saveApplication).toHaveBeenCalledTimes(1);
  });
});

describe("getQuoteApprovalAction", () => {
  it("returns what was asked for, by whom, and who approved it", async () => {
    const row = await pending();
    getApplication.mockResolvedValue({
      ...row, quoteStatus: "approved",
      quoteApproval: { ...row.quoteApproval!, approvedAt: "2026-11-02T00:00:00.000Z", approvedByUserId: "admin-1" },
    });
    expect(await getQuoteApprovalAction("app-1")).toEqual({
      quoteStatus: "approved",
      overrides: row.quoteApproval!.overrides,
      requestedAt: "2026-11-01T00:00:00.000Z",
      requestedByName: "Name rep-1",
      approvedAt: "2026-11-02T00:00:00.000Z",
      approvedByName: "Name admin-1",
    });
  });

  it("is empty for a quote with no approval, and refuses a row the caller can't see", async () => {
    getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep", name: "Rita" });
    getApplication.mockResolvedValue(base({ quoteStatus: null, quoteApproval: null }));
    expect(await getQuoteApprovalAction("app-1")).toMatchObject({ overrides: [], requestedByName: null, approvedAt: null });
    getApplication.mockResolvedValue(null);
    await expect(getQuoteApprovalAction("app-2")).rejects.toThrow(/not found/);
  });
});
