import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MerchantApplication } from "@/types/merchant";

// provisionAioTenant, with the drizzle client stubbed in the
// hubspotBillingCron.test.ts style. What matters here is NOT the happy path —
// it's that nothing can ever create a second tenant. Every AIO object is
// permanent: a business alias is globally unique and delete is soft, so it is
// never freed. A duplicate is unfixable debris with a real merchant's name on
// it, in a database shared with other AIO teams.

const createAioBusiness = vi.fn();
const createAioLocation = vi.fn();
const createAioAdyenOnboardingLink = vi.fn();
const findAioBusinessByAlias = vi.fn();

let claimSucceeds = true;
const updates: Array<Record<string, unknown>> = [];

const db = {
  update: () => ({
    set: (patch: Record<string, unknown>) => ({
      where: async () => {
        // The lease is the only update issued via a raw sql`` patch; every
        // later persist passes a plain aioTenant object.
        const isClaim = typeof patch.aioTenant === "object" && patch.aioTenant !== null &&
          !("alias" in (patch.aioTenant as Record<string, unknown>));
        updates.push(patch);
        return { rowCount: isClaim && !claimSucceeds ? 0 : 1 };
      },
    }),
  }),
};

vi.mock("@/lib/db/client", () => ({ db }));
vi.mock("@/lib/adapters/aioDashboard", () => ({
  createAioBusiness,
  createAioLocation,
  createAioAdyenOnboardingLink,
  findAioBusinessByAlias,
  aioBusinessAlias: (a: { id: string }) => `easyob_${a.id}`,
  aioEnvironment: () => "internal",
  adyenEnvironmentFromOnboardingUrl: () => "test",
}));

const { provisionAioTenant } = await import("@/lib/aio/provision");

const URL_OK =
  "https://onboarding-test.adyen.com/onboardingcomponents/ho/v1/xtl/legalEntities/LE3295D22322885Q2G7VW4SX3";

function app(extra: Partial<MerchantApplication> = {}): MerchantApplication {
  return {
    id: "prospect_1",
    stage: "quote_accepted",
    adyenIds: null,
    aioTenant: null,
    business: { dba: "Blue Plate", legalName: "Blue Plate LLC" },
    ownerContact: { firstName: "Sam", lastName: "R", email: "sam@example.com", phone: "4155550143" },
    ...extra,
  } as unknown as MerchantApplication;
}

/** The last persisted aioTenant object (the lease patch uses raw sql). */
function lastTenant(): Record<string, unknown> | undefined {
  for (let i = updates.length - 1; i >= 0; i--) {
    const t = updates[i].aioTenant as Record<string, unknown> | undefined;
    if (t && "alias" in t) return t;
  }
  return undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  claimSucceeds = true;
  findAioBusinessByAlias.mockResolvedValue(null);
  createAioBusiness.mockResolvedValue({ businessId: 5217, companyId: "com_x", businessName: "Blue Plate" });
  createAioLocation.mockResolvedValue({ locationId: 4690, workplaceId: "wrk_x" });
  createAioAdyenOnboardingLink.mockResolvedValue({
    url: URL_OK,
    legalEntityId: "LE3295D22322885Q2G7VW4SX3",
    newOnboarding: false,
  });
});

describe("the happy path", () => {
  it("creates tenant then location then link, and reports both ids", async () => {
    const out = await provisionAioTenant(app());
    expect(out).toEqual({ status: "provisioned", businessId: 5217, locationId: 4690 });
  });

  it("writes the business id as the AIO tenant number — this is what prod-{n} settlement attribution reads", async () => {
    await provisionAioTenant(app());
    const final = updates[updates.length - 1];
    expect(final.adyenIds).toMatchObject({
      tenantNumber: "5217",
      legalEntityId: "LE3295D22322885Q2G7VW4SX3",
      environment: "test",
    });
  });

  it("advances the stage and stores the minted link for admin visibility", async () => {
    await provisionAioTenant(app());
    const final = updates[updates.length - 1];
    expect(final.stage).toBe("adyen_kyc_pending");
    expect(final.adyenOnboardingUrl).toBe(URL_OK);
  });

  it("never regresses a stage that is already further along", async () => {
    await provisionAioTenant(app({ stage: "adyen_approved" }));
    const final = updates[updates.length - 1];
    expect(final.stage).toBeUndefined();
  });

  it("records where the tenant lives and clears the claim on success", async () => {
    await provisionAioTenant(app());
    const t = lastTenant();
    expect(t).toMatchObject({ businessId: 5217, locationId: 4690, environment: "internal", claimedAt: null });
    expect(t?.provisionedAt).toBeTruthy();
  });
});

