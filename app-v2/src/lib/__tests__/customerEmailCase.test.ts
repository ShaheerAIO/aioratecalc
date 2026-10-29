import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { hashSync } from "bcryptjs";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Auth, raw, skipCSRFCheck, type AuthConfig } from "@auth/core";
import { users, customerLoginTokens, merchantApplications } from "@/lib/db/schema";

// Every customer lookup by email, against the case a merchant actually types.
//
// Customer rows are written two ways: the lead-link account form stores the
// email trimmed and lowercased, while the magic-link branch of authorize()
// stores the token's address exactly as the rep typed it. Postgres `=` on text
// is case-sensitive, so each exact lookup failed on a capital letter
// (2026-10-29: "I set the password. The login doesn't work when trying to sign
// back in"). The real code runs here; only Postgres is faked, and the fake runs
// the WHERE clause drizzle actually built, compiled to SQL, with Postgres's own
// semantics: `"t"."c" = $1` is exact and `lower("t"."c") = $1` is not.

type Row = Record<string, unknown> & { id: string };
const tables = new Map<unknown, Row[]>();
const rowsOf = (table: unknown) => tables.get(table)!;

const dialect = new PgDialect();
const camel = (s: string) => s.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
function matches(row: Row, where: SQL): boolean {
  const { sql, params } = dialect.sqlToQuery(where);
  const ci = /^lower\("\w+"\."(\w+)"\) = \$1$/.exec(sql);
  if (ci) return String(row[camel(ci[1])]).toLowerCase() === params[0];
  const exact = /^"\w+"\."(\w+)" = \$1$/.exec(sql);
  if (exact) return row[camel(exact[1])] === params[0];
  throw new Error(`fake db: unexpected predicate: ${sql}`);
}

const DEFAULTS = new Map<unknown, Record<string, unknown>>([
  [users, { passwordHash: null, disabledAt: null }],
  [customerLoginTokens, { usedAt: null, applicationId: null }],
]);

const db = {
  select: () => ({
    from: (table: unknown) => ({
      where: (where: SQL) => ({ limit: async (n: number) => rowsOf(table).filter(r => matches(r, where)).slice(0, n) }),
    }),
  }),
  insert: (table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      const row = { id: randomUUID(), ...DEFAULTS.get(table), ...values } as Row;
      rowsOf(table).push(row);
      return { returning: async () => [row], then: (resolve: (v: unknown) => void) => resolve(undefined) };
    },
  }),
  update: (table: unknown) => ({
    set: (patch: Record<string, unknown>) => ({
      where: async (where: SQL) => {
        for (const r of rowsOf(table).filter(r => matches(r, where))) Object.assign(r, patch);
      },
    }),
  }),
};

const h = vi.hoisted(() => ({
  signInCalls: [] as Array<[string, Record<string, unknown>]>,
  sentTo: [] as string[],
  lead: { id: "app-1", customerUserId: null as string | null, quoteAcceptedAt: new Date() },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db }));
// next-auth's own entry imports next/server, which doesn't resolve under
// Vitest; its providers are thin re-exports of @auth/core's. Capturing the
// config handed to NextAuth() is all that's needed to drive Auth() directly.
vi.mock("next-auth", () => ({
  default: (config: AuthConfig) => {
    (globalThis as { __authConfig?: AuthConfig }).__authConfig = config;
    return { signIn: async (provider: string, opts: Record<string, unknown>) => { h.signInCalls.push([provider, opts]); } };
  },
  AuthError: class AuthError extends Error {},
}));
vi.mock("next-auth/providers/credentials", async () => await import("@auth/core/providers/credentials"));
vi.mock("next-auth/providers/microsoft-entra-id", async () => await import("@auth/core/providers/microsoft-entra-id"));
vi.mock("next/server", () => ({ NextResponse: { redirect: (url: URL) => ({ redirectedTo: String(url) }) } }));
vi.mock("@/lib/adapters/email", () => ({
  sendMagicLinkEmail: async (to: string, url: string) => { h.sentTo.push(to); return { sent: true, devUrl: url }; },
}));
vi.mock("@/lib/leadToken", () => ({ getLeadApplicationByToken: async () => ({ ok: true, row: h.lead }) }));
// customer.ts's other neighbours, none of which the login code touches.
vi.mock("@/lib/storage/postgresAdapter", () => ({ postgresStorage: {} }));
vi.mock("@/lib/adapters/check", () => ({}));
vi.mock("@/lib/adapters/hubspot", () => ({}));
vi.mock("@/lib/billing/acceptance", () => ({}));

await import("@/lib/auth");
const authConfig = (globalThis as { __authConfig?: AuthConfig }).__authConfig!;
const { requestCustomerLoginAction } = await import("@/lib/actions/customer");
const { createAccountFromLeadAction } = await import("@/lib/actions/leadAccount");
const { GET: verifyLink } = await import("@/app/api/customer/verify/route");

/** What signIn("credentials", …) posts to @auth/core. */
async function credentialsSignIn(fields: Record<string, string>) {
  const req = new Request("http://localhost:5001/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, callbackUrl: "/customer" }),
  });
  const res = (await Auth(req, {
    ...authConfig,
    secret: "test-secret-test-secret-test-secret",
    trustHost: true,
    basePath: "/api/auth",
    raw,
    skipCSRFCheck,
  })) as { redirect?: string; cookies?: Array<{ name: string }> };
  return { redirect: res.redirect, sessionCookie: res.cookies?.some(c => c.name.endsWith("session-token")) ?? false };
}

const PASSWORD = "correct horse battery";

