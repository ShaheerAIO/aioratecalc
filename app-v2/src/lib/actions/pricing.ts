"use server";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { marginPolicy } from "@/lib/db/schema";
import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import { derivePricingForRole, type PaddingConfig, type RoleScopedPricing, type FeeOverrides } from "@/lib/pricing";
import { DEFAULT_MAX_DISCOUNT_PERCENT } from "@/lib/quoting";
import type { StatementAnalysis, ProcessorTier } from "@/types/merchant";

// paddingPct is a proportion (0.5 = +50%). It is persisted in the existing integer
// padding_bps column as basis points of proportion (5000 = 0.50) — no schema change.
const DEFAULT_PADDING: PaddingConfig = { paddingPct: 0.5, paddingMinMrrAdd: 0, paddingAdyenCostHide: true };

export async function getActivePaddingPolicy(): Promise<PaddingConfig> {
  const [row] = await db.select().from(marginPolicy).where(eq(marginPolicy.isActive, true)).limit(1);
  if (!row) return DEFAULT_PADDING;
  return {
    paddingPct: row.paddingBps / 10000,
    paddingMinMrrAdd: Number(row.paddingMinMrrAdd),
    paddingAdyenCostHide: row.paddingAdyenCostHide,
  };
}

export async function updatePaddingPolicyAction(input: PaddingConfig): Promise<void> {
  const effective = await getEffectiveRole();
  if (!effective || effective.role !== "admin") throw new Error("Admin only");

  const [existing] = await db.select({ id: marginPolicy.id }).from(marginPolicy).where(eq(marginPolicy.isActive, true)).limit(1);
  const values = {
    paddingBps: Math.round(input.paddingPct * 10000),
    paddingMinMrrAdd: String(input.paddingMinMrrAdd),
    paddingAdyenCostHide: input.paddingAdyenCostHide,
    updatedByUserId: effective.userId,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(marginPolicy).set(values).where(eq(marginPolicy.id, existing.id));
  } else {
    await db.insert(marginPolicy).values(values);
  }
}

// ── The quote discount cap ──────────────────────────────────────────────────
// Deliberately NOT folded into PaddingConfig: that type is consumed by
// derivePricingForRole on the pricing hot path and is about what a rep may
// SEE. This is about what a rep may GIVE AWAY, it is read at quote-build and
// publish time, and it is not a secret from anyone. Same row, separate
// accessor.

/**
 * The most a rep may discount a single quote line. Falls back to the module
 * default when no policy row exists, for the same reason the quote-template
 * policy does: an unseeded settings table must never be able to block a quote.
 * It fails CLOSED — the fallback is the conservative cap, not 100.
 */
export async function getMaxDiscountPercent(): Promise<number> {
  const [row] = await db.select().from(marginPolicy).where(eq(marginPolicy.isActive, true)).limit(1);
  return row?.maxDiscountPercent ?? DEFAULT_MAX_DISCOUNT_PERCENT;
}

export async function updateMaxDiscountPercentAction(maxDiscountPercent: number): Promise<void> {
  const effective = await getEffectiveRole();
  if (!effective || effective.role !== "admin") throw new Error("Admin only");
  if (!Number.isInteger(maxDiscountPercent) || maxDiscountPercent < 0 || maxDiscountPercent > 100) {
    throw new Error("The discount cap has to be a whole percentage between 0 and 100.");
  }

  const [existing] = await db.select({ id: marginPolicy.id }).from(marginPolicy).where(eq(marginPolicy.isActive, true)).limit(1);
  const values = { maxDiscountPercent, updatedByUserId: effective.userId, updatedAt: new Date() };
  if (existing) {
    await db.update(marginPolicy).set(values).where(eq(marginPolicy.id, existing.id));
  } else {
    await db.insert(marginPolicy).values(values);
  }
}

export async function getPricingPreviewAction(input: {
  analysis: StatementAnalysis;
  targetMargin?: number; // omit on first load → server applies the tier's desired margin
  pricingModel: string;
  feeOverrides: FeeOverrides;
  activeTier: ProcessorTier | null;
}): Promise<RoleScopedPricing> {
  const effective = await getEffectiveRole();
  if (!effective) throw new Error("Not authenticated");
  const padding = await getActivePaddingPolicy();
  return derivePricingForRole(
    input.analysis, input.targetMargin, input.pricingModel, input.feeOverrides,
    effective.role, input.activeTier, padding
  );
}
