import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import type { EntraDenial } from "./entraDenial";

// ── Entra ID (Microsoft 365) staff sign-in ──────────────────────────────────
//
// Staff authenticate against AIO's own Entra tenant; AIO's database still
// decides what they can DO. Entra proves identity, `users.role` grants
// authority. There is deliberately no group/appRole claim plumbing here — a
// rep is a rep because an admin said so at /admin/users, not because of
// directory membership.
//
// Nothing is auto-provisioned. A tenant member with no `users` row is refused,
// because a rep account can read pillowed margins, configure quotes and push
// deals to HubSpot — access that has to be granted deliberately, not inherited
// from being an AIO employee.

/** The claims we use out of the Entra ID token. */
export type EntraClaims = {
  /** Directory object id — immutable, unlike email/UPN. */
  oid?: unknown;
  /** Tenant id the token was issued for. */
  tid?: unknown;
  email?: unknown;
  preferred_username?: unknown;
  upn?: unknown;
  name?: unknown;
  sub?: unknown;
};

export type EntraIdentity = { oid: string; tid: string | null; email: string; name: string };

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * The tenant this deployment accepts, parsed out of the OIDC issuer so there's
 * only one place to configure it. `common` (the provider's default when no
 * issuer is set) means "any Microsoft account" and is NOT a tenant — treated
 * as unconfigured, which makes `tid` checking a no-op rather than a false
 * guarantee. Pin AUTH_MICROSOFT_ENTRA_ID_ISSUER to the real tenant id.
 */
export function expectedTenantId(): string | null {
  const issuer = process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER;
  const tid = issuer?.match(/login\.microsoftonline\.com\/([^/]+)\//)?.[1] ?? null;
  return tid && tid !== "common" && tid !== "organizations" ? tid : null;
}

/**
 * Normalizes the ID token claims into the identity we key on.
 *
 * The email is the merge key, and Entra is unreliable about it: the `email`
 * claim is only emitted when the user has a `mail` attribute or the app
 * registration requests it as an optional claim. `preferred_username` (the UPN)
 * is what's actually always present on a work account, so it's the fallback —
 * without it, an AIO tenant whose users lack `mail` would match nobody.
 */
export function readEntraIdentity(claims: EntraClaims): EntraIdentity | { denied: EntraDenial } {
  const oid = str(claims.oid) ?? str(claims.sub);
  if (!oid) return { denied: "no_identity" };

  const tid = str(claims.tid);
  const expected = expectedTenantId();
  if (expected && tid !== expected) return { denied: "wrong_tenant" };

  const email = (str(claims.email) ?? str(claims.preferred_username) ?? str(claims.upn))?.toLowerCase();
  if (!email) return { denied: "no_email" };

  return { oid, tid, email, name: str(claims.name) ?? email.split("@")[0] };
}

export type EntraResolution =
  | { ok: true; userId: string; email: string; name: string; role: "rep" | "admin" }
  | { ok: false; denied: EntraDenial };

/**
 * Resolves an Entra identity to the AIO staff account it owns, linking the two
 * on first sign-in.
 *
 * Match order matters: `entra_oid` first, email second. Once a row is linked,
 * the immutable oid is authoritative — so someone who changes their surname
 * (and therefore their UPN) in Entra keeps their account and their deals,
 * instead of being refused as unprovisioned while a stale row sits on the
 * old address.
 *
 * Writes on the link, which is why this lives behind the provider's profile()
 * rather than in a pure helper: it's the only hook that has both the claims
 * and the ability to decide which DB row becomes the session.
 */
export async function resolveEntraStaffUser(claims: EntraClaims): Promise<EntraResolution> {
  const identity = readEntraIdentity(claims);
  if ("denied" in identity) return { ok: false, denied: identity.denied };

  const [byOid] = await db.select().from(users).where(eq(users.entraOid, identity.oid)).limit(1);
  const [row] = byOid
    ? [byOid]
    : await db.select().from(users).where(eq(users.email, identity.email)).limit(1);

  if (!row) return { ok: false, denied: "not_provisioned" };

  // Another Entra identity already claimed this row. Refusing is the only safe
  // answer: silently re-pointing it would hand one person's deals to another.
  if (row.entraOid && row.entraOid !== identity.oid) return { ok: false, denied: "oid_conflict" };

  // Customers sign in by magic link, not Entra — they're merchants, external to
  // the tenant. A customer row reached from an AIO-tenant token means the
  // addresses collided (a staff member on file as a merchant contact), and
  // upgrading them to staff here would be a silent privilege grant.
  if (row.role !== "rep" && row.role !== "admin") return { ok: false, denied: "not_staff" };
  if (row.disabledAt) return { ok: false, denied: "disabled" };

  if (!row.entraOid) {
    await db
      .update(users)
      .set({ entraOid: identity.oid, entraLinkedAt: new Date() })
      .where(eq(users.id, row.id));
  }

  // The name comes from Entra (it's the directory's job to be current), but the
  // email stays as it is on file: it feeds hs_sender_email on published HubSpot
  // quotes, and a published quote can't be amended.
  return { ok: true, userId: row.id, email: row.email, name: identity.name || row.name, role: row.role };
}
