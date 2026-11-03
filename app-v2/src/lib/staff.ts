import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";

export type StaffRecipient = { id: string; email: string; name: string | null };

const cols = { id: users.id, email: users.email, name: users.name };

/** Every enabled admin: who gets "a quote needs approval". */
export async function listActiveAdminRecipients(): Promise<StaffRecipient[]> {
  return db.select(cols).from(users).where(and(eq(users.role, "admin"), isNull(users.disabledAt)));
}

/** One staff member by id (e.g. the owning rep), or null if missing. */
export async function getStaffRecipient(userId: string): Promise<StaffRecipient | null> {
  const rows = await db.select(cols).from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] ?? null;
}
