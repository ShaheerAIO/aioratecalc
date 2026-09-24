import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MerchantApplication } from "@/types/merchant";

// A failed write must not hand the caller Drizzle's own error. DrizzleQueryError
// puts the whole statement AND every bound parameter in `message`, and the rep
// and customer UIs render a caught `err.message` verbatim — so a foreign-key
// violation on merchant_applications printed the merchant's legal name,
// address, phone and email onto the screen. What went wrong lives on `cause`
// and carries none of that.

// A realistic stand-in for what @neondatabase/serverless + drizzle produce.
const PII = "shaheer.hasnain+2t@aioapp.com";
const CONSTRAINT = 'insert or update on table "merchant_applications" violates foreign key constraint ' +
  '"merchant_applications_owner_user_id_users_id_fk"';

function drizzleFailure(): Error {
  const err = new Error(
    `Failed query: insert into "merchant_applications" ("id", "owner_user_id") values ($1, $2) ` +
    `params: prospect_1790200548084,efb1ffb5-a188-45b2-8672-1d060a6f93f5,{"email":"${PII}"}`
  );
  (err as Error & { cause?: Error }).cause = new Error(CONSTRAINT);
  return err;
}

let failure: Error | null = null;

const throwingWrite = () => {
  if (failure) throw failure;
  return Promise.resolve([]);
};

const db = {
  insert: () => ({
    values: () => ({
      onConflictDoUpdate: throwingWrite,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(throwingWrite()).then(resolve),
    }),
  }),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db }));

const { postgresStorage } = await import("@/lib/storage/postgresAdapter");

const APP = {
  id: "prospect_1790200548084",
  ownerUserId: "efb1ffb5-a188-45b2-8672-1d060a6f93f5",
  customerUserId: null,
  createdAt: "2026-09-23T21:55:48.084Z",
  updatedAt: "2026-09-23T21:55:49.260Z",
  stage: "quote_sent",
  hubspotDealId: null,
  dealLink: null,
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
  ownerContact: { firstName: "Shaheer", lastName: "H", title: "", email: PII, phone: "6692149392" },
  processing: null,
  agreement: null,
} as MerchantApplication;

const scope = { userId: APP.ownerUserId, role: "rep" as const };

beforeEach(() => {
  failure = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("saveApplication error handling", () => {
  it("does not leak the query or its parameters", async () => {
    failure = drizzleFailure();

    const err = await postgresStorage.saveApplication(scope, APP).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(PII);
    expect((err as Error).message).not.toContain("params:");
    expect((err as Error).message).not.toContain("insert into");
  });

  it("keeps the driver's cause, which is the part that says what went wrong", async () => {
    failure = drizzleFailure();

    const err = await postgresStorage.saveApplication(scope, APP).catch((e: Error) => e);

    expect((err as Error).message).toContain("Couldn't save this application.");
    expect((err as Error).message).toContain("merchant_applications_owner_user_id_users_id_fk");
  });

  it("logs the original error server-side so it stays diagnosable", async () => {
    failure = drizzleFailure();

    await postgresStorage.saveApplication(scope, APP).catch(() => {});

    expect(console.error).toHaveBeenCalledWith("[storage] save this application failed", failure);
  });

  it("stays quiet on success", async () => {
    await expect(postgresStorage.saveApplication(scope, APP)).resolves.toBeUndefined();
  });
});
