// DEBUG-AUTO-LOGIN: debug-only test (branch debug/team-preview), never merge.
//
// DEBUG_AUTO_LOGIN treats a visitor with no session as the debug "rep" (or
// whatever the debug_role cookie says) — and only when BOTH it and
// ENABLE_DEBUG_ROLE_SWITCH are "true". Customer routes are never affected.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { users } from "@/lib/db/schema";

type Row = { id: string; email: string; name: string; role: string; disabledAt: Date | null };
let rows: Row[] = [];
let debugCookie: string | undefined;

const db = {
  select: (_fields?: unknown) => ({
    from: (_table: unknown) => ({
      where: (pred: { column: unknown; value: unknown }) => ({
        limit: async () => {
          const key = pred.column === users.id ? "id" : "email";
          const match = rows.find(r => r[key as "id" | "email"] === pred.value);
          return match ? [match] : [];
        },
      }),
    }),
  }),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db }));
vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (debugCookie ? { name, value: debugCookie } : undefined) }),
}));
vi.mock("drizzle-orm", async importOriginal => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual, eq: (column: unknown, value: unknown) => ({ column, value }) };
});

const { getEffectiveRole } = await import("@/lib/auth/getEffectiveRole");
const { authConfig } = await import("@/lib/auth.config");
const { effectiveDebugRole, isDebugAutoLoginEnabled, debugUserEmail } = await import("@/lib/debug/autoLogin");

const REP = { id: "11111111-1111-4111-8111-111111111111", email: "rep@aioapp.com", name: "Rep", role: "rep", disabledAt: null };
const ADMIN = { id: "22222222-2222-4222-8222-222222222222", email: "admin@aioapp.com", name: "Admin", role: "admin", disabledAt: null };
// The dedicated rows auto-login acts as (prod has no seeded rep@/admin@ rows).
const DEBUG_REP = { id: "33333333-3333-4333-8333-333333333333", email: "debug-rep@aioapp.com", name: "Debug Rep", role: "rep", disabledAt: null };
const DEBUG_ADMIN = { id: "44444444-4444-4444-8444-444444444444", email: "debug-admin@aioapp.com", name: "Debug Admin", role: "admin", disabledAt: null };

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["ENABLE_DEBUG_ROLE_SWITCH", "DEBUG_AUTO_LOGIN"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  rows = [REP, ADMIN, DEBUG_REP, DEBUG_ADMIN];
  debugCookie = undefined;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const bothFlags = () => {
  process.env.ENABLE_DEBUG_ROLE_SWITCH = "true";
  process.env.DEBUG_AUTO_LOGIN = "true";
};

// The middleware gate, called the way NextAuth calls it for a visitor with no session.
function authorized(pathname: string, cookie?: string) {
  const request = {
    nextUrl: new URL(`http://localhost${pathname}`),
    cookies: { get: (name: string) => (cookie ? { name, value: cookie } : undefined) },
  };
  return authConfig.callbacks!.authorized!({ auth: null, request } as never);
}

describe("off unless both flags are set", () => {
  it("no flags: an anonymous visitor is nobody, and /rep is closed", async () => {
    expect(isDebugAutoLoginEnabled()).toBe(false);
    expect(effectiveDebugRole(undefined)).toBeNull();
    expect(await getEffectiveRole()).toBeNull();
    expect(authorized("/rep")).toBe(false);
  });

  it("DEBUG_AUTO_LOGIN alone does nothing", async () => {
    process.env.DEBUG_AUTO_LOGIN = "true";
    expect(isDebugAutoLoginEnabled()).toBe(false);
    expect(await getEffectiveRole()).toBeNull();
    expect(authorized("/rep")).toBe(false);
  });

  it("the role switch alone keeps needing a cookie (the old behaviour)", async () => {
    process.env.ENABLE_DEBUG_ROLE_SWITCH = "true";
    expect(await getEffectiveRole()).toBeNull();
    expect(authorized("/rep")).toBe(false);
    debugCookie = "admin";
    // Local dev keeps the seeded <role>@aioapp.com rows.
    expect(debugUserEmail("admin")).toBe("admin@aioapp.com");
    expect(await getEffectiveRole()).toMatchObject({ role: "admin", userId: ADMIN.id, isDebug: true });
  });
});

describe("both flags: auto-login", () => {
  beforeEach(bothFlags);

  it("an anonymous visitor is the dedicated debug rep by default", async () => {
    expect(await getEffectiveRole()).toMatchObject({ role: "rep", userId: DEBUG_REP.id, isDebug: true });
    expect(authorized("/rep")).toBe(true);
    expect(authorized("/admin")).toBe(false);
  });

  it("the debug_role cookie decides: admin", async () => {
    debugCookie = "admin";
    expect(await getEffectiveRole()).toMatchObject({ role: "admin", userId: DEBUG_ADMIN.id, isDebug: true });
    expect(authorized("/admin", "admin")).toBe(true);
  });

  it("maps to debug-<role>@aioapp.com", () => {
    expect(debugUserEmail("rep")).toBe("debug-rep@aioapp.com");
    expect(debugUserEmail("admin")).toBe("debug-admin@aioapp.com");
  });

  it("a missing debug row is logged and falls through to the real session (no other row borrowed)", async () => {
    rows = [REP, ADMIN, DEBUG_ADMIN];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await getEffectiveRole()).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("debug-rep@aioapp.com"));
    error.mockRestore();
  });

  it("customer routes are untouched", () => {
    const res = authorized("/customer/applications/x");
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).headers.get("location")).toContain("/customer/login");
    expect(authorized("/customer/login")).toBe(true);
  });
});
