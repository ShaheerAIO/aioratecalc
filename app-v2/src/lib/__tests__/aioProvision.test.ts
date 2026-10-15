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
  isTenantSchemaNotReady: (e: unknown) =>
    Boolean((e as { tenantSchemaNotReady?: boolean })?.tenantSchemaNotReady),
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

/**
 * Provision to completion.
 *
 * The happy path is TWO passes as of 2026-10-14, and that is the feature, not
 * an awkwardness to hide: AIO builds the tenant's Postgres schema
 * asynchronously after `business/create`, and calling `restaurant/post/create`
 * before it lands still CREATES a restaurant — a permanently broken one. So
 * pass 1 creates the tenant and stops, and pass 2 (here, with the clock wound
 * past `locationNotBefore`) does the location and the link.
 */
async function provisionFully(base: MerchantApplication = app()) {
  const first = await provisionAioTenant(base);
  const resumed = {
    ...base,
    aioTenant: { ...(lastTenant() as object), locationNotBefore: "2000-01-01T00:00:00.000Z" },
  } as MerchantApplication;
  return { first, second: await provisionAioTenant(resumed) };
}

/** A schema-not-ready rejection, shaped as the adapter throws it. */
function schemaNotReady() {
  return Object.assign(new Error(`relation "tenant_5217.state" does not exist`), {
    tenantSchemaNotReady: true,
  });
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
    // Pass 1 stops at the tenant — see provisionFully.
    const first = await provisionAioTenant(app());
    expect(first.status).toBe("waiting");
    expect(createAioBusiness).toHaveBeenCalledTimes(1);
    expect(createAioLocation).not.toHaveBeenCalled();

    const resumed = {
      ...app(),
      aioTenant: { ...(lastTenant() as object), locationNotBefore: "2000-01-01T00:00:00.000Z" },
    } as MerchantApplication;
    expect(await provisionAioTenant(resumed))
      .toEqual({ status: "provisioned", businessId: 5217, locationId: 4690 });
  });

  // ONE location per tenant is the requirement (product owner, 2026-10-14).
  it("creates exactly ONE location across the whole chain", async () => {
    await provisionFully();
    expect(createAioLocation).toHaveBeenCalledTimes(1);
    expect(createAioBusiness).toHaveBeenCalledTimes(1);
  });

  it("writes the business id as the AIO tenant number — this is what prod-{n} settlement attribution reads", async () => {
    await provisionFully();
    const final = updates[updates.length - 1];
    expect(final.adyenIds).toMatchObject({
      tenantNumber: "5217",
      legalEntityId: "LE3295D22322885Q2G7VW4SX3",
      environment: "test",
    });
  });

  it("advances the stage and stores the minted link for admin visibility", async () => {
    await provisionFully();
    const final = updates[updates.length - 1];
    expect(final.stage).toBe("adyen_kyc_pending");
    expect(final.adyenOnboardingUrl).toBe(URL_OK);
  });

  it("never regresses a stage that is already further along", async () => {
    await provisionFully(app({ stage: "adyen_approved" }));
    const final = updates[updates.length - 1];
    expect(final.stage).toBeUndefined();
  });

  it("records where the tenant lives and clears the claim on success", async () => {
    await provisionFully();
    const t = lastTenant();
    expect(t).toMatchObject({ businessId: 5217, locationId: 4690, environment: "internal", claimedAt: null });
    expect(t?.provisionedAt).toBeTruthy();
  });
});

