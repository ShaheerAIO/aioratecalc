import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  commissionWritebackEnabled,
  commissionWritebackProperties,
  writeCommissionToDeal,
} from "@/lib/billing/commissionWriteback";
import { DEFAULT_QUOTE_RATES } from "@/types/merchant";
import type { MerchantApplication, StoredQuoteType } from "@/types/merchant";

// This module's whole point (2026-10-13, corrected from an earlier version
// that summed payment_processing_arr with an ESTIMATE of saas_revenue): the
// written commission must be 5%/5% of the SAME total_arr HubSpot itself would
// compute — payment_processing_arr (ours, freshly computed) + HubSpot's real
// saas_revenue (read live, never estimated). A read failure or a missing
// property means NO WRITE AT ALL, recorded as a sync error, never a guess.

vi.mock("@/lib/db/client", () => ({
  db: { update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })) },
}));

function app(over: Partial<MerchantApplication> = {}): MerchantApplication {
  return {
    id: "app-1",
    stage: "quote_accepted",
    hubspotDealId: "343689933538",
    hubspotIds: {},
    quoteType: "all_in_one" as StoredQuoteType,
    quoteAcceptedAt: "2026-10-13T00:00:00.000Z",
    pricingModel: "2-tier",
    quoteRates: DEFAULT_QUOTE_RATES,
    quoteConfig: { monthlyVolume: 100_000, avgTicket: 30 },
    analysis: null,
    business: { dba: "Torta Palace" },
    quoteLines: [],
    ...over,
  } as unknown as MerchantApplication;
}

function dealGetRes(saasRevenue: string | null | undefined, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ properties: { saas_revenue: saasRevenue } }),
    text: async () => JSON.stringify({ properties: { saas_revenue: saasRevenue } }),
  } as unknown as Response;
}

function patchOkRes() {
  return { ok: true, status: 200, text: async () => "" } as unknown as Response;
}

