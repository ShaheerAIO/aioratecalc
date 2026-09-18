import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { users } from "@/lib/db/schema";

// The real merge logic (lib/auth/entra.ts) with only the DB stubbed. What's
// under test is exactly the part that can't be eyeballed: which row an Entra
// identity resolves to, when the link gets written, and which identities are
// refused a session.

type Row = {
  id: string;
  email: string;
  name: string;
  role: string;
  entraOid: string | null;
  disabledAt: Date | null;
};

let rows: Row[] = [];
const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];

// Chainable drizzle stand-in. The resolver only ever selects from `users` by a
// single equality, so `eq` is stubbed to hand back the predicate it was built
// from and this replays it against `rows` — keeping the two-step
// oid-then-email match order observable rather than assumed.
const db = {
  select: (_fields?: unknown) => ({
    from: (_table: unknown) => ({
      where: (pred: { column: unknown; value: unknown }) => ({
        limit: async () => {
          const { column, value } = pred;
          const key = column === users.entraOid ? "entraOid" : "email";
          const match = rows.find(r => r[key as "entraOid" | "email"] === value);
          return match ? [match] : [];
        },
      }),
    }),
  }),
  update: (_table: unknown) => ({
    set: (patch: Record<string, unknown>) => ({
      where: async (pred: { value: unknown }) => {
        const row = rows.find(r => r.id === pred.value);
        if (row) {
          Object.assign(row, patch);
          updates.push({ id: row.id, patch });
        }
      },
    }),
  }),
};

// entra.ts is server-only; under Vitest that package throws on import because
// it resolves to its client build. Stubbing it is enough — the guard exists to
// stop client bundles pulling the module in, which a test isn't.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db }));
vi.mock("drizzle-orm", async importOriginal => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual, eq: (column: unknown, value: unknown) => ({ column, value }) };
});

const { readEntraIdentity, resolveEntraStaffUser, expectedTenantId } = await import("@/lib/auth/entra");

const TENANT = "11111111-2222-3333-4444-555555555555";
const OID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function claims(over: Record<string, unknown> = {}) {
  return { oid: OID, tid: TENANT, email: "joe@aioapp.com", name: "Joe Mendonca", ...over };
}

const ORIGINAL_ISSUER = process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER;

beforeEach(() => {
  rows = [];
  updates.length = 0;
  process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
});

afterEach(() => {
  if (ORIGINAL_ISSUER === undefined) delete process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER;
  else process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER = ORIGINAL_ISSUER;
});

function staffRow(over: Partial<Row> = {}): Row {
  return {
    id: "user-joe",
    email: "joe@aioapp.com",
    name: "Joe Mendonca",
    role: "rep",
    entraOid: null,
    disabledAt: null,
    ...over,
  };
}

describe("expectedTenantId", () => {
  it("parses the tenant out of the issuer", () => {
    expect(expectedTenantId()).toBe(TENANT);
  });

  // "common" is the provider's default when no issuer is configured, and it
  // means "any Microsoft account". Treating it as a tenant would turn the tid
  // check into a guarantee it can't make.
  it("treats the multi-tenant issuers as unconfigured", () => {
    process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER = "https://login.microsoftonline.com/common/v2.0";
    expect(expectedTenantId()).toBeNull();
    process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER = "https://login.microsoftonline.com/organizations/v2.0";
    expect(expectedTenantId()).toBeNull();
  });

  it("is null when no issuer is set at all", () => {
    delete process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER;
    expect(expectedTenantId()).toBeNull();
  });
});