// The 2026-10-14 incident, in full: tenant 2047 ended up with restaurants
// 2080, 2081 and 2082 because `restaurant/post/create` was called before AIO
// had built the tenant's Postgres schema. Each premature call 500s AND leaves
// a half-created row that answers 404 forever and cannot be deleted. The cure
// is to WAIT — across cron ticks, for free — not to retry.
describe("one location, by waiting instead of retrying", () => {
  it("does not touch the location endpoint in the same pass that creates the tenant", async () => {
    const out = await provisionAioTenant(app());
    expect(out.status).toBe("waiting");
    expect(createAioLocation).not.toHaveBeenCalled();
    expect(lastTenant()).toMatchObject({ businessId: 5217, locationId: null, claimedAt: null });
  });

  it("charges the merchant nothing for waiting — no attempt, no backoff, no error", async () => {
    // This is the difference between `defer` and `fail`. On 2026-10-14 the
    // equivalent moment cost one attempt and a one-hour backoff, and the
    // tenant sat unfinished for the rest of it.
    await provisionAioTenant(app());
    const t = lastTenant();
    expect(t).toMatchObject({ attempts: 0, lastAttemptAt: null, lastError: null, lastErrorAt: null });
    expect(t?.locationNotBefore).toBeTruthy();
  });

  it("keeps waiting while the schema window is still open, without calling AIO", async () => {
    const waiting = app({
      aioTenant: {
        businessId: 5217, locationId: null, companyId: "com_x", workplaceId: null,
        alias: "easyob_prospect_1", businessName: "Blue Plate", environment: "internal",
        createdAt: "2026-10-14T23:40:00.000Z", provisionedAt: null, claimedAt: null,
        attempts: 0, lastAttemptAt: null,
        locationNotBefore: new Date(Date.now() + 60_000).toISOString(),
        lastError: null, lastErrorAt: null,
      },
    } as never);

    const out = await provisionAioTenant(waiting);
    expect(out.status).toBe("waiting");
    expect(createAioLocation).not.toHaveBeenCalled();
  });

  it("treats a schema-not-ready 500 as too-early, not as a failure", async () => {
    createAioLocation.mockRejectedValue(schemaNotReady());
    const { second: out } = await provisionFully();

    expect(out.status).toBe("waiting");
    const t = lastTenant();
    // Not a failure: no error recorded, no attempt spent, and the next
    // window pushed out rather than an exponential backoff started.
    expect(t).toMatchObject({ attempts: 0, lastError: null, locationId: null });
    expect(Date.parse(t?.locationNotBefore as string)).toBeGreaterThan(Date.now());
  });

  it("still creates only ONE location when the first window was too short", async () => {
    createAioLocation.mockRejectedValueOnce(schemaNotReady());
    const { second } = await provisionFully();
    expect(second.status).toBe("waiting");

    // A later tick, past the pushed-out window.
    const retry = {
      ...app(),
      aioTenant: { ...(lastTenant() as object), locationNotBefore: "2000-01-01T00:00:00.000Z" },
    } as MerchantApplication;
    expect(await provisionAioTenant(retry))
      .toEqual({ status: "provisioned", businessId: 5217, locationId: 4690 });

    // Three calls would be tonight's bug. Two is the known-slow tenant.
    expect(createAioLocation).toHaveBeenCalledTimes(2);
    expect(createAioBusiness).toHaveBeenCalledTimes(1);
  });

  // A reconciled business is one AIO made minutes or days ago; making it wait
  // five more would be waiting for something that has already happened.
  it("does not impose a warm-up on a business it reconciled rather than created", async () => {
    findAioBusinessByAlias.mockResolvedValue({
      businessId: 9999, businessName: "Blue Plate", restaurants: [],
    });
    const out = await provisionAioTenant(app());
    expect(createAioBusiness).not.toHaveBeenCalled();
    expect(createAioLocation).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ status: "provisioned", businessId: 9999, locationId: 4690 });
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
        // Long past, so the location step runs immediately in this test.
        locationNotBefore: "2026-09-23T00:00:00.000Z",
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
    createAioLocation.mockRejectedValue(new Error("upstream exploded"));

    const { second: out } = await provisionFully();

    expect(out.status).toBe("failed");
    const t = lastTenant();
    expect(t).toMatchObject({ businessId: 5217, locationId: null, claimedAt: null });
    expect(t?.lastError).toMatch(/upstream exploded/);
  });

  it("persists the error rather than only logging it — a cron failure nobody sees is a stuck account", async () => {
    createAioAdyenOnboardingLink.mockRejectedValue(new Error("empty url after 3 attempts"));

    await provisionFully();

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