describe("never creating twice", () => {
  it("does nothing when another run holds the lease", async () => {
    claimSucceeds = false;
    const out = await provisionAioTenant(app());
    expect(out).toEqual({ status: "not_claimed" });
    expect(createAioBusiness).not.toHaveBeenCalled();
  });

  it("reconciles by alias before creating — a lost write must not mint a second tenant", async () => {
    findAioBusinessByAlias.mockResolvedValue({
      businessId: 9999,
      businessName: "Blue Plate",
      restaurants: [{ id: 8888, name: "Loc" }],
    });

    const out = await provisionAioTenant(app());

    expect(createAioBusiness).not.toHaveBeenCalled();
    expect(createAioLocation).not.toHaveBeenCalled();
    expect(out).toEqual({ status: "provisioned", businessId: 9999, locationId: 8888 });
  });

  it("stops and asks for a human when the alias exists but its id can't be read back", async () => {
    // AIO's alias lookup does not return the business id (verified 2026-09-23),
    // so this is a genuine dead end. Creating again would burn a second alias.
    findAioBusinessByAlias.mockResolvedValue({ businessId: null, businessName: "Blue Plate", restaurants: [] });

    const out = await provisionAioTenant(app());

    expect(out.status).toBe("needs_attention");
    expect(createAioBusiness).not.toHaveBeenCalled();
    expect((out as { error: string }).error).toMatch(/cannot be read back/);
  });

  it("resumes from a persisted business id instead of recreating it", async () => {
    const resumed = app({
      aioTenant: {
        businessId: 5217,
        locationId: null,
        companyId: "com_x",
        workplaceId: null,
        alias: "easyob_prospect_1",
        businessName: "Blue Plate",
        environment: "internal",
        createdAt: "2026-09-23T00:00:00.000Z",
        provisionedAt: null,
        claimedAt: null,
        attempts: 1,
        lastAttemptAt: "2026-09-23T00:00:00.000Z",
        lastError: "boom",
        lastErrorAt: "2026-09-23T00:00:00.000Z",
      },
    });

    const out = await provisionAioTenant(resumed);

    expect(findAioBusinessByAlias).not.toHaveBeenCalled();
    expect(createAioBusiness).not.toHaveBeenCalled();
    expect(createAioLocation).toHaveBeenCalledOnce();
    expect(out).toEqual({ status: "provisioned", businessId: 5217, locationId: 4690 });
  });

  it("keeps the alias it was provisioned under rather than re-deriving one", async () => {
    const resumed = app({
      aioTenant: { businessId: 0, alias: "easyob_legacy_alias", attempts: 1, provisionedAt: null } as never,
    });
    await provisionAioTenant(resumed);
    expect(findAioBusinessByAlias).toHaveBeenCalledWith("easyob_legacy_alias");
  });
});

describe("failure handling", () => {
  it("keeps the business id when the location step fails, so the retry resumes", async () => {
    createAioLocation.mockRejectedValue(new Error("relation does not exist"));

    const out = await provisionAioTenant(app());

    expect(out.status).toBe("failed");
    const t = lastTenant();
    expect(t).toMatchObject({ businessId: 5217, locationId: null, claimedAt: null });
    expect(t?.lastError).toMatch(/relation does not exist/);
  });

  it("persists the error rather than only logging it — a cron failure nobody sees is a stuck account", async () => {
    createAioAdyenOnboardingLink.mockRejectedValue(new Error("empty url after 3 attempts"));

    await provisionAioTenant(app());

    const t = lastTenant();
    expect(t?.lastError).toMatch(/empty url after 3 attempts/);
    expect(t?.lastErrorAt).toBeTruthy();
    expect(t?.provisionedAt).toBeNull();
  });

  it("releases the claim on failure so the row is retryable after backoff", async () => {
    createAioLocation.mockRejectedValue(new Error("nope"));
    await provisionAioTenant(app());
    expect(lastTenant()?.claimedAt).toBeNull();
  });

  it("never throws — one bad merchant must not abort the cron batch", async () => {
    createAioBusiness.mockRejectedValue(new Error("kaboom"));
    await expect(provisionAioTenant(app())).resolves.toMatchObject({ status: "failed" });
  });
});
