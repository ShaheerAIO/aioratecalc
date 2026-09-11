import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MerchantApplication, BusinessInfo, OwnerContact, ProcessingInfo, AgreementInfo } from "@/types/merchant";

// saveMyApplicationOnboardingAction is a Server Action; its collaborators are
// stubbed the same way customerQuote.test.ts stubs them. What's under test is
// the gate: whether Adyen is called at all, what the form is told when it
// isn't, and — since the chain is resumable — exactly which steps run and what
// is persisted between them. Same mock set as that file — the module graph is
// shared.
const auth = vi.fn();
const getApplicationForCustomer = vi.fn();
const updateApplicationAsCustomer = vi.fn();
const createAdyenLegalEntity = vi.fn();
const createAdyenAccountHolder = vi.fn();
const createAdyenBusinessLine = vi.fn();
const createAdyenBalanceAccount = vi.fn();
const createOnboardingLink = vi.fn();
const updateLegalEntity = vi.fn();
const pushToHubSpot = vi.fn();

vi.mock("@/lib/auth", () => ({ auth, signIn: vi.fn() }));
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/storage/postgresAdapter", () => ({
  postgresStorage: { getApplicationForCustomer, updateApplicationAsCustomer },
}));
vi.mock("@/lib/adapters/email", () => ({ sendMagicLinkEmail: vi.fn() }));
vi.mock("@/lib/adapters/adyen", () => ({
  createAdyenLegalEntity, createAdyenAccountHolder, createAdyenBusinessLine,
  createAdyenBalanceAccount, createOnboardingLink, updateLegalEntity,
}));
vi.mock("@/lib/adapters/check", () => ({
  checkEnvironment: vi.fn(), createCheckCompany: vi.fn(),
  createCheckOnboardLink: vi.fn(), getCheckOnboardStatus: vi.fn(),
}));
// Partial mock: the pure helpers — including the tenant-link gate — stay real,
// only the network call is stubbed.
vi.mock("@/lib/adapters/hubspot", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/adapters/hubspot")>()),
  pushToHubSpot,
}));

const { saveMyApplicationOnboardingAction, updateMyApplicationDetailsAction } =
  await import("@/lib/actions/customer");

const CUSTOMER_SESSION = { user: { id: "cust-1", role: "customer" } };

const BUSINESS: BusinessInfo = {
  legalName: "Torta Palace LLC", dba: "Torta Palace", bizType: "llc",
  address: "1200 Wilshire Blvd", city: "Los Angeles", state: "CA", zip: "90017",
  phone: "555-000-0000", website: "tortapalace.com", yearsInBusiness: "5", annualRevenue: "1200000",
};
const OWNER: OwnerContact = {
  firstName: "Ana", lastName: "Reyes", title: "Owner",
  email: "ana@tortapalace.com", phone: "555-000-0001",
};
const PROCESSING: ProcessingInfo = {
  monthlyVolume: "100000", avgTicket: "45", cardPresentPct: "80", mcc: "5812",
  businessDescription: "Taqueria", previouslyTerminated: "no", bankruptcy: "no",
  currentProcessor: "Stripe",
};
const AGREEMENT: AgreementInfo = {
  sigName: "Ana Reyes", sigDate: "2026-08-19",
  termsAccepted: true, electronicConsentAccepted: true, actor: "customer",
};

const fields = (biz: Partial<BusinessInfo> = {}, agreement: AgreementInfo = AGREEMENT) => ({
  business: { ...BUSINESS, ...biz },
  ownerContact: OWNER,
  processing: PROCESSING,
  agreement,
});

type AdyenIds = NonNullable<MerchantApplication["adyenIds"]>;
type StoredApp = Partial<MerchantApplication> & { id: string };

// Every id slot empty — what a record looks like before onboarding starts.
const NO_IDS: AdyenIds = {
  legalEntityId: null, accountHolderId: null, balanceAccountId: null,
  merchantAccountId: null, storeId: null, businessLineId: null,
  tenantNumber: null, environment: "test",
};

