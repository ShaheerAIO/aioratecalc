import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MerchantApplication } from "@/types/merchant";
import {
  aioDashboardEnabled,
  aioBusinessAlias,
  legalEntityIdFromOnboardingUrl,
  adyenEnvironmentFromOnboardingUrl,
  createAioBusiness,
  createAioLocation,
  createAioAdyenOnboardingLink,
  __resetAioSession,
} from "@/lib/adapters/aioDashboard";

// The two AIO bugs this adapter exists to absorb are the reason most of these
// tests are here: the location create 500s on its FIRST call, and
// adyen-onboard returns HTTP 201 success:true with an EMPTY url on its first
// call. Both were verified live on 2026-09-23. A regression in either one
// hands a real merchant a blank KYC link or mints a duplicate tenant that
// cannot be deleted.

const LOGIN_OK = {
  data: {
    authChallengeResponse: {
      AuthenticationResult: { AccessToken: "acc-1", IdToken: "id-1", ExpiresIn: 86400 },
    },
  },
};

function res(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetAioSession();
  process.env.AIO_DASHBOARD_ENABLED = "true";
  process.env.AIO_DASHBOARD_BASE_URL = "https://backend.internal.dev.aioapp.com";
  process.env.AIO_DASHBOARD_USERNAME = "svc@aioapp.com";
  process.env.AIO_DASHBOARD_PASSWORD = "pw";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const APP = {
  id: "prospect_1758901234567",
  business: {
    legalName: "Blue Plate LLC",
    dba: "Blue Plate Diner",
    bizType: "llc",
    address: "1 Probe St",
    city: "San Jose",
    state: "CA",
    zip: "95120",
    phone: "(415) 555-0142",
    website: "",
    yearsInBusiness: "3",
    annualRevenue: "500000",
  },
  ownerContact: { firstName: "Sam", lastName: "Rivera", title: "Owner", email: "sam@example.com", phone: "4155550143" },
} as unknown as MerchantApplication;

describe("aioDashboardEnabled", () => {
  it("is off unless the switch is exactly 'true'", () => {
    process.env.AIO_DASHBOARD_ENABLED = "1";
    expect(aioDashboardEnabled()).toBe(false);
    process.env.AIO_DASHBOARD_ENABLED = "true";
    expect(aioDashboardEnabled()).toBe(true);
  });

  it("is off when half-configured — a partial env must not be half-broken", () => {
    delete process.env.AIO_DASHBOARD_PASSWORD;
    expect(aioDashboardEnabled()).toBe(false);
  });

  it("is off when no base URL is set, since there is deliberately no default", () => {
    delete process.env.AIO_DASHBOARD_BASE_URL;
    expect(aioDashboardEnabled()).toBe(false);
  });
});

describe("pure helpers", () => {
  it("derives a deterministic alias — a random one would mint a second tenant on retry", () => {
    expect(aioBusinessAlias(APP)).toBe("easyob_prospect_1758901234567");
    expect(aioBusinessAlias(APP)).toBe(aioBusinessAlias(APP));
  });

  it("pulls the legal entity id out of the onboarding URL, the only place it exists", () => {
    const url =
      "https://onboarding-test.adyen.com/onboardingcomponents/ho/v1/xtl-AQFcy/legalEntities/LE3295D22322885Q2G7VW4SX3";
    expect(legalEntityIdFromOnboardingUrl(url)).toBe("LE3295D22322885Q2G7VW4SX3");
  });

  it("returns null rather than throwing when the URL carries no legal entity", () => {
    expect(legalEntityIdFromOnboardingUrl("https://onboarding-test.adyen.com/ho/v1/abc")).toBeNull();
    expect(legalEntityIdFromOnboardingUrl("")).toBeNull();
  });

  it("reads the Adyen environment off the URL host, not off an env var", () => {
    expect(adyenEnvironmentFromOnboardingUrl("https://onboarding-test.adyen.com/x/legalEntities/LE1")).toBe("test");
    expect(adyenEnvironmentFromOnboardingUrl("https://onboarding.adyen.com/x/legalEntities/LE1")).toBe("live");
  });
});

describe("session handling", () => {
  it("logs in once and reuses the token across calls", async () => {
    fetchMock
      .mockResolvedValueOnce(res(LOGIN_OK))
      .mockResolvedValueOnce(res({ success: true, data: { id: 5217, companyId: "com_x" } }))
      .mockResolvedValueOnce(res({ success: true, data: { id: 5218, companyId: "com_y" } }));

    await createAioBusiness(APP, { alias: "a1" });
    await createAioBusiness(APP, { alias: "a2" });

    const logins = fetchMock.mock.calls.filter(c => String(c[0]).includes("user-login"));
    expect(logins).toHaveLength(1);
  });

  it("sends BOTH auth headers — Bearer alone is rejected by most routes", async () => {
    fetchMock
      .mockResolvedValueOnce(res(LOGIN_OK))
      .mockResolvedValueOnce(res({ success: true, data: { id: 5217, companyId: null } }));

    await createAioBusiness(APP, { alias: "a1" });

    const headers = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer acc-1");
    expect(headers["x-id-token"]).toBe("id-1");
    expect(headers["x-app-name"]).toBe("dashboard");
  });

  it("collapses concurrent callers onto a single login", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("user-login")) return res(LOGIN_OK);
      return res({ success: true, data: { id: 5217, companyId: null } });
    });

    await Promise.all([
      createAioBusiness(APP, { alias: "a1" }),
      createAioBusiness(APP, { alias: "a2" }),
      createAioBusiness(APP, { alias: "a3" }),
    ]);

    const logins = fetchMock.mock.calls.filter(c => String(c[0]).includes("user-login"));
    expect(logins).toHaveLength(1);
  });

  it("re-logs-in once on a 401, then gives up rather than looping", async () => {
    fetchMock
      .mockResolvedValueOnce(res(LOGIN_OK))
      .mockResolvedValueOnce(res("unauthorized", 401))
      .mockResolvedValueOnce(res(LOGIN_OK))
      .mockResolvedValueOnce(res("unauthorized", 401));

    await expect(createAioBusiness(APP, { alias: "a1" })).rejects.toThrow(/failed \(401\)/);
    const logins = fetchMock.mock.calls.filter(c => String(c[0]).includes("user-login"));
    expect(logins).toHaveLength(2);
  });
});

