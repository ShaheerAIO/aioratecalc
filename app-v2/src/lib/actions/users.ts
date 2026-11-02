"use server";

import { and, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { hash } from "bcryptjs";
import { db } from "@/lib/db/client";
import {
  users,
  merchantApplications,
  customerLoginTokens,
  marginPolicy,
  quoteTemplatePolicy,
  quoteLimitPolicy,
  rateMatrixPolicy,
  marginReqsPolicy,
  commissionPolicy,
  foodbuyPolicy,
} from "@/lib/db/schema";
import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";

// Staff role — the only roles an admin can assign through user management.
// "customer" is excluded on purpose: customer accounts are created
// automatically via magic-link signup (see auth.ts), never hand-assigned,
// so they can't cross over into/out of the staff roster here.
export type StaffRole = "rep" | "admin";

export type AdminUserSummary = {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  createdAt: string;
  disabledAt: string | null;
  /** When this row was bound to a Microsoft account. Null = not linked yet. */
  entraLinkedAt: string | null;
  /** True for an admin who also has a breakglass password (see lib/auth.ts). */
  hasPassword: boolean;
};

type UserRow = typeof users.$inferSelect;

function rowToSummary(row: UserRow): AdminUserSummary {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as StaffRole,
    createdAt: row.createdAt.toISOString(),
    disabledAt: row.disabledAt ? row.disabledAt.toISOString() : null,
    entraLinkedAt: row.entraLinkedAt ? row.entraLinkedAt.toISOString() : null,
    hasPassword: Boolean(row.passwordHash),
  };
}

async function requireAdmin() {
  const effective = await getEffectiveRole();
  if (!effective || effective.role !== "admin") throw new Error("Admin only");
  return effective;
}

// Reps + admins only — the staff roster. Customer accounts are managed via
// their applications (see the Customers tab / listApplicationsAction), not here.
export async function listStaffUsersAction(): Promise<AdminUserSummary[]> {
  await requireAdmin();
  const rows = await db.select().from(users).where(inArray(users.role, ["rep", "admin"]));
  return rows.map(rowToSummary);
}

// Creates the staff row an Entra sign-in will bind itself to. No password:
// staff authenticate against Entra, and nothing is auto-provisioned there —
// an unprovisioned tenant member is refused, so THIS is the access grant.
// The email must match the person's Microsoft work account (their UPN or mail
// attribute); the first successful sign-in stamps entra_oid onto the row and
// the immutable oid takes over as the match key from then on.
export async function createUserAction(input: {
  email: string;
  name: string;
  role: StaffRole;
}): Promise<AdminUserSummary> {
  await requireAdmin();
  const email = input.email.trim().toLowerCase();
  if (!email) throw new Error("Email is required");
  const [row] = await db
    .insert(users)
    .values({ email, name: input.name.trim(), role: input.role })
    .returning();
  return rowToSummary(row);
}

export async function updateUserRoleAction(id: string, role: StaffRole): Promise<AdminUserSummary> {
  const effective = await requireAdmin();
  if (id === effective.userId) throw new Error("Cannot change your own role");
  const [row] = await db.update(users).set({ role }).where(eq(users.id, id)).returning();
  if (!row) throw new Error("User not found");
  return rowToSummary(row);
}

export async function setUserDisabledAction(id: string, disabled: boolean): Promise<AdminUserSummary> {
  const effective = await requireAdmin();
  if (id === effective.userId && disabled) throw new Error("Cannot disable your own account");
  const [row] = await db
    .update(users)
    .set({ disabledAt: disabled ? new Date() : null })
    .where(eq(users.id, id))
    .returning();
  if (!row) throw new Error("User not found");
  return rowToSummary(row);
}

// Releases a staff row from the Microsoft account it got bound to, so the next
// Entra sign-in can re-link it by email. The recovery path for an "already
// linked to a different Microsoft account" refusal — which happens when a row
// was claimed by the wrong identity (colliding addresses, or a test account).
export async function unlinkEntraAction(id: string): Promise<AdminUserSummary> {
  await requireAdmin();
  const [row] = await db
    .update(users)
    .set({ entraOid: null, entraLinkedAt: null })
    .where(eq(users.id, id))
    .returning();
  if (!row) throw new Error("User not found");
  return rowToSummary(row);
}