let stored: StoredApp;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const m of [auth, getApplicationForCustomer, updateApplicationAsCustomer,
                   createAdyenLegalEntity, createAdyenAccountHolder, createAdyenBusinessLine,
                   createAdyenBalanceAccount, createOnboardingLink, updateLegalEntity,
                   pushToHubSpot]) m.mockReset();
  auth.mockResolvedValue(CUSTOMER_SESSION);
  // A stand-in row rather than a static echo: the resumable chain reads the ids
  // back out of what it just wrote, so the stub has to accumulate patches the
  // way the real adapter does.
  stored = { id: "app-1" };
  getApplicationForCustomer.mockImplementation(async () => ({ ...stored }) as MerchantApplication);
  updateApplicationAsCustomer.mockImplementation(async (_u: string, id: string, patch: object) => {
    stored = { ...stored, ...patch, id };
    return { ...stored } as MerchantApplication;
  });
  createAdyenLegalEntity.mockResolvedValue("LE1");
  createAdyenAccountHolder.mockResolvedValue("AH1");
  createAdyenBusinessLine.mockResolvedValue("BL1");
  createAdyenBalanceAccount.mockResolvedValue("BA1");
  createOnboardingLink.mockResolvedValue("https://kyc-test.adyen.com/uo/abc");
  pushToHubSpot.mockRejectedValue(new Error("HUBSPOT_PRIVATE_APP_TOKEN not set"));
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => errorSpy.mockRestore());

const neverCalledAdyen = () => {
  for (const step of [createAdyenLegalEntity, createAdyenAccountHolder,
                      createAdyenBusinessLine, createAdyenBalanceAccount, createOnboardingLink]) {
    expect(step).not.toHaveBeenCalled();
  }
};

describe("saveMyApplicationOnboardingAction — validation gates Adyen", () => {
  it("never calls Adyen when a required field is missing", async () => {
    const result = await saveMyApplicationOnboardingAction("app-1", fields({ zip: "" }));

    neverCalledAdyen();
    expect(result.fieldErrors).toEqual({ "business.zip": expect.any(String) });
    expect(result.adyenReady).toBe(false);
    expect(result.adyenFailed).toBe(false);
  });

  it("never calls Adyen for a present-but-malformed value", async () => {
    const result = await saveMyApplicationOnboardingAction("app-1", fields({ state: "Kalifornia" }));

    neverCalledAdyen();
    expect(result.fieldErrors).toEqual({ "business.state": expect.any(String) });
  });

  // THE ONE THAT MATTERS. A rejected submission must not cost the customer
  // everything they typed — that would be a worse bug than the dead end.
  it("still saves the customer's input when validation fails", async () => {
    await saveMyApplicationOnboardingAction("app-1", fields({ zip: "", legalName: "Torta Palace LLC" }));

    expect(updateApplicationAsCustomer).toHaveBeenCalledTimes(1);
    const [userId, id, patch] = updateApplicationAsCustomer.mock.calls[0];
    expect([userId, id]).toEqual(["cust-1", "app-1"]);
    expect(patch.business.legalName).toBe("Torta Palace LLC");
    expect(patch.business.zip).toBe("");
    expect(patch.ownerContact).toEqual(OWNER);
    expect(patch.processing).toEqual(PROCESSING);
    expect(patch.agreement).toEqual(AGREEMENT);
  });

  it("does not advance the stage when onboarding never started", async () => {
    await saveMyApplicationOnboardingAction("app-1", fields({ zip: "" }));
    expect(updateApplicationAsCustomer.mock.calls[0][2]).not.toHaveProperty("stage");
  });
});

