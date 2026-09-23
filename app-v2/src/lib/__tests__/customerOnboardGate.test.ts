import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  MerchantApplication,
  BusinessInfo,
  OwnerContact,
  ProcessingInfo,
  AgreementInfo,
} from "@/types/merchant";

// saveMyApplicationOnboardingAction / updateMyApplicationDetailsAction, with
// their collaborators stubbed the way customerQuote.test.ts stubs them.
//
// What used to be under test here was a four-object Adyen chain: whether it
// ran, whether it resumed, whether it duplicated. All of that is gone —
// EasyOB no longer creates Adyen objects, because doing so produced accounts
// misnamed and unlinked from the AIO tenant graph. AIO's platform provisions
// them, and only after billing is paid (lib/aio/provision.ts).
//
// So the gate under test is now narrower but still load-bearing: validation
// and consent still decide whether the submission counts, and — the new
// invariant — submitting details must reach NO remote provisioning system at
// all. If that ever regresses, a merchant gets an Adyen account before they
// have paid, from the system we just stopped letting create them.

const auth = vi.fn();
const getApplicationForCustomer = vi.fn();
const updateApplicationAsCustomer = vi.fn();
const syncDealFromApplication = vi.fn();
const provisionAioTenant = vi.fn();
const createAioBusiness = vi.fn();

vi.mock("@/lib/auth", () => ({ auth, signIn: vi.fn() }));
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/storage/postgresAdapter", () => ({
  postgresStorage: { getApplicationForCustomer, updateApplicationAsCustomer },
}));
vi.mock("@/lib/adapters/email", () => ({ sendMagicLinkEmail: vi.fn() }));
vi.mock("@/lib/adapters/check", () => ({
  checkEnvironment: vi.fn(), createCheckCompany: vi.fn(),
  createCheckOnboardLink: vi.fn(), getCheckOnboardStatus: vi.fn(),
}));
// Stubbed purely so the "nothing provisions here" assertions can prove it.
vi.mock("@/lib/aio/provision", () => ({ provisionAioTenant }));
vi.mock("@/lib/adapters/aioDashboard", () => ({
  createAioBusiness,
  createAioLocation: vi.fn(),
  createAioAdyenOnboardingLink: vi.fn(),
  findAioBusinessByAlias: vi.fn(),
  aioDashboardEnabled: () => false,
  aioBusinessAlias: (a: { id: string }) => `easyob_${a.id}`,
  aioEnvironment: () => "internal",
  adyenEnvironmentFromOnboardingUrl: () => "test",
}));
vi.mock("@/lib/adapters/hubspot", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/adapters/hubspot")>()),
  syncDealFromApplication,
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

type StoredApp = Partial<MerchantApplication> & { id: string };

let stored: StoredApp;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const m of [auth, getApplicationForCustomer, updateApplicationAsCustomer,
                   syncDealFromApplication, provisionAioTenant, createAioBusiness]) m.mockReset();
  auth.mockResolvedValue(CUSTOMER_SESSION);
  stored = { id: "app-1" };
  getApplicationForCustomer.mockImplementation(async () => ({ ...stored }) as MerchantApplication);
  updateApplicationAsCustomer.mockImplementation(async (_u: string, id: string, patch: object) => {
    stored = { ...stored, ...patch, id };
    return { ...stored } as MerchantApplication;
  });
  syncDealFromApplication.mockRejectedValue(new Error("HUBSPOT_PRIVATE_APP_TOKEN not set"));
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => errorSpy.mockRestore());

/** The invariant that replaced the old Adyen-chain assertions: submitting
 *  details provisions nothing, anywhere. */
const provisionedNothing = () => {
  expect(provisionAioTenant).not.toHaveBeenCalled();
  expect(createAioBusiness).not.toHaveBeenCalled();
};

describe("saveMyApplicationOnboardingAction — validation gates the submission", () => {
  it("rejects a missing required field", async () => {
    const r = await saveMyApplicationOnboardingAction("app-1", fields({ address: "" }));
    expect(r.fieldErrors).toBeTruthy();
    provisionedNothing();
  });

  it("rejects a present-but-malformed value", async () => {
    const r = await saveMyApplicationOnboardingAction("app-1", fields({ zip: "9001" }));
    expect(r.fieldErrors).toBeTruthy();
    provisionedNothing();
  });

  it("still saves the customer's input when validation fails", async () => {
    await saveMyApplicationOnboardingAction("app-1", fields({ address: "" }));
    expect(updateApplicationAsCustomer).toHaveBeenCalled();
    expect(stored.ownerContact).toEqual(OWNER);
    expect(stored.processing).toEqual(PROCESSING);
  });

  it("does not advance the stage when validation fails", async () => {
    await saveMyApplicationOnboardingAction("app-1", fields({ address: "" }));
    expect(stored.stage).toBeUndefined();
  });

  it("advances to merchant_filling on a clean submission", async () => {
    const r = await saveMyApplicationOnboardingAction("app-1", fields());
    expect(r.fieldErrors).toBeNull();
    expect(stored.stage).toBe("merchant_filling");
  });
});

