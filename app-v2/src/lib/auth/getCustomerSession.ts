import "server-only";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";

/** See getEffectiveRole.ts — same reason, same uuid column. */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * The customer-side counterpart to getEffectiveRole: resolves the session to a
 * live `users` row, or null.
 *
 * Same reasoning — the JWT is never revalidated, so a deleted or disabled
 * customer keeps a working session until it expires, and the failure surfaces
 * at the first write as a foreign-key violation on
 * merchant_applications.customer_user_id rather than as "sign in again".
 *
 * Its own module rather than a helper inside actions/customer.ts because that
 * file is "use server", where every export becomes a callable endpoint.
 */
export const getCustomerSession = cache(async function getCustomerSession(): Promise<{ userId: string } | null> {
  const session = await auth();
  if (!session?.user || session.user.role !== "customer") return null;

  const id = session.user.id;
  if (!id || !isUuid(id)) return null;

  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!user || user.disabledAt || user.role !== "customer") return null;

  return { userId: user.id };
});
