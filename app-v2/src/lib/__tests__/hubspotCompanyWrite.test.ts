import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { updateCompanyMerchantDetails } from "@/lib/adapters/hubspot";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("HUBSPOT_PRIVATE_APP_TOKEN", "general-token");
  vi.stubEnv("HUBSPOT_BILLING_PRIVATE_APP_TOKEN", "billing-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("updateCompanyMerchantDetails", () => {
  it("PATCHes the company, not a deal, with the general CRM token", async () => {
    await updateCompanyMerchantDetails("338486660836", { legalName: "Little Arabia Holdings LLC", previousProcessor: "Clover", mcc: "5812" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.hubapi.com/crm/v3/objects/companies/338486660836");
    expect(init.method).toBe("PATCH");
    expect(init.headers.Authorization).toBe("Bearer general-token");
    expect(JSON.parse(init.body)).toEqual({
      properties: {
        legal_trading_name_as_registered_with_government: "Little Arabia Holdings LLC",
        previous_processor: "Clover",
        mcc_code: "5812",
      },
    });
  });

  it("leaves blank values out, so it never erases what HubSpot already has", async () => {
    const written = await updateCompanyMerchantDetails("1", { legalName: "  Bojax Inc ", previousProcessor: "  ", mcc: null });
    expect(written).toEqual(["legal_trading_name_as_registered_with_government"]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      properties: { legal_trading_name_as_registered_with_government: "Bojax Inc" },
    });
  });

  it("makes no call at all when there is nothing to write", async () => {
    expect(await updateCompanyMerchantDetails("1", { legalName: "", previousProcessor: undefined })).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a HubSpot refusal so the caller can report it", async () => {
    fetchMock.mockResolvedValue(new Response('{"message":"nope"}', { status: 403 }));
    await expect(updateCompanyMerchantDetails("1", { mcc: "5812" })).rejects.toThrow(/company update failed/);
  });
});