// The checkboxes were enforced in the browser only, so a bypassed client could
// reach Adyen's KYC pages having consented to nothing. lib/consent.ts decides
// what counts; this is only about the gate honouring it.
describe("saveMyApplicationOnboardingAction — consent gates Adyen server-side", () => {
  const unticked = [
    ["neither box", { termsAccepted: false, electronicConsentAccepted: false }],
    ["terms only", { termsAccepted: true, electronicConsentAccepted: false }],
    ["e-consent only", { termsAccepted: false, electronicConsentAccepted: true }],
  ] as const;

  for (const [label, consent] of unticked) {
    it(`never calls Adyen with ${label} accepted`, async () => {
      const result = await saveMyApplicationOnboardingAction(
        "app-1", fields({}, { ...AGREEMENT, ...consent })
      );

      neverCalledAdyen();
      expect(result.fieldErrors).toEqual({ "agreement.consent": expect.any(String) });
      // Consent the customer can give is theirs to fix — not an outage.
      expect(result.adyenFailed).toBe(false);
      expect(result.adyenReady).toBe(false);
    });
  }

  it("refuses an agreement with no recorded author", async () => {
    // Legacy JSONB rows carry no `actor`. Unknown origin is not the merchant's
    // consent (see lib/consent.ts), so it must not open the handoff either.
    const legacy = { ...AGREEMENT } as AgreementInfo;
    delete legacy.actor;

    const result = await saveMyApplicationOnboardingAction("app-1", fields({}, legacy));

    neverCalledAdyen();
    expect(result.fieldErrors).toEqual({ "agreement.consent": expect.any(String) });
  });

  it("still saves the input, and still doesn't advance the stage", async () => {
    await saveMyApplicationOnboardingAction(
      "app-1", fields({}, { ...AGREEMENT, termsAccepted: false })
    );

    expect(updateApplicationAsCustomer).toHaveBeenCalledTimes(1);
    expect(updateApplicationAsCustomer.mock.calls[0][2]).not.toHaveProperty("stage");
    expect(stored.business?.legalName).toBe("Torta Palace LLC");
  });

  it("reports a missing field and missing consent together", async () => {
    const result = await saveMyApplicationOnboardingAction(
      "app-1", fields({ zip: "" }, { ...AGREEMENT, termsAccepted: false })
    );

    expect(Object.keys(result.fieldErrors ?? {}).sort()).toEqual(["agreement.consent", "business.zip"]);
  });
});

describe("saveMyApplicationOnboardingAction — the three outcomes", () => {
  it("reports success with the onboarding URL when Adyen accepts", async () => {
    const result = await saveMyApplicationOnboardingAction("app-1", fields());

    expect(result.fieldErrors).toBeNull();
    expect(result.adyenReady).toBe(true);
    expect(result.adyenFailed).toBe(false);
    expect(result.app.adyenOnboardingUrl).toBe("https://kyc-test.adyen.com/uo/abc");
    expect(stored.adyenIds).toEqual({
      ...NO_IDS, legalEntityId: "LE1", accountHolderId: "AH1",
      businessLineId: "BL1", balanceAccountId: "BA1",
    });
    expect(updateApplicationAsCustomer.mock.calls[0][2].stage).toBe("merchant_filling");
    expect(stored.stage).toBe("adyen_kyc_pending");
  });

  it("reports an Adyen failure as a failure, not as a submitted application", async () => {
    createAdyenLegalEntity.mockRejectedValue(
      new Error("Adyen legal entity creation failed (401): Unauthorized")
    );

    const result = await saveMyApplicationOnboardingAction("app-1", fields());

    expect(result.adyenReady).toBe(false);
    expect(result.adyenFailed).toBe(true);
    expect(result.fieldErrors).toBeNull(); // not the customer's to fix
    // The log is the only trace of a credentials/outage failure — keep it.
    expect(errorSpy).toHaveBeenCalledWith(
      "Adyen onboarding failed:", "Adyen legal entity creation failed (401): Unauthorized"
    );
  });

  it("treats a created entity with no link back as a failure too", async () => {
    // The old dead end: adyenReady was true while adyenOnboardingUrl was empty,
    // so the form rendered a success screen with nothing to click.
    createOnboardingLink.mockResolvedValue("");

    const result = await saveMyApplicationOnboardingAction("app-1", fields());

    expect(result.adyenReady).toBe(false);
    expect(result.adyenFailed).toBe(true);
  });
});