describe("saveMyApplicationOnboardingAction — consent is still enforced server-side", () => {
  const withoutConsent: [string, AgreementInfo][] = [
    ["terms not", { ...AGREEMENT, termsAccepted: false }],
    ["e-sign not", { ...AGREEMENT, electronicConsentAccepted: false }],
    ["neither", { ...AGREEMENT, termsAccepted: false, electronicConsentAccepted: false }],
  ];

  for (const [label, agreement] of withoutConsent) {
    it(`refuses the submission with ${label} accepted`, async () => {
      const r = await saveMyApplicationOnboardingAction("app-1", fields({}, agreement));
      expect(r.fieldErrors).toBeTruthy();
      expect(stored.stage).toBeUndefined();
      provisionedNothing();
    });
  }

  it("refuses an agreement with no recorded author", async () => {
    const r = await saveMyApplicationOnboardingAction("app-1", fields({}, { ...AGREEMENT, actor: null as never }));
    expect(r.fieldErrors).toBeTruthy();
  });

  it("reports a missing field and missing consent together", async () => {
    const r = await saveMyApplicationOnboardingAction(
      "app-1",
      fields({ address: "" }, { ...AGREEMENT, termsAccepted: false })
    );
    expect(Object.keys(r.fieldErrors ?? {}).length).toBeGreaterThan(1);
  });
});

describe("saveMyApplicationOnboardingAction — nothing is provisioned here", () => {
  // The ordering inversion this change introduced. Details come in early;
  // the Adyen account is created later, by AIO, once billing is paid.
  it("provisions nothing even on a perfectly valid submission", async () => {
    const r = await saveMyApplicationOnboardingAction("app-1", fields());
    expect(r.fieldErrors).toBeNull();
    provisionedNothing();
  });

  it("writes no onboarding URL and no Adyen ids", async () => {
    await saveMyApplicationOnboardingAction("app-1", fields());
    expect(stored.adyenOnboardingUrl).toBeUndefined();
    expect(stored.adyenIds).toBeUndefined();
    expect(stored.aioTenant).toBeUndefined();
  });

  it("never reaches adyen_kyc_pending — only provisioning sets that", async () => {
    await saveMyApplicationOnboardingAction("app-1", fields());
    expect(stored.stage).toBe("merchant_filling");
  });

  it("returns only the app and the field errors", async () => {
    const r = await saveMyApplicationOnboardingAction("app-1", fields());
    expect(Object.keys(r).sort()).toEqual(["app", "fieldErrors"]);
  });
});

describe("updateMyApplicationDetailsAction — the edit path", () => {
  beforeEach(() => {
    stored = { id: "app-1", aioTenant: { businessId: 5217, provisionedAt: "2026-09-23" } as never };
  });

  it("rejects an invalid address", async () => {
    const r = await updateMyApplicationDetailsAction("app-1", fields({ zip: "abc" }));
    expect(r.fieldErrors).toBeTruthy();
  });

  it("still saves the edit that was rejected", async () => {
    await updateMyApplicationDetailsAction("app-1", fields({ zip: "abc" }));
    expect(stored.ownerContact).toEqual(OWNER);
  });

  it("never touches the stage, valid or not", async () => {
    await updateMyApplicationDetailsAction("app-1", fields());
    expect(stored.stage).toBeUndefined();
    await updateMyApplicationDetailsAction("app-1", fields({ zip: "abc" }));
    expect(stored.stage).toBeUndefined();
  });

  it("does not re-demand consent to edit a detail", async () => {
    const r = await updateMyApplicationDetailsAction(
      "app-1",
      fields({}, { ...AGREEMENT, termsAccepted: false, electronicConsentAccepted: false })
    );
    expect(r.fieldErrors).toBeNull();
  });

  it("pushes nothing to AIO — an edit changes our record, not the one Adyen holds", async () => {
    await updateMyApplicationDetailsAction("app-1", fields());
    provisionedNothing();
  });

  it("returns only the app and the field errors", async () => {
    const r = await updateMyApplicationDetailsAction("app-1", fields());
    expect(Object.keys(r).sort()).toEqual(["app", "fieldErrors"]);
  });
});