describe("createAioBusiness", () => {
  it("returns the business id and the Check company the platform auto-creates", async () => {
    fetchMock
      .mockResolvedValueOnce(res(LOGIN_OK))
      .mockResolvedValueOnce(res({ success: true, data: { id: 5217, companyId: "com_7cFTDdes" } }));

    const out = await createAioBusiness(APP, { alias: "easyob_x" });
    expect(out).toEqual({ businessId: 5217, companyId: "com_7cFTDdes", businessName: "Blue Plate Diner" });
  });

  it("sends the merchant's real name first — getting the name right is the point", async () => {
    fetchMock
      .mockResolvedValueOnce(res(LOGIN_OK))
      .mockResolvedValueOnce(res({ success: true, data: { id: 5217 } }));

    await createAioBusiness(APP, { alias: "easyob_x" });
    const body = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(body.businessInfo.businessName).toBe("Blue Plate Diner");
    expect(body.businessInfo.businessAlias).toBe("easyob_x");
    expect(body.pocInfo[0]).toMatchObject({ name: "Sam Rivera", roleId: 4, email: "sam@example.com" });
  });

  it("normalises phones to E.164 for both the business and the contact", async () => {
    fetchMock
      .mockResolvedValueOnce(res(LOGIN_OK))
      .mockResolvedValueOnce(res({ success: true, data: { id: 5217 } }));

    await createAioBusiness(APP, { alias: "easyob_x" });
    const body = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(body.businessInfo.contactNo).toBe("+14155550142");
    expect(body.pocInfo[0].contactNo).toBe("+14155550143");
  });

  it("disambiguates only when AIO says the name is taken", async () => {
    fetchMock
      .mockResolvedValueOnce(res(LOGIN_OK))
      .mockResolvedValueOnce(res({ message: "Business name already exists" }, 400))
      .mockResolvedValueOnce(res({ success: true, data: { id: 5219 } }));

    const out = await createAioBusiness(APP, { alias: "easyob_x" });
    expect(out.businessName).toBe("Blue Plate Diner (EasyOB 234567)");
    expect(out.businessId).toBe(5219);
  });

  it("does not retry a name that failed for any other reason", async () => {
    fetchMock
      .mockResolvedValueOnce(res(LOGIN_OK))
      .mockResolvedValueOnce(res({ message: "Business alias already exists" }, 400));

    await expect(createAioBusiness(APP, { alias: "easyob_x" })).rejects.toThrow(/alias already exists/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("createAioLocation — the first-call schema bug", () => {
  it("retries exactly once when the per-tenant schema is not ready yet", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(res(LOGIN_OK))
      .mockResolvedValueOnce(
        res({ message: 'Error while performing operation :relation "tenant_5217.state" does not exist' }, 500)
      )
      .mockResolvedValueOnce(res({ statusCode: 200, response: { success: true, data: { id: 4690, workplaceId: "wrk_1" } } }));

    const p = createAioLocation(APP, { businessId: 5217, companyId: "com_x" });
    await vi.advanceTimersByTimeAsync(2000);

    expect(await p).toEqual({ locationId: 4690, workplaceId: "wrk_1" });
    const creates = fetchMock.mock.calls.filter(c => String(c[0]).includes("restaurant/post/create"));
    expect(creates).toHaveLength(2);
  });

  it("does NOT retry any other 500 — a blind retry could create two locations", async () => {
    fetchMock
      .mockResolvedValueOnce(res(LOGIN_OK))
      .mockResolvedValueOnce(res({ message: "Internal server error" }, 500));

    await expect(createAioLocation(APP, { businessId: 5217, companyId: null })).rejects.toThrow(/500/);
    const creates = fetchMock.mock.calls.filter(c => String(c[0]).includes("restaurant/post/create"));
    expect(creates).toHaveLength(1);
  });

  it("gives up after the one permitted retry", async () => {
    vi.useFakeTimers();
    const schemaErr = res({ message: 'relation "tenant_5217.state" does not exist' }, 500);
    fetchMock.mockResolvedValueOnce(res(LOGIN_OK)).mockResolvedValue(schemaErr);

    const p = createAioLocation(APP, { businessId: 5217, companyId: null });
    const assertion = expect(p).rejects.toThrow(/does not exist/);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    const creates = fetchMock.mock.calls.filter(c => String(c[0]).includes("restaurant/post/create"));
    expect(creates).toHaveLength(2);
  });
});

describe("createAioAdyenOnboardingLink — the empty-url bug", () => {
  const REAL_URL =
    "https://onboarding-test.adyen.com/onboardingcomponents/ho/v1/xtl-AQ/legalEntities/LE3295D22322885Q2G7VW4SX3";

  it("treats a 201 with an empty url as NOT ready and retries", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(res(LOGIN_OK))
      .mockResolvedValueOnce(res({ success: true, data: { url: "", newOnboarding: true } }, 201))
      .mockResolvedValueOnce(res({ success: true, data: { url: REAL_URL, newOnboarding: false } }, 201));

    const p = createAioAdyenOnboardingLink({ businessId: 5217, locationId: 4690 });
    await vi.advanceTimersByTimeAsync(1500);
    const out = await p;

    expect(out.url).toBe(REAL_URL);
    expect(out.legalEntityId).toBe("LE3295D22322885Q2G7VW4SX3");
  });

  it("throws rather than ever returning an empty url to a merchant", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(res(LOGIN_OK))
      .mockResolvedValue(res({ success: true, data: { url: "", newOnboarding: true } }, 201));

    const p = createAioAdyenOnboardingLink({ businessId: 5217, locationId: 4690 });
    const assertion = expect(p).rejects.toThrow(/empty url after 3 attempts/);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it("sends the location id in the body and the tenant id in the header", async () => {
    fetchMock
      .mockResolvedValueOnce(res(LOGIN_OK))
      .mockResolvedValueOnce(res({ success: true, data: { url: REAL_URL } }, 201));

    await createAioAdyenOnboardingLink({ businessId: 5217, locationId: 4690 });
    const call = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(call.body))).toEqual({ restaurantId: 4690 });
    expect((call.headers as Record<string, string>)["x-tenant-id"]).toBe("5217");
  });

  it("mints a fresh link per call — the same legal entity, a different url", async () => {
    const second = REAL_URL.replace("xtl-AQ", "xtl-ZZ");
    fetchMock
      .mockResolvedValueOnce(res(LOGIN_OK))
      .mockResolvedValueOnce(res({ success: true, data: { url: REAL_URL } }, 201))
      .mockResolvedValueOnce(res({ success: true, data: { url: second } }, 201));

    const a = await createAioAdyenOnboardingLink({ businessId: 5217, locationId: 4690 });
    const b = await createAioAdyenOnboardingLink({ businessId: 5217, locationId: 4690 });

    expect(a.url).not.toBe(b.url);
    expect(a.legalEntityId).toBe(b.legalEntityId);
  });
});
