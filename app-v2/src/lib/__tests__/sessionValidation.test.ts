import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { users } from "@/lib/db/schema";

// Two halves of the same failure mode: a session whose `sub` is not a live
// `users.id`. The first half is how that happened (@auth/core discards the id
// our Entra profile() returns); the second is the guard that turns any future
// recurrence into "sign in again" instead of a foreign-key violation on
// merchant_applications.owner_user_id.

type Row = {
  id: string;
  email: string;
  name: string;
  role: string;
  disabledAt: Date | null;
};

let rows: Row[] = [];
let session: unknown = null;
let debugCookie: string | undefined;

// Chainable drizzle stand-in. Both resolvers do exactly one equality select
// on `users`, so replaying the predicate against `rows` is enough — and it
// keeps "which column was matched on" observable.
const db = {
  select: (_fields?: unknown) => ({
    from: (_table: unknown) => ({
      where: (pred: { column: unknown; value: unknown }) => ({
        limit: async () => {
          const { column, value } = pred;
          const key = column === users.id ? "id" : "email";
          const match = rows.find(r => r[key as "id" | "email"] === value);
          return match ? [match] : [];
        },
      }),
    }),
  }),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db }));
vi.mock("@/lib/auth", () => ({ auth: async () => session }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (debugCookie ? { name, value: debugCookie } : undefined) }),
}));
vi.mock("drizzle-orm", async importOriginal => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual, eq: (column: unknown, value: unknown) => ({ column, value }) };
});

const { getEffectiveRole } = await import("@/lib/auth/getEffectiveRole");
const { getCustomerSession } = await import("@/lib/auth/getCustomerSession");
const { authConfig } = await import("@/lib/auth.config");

const AIO_ID = "399711ca-517a-477e-870f-fdfc786a3c97";

function staffRow(over: Partial<Row> = {}): Row {
  return { id: AIO_ID, email: "rep@aioapp.com", name: "Rep", role: "rep", disabledAt: null, ...over };
}

function staffSession(over: Record<string, unknown> = {}) {
  return { user: { id: AIO_ID, role: "rep", name: "Rep", email: "rep@aioapp.com", ...over } };
}

beforeEach(() => {
  rows = [];
  session = null;
  debugCookie = undefined;
  delete process.env.ENABLE_DEBUG_ROLE_SWITCH;
});

// ── The bug itself ──────────────────────────────────────────────────────────
// @auth/core builds the sign-in user as `{ ...profile(), id: crypto.randomUUID() }`
// for every OAuth provider (lib/actions/callback/oauth/callback.js), then seeds
// the token's `sub` from that id. Modelling the clobber rather than trusting
// profile()'s return is the whole point — asserting on profile() alone passed
// happily while every staff session named a user that did not exist.
describe("jwt callback: the AIO user id survives @auth/core's id clobber", () => {
  const jwt = authConfig.callbacks!.jwt!;

  function signIn(user: Record<string, unknown>) {
    // Exactly what @auth/core passes: the token pre-seeded from user.id.
    return jwt({ token: { sub: user.id as string }, user } as never) as Promise<{ sub?: string }>;
  }

  it("restores sub from aioUserId on an Entra sign-in", async () => {
    const fromProfile = { id: AIO_ID, aioUserId: AIO_ID, email: "rep@aioapp.com", name: "Rep", role: "rep" };
    const clobbered = { ...fromProfile, id: randomUUID() };

    const token = await signIn(clobbered);

    expect(token.sub).toBe(AIO_ID);
    expect(token.sub).not.toBe(clobbered.id);
  });

  it("mints a different random id each time, so sub must not be left as-is", async () => {
    const base = { aioUserId: AIO_ID, role: "rep" };
    const first = await signIn({ ...base, id: randomUUID() });
    const second = await signIn({ ...base, id: randomUUID() });

    expect(first.sub).toBe(AIO_ID);
    expect(second.sub).toBe(AIO_ID);
  });

  it("leaves sub alone for credentials sign-ins, which carry a real id already", async () => {
    // authorize() returns the row's own id and @auth/core keeps it, so there
    // is no aioUserId on this path and nothing to restore.
    const token = await signIn({ id: AIO_ID, role: "customer", email: "customer@aioapp.com" });

    expect(token.sub).toBe(AIO_ID);
  });

  it("carries the role through", async () => {
    const token = (await signIn({ id: randomUUID(), aioUserId: AIO_ID, role: "admin" })) as { role?: string };
    expect(token.role).toBe("admin");
  });
});