// The chain creates four remote objects. It used to persist nothing until all
// four landed, so the failed-handoff screen's "Try Again" restarted from step
// one and created a SECOND legal entity for the same merchant.
describe("saveMyApplicationOnboardingAction — the chain is resumable", () => {
  it("keeps the ids it earned when a middle step fails", async () => {
    createAdyenAccountHolder.mockRejectedValue(new Error("Adyen account holder creation failed (500): boom"));

    const result = await saveMyApplicationOnboardingAction("app-1", fields());

    expect(result.adyenFailed).toBe(true);
    expect(stored.adyenIds).toEqual({ ...NO_IDS, legalEntityId: "LE1" });
    // Nothing past the break is attempted.
    expect(createAdyenBusinessLine).not.toHaveBeenCalled();
    expect(createAdyenBalanceAccount).not.toHaveBeenCalled();
    expect(createOnboardingLink).not.toHaveBeenCalled();
  });

  it("persists each id as its step returns, not only at the end", async () => {
    createAdyenBalanceAccount.mockRejectedValue(new Error("Adyen balance account creation failed (503): down"));

    await saveMyApplicationOnboardingAction("app-1", fields());

    // One write per object created, in order — that's what makes a retry able to
    // pick up where this one stopped.
    const ids = updateApplicationAsCustomer.mock.calls
      .map((call: unknown[]) => (call[2] as { adyenIds?: AdyenIds }).adyenIds)
      .filter(Boolean);
    expect(ids).toEqual([
      { ...NO_IDS, legalEntityId: "LE1" },
      { ...NO_IDS, legalEntityId: "LE1", accountHolderId: "AH1" },
      { ...NO_IDS, legalEntityId: "LE1", accountHolderId: "AH1", businessLineId: "BL1" },
    ]);
  });

  it("resumes at the break instead of creating a second legal entity", async () => {
    // Where the retry starts from: the first two steps already succeeded.
    stored.adyenIds = { ...NO_IDS, legalEntityId: "LE1", accountHolderId: "AH1" };

    const result = await saveMyApplicationOnboardingAction("app-1", fields());

    expect(createAdyenLegalEntity).not.toHaveBeenCalled();
    expect(createAdyenAccountHolder).not.toHaveBeenCalled();
    // And the steps that do run are handed the ids already on the record.
    expect(createAdyenBusinessLine).toHaveBeenCalledWith(expect.anything(), "LE1");
    expect(createAdyenBalanceAccount).toHaveBeenCalledWith(expect.anything(), "AH1");
    expect(result.adyenReady).toBe(true);
    expect(stored.adyenIds).toEqual({
      ...NO_IDS, legalEntityId: "LE1", accountHolderId: "AH1",
      businessLineId: "BL1", balanceAccountId: "BA1",
    });
  });

  it("creates nothing at all when the whole graph already exists", async () => {
    stored.adyenIds = {
      ...NO_IDS, legalEntityId: "LE1", accountHolderId: "AH1",
      businessLineId: "BL1", balanceAccountId: "BA1",
    };

    const result = await saveMyApplicationOnboardingAction("app-1", fields());

    for (const step of [createAdyenLegalEntity, createAdyenAccountHolder,
                        createAdyenBusinessLine, createAdyenBalanceAccount]) {
      expect(step).not.toHaveBeenCalled();
    }
    expect(result.adyenReady).toBe(true);
  });

  it("mints a FRESH onboarding link rather than re-serving the stored one", async () => {
    // Adyen links are single-use with a ~4-minute fuse, so a resume that handed
    // back the persisted URL would send the merchant to /uo/error/startup-failed.
    stored.adyenIds = {
      ...NO_IDS, legalEntityId: "LE1", accountHolderId: "AH1",
      businessLineId: "BL1", balanceAccountId: "BA1",
    };
    stored.adyenOnboardingUrl = "https://kyc-test.adyen.com/uo/STALE";
    createOnboardingLink.mockResolvedValue("https://kyc-test.adyen.com/uo/FRESH");

    const result = await saveMyApplicationOnboardingAction("app-1", fields());

    expect(createOnboardingLink).toHaveBeenCalledTimes(1);
    expect(createOnboardingLink).toHaveBeenCalledWith("LE1", "app-1");
    expect(result.app.adyenOnboardingUrl).toBe("https://kyc-test.adyen.com/uo/FRESH");
  });

  it("keeps the environment the existing objects actually live in", async () => {
    // The stored environment is a fact about objects Adyen is holding, not a
    // reading of the current config.
    stored.adyenIds = { ...NO_IDS, legalEntityId: "LE1", environment: "live" };

    await saveMyApplicationOnboardingAction("app-1", fields());

    expect(stored.adyenIds?.environment).toBe("live");
  });

  it("leaves the tenant/store slots alone as the chain advances", async () => {
    // applyTenantNumber owns these; a resume must not blank what it wrote.
    stored.adyenIds = {
      ...NO_IDS, legalEntityId: "LE1", accountHolderId: "AH1",
      merchantAccountId: "AIOAppIncPOS", storeId: "ST1", tenantNumber: "1234",
    };

    await saveMyApplicationOnboardingAction("app-1", fields());

    expect(stored.adyenIds).toMatchObject({
      merchantAccountId: "AIOAppIncPOS", storeId: "ST1", tenantNumber: "1234",
    });
  });
});

