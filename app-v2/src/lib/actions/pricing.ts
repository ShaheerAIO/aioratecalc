"use server";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { marginPolicy, quoteLimitPolicy } from "@/lib/db/schema";
import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import {
  analysisFromQuoteConfig, derivePricingForRole,
  type PaddingConfig, type RoleScopedPricing, type FeeOverrides,
} from "@/lib/pricing";
import {
  DEFAULT_MAX_APPROVED_DELAY_DAYS, DEFAULT_MAX_DISCOUNT_PERCENT, DEFAULT_UNIT_CAPS,
  MAX_BILLING_DELAY_DAYS, type QuoteLimits,
} from "@/lib/quoting";
import type { StatementAnalysis, ProcessorTier, QuoteConfig, QuoteRates } from "@/types/merchant";

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
  /**
   * The statement, when there is one. `quoteConfig` is the alternative for a
   * rep who has typed a volume and a ticket instead — the conversion happens
   * HERE rather than in the caller, because `analysisFromQuoteConfig` lives in
   * pricing.ts next to the true MARGIN_REQS table, and a client component that
   * imported it would ship AIO's real floors to the browser.
   */
  analysis?: StatementAnalysis | null;
  quoteConfig?: QuoteConfig | null;
  // The rates the rep has typed. Omitted means "the standard rate" —
  // DEFAULT_QUOTE_RATES — not "work one out from a margin", which is what the
  // omitted targetMargin this replaced used to mean.
  quoteRates?: QuoteRates | null;
  pricingModel: string;
  feeOverrides: FeeOverrides;
  activeTier: ProcessorTier | null;
}): Promise<RoleScopedPricing> {
  const effective = await getEffectiveRole();
  if (!effective) throw new Error("Not authenticated");
  const analysis = input.analysis ?? (input.quoteConfig ? analysisFromQuoteConfig(input.quoteConfig) : null);
  if (!analysis) throw new Error("A statement or a volume and ticket is needed to price a quote.");
  const padding = await getActivePaddingPolicy();
  return derivePricingForRole(
    analysis, input.quoteRates, input.pricingModel, input.feeOverrides,
    effective.role, input.activeTier, padding
  );
}

// ── Quantity caps and the billing-delay ceiling ─────────────────────────────
// Their own table (`quote_limit_policy`) rather than more columns on
// margin_policy: that row is about AIO's margin — what a rep may see of it and
// give away of it. A quantity ceiling catches a typo in a quantity box, and a
// delay ceiling is a question about commitment. Neither is a margin secret;
// both are shown to the rep in the blocker that refuses the quote.

/**
 * The active limits, or the module defaults when nothing has been saved yet.
 *
 * Fails to the DEFAULTS, not to "no limit": an unseeded settings table must
 * never be able to block a quote, and must not silently uncap one either. Same
 * posture as `getMaxDiscountPercent` and the quote-template policy.
 */
export async function getQuoteLimits(): Promise<QuoteLimits> {
  const fallback = { unitCaps: DEFAULT_UNIT_CAPS, maxBillingDelayDays: DEFAULT_MAX_APPROVED_DELAY_DAYS };
  // The READ is wrapped, not just the empty case. `saveQuoteConfigurationAction`
  // awaits this alongside the discount cap with no catch of its own, so a
  // database that has not run migration 0019 yet — a preview branch, a local
  // DB, the window between deploy and migrate — would otherwise take the whole
  // save down rather than falling back to the limits in code.
  let row;
  try {
    [row] = await db.select().from(quoteLimitPolicy).where(eq(quoteLimitPolicy.isActive, true)).limit(1);
  } catch (err) {
    console.error("[quote-limits] could not read quote_limit_policy; using the defaults in code", err);
    return fallback;
  }
  if (!row) return fallback;
  // An empty map is a real answer ("an admin removed every cap"), so it is
  // kept rather than falling through to the defaults — but a row written
  // before this column existed, or one whose jsonb came back as something
  // other than an object, is not an answer at all.
  const caps = row.unitCaps;
  return {
    unitCaps: caps && typeof caps === "object" && !Array.isArray(caps) ? caps : DEFAULT_UNIT_CAPS,
    maxBillingDelayDays: row.maxBillingDelayDays || DEFAULT_MAX_APPROVED_DELAY_DAYS,
  };
}

export async function updateQuoteLimitsAction(input: QuoteLimits): Promise<void> {
  const effective = await getEffectiveRole();
  if (!effective || effective.role !== "admin") throw new Error("Admin only");

  if (
    !Number.isInteger(input.maxBillingDelayDays) ||
    input.maxBillingDelayDays < 1 ||
    input.maxBillingDelayDays > MAX_BILLING_DELAY_DAYS
  ) {
    throw new Error(
      `The billing-delay limit has to be a whole number of days between 1 and ${MAX_BILLING_DELAY_DAYS} — ` +
      `HubSpot will not accept a start further out than that.`
    );
  }
  // A cap of 0 or a fraction would refuse every quote carrying the product,
  // with a blocker reading "a merchant can only have 0". Removing the entry is
  // how you uncap something.
  const unitCaps: Record<string, number> = {};
  for (const [productId, cap] of Object.entries(input.unitCaps ?? {})) {
    if (!Number.isInteger(cap) || cap < 1) {
      throw new Error(`The cap on product ${productId} has to be a whole number of 1 or more, or removed entirely.`);
    }
    unitCaps[productId] = cap;
  }

  const [existing] = await db.select({ id: quoteLimitPolicy.id }).from(quoteLimitPolicy).where(eq(quoteLimitPolicy.isActive, true)).limit(1);
  const values = {
    unitCaps,
    maxBillingDelayDays: input.maxBillingDelayDays,
    updatedByUserId: effective.userId,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(quoteLimitPolicy).set(values).where(eq(quoteLimitPolicy.id, existing.id));
  } else {
    await db.insert(quoteLimitPolicy).values(values);
  }
}