// ── The guard ───────────────────────────────────────────────────────────────
describe("getEffectiveRole", () => {
  it("resolves a live staff row", async () => {
    rows = [staffRow()];
    session = staffSession();

    expect(await getEffectiveRole()).toEqual({ role: "rep", userId: AIO_ID, name: "Rep", isDebug: false });
  });

  it("refuses a session whose users row is gone", async () => {
    rows = [];
    session = staffSession();

    expect(await getEffectiveRole()).toBeNull();
  });

  it("refuses a disabled account, ending the live session", async () => {
    rows = [staffRow({ disabledAt: new Date() })];
    session = staffSession();

    expect(await getEffectiveRole()).toBeNull();
  });

  it("takes the role from the database, not the token", async () => {
    // Demoted at /admin/users after signing in — the JWT still says admin.
    rows = [staffRow({ role: "rep" })];
    session = staffSession({ role: "admin" });

    expect((await getEffectiveRole())?.role).toBe("rep");
  });

  it("refuses a row demoted to customer", async () => {
    rows = [staffRow({ role: "customer" })];
    session = staffSession();

    expect(await getEffectiveRole()).toBeNull();
  });

  it("refuses a non-uuid sub without querying", async () => {
    // A refused Entra identity carries id "entra:denied:<reason>". Handing
    // that to a uuid column throws `invalid input syntax for type uuid`.
    const select = vi.spyOn(db, "select");
    rows = [staffRow()];
    session = staffSession({ id: "entra:denied:not_provisioned" });

    expect(await getEffectiveRole()).toBeNull();
    expect(select).not.toHaveBeenCalled();
    select.mockRestore();
  });

  it("short-circuits a customer session without a database read", async () => {
    const select = vi.spyOn(db, "select");
    session = staffSession({ role: "customer" });

    expect(await getEffectiveRole()).toBeNull();
    expect(select).not.toHaveBeenCalled();
    select.mockRestore();
  });

  it("returns null with no session at all", async () => {
    session = null;
    expect(await getEffectiveRole()).toBeNull();
  });
});

describe("getCustomerSession", () => {
  const CUSTOMER_ID = "99933e9f-3dba-4b49-976f-7b764342277a";

  function customerRow(over: Partial<Row> = {}): Row {
    return {
      id: CUSTOMER_ID, email: "customer@aioapp.com", name: "Cust", role: "customer", disabledAt: null, ...over,
    };
  }

  it("resolves a live customer row", async () => {
    rows = [customerRow()];
    session = { user: { id: CUSTOMER_ID, role: "customer" } };

    expect(await getCustomerSession()).toEqual({ userId: CUSTOMER_ID });
  });

  it("refuses a deleted customer — the customer_user_id FK is just as strict", async () => {
    rows = [];
    session = { user: { id: CUSTOMER_ID, role: "customer" } };

    expect(await getCustomerSession()).toBeNull();
  });

  it("refuses a disabled customer", async () => {
    rows = [customerRow({ disabledAt: new Date() })];
    session = { user: { id: CUSTOMER_ID, role: "customer" } };

    expect(await getCustomerSession()).toBeNull();
  });

  it("refuses a staff session", async () => {
    rows = [staffRow()];
    session = staffSession();

    expect(await getCustomerSession()).toBeNull();
  });
});