// The edit path pushes the same registeredAddress to Adyen, and had no
// server-side validation at all — the client's was the only check, and the 422
// it invited went to console.error.
describe("updateMyApplicationDetailsAction — the edit path is gated too", () => {
  beforeEach(() => {
    stored.adyenIds = { ...NO_IDS, legalEntityId: "LE1" };
    stored.adyenOnboardingUrl = "https://kyc-test.adyen.com/uo/abc";
  });

  it("never pushes an invalid address to Adyen", async () => {
    const result = await updateMyApplicationDetailsAction("app-1", fields({ zip: "not a zip" }));

    expect(updateLegalEntity).not.toHaveBeenCalled();
    expect(result.fieldErrors).toEqual({ "business.zip": expect.any(String) });
    expect(result.adyenSynced).toBe(false);
    expect(result.adyenFailed).toBe(false); // the customer's to fix, not an outage
  });

  it("still saves the edit that was rejected", async () => {
    await updateMyApplicationDetailsAction("app-1", fields({ zip: "not a zip" }));
    expect(stored.business?.zip).toBe("not a zip");
  });

  it("never touches the stage, valid or not", async () => {
    await updateMyApplicationDetailsAction("app-1", fields());
    await updateMyApplicationDetailsAction("app-1", fields({ city: "" }));

    for (const [, , patch] of updateApplicationAsCustomer.mock.calls) {
      expect(patch).not.toHaveProperty("stage");
    }
  });

  it("syncs a valid edit and says so", async () => {
    const result = await updateMyApplicationDetailsAction("app-1", fields({ city: "Pasadena" }));

    expect(updateLegalEntity).toHaveBeenCalledWith("LE1", expect.objectContaining({ id: "app-1" }));
    expect(result.adyenSynced).toBe(true);
    expect(result.adyenFailed).toBe(false);
  });

  it("surfaces an Adyen rejection instead of swallowing it", async () => {
    updateLegalEntity.mockRejectedValue(new Error("Adyen legal entity update failed (422): invalid address"));

    const result = await updateMyApplicationDetailsAction("app-1", fields());

    expect(result.adyenSynced).toBe(false);
    expect(result.adyenFailed).toBe(true);
    expect(result.fieldErrors).toBeNull();
  });

  it("reports nothing-to-sync as neither synced nor failed", async () => {
    stored.adyenIds = null;

    const result = await updateMyApplicationDetailsAction("app-1", fields());

    expect(updateLegalEntity).not.toHaveBeenCalled();
    expect(result.adyenSynced).toBe(false);
    expect(result.adyenFailed).toBe(false);
  });

  it("does not re-demand consent to edit a detail", async () => {
    // Editing a phone number can't reach the KYC handoff, and the agreement on
    // the record stands — so the consent gate is deliberately not applied here.
    const legacy = { ...AGREEMENT } as AgreementInfo;
    delete legacy.actor;

    const result = await updateMyApplicationDetailsAction("app-1", fields({}, legacy));

    expect(result.fieldErrors).toBeNull();
    expect(result.adyenSynced).toBe(true);
  });
});