function customer(email: string, over: Partial<Row> = {}): Row {
  return { id: randomUUID(), email, name: "ana", role: "customer", passwordHash: hashSync(PASSWORD, 4), disabledAt: null, ...over };
}

function loginToken(email: string): Row {
  return { id: randomUUID(), email, token: randomUUID(), applicationId: null, usedAt: null, expiresAt: new Date(Date.now() + 60_000) };
}

beforeEach(() => {
  tables.set(users, []);
  tables.set(customerLoginTokens, []);
  tables.set(merchantApplications, []);
  h.signInCalls.length = 0;
  h.sentTo.length = 0;
  h.lead.customerUserId = null;
});

describe("customer password sign-in", () => {
  it("signs in with the exact address the account was created with", async () => {
    rowsOf(users).push(customer("ana+t1@tortapalace.com"));
    const res = await credentialsSignIn({ email: "ana+t1@tortapalace.com", password: PASSWORD, scope: "customer" });
    expect(res.redirect).toBe("http://localhost:5001/customer");
    expect(res.sessionCookie).toBe(true);
  });

  // The reported bug. createAccountFromLeadAction stores trim().toLowerCase().
  it("finds a lead-link account whatever case or spacing the email is typed in", async () => {
    rowsOf(users).push(customer("ana+t1@tortapalace.com"));
    const res = await credentialsSignIn({ email: " Ana+T1@TortaPalace.com ", password: PASSWORD, scope: "customer" });
    expect(res.redirect).toBe("http://localhost:5001/customer");
    expect(res.sessionCookie).toBe(true);
  });

  // The magic-link path creates the row from the address the rep typed, case
  // and all — those accounts must keep working however they're typed too.
  it("finds a mixed-case account created by a magic link when typed in lowercase", async () => {
    rowsOf(users).push(customer("Ana@TortaPalace.com"));
    const res = await credentialsSignIn({ email: "ana@tortapalace.com", password: PASSWORD, scope: "customer" });
    expect(res.redirect).toBe("http://localhost:5001/customer");
  });

  it("still refuses a wrong password", async () => {
    rowsOf(users).push(customer("ana@tortapalace.com"));
    await expect(credentialsSignIn({ email: "Ana@TortaPalace.com", password: "wrong password", scope: "customer" }))
      .rejects.toMatchObject({ type: "CredentialsSignin" });
  });

  it("still refuses a customer row on the admin breakglass scope", async () => {
    rowsOf(users).push(customer("ana@tortapalace.com"));
    await expect(credentialsSignIn({ email: "ana@tortapalace.com", password: PASSWORD, scope: "breakglass" }))
      .rejects.toMatchObject({ type: "CredentialsSignin" });
  });
});

describe("customer magic link", () => {
  it("sends a link to a differently-cased address, and the link signs in to that account", async () => {
    const account = customer("ana+t1@tortapalace.com");
    rowsOf(users).push(account);

    await requestCustomerLoginAction(" Ana+T1@TortaPalace.com ");

    // Sent, and stored under the row's own address rather than the typed one.
    expect(h.sentTo).toEqual(["ana+t1@tortapalace.com"]);
    const [token] = rowsOf(customerLoginTokens);
    expect(token).toMatchObject({ email: "ana+t1@tortapalace.com" });

    const res = await credentialsSignIn({ magicToken: String(token.token) });
    expect(res.redirect).toBe("http://localhost:5001/customer");
    expect(res.sessionCookie).toBe(true);
    expect(token.usedAt).toBeInstanceOf(Date);
    expect(rowsOf(users)).toEqual([account]); // signed in to it, no second account
  });

  it("still sends nothing for an address with no customer account", async () => {
    rowsOf(users).push(customer("ana@tortapalace.com", { role: "admin" }));
    await requestCustomerLoginAction("Ana@TortaPalace.com");
    await requestCustomerLoginAction("nobody@tortapalace.com");
    expect(h.sentTo).toEqual([]);
    expect(rowsOf(customerLoginTokens)).toEqual([]);
  });

  // Acceptance and the rep's "send link" mint tokens from ownerContact.email as
  // the rep typed it. An exact lookup missed the merchant's existing account
  // and created a second one under the other casing.
  it("resolves a rep-cased acceptance token to the existing account instead of creating another", async () => {
    const account = customer("ana@tortapalace.com");
    rowsOf(users).push(account);
    const token = loginToken("Ana@TortaPalace.com");
    rowsOf(customerLoginTokens).push(token);

    const res = await credentialsSignIn({ magicToken: String(token.token) });
    expect(res.sessionCookie).toBe(true);
    expect(rowsOf(users)).toEqual([account]);
  });

  it("does not send a merchant who already has a password through set-password", async () => {
    rowsOf(users).push(customer("ana@tortapalace.com"));
    const token = loginToken("Ana@TortaPalace.com");
    rowsOf(customerLoginTokens).push(token);

    const url = new URL(`http://localhost:5001/api/customer/verify?token=${token.token}`);
    await verifyLink({ nextUrl: url, url: String(url) } as never);
    expect(h.signInCalls).toEqual([["credentials", { magicToken: token.token, redirectTo: "/customer" }]]);
  });
});

describe("lead-link account creation", () => {
  it("treats a differently-cased existing account as taken instead of creating a second one", async () => {
    rowsOf(users).push(customer("Ana@TortaPalace.com", { passwordHash: null }));
    const result = await createAccountFromLeadAction("lead-token", { email: "ana@tortapalace.com", password: PASSWORD });
    expect(result).toBe("That email is already in use. Sign in, or use a different email.");
    expect(rowsOf(users)).toHaveLength(1);
  });
});
