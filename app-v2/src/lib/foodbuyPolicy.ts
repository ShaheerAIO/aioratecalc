// The Foodbuy rep's address, read on the server only. Deliberately NOT in a
// "use server" file: anything exported from one is callable from any browser,
// and the customer's send route must be able to read this without handing the
// address to every signed-in customer. The admin-facing actions are in
// actions/foodbuy.ts.
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { foodbuyPolicy } from "@/lib/db/schema";

export const FOODBUY_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The configured address, or null when none is set. Fails to null, not to a
 * throw: a database that hasn't run migration 0030 yet must read as "not set
 * up", which the send route turns into a message the customer can act on.
 */
export async function getFoodbuyRepEmail(): Promise<string | null> {
  try {
    const [row] = await db.select().from(foodbuyPolicy).where(eq(foodbuyPolicy.isActive, true)).limit(1);
    return row?.repEmail?.trim() || null;
  } catch (err) {
    console.error("[foodbuy] could not read foodbuy_policy; treating as not configured", err);
    return null;
  }
}
