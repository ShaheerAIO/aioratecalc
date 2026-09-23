import { describe, it, expect } from "vitest";
import { rowToApp, appToRow, type ApplicationRow } from "@/lib/storage/applicationRow";
import type { MerchantApplication } from "@/types/merchant";

// rowToApp/appToRow are kept together in one file specifically so a new
// column can't be added to one direction and forgotten in the other (see the
// file's own header comment). dealLink/demo are the two new columns this
// suite exists to pin down: a nullable jsonb round trip is easy to get one
// direction right and the other silently wrong (e.g. reading the column but
// never writing it back on save).

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
  demo: {
    bookedAt: null,
    heldAt: "2026-09-10T00:00:00.000Z",
    source: "manual",
    meetingId: null,
    meetingTitle: null,
    outcome: null,
    markedByUserId: "rep-1",
    checkedAt: "2026-09-10T00:00:00.000Z",
    lastSyncError: null,
    lastSyncErrorAt: null,
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

describe("applicationRow — dealLink/demo round trip", () => {
  it("appToRow → rowToApp preserves dealLink and demo exactly", () => {
    const row = {
      ...appToRow(APP),
      createdAt: new Date(APP.createdAt),
    } as unknown as ApplicationRow;

    const roundTripped = rowToApp(row);

    expect(roundTripped.dealLink).toEqual(APP.dealLink);
    expect(roundTripped.demo).toEqual(APP.demo);
  });

  it("rowToApp reads a null dealLink/demo (every pre-existing row) as null, not undefined", () => {
    const row = {
      ...appToRow({ ...APP, dealLink: null, demo: null }),
      createdAt: new Date(APP.createdAt),
    } as unknown as ApplicationRow;

    const app = rowToApp(row);

    expect(app.dealLink).toBeNull();
    expect(app.demo).toBeNull();
  });
});