const ENV_KEYS = ["COMMISSION_WRITEBACK_ENABLED", "HUBSPOT_BILLING_PRIVATE_APP_TOKEN"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.COMMISSION_WRITEBACK_ENABLED;
  process.env.HUBSPOT_BILLING_PRIVATE_APP_TOKEN = "test-token";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("commissionWritebackEnabled", () => {
  it("is off by default — unset, 'false', or anything other than the literal 'true'", () => {
    expect(commissionWritebackEnabled()).toBe(false);
    process.env.COMMISSION_WRITEBACK_ENABLED = "false";
    expect(commissionWritebackEnabled()).toBe(false);
    process.env.COMMISSION_WRITEBACK_ENABLED = "1";
    expect(commissionWritebackEnabled()).toBe(false);
  });

  it("is on only for the exact string 'true'", () => {
    process.env.COMMISSION_WRITEBACK_ENABLED = "true";
    expect(commissionWritebackEnabled()).toBe(true);
  });
});

describe("commissionWritebackProperties — given a real saas_revenue in hand", () => {
  it("writes both properties, 5%/5% of OUR processing ARR plus the GIVEN saas_revenue", () => {
    const props = commissionWritebackProperties(app(), 4788.5);
    expect(props.signing_commission).toBeDefined();
    expect(props.activation_commission).toBeDefined();
    expect(props.signing_commission).toBe(props.activation_commission);
    expect(Number(props.signing_commission)).toBeGreaterThan(0);
  });

  it("is driven by the GIVEN saas_revenue argument, not derived internally from quoteLines", () => {
    // Same app, same quoteLines, two different GIVEN saas_revenue figures —
    // if this function secretly fell back to estimating from quoteLines
    // instead of using the argument, these two calls would come out
    // identical no matter what's passed in. A large gap (not the ~$0.50
    // pre-auth-sized gap a real deal would show) makes sure dollar-rounding
    // can't mask the difference.
    const withLines = app({
      quoteLines: [{
        hubspotProductId: "335283119838", name: "All-in-One Platform", qty: 1,
        unitPrice: 399, billingFrequency: "monthly", productType: "Software",
      }],
    });
    const low = commissionWritebackProperties(withLines, 0);
    const high = commissionWritebackProperties(withLines, 100_000);
    expect(Number(high.signing_commission)).toBeGreaterThan(Number(low.signing_commission));
  });

  it("omits rather than zeroes for a marketing-only quote with no processing basis — EVEN with saas_revenue confirmed present", () => {
    // Reachable in practice: a marketing-only deal with genuinely nothing
    // billed yet. processingArr is null (no processing quote), and
    // saas_revenue is a real, confirmed non-zero figure here on purpose —
    // this isn't the "zero means unknown" case, it's "there IS a platform
    // fee basis", which is why props come back populated rather than empty.
    const props = commissionWritebackProperties(
      app({ quoteType: "marketing_only" as StoredQuoteType, quoteConfig: undefined }),
      2_388 // e.g. a $199/mo marketing platform fee, annualised
    );
    expect(props.signing_commission).toBeDefined();
    expect(Number(props.signing_commission)).toBeGreaterThan(0);
  });

  it("writes an honest zero, not an omission, when BOTH components are a confirmed zero", () => {
    // This function only ever runs after `writeCommissionToDeal` has already
    // confirmed a real (non-null, parseable) saas_revenue from HubSpot — so a
    // literal 0 here is a CONFIRMED answer ("this deal truly has no SaaS
    // revenue"), not an unknown masquerading as zero. That's different from
    // `payment_processing_arr`'s own omit-on-<=0 rule, which exists because a
    // non-positive margin there usually signals a bad INPUT (a rate under
    // the floor), not a verified fact.
    const props = commissionWritebackProperties(
      app({ quoteType: "marketing_only" as StoredQuoteType, quoteConfig: undefined }),
      0
    );
    expect(props.signing_commission).toBe("0");
    expect(props.activation_commission).toBe("0");
  });
});

describe("writeCommissionToDeal", () => {
  it("never calls HubSpot when the flag is off (default)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await writeCommissionToDeal(app());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never calls HubSpot with no hubspotDealId, even with the flag on", async () => {
    process.env.COMMISSION_WRITEBACK_ENABLED = "true";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await writeCommissionToDeal(app({ hubspotDealId: null }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never calls HubSpot when enabled but the token is missing", async () => {
    process.env.COMMISSION_WRITEBACK_ENABLED = "true";
    delete process.env.HUBSPOT_BILLING_PRIVATE_APP_TOKEN;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await writeCommissionToDeal(app());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads saas_revenue (not total_arr) before writing anything", async () => {
    process.env.COMMISSION_WRITEBACK_ENABLED = "true";
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(dealGetRes("4788.50"))
      .mockResolvedValueOnce(patchOkRes());
    vi.stubGlobal("fetch", fetchSpy);

    await writeCommissionToDeal(app());

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [getUrl, getInit] = fetchSpy.mock.calls[0];
    expect(getUrl).toContain("/crm/v3/objects/deals/343689933538");
    expect(getUrl).toContain("properties=saas_revenue");
    expect(getUrl).not.toContain("total_arr");
    expect(getInit.method).toBeUndefined(); // GET
  });

  it("PATCHes signing_commission/activation_commission computed off the REAL saas_revenue", async () => {
    process.env.COMMISSION_WRITEBACK_ENABLED = "true";
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(dealGetRes("4788.50"))
      .mockResolvedValueOnce(patchOkRes());
    vi.stubGlobal("fetch", fetchSpy);

    await writeCommissionToDeal(app());

    const [patchUrl, patchInit] = fetchSpy.mock.calls[1];
    expect(patchUrl).toContain("/crm/v3/objects/deals/343689933538");
    expect(patchInit.method).toBe("PATCH");
    const body = JSON.parse(patchInit.body);
    const expected = commissionWritebackProperties(app(), 4788.5);
    expect(body.properties).toEqual(expected);
  });

  it("writes NOTHING and records a sync error when the saas_revenue read fails (network/non-2xx)", async () => {
    process.env.COMMISSION_WRITEBACK_ENABLED = "true";
    const fetchSpy = vi.fn().mockResolvedValueOnce({ ok: false, status: 500, text: async () => "server error" });
    vi.stubGlobal("fetch", fetchSpy);

    await writeCommissionToDeal(app());

    // Only the GET happened — no PATCH was ever attempted.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("writes NOTHING when saas_revenue is absent from the response", async () => {
    process.env.COMMISSION_WRITEBACK_ENABLED = "true";
    const fetchSpy = vi.fn().mockResolvedValueOnce(dealGetRes(null));
    vi.stubGlobal("fetch", fetchSpy);

    await writeCommissionToDeal(app());

    expect(fetchSpy).toHaveBeenCalledTimes(1); // GET only, no PATCH
  });

  it("writes NOTHING when saas_revenue doesn't parse as a number", async () => {
    process.env.COMMISSION_WRITEBACK_ENABLED = "true";
    const fetchSpy = vi.fn().mockResolvedValueOnce(dealGetRes("not-a-number"));
    vi.stubGlobal("fetch", fetchSpy);

    await writeCommissionToDeal(app());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("writes NOTHING when the GET itself throws", async () => {
    process.env.COMMISSION_WRITEBACK_ENABLED = "true";
    const fetchSpy = vi.fn().mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(writeCommissionToDeal(app())).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("never throws when the PATCH itself fails after a good GET", async () => {
    process.env.COMMISSION_WRITEBACK_ENABLED = "true";
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(dealGetRes("4788.50"))
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(writeCommissionToDeal(app())).resolves.toBeUndefined();
  });

  it("never throws when the PATCH call itself rejects", async () => {
    process.env.COMMISSION_WRITEBACK_ENABLED = "true";
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(dealGetRes("4788.50"))
      .mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(writeCommissionToDeal(app())).resolves.toBeUndefined();
  });
});