// The ONLY remaining staff password is the admin breakglass at
// /login/breakglass — the way back into /admin when Entra is unreachable.
// Reps have no password path at all, so setting one on a rep row would be
// dead weight that only widens the credential surface.
export async function setBreakglassPasswordAction(id: string, password: string): Promise<void> {
  await requireAdmin();
  if (password.length < 12) throw new Error("Breakglass password must be at least 12 characters");
  const [target] = await db.select({ role: users.role }).from(users).where(eq(users.id, id)).limit(1);
  if (!target) throw new Error("User not found");
  if (target.role !== "admin") throw new Error("Only admins can have a breakglass password");
  const passwordHash = await hash(password, 10);
  await db.update(users).set({ passwordHash }).where(eq(users.id, id));
}

// Drops the breakglass password entirely, leaving Entra as the only way in.
// Also how a rep's pre-Entra leftover password gets cleared. Staff only —
// a customer's password is theirs to manage (setCustomerPasswordAction).
export async function clearBreakglassPasswordAction(id: string): Promise<void> {
  await requireAdmin();
  await db
    .update(users)
    .set({ passwordHash: null })
    .where(and(eq(users.id, id), inArray(users.role, ["rep", "admin"])));
}

// Every policy table stamps updated_by_user_id with a plain FK to users, so a
// user who ever saved a policy can't be deleted until those stamps are cleared.
const POLICY_TABLES = [
  marginPolicy,
  quoteTemplatePolicy,
  quoteLimitPolicy,
  rateMatrixPolicy,
  marginReqsPolicy,
  commissionPolicy,
  foodbuyPolicy,
];

function clearPolicyStamps(id: string) {
  return POLICY_TABLES.map(t => db.update(t).set({ updatedByUserId: null }).where(eq(t.updatedByUserId, id)));
}

// Hard-deletes a rep/admin row. merchant_applications.owner_user_id is a
// required FK, so any applications they own move to `reassignToId` first.
// Local DB only — HubSpot deals/owners and AIO dashboard records are untouched.
// One db.batch, so a failure part-way leaves nothing half-done.
export async function deleteStaffUserAction(id: string, reassignToId: string | null): Promise<void> {
  const effective = await requireAdmin();
  if (id === effective.userId) throw new Error("Cannot delete your own account");

  const [target] = await db.select({ role: users.role }).from(users).where(eq(users.id, id)).limit(1);
  if (!target || target.role === "customer") throw new Error("User not found");

  const owned = await db
    .select({ id: merchantApplications.id })
    .from(merchantApplications)
    .where(eq(merchantApplications.ownerUserId, id));
  if (owned.length > 0) {
    if (!reassignToId || reassignToId === id) {
      throw new Error(`This user owns ${owned.length} application(s). Pick someone to reassign them to.`);
    }
    const [to] = await db.select({ role: users.role }).from(users).where(eq(users.id, reassignToId)).limit(1);
    if (!to || to.role === "customer") throw new Error("Reassign target must be a rep or admin");
  }

  const steps: BatchItem<"pg">[] = [];
  if (owned.length > 0) {
    steps.push(db.update(merchantApplications).set({ ownerUserId: reassignToId as string }).where(eq(merchantApplications.ownerUserId, id)));
  }
  steps.push(...clearPolicyStamps(id), db.delete(users).where(eq(users.id, id)));
  await db.batch(steps as [BatchItem<"pg">, ...BatchItem<"pg">[]]);
}

export type CustomerAccountSummary = { id: string; email: string; name: string };

// Customer login accounts, keyed by id, so the Customers tab can show which
// login (if any) is linked to each application.
export async function listCustomerUsersAction(): Promise<CustomerAccountSummary[]> {
  await requireAdmin();
  return db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.role, "customer"));
}

// Hard-deletes a customer login. Their applications stay (they belong to the
// rep) but are unlinked, and every login token for the email is dropped so an
// outstanding magic link can't quietly recreate the account.
export async function deleteCustomerUserAction(id: string): Promise<void> {
  await requireAdmin();
  const [target] = await db.select({ email: users.email, role: users.role }).from(users).where(eq(users.id, id)).limit(1);
  if (!target || target.role !== "customer") throw new Error("Customer account not found");

  await db.batch([
    db.update(merchantApplications).set({ customerUserId: null }).where(eq(merchantApplications.customerUserId, id)),
    db.delete(customerLoginTokens).where(sql`lower(${customerLoginTokens.email}) = ${target.email.trim().toLowerCase()}`),
    ...clearPolicyStamps(id),
    db.delete(users).where(eq(users.id, id)),
  ]);
}
