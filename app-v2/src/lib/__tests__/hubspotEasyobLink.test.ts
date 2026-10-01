import { describe, it, expect } from "vitest";
import {
  buildEasyobDealLink,
  dealLinkCompanyId,
  planEasyobDealLinkUpdates,
  planCompanyLinkClears,
  isPublicBaseUrl,
  countBatchUpdateOutcome,
  type EasyobLinkDeal,
} from "@/lib/adapters/hubspot";

const BASE = "https://easyob.example.com";

describe("buildEasyobDealLink", () => {
  it("opens the prospect form for the company, in that deal", () => {
    expect(buildEasyobDealLink("123", "456", BASE)).toBe(
      "https://easyob.example.com/rep/prospects/new?hubspotCompanyId=123&hubspotDealId=456"
    );
  });
});

describe("dealLinkCompanyId", () => {
  it("prefers the primary company association", () => {
    expect(dealLinkCompanyId([
      { id: "1", type: "deal_to_company_unlabeled" },
      { id: "2", type: "deal_to_company" },
      { id: "2", type: "deal_to_company_unlabeled" },
    ])).toBe("2");
  });

  it("falls back to the first company when none is primary", () => {
    expect(dealLinkCompanyId([{ id: 7, type: "deal_to_company_unlabeled" }])).toBe("7");
  });

  it("is null for a deal on no company", () => {
    expect(dealLinkCompanyId(undefined)).toBeNull();
    expect(dealLinkCompanyId([])).toBeNull();
  });
});

describe("planEasyobDealLinkUpdates", () => {
  it("plans a link for a deal with none", () => {
    const deals: EasyobLinkDeal[] = [{ id: "10", companyId: "1", easyobLink: null }];
    expect(planEasyobDealLinkUpdates(deals, BASE)).toEqual([
      { id: "10", properties: { easyob_link: buildEasyobDealLink("1", "10", BASE) } },
    ]);
  });

  it("rewrites a stale base URL or company", () => {
    const deals: EasyobLinkDeal[] = [
      { id: "11", companyId: "1", easyobLink: "https://old.example.com/rep/prospects/new?hubspotCompanyId=1&hubspotDealId=11" },
      { id: "12", companyId: "2", easyobLink: buildEasyobDealLink("999", "12", BASE) },
    ];
    expect(planEasyobDealLinkUpdates(deals, BASE)).toEqual([
      { id: "11", properties: { easyob_link: buildEasyobDealLink("1", "11", BASE) } },
      { id: "12", properties: { easyob_link: buildEasyobDealLink("2", "12", BASE) } },
    ]);
  });

  it("skips a deal whose link already matches", () => {
    const deals: EasyobLinkDeal[] = [{ id: "13", companyId: "3", easyobLink: buildEasyobDealLink("3", "13", BASE) }];
    expect(planEasyobDealLinkUpdates(deals, BASE)).toEqual([]);
  });

  it("empties the link on a deal that has lost its company, and leaves an unlinked one alone", () => {
    const deals: EasyobLinkDeal[] = [
      { id: "14", companyId: null, easyobLink: buildEasyobDealLink("4", "14", BASE) },
      { id: "15", companyId: null, easyobLink: null },
    ];
    expect(planEasyobDealLinkUpdates(deals, BASE)).toEqual([
      { id: "14", properties: { easyob_link: "" } },
    ]);
  });
});

describe("planCompanyLinkClears", () => {
  it("clears only companies still carrying the old link", () => {
    expect(planCompanyLinkClears([
      { id: "1", properties: { easyob_link: `${BASE}/rep/prospects/new?hubspotCompanyId=1` } },
      { id: "2", properties: { easyob_link: "" } },
      { id: "3", properties: { easyob_link: null } },
      { id: "4", properties: {} },
    ])).toEqual([{ id: "1", properties: { easyob_link: "" } }]);
  });
});

describe("isPublicBaseUrl", () => {
  it("rejects localhost", () => {
    expect(isPublicBaseUrl("http://localhost:5001")).toBe(false);
  });

  it("rejects 127.0.0.1", () => {
    expect(isPublicBaseUrl("http://127.0.0.1:3000")).toBe(false);
  });

  it("rejects a bare hostname with no dot", () => {
    expect(isPublicBaseUrl("http://easyob")).toBe(false);
  });

  it("rejects an empty/unset value", () => {
    expect(isPublicBaseUrl("")).toBe(false);
    expect(isPublicBaseUrl(undefined)).toBe(false);
  });

  it("rejects an unparseable value", () => {
    expect(isPublicBaseUrl("not-a-url")).toBe(false);
  });

  it("accepts a valid public https URL", () => {
    expect(isPublicBaseUrl("https://easyob.example.com")).toBe(true);
  });
});

describe("countBatchUpdateOutcome", () => {
  it("counts a full-success (200) response from results alone", () => {
    const body = { status: "COMPLETE", results: [{ id: "1" }, { id: "2" }] };
    expect(countBatchUpdateOutcome(body, 2)).toEqual({ updated: 2, failed: 0 });
  });

  it("counts a 207 MULTI_STATUS partial failure using numErrors", () => {
    const body = {
      status: "COMPLETE",
      results: [{ id: "1" }],
      numErrors: 1,
      errors: [{ status: "error", category: "OBJECT_NOT_FOUND", context: { ids: ["2"] } }],
    };
    expect(countBatchUpdateOutcome(body, 2)).toEqual({ updated: 1, failed: 1 });
  });

  it("falls back to requestedCount - updated when numErrors is absent", () => {
    const body = { results: [{ id: "1" }] };
    expect(countBatchUpdateOutcome(body, 3)).toEqual({ updated: 1, failed: 2 });
  });

  it("treats a body with no results and no error info as a total failure", () => {
    expect(countBatchUpdateOutcome({}, 5)).toEqual({ updated: 0, failed: 5 });
  });

  it("never reports negative failures when results exceeds requestedCount", () => {
    const body = { results: [{ id: "1" }, { id: "2" }] };
    expect(countBatchUpdateOutcome(body, 1)).toEqual({ updated: 2, failed: 0 });
  });
});
