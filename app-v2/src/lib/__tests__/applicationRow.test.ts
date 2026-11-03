import { describe, it, expect } from "vitest";
import { rowToApp, appToRow, type ApplicationRow } from "@/lib/storage/applicationRow";
import type { MerchantApplication } from "@/types/merchant";

// rowToApp/appToRow are kept together in one file specifically so a new
// column can't be added to one direction and forgotten in the other (see the
// file's own header comment). dealLink is the column this suite exists to
// pin down: a nullable jsonb round trip is easy to get one direction right
// and the other silently wrong (e.g. reading the column but never writing it
// back on save).

const APP: MerchantApplication = {
  id: "app-1",
  ownerUserId: "rep-1",
  customerUserId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  stage: "quote_sent",
  hubspotDealId: "deal-1",
  dealLink: {
    origin: "adopted",
    dealName: "Torta Palace LLC / Deal - 1",
    pipelineStageAtLink: "2717103849",
    linkedAt: "2026-09-01T00:00:00.000Z",
    linkedByUserId: "rep-1",
  },
  tenantLink: null,
  adyenIds: null,
  adyenOnboardingUrl: null,
  aioTenant: null,
  checkIds: null,
  foodbuyIds: null,
  hubspotIds: null,
  quoteType: "full_pos",
  quoteConfig: null,
  quoteLines: null,
  orderPoints: null,
  quoteAcceptedAt: null,
  detailsConfirmedAt: null,
  quoteNote: null,
  quoteRates: null,
  targetMargin: null,
  pricingModel: null,
  customerLinkToken: null,
  customerLinkPurpose: null,
  customerLinkSentAt: null,
  customerLinkExpiresAt: null,
  analysis: null,
  proposal: null,
  business: null,
  ownerContact: null,
  processing: null,
  agreement: null,
};

describe("applicationRow — dealLink round trip", () => {
  it("appToRow → rowToApp preserves dealLink exactly", () => {
    const row = {
      ...appToRow(APP),
      createdAt: new Date(APP.createdAt),
    } as unknown as ApplicationRow;

    const roundTripped = rowToApp(row);

    expect(roundTripped.dealLink).toEqual(APP.dealLink);
  });

  it("rowToApp reads a null dealLink (every pre-existing row) as null, not undefined", () => {
    const row = {
      ...appToRow({ ...APP, dealLink: null }),
      createdAt: new Date(APP.createdAt),
    } as unknown as ApplicationRow;

    const app = rowToApp(row);

    expect(app.dealLink).toBeNull();
  });
});

describe("applicationRow — quote draft columns round trip", () => {
  const toRow = (a: MerchantApplication) =>
    ({ ...appToRow(a), createdAt: new Date(APP.createdAt) }) as unknown as ApplicationRow;

  it("preserves quoteStatus, quoteApproval and pendingDealChoice", () => {
    const app: MerchantApplication = {
      ...APP,
      quoteStatus: "pending_approval",
      quoteApproval: {
        overrides: [{ kind: "cp_rate", message: "m", value: 150, limit: 200 }],
        fingerprint: "abc",
        requestedAt: "2026-11-02T00:00:00.000Z",
        requestedByUserId: "rep-1",
      },
      pendingDealChoice: { mode: "existing", dealId: "d1" },
    };
    const out = rowToApp(toRow(app));
    expect(out.quoteStatus).toBe("pending_approval");
    expect(out.quoteApproval).toEqual(app.quoteApproval);
    expect(out.pendingDealChoice).toEqual(app.pendingDealChoice);
  });

  it("null and undefined round-trip as null", () => {
    for (const a of [APP, { ...APP, quoteStatus: null, quoteApproval: null, pendingDealChoice: null }]) {
      const out = rowToApp(toRow(a));
      expect(out.quoteStatus).toBeNull();
      expect(out.quoteApproval).toBeNull();
      expect(out.pendingDealChoice).toBeNull();
    }
  });
});
