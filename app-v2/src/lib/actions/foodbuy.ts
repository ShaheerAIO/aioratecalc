"use server";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { foodbuyPolicy } from "@/lib/db/schema";
import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import { FOODBUY_EMAIL_RE, getFoodbuyRepEmail } from "@/lib/foodbuyPolicy";

async function requireAdmin(): Promise<string> {
  const effective = await getEffectiveRole();
  if (!effective || effective.role !== "admin") throw new Error("Admin only");
  return effective.userId;
}

export async function getFoodbuyRepEmailAction(): Promise<string | null> {
  await requireAdmin();
  return getFoodbuyRepEmail();
}

/** Blank clears it, which turns customer sends off until a new one is set. */
export async function updateFoodbuyRepEmailAction(email: string): Promise<string | null> {
  const userId = await requireAdmin();
  const repEmail = email.trim() || null;
  if (repEmail && !FOODBUY_EMAIL_RE.test(repEmail)) throw new Error("Enter a valid email address.");

  const [existing] = await db.select({ id: foodbuyPolicy.id }).from(foodbuyPolicy).where(eq(foodbuyPolicy.isActive, true)).limit(1);
  const values = { repEmail, updatedByUserId: userId, updatedAt: new Date() };
  if (existing) await db.update(foodbuyPolicy).set(values).where(eq(foodbuyPolicy.id, existing.id));
  else await db.insert(foodbuyPolicy).values(values);
  return repEmail;
}
