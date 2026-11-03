import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MerchantApplication, QuoteApproval } from "@/types/merchant";

// saveApplicationAction — the blind full-row upsert the proposal wizard still
// calls with whatever app object its tab is holding. Under test: it never
// takes the quote approval state (quoteStatus / quoteApproval /
// pendingDealChoice) from the client (2026-11-02), so a stale tab can't
// un-lock a quote waiting on an admin or re-lock one an admin just approved.

const getEffectiveRole = vi.fn();
const getApplication = vi.fn();
const saveApplication = vi.fn();

vi.mock("@/lib/auth/getEffectiveRole", () => ({ getEffectiveRole }));
vi.mock("@/lib/storage/postgresAdapter", () => ({ postgresStorage: { getApplication, saveApplication } }));
vi.mock("@/lib/adapters/email", () => ({ sendMagicLinkEmail: vi.fn() }));
vi.mock("@/lib/db/schema", () => ({ customerLoginTokens: {}, users: {} }));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/hubspotDeal", () => ({ resolveDealForCompany: vi.fn() }));
vi.mock("@/lib/adapters/hubspot", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/adapters/hubspot")>()),
}));
vi.mock("@/lib/billing/publishBillingQuote", () => ({ buildAndPublishBillingQuote: vi.fn() }));

const { saveApplicationAction } = await import("@/lib/actions/applications");

const APPROVAL: QuoteApproval = {
  overrides: [{ kind: "cnp_rate", message: "Card-not-present rate 2.99% differs from the 2.49% policy rate", value: 299, limit: 249 }],
  fingerprint: "fp-1",
  requestedAt: "2026-11-01T00:00:00.000Z",
  requestedByUserId: "rep-1",
};
const DEAL_CHOICE = { mode: "create" as const, dealName: "Torta Palace" };

const app = (over: Partial<MerchantApplication> = {}): MerchantApplication =>
  ({ id: "app-1", ownerUserId: "rep-1", stage: "analysis", quoteNote: "tab copy", ...over }) as MerchantApplication;

beforeEach(() => {
  vi.clearAllMocks();
  getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep" });
  saveApplication.mockResolvedValue(undefined);
});

describe("saveApplicationAction — quote approval state is never the client's", () => {
  it("keeps a pending_approval row pending when the client sends quoteStatus: null, with its approval and deal choice", async () => {
    getApplication.mockResolvedValue(app({
      quoteStatus: "pending_approval", quoteApproval: APPROVAL, pendingDealChoice: DEAL_CHOICE,
    }));

    const result = await saveApplicationAction(app({ quoteStatus: null, quoteApproval: null, pendingDealChoice: null }));

    expect(getApplication).toHaveBeenCalledWith({ userId: "rep-1", role: "rep" }, "app-1");
    const [, saved] = saveApplication.mock.calls[0] as [unknown, MerchantApplication];
    expect(saved.quoteStatus).toBe("pending_approval");
    expect(saved.quoteApproval).toEqual(APPROVAL);
    expect(saved.pendingDealChoice).toEqual(DEAL_CHOICE);
    // Everything else is still the client's, as before.
    expect(saved.quoteNote).toBe("tab copy");
    expect(result).toEqual(saved);
  });

  it("doesn't let a stale tab re-lock a quote an admin just approved", async () => {
    getApplication.mockResolvedValue(app({ quoteStatus: null, quoteApproval: { ...APPROVAL, approvedAt: "t", approvedByUserId: "admin-1" } }));

    await saveApplicationAction(app({ quoteStatus: "pending_approval", quoteApproval: APPROVAL }));

    const [, saved] = saveApplication.mock.calls[0] as [unknown, MerchantApplication];
    expect(saved.quoteStatus).toBeNull();
    expect(saved.quoteApproval?.approvedByUserId).toBe("admin-1");
  });

  it("starts all three null on a brand-new row, whatever the client sent", async () => {
    getApplication.mockResolvedValue(null);

    await saveApplicationAction(app({
      ownerUserId: "", quoteStatus: "approved", quoteApproval: { ...APPROVAL, approvedAt: "t" }, pendingDealChoice: DEAL_CHOICE,
    }));

    const [, saved] = saveApplication.mock.calls[0] as [unknown, MerchantApplication];
    expect(saved).toMatchObject({ ownerUserId: "rep-1", quoteStatus: null, quoteApproval: null, pendingDealChoice: null });
  });
});
