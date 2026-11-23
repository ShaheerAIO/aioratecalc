import { describe, it, expect } from "vitest";
import { accountStatus, STATUS_LADDER, type AccountStatusInput } from "@/lib/accountStatus";
import { EMPTY_HUBSPOT_IDS, type DealStage, type HubspotIds, type MerchantApplication } from "@/types/merchant";

const linked: MerchantApplication["tenantLink"] = {
  hubspotCompanyId: "1", companyName: "T", tenantRef: "t", adyenAccountHolderId: null,
  linkedAt: "2026-08-01T00:00:00Z", linkedByUserId: "u1",
};
const lines: MerchantApplication["quoteLines"] = [{
  hubspotProductId: "p1", name: "AIO", qty: 1, unitPrice: 99, billingFrequency: "weekly", productType: "Software",
}];
const ids = (o: Partial<HubspotIds> = {}): HubspotIds => ({ ...EMPTY_HUBSPOT_IDS, ...o });
const app = (stage: DealStage, o: Partial<AccountStatusInput> = {}): AccountStatusInput => ({
  stage, quoteStatus: null, quoteAcceptedAt: null, aioTenant: null, quoteLines: null, hubspotIds: null, tenantLink: linked, ...o,
});
const st = (a: AccountStatusInput, role: "rep" | "admin" = "rep") => accountStatus(a, role);

describe("accountStatus", () => {
  it("one case per status", () => {
    expect(st(app("pricing", { quoteStatus: "draft" })).status).toBe("draft");
    expect(st(app("prospect_created")).status).toBe("draft");
    expect(st(app("proposal_ready", { quoteStatus: "pending_approval" })).status).toBe("needs_approval");
    expect(st(app("proposal_ready", { quoteStatus: "approved" })).status).toBe("ready_to_send");
    expect(st(app("quote_sent")).status).toBe("sent");
    expect(st(app("lead_link_sent")).status).toBe("sent");
    expect(st(app("proposal_sent", { quoteAcceptedAt: "2026-11-01" })).status).toBe("signed");
    expect(st(app("quote_accepted")).status).toBe("signed");
    expect(st(app("proposal_sent", { hubspotIds: ids({ esignStatus: "SIGNED" }) })).status).toBe("signed");
    expect(st(app("merchant_filling")).status).toBe("onboarding");
    expect(st(app("adyen_approved")).status).toBe("live");
    expect(st(app("closed_lost")).status).toBe("closed_lost");
  });

  it("provisioned aioTenant counts as accepted", () => {
    const tenant = { tenantRef: "t" } as unknown as AccountStatusInput["aioTenant"];
    expect(st(app("quote_sent", { aioTenant: tenant })).status).toBe("signed");
  });

  it("onboarding sub-labels", () => {
    expect(st(app("merchant_filling")).subLabel).toBe("Filling in form");
    expect(st(app("adyen_kyc_pending")).subLabel).toBe("KYC in review");
    expect(st(app("adyen_kyc_complete")).subLabel).toBe("KYC complete");
  });

  it("onboarding beats accepted; precedence of closed_lost and live", () => {
    expect(st(app("merchant_link_sent", { quoteAcceptedAt: "x" })).status).toBe("onboarding");
    expect(st(app("closed_lost", { quoteStatus: "pending_approval", quoteAcceptedAt: "x" })).status).toBe("closed_lost");
    expect(st(app("closed_lost", { quoteStatus: "approved" })).nextAction).toBeNull();
    expect(st(app("adyen_approved", { quoteStatus: "draft" })).status).toBe("live");
  });

  it("pending_approval vs stage", () => {
    expect(st(app("quote_sent", { quoteStatus: "pending_approval" })).status).toBe("needs_approval");
    expect(st(app("merchant_filling", { quoteStatus: "pending_approval" })).status).toBe("onboarding");
  });

  it("flags", () => {
    expect(st(app("proposal_ready", { quoteStatus: "approved", quoteLines: lines, tenantLink: null })).flags)
      .toEqual(["needs_company_link"]);
    expect(st(app("quote_sent", { hubspotIds: ids({ lastSyncError: "boom" }) })).flags).toEqual(["sync_error"]);
    expect(st(app("quote_sent")).flags).toEqual([]);
  });

  it("paid note", () => {
    expect(st(app("quote_accepted")).paid).toBe("unknown");
    const pub = { publishedAt: "2026-11-01" };
    expect(st(app("quote_accepted", { hubspotIds: ids({ ...pub, paymentStatus: "PAID" }) })).paid).toBe(true);
    expect(st(app("quote_accepted", { hubspotIds: ids({ ...pub, paymentStatus: "PENDING" }) })).paid).toBe(false);
  });

  it("next action by role and status", () => {
    expect(st(app("pricing", { quoteStatus: "draft" })).nextAction?.key).toBe("finish_quote");
    const pa = app("proposal_ready", { quoteStatus: "pending_approval" });
    expect(st(pa, "rep").nextAction).toEqual({ key: "waiting_on_admin", label: "Waiting on admin", disabled: true });
    expect(st(pa, "admin").nextAction?.key).toBe("approve");
    expect(st(app("proposal_ready", { quoteStatus: "approved" })).nextAction?.key).toBe("send_quote");
    expect(st(app("proposal_ready", { quoteStatus: "approved", quoteLines: lines, tenantLink: null })).nextAction?.key)
      .toBe("link_company");
    expect(st(app("quote_sent")).nextAction?.key).toBe("resend_quote_link");
    expect(st(app("quote_accepted")).nextAction?.key).toBe("send_onboarding_link");
    expect(st(app("merchant_filling")).nextAction?.key).toBe("resend_onboarding_link");
    expect(st(app("adyen_approved")).nextAction?.key).toBe("view");
  });

  it("filterGroup", () => {
    expect(st(app("pricing", { quoteStatus: "draft" })).filterGroup).toBe("needs_me");
    expect(st(app("proposal_ready", { quoteStatus: "approved" })).filterGroup).toBe("needs_me");
    expect(st(app("proposal_ready", { quoteStatus: "pending_approval" })).filterGroup).toBe("needs_approval");
    expect(st(app("quote_sent")).filterGroup).toBe("sent");
    expect(st(app("quote_accepted")).filterGroup).toBe("sent");
    expect(st(app("merchant_filling")).filterGroup).toBe("onboarding");
    expect(st(app("adyen_approved")).filterGroup).toBe("live");
    expect(st(app("closed_lost")).filterGroup).toBe("closed_lost");
    const nl = app("quote_sent", { quoteLines: lines, tenantLink: null });
    expect(st(nl, "rep").filterGroup).toBe("needs_me");
    expect(st(nl, "admin").filterGroup).toBe("sent");
  });

  it("ladder order", () => {
    expect(STATUS_LADDER).toEqual(["draft", "needs_approval", "ready_to_send", "sent", "signed", "onboarding", "live"]);
  });
});
