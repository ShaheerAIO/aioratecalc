import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { DEBUG_ROLE_COOKIE, isDebugRoleSwitchEnabled, parseDebugRole, type DebugRole } from "./debugRole";

export type EffectiveRole = { role: DebugRole; userId: string; name: string; isDebug: boolean };

/**
 * A `users.id` is a uuid column, so anything else can't match a row — and
 * handing Postgres a non-uuid makes it throw `invalid input syntax for type
 * uuid` rather than return nothing. A refused Entra identity carries
 * `id: "entra:denied:<reason>"` (see lib/auth.ts), which is exactly that case.
 */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// DEBUG-ROLE-SWITCHER: Server Components/Actions should call this instead of
// auth() directly when they need to render differently per role, so the
// debug override (local dev only) and the real session both flow through
// one place. See lib/auth/debugRole.ts for the removal note.
//
// A debug role resolves to the real seeded dev account's DB id (not a fake
// string) because merchant_applications.owner_user_id is a strict FK — any
// data written while impersonating must attribute to a real users row.
// This assumes the seed convention in scripts/seed-users.ts (<role>@aioapp.com).
//
// The session itself is re-checked against the database on every request. The
// JWT carries `sub` and `role` and is never revalidated by Auth.js, so a
// session outlives the row it names: an account deleted, disabled or demoted
// after sign-in keeps satisfying middleware (which is edge-side and can't read
// Postgres) and only fails at the first write, as a foreign-key violation on
// owner_user_id. Resolving the row here turns all of that into "not signed in",
// which the callers already handle. It also means `role` is whatever the
// database says right now, not what it said at sign-in.
//
// cache() keeps it to one indexed primary-key lookup per request no matter how
// many callers ask.
export const getEffectiveRole = cache(async function getEffectiveRole(): Promise<EffectiveRole | null> {
  if (isDebugRoleSwitchEnabled()) {
    const store = await cookies();
    const debugRole = parseDebugRole(store.get(DEBUG_ROLE_COOKIE)?.value);
    if (debugRole) {
      const [user] = await db.select().from(users).where(eq(users.email, `${debugRole}@aioapp.com`)).limit(1);
      if (user) return { role: debugRole, userId: user.id, name: `${user.name} (debug)`, isDebug: true };
    }
  }
  const session = await auth();
  if (!session?.user?.role) return null;
  // This resolver is rep/admin-only — a customer session has no rep/admin
  // scope to resolve to. Customer routes/actions call auth() directly.
  // Checked before the query so a customer session costs no round trip.
  if (session.user.role !== "rep" && session.user.role !== "admin") return null;

  const id = session.user.id;
  if (!id || !isUuid(id)) return null;

  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!user || user.disabledAt) return null;
  if (user.role !== "rep" && user.role !== "admin") return null;

  return { role: user.role, userId: user.id, name: user.name, isDebug: false };
});