describe("readEntraIdentity", () => {
  it("lowercases the email so the merge key matches regardless of claim casing", () => {
    const id = readEntraIdentity(claims({ email: "Joe.Mendonca@AIOApp.com" }));
    expect(id).toMatchObject({ email: "joe.mendonca@aioapp.com" });
  });

  // Entra only emits `email` when the user has a mail attribute or the app
  // requests it as an optional claim. preferred_username (the UPN) is what's
  // actually always there on a work account.
  it("falls back to preferred_username, then upn, when email is absent", () => {
    expect(readEntraIdentity(claims({ email: undefined, preferred_username: "joe@aioapp.com" })))
      .toMatchObject({ email: "joe@aioapp.com" });
    expect(readEntraIdentity(claims({ email: undefined, upn: "joe@aioapp.com" })))
      .toMatchObject({ email: "joe@aioapp.com" });
  });

  it("refuses a token with no address at all", () => {
    expect(readEntraIdentity(claims({ email: undefined }))).toEqual({ denied: "no_email" });
  });

  it("refuses a token from another tenant", () => {
    expect(readEntraIdentity(claims({ tid: "99999999-9999-9999-9999-999999999999" })))
      .toEqual({ denied: "wrong_tenant" });
  });

  it("accepts any tenant when the issuer isn't pinned", () => {
    delete process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER;
    expect(readEntraIdentity(claims({ tid: "someone-elses-tenant" }))).toMatchObject({
      email: "joe@aioapp.com",
    });
  });

  it("refuses a token with no object id", () => {
    expect(readEntraIdentity(claims({ oid: undefined, sub: undefined })))
      .toEqual({ denied: "no_identity" });
  });
});

describe("resolveEntraStaffUser", () => {
  it("links an existing staff row by email on first sign-in", async () => {
    rows = [staffRow()];
    const result = await resolveEntraStaffUser(claims());

    expect(result).toMatchObject({ ok: true, userId: "user-joe", role: "rep" });
    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toMatchObject({ entraOid: OID });
    expect(updates[0].patch.entraLinkedAt).toBeInstanceOf(Date);
  });

  // The whole reason entra_oid exists. A rep who changes their surname gets a
  // new UPN; matching on email alone would refuse them as unprovisioned while
  // their deals sat on a row keyed to the old address.
  it("matches an already-linked row by oid even after their email changes", async () => {
    rows = [staffRow({ entraOid: OID, email: "joe.mendonca@aioapp.com" })];
    const result = await resolveEntraStaffUser(claims({ email: "joe.newname@aioapp.com" }));

    expect(result).toMatchObject({ ok: true, userId: "user-joe" });
    expect(updates).toHaveLength(0); // already linked — nothing to write
  });

  // The email on file feeds hs_sender_email on published HubSpot quotes, and a
  // published quote can't be amended. Entra's claim must not quietly replace it.
  it("returns the email on file, not the claim's", async () => {
    rows = [staffRow({ entraOid: OID, email: "joe@aioapp.com" })];
    const result = await resolveEntraStaffUser(claims({ email: "joe.alias@aioapp.com" }));
    expect(result).toMatchObject({ ok: true, email: "joe@aioapp.com" });
  });

  // Nothing is auto-provisioned: a rep account can read pillowed margins and
  // push deals to HubSpot, so being in the tenant isn't enough.
  it("refuses a tenant member with no row", async () => {
    rows = [];
    expect(await resolveEntraStaffUser(claims())).toEqual({ ok: false, denied: "not_provisioned" });
    expect(updates).toHaveLength(0);
  });

  it("refuses a customer row reached by a colliding address", async () => {
    rows = [staffRow({ role: "customer" })];
    expect(await resolveEntraStaffUser(claims())).toEqual({ ok: false, denied: "not_staff" });
    expect(updates).toHaveLength(0);
  });

  it("refuses a disabled account", async () => {
    rows = [staffRow({ disabledAt: new Date() })];
    expect(await resolveEntraStaffUser(claims())).toEqual({ ok: false, denied: "disabled" });
    expect(updates).toHaveLength(0);
  });

  // Re-pointing the row would hand one person's deals to another.
  it("refuses when the row belongs to a different Microsoft account", async () => {
    rows = [staffRow({ entraOid: "some-other-oid" })];
    expect(await resolveEntraStaffUser(claims())).toEqual({ ok: false, denied: "oid_conflict" });
    expect(updates).toHaveLength(0);
  });

  it("carries the admin role through", async () => {
    rows = [staffRow({ role: "admin" })];
    expect(await resolveEntraStaffUser(claims())).toMatchObject({ ok: true, role: "admin" });
  });
});
