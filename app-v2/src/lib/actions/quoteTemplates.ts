"use server";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { quoteTemplatePolicy } from "@/lib/db/schema";
import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import { listQuoteTemplates, type QuoteTemplate } from "@/lib/adapters/hubspot";
import type { QuoteType } from "@/types/merchant";

// Seeded defaults — see app-v2/PHASE-E-SPEC.md §3.4/§10 O-1. These are the
// fallback used whenever no policy row exists yet, so a fresh environment (or
// one where the migration hasn't been applied) can still publish a Phase E
// quote instead of hard-failing on a missing settings row.
const DEFAULT_TEMPLATE_IDS: Record<QuoteType, string> = {
  full_pos: "817263673055",
  food_truck: "817263673055",
  marketing_only: "817697352408",
};

export type QuoteTemplatePolicy = Record<QuoteType, string>;

function rowToPolicy(row: typeof quoteTemplatePolicy.$inferSelect): QuoteTemplatePolicy {
  return {
    full_pos: row.fullPosTemplateId,
    food_truck: row.foodTruckTemplateId,
    marketing_only: row.marketingOnlyTemplateId,
  };
}

/**
 * The active QuoteType → HubSpot quote_template mapping. Falls back to the
 * hardcoded defaults when no row exists (unseeded table, or the migration
 * hasn't been run yet) — Phase E's publish path must never be blocked by a
 * missing settings row.
 */
export async function getQuoteTemplatePolicy(): Promise<QuoteTemplatePolicy> {
  const [row] = await db.select().from(quoteTemplatePolicy).where(eq(quoteTemplatePolicy.isActive, true)).limit(1);
  if (!row) return { ...DEFAULT_TEMPLATE_IDS };
  return rowToPolicy(row);
}

export async function updateQuoteTemplatePolicyAction(input: QuoteTemplatePolicy): Promise<void> {
  const effective = await getEffectiveRole();
  if (!effective || effective.role !== "admin") throw new Error("Admin only");

  // A typo'd template id would 400 at publish time, which is unrecoverable
  // mid-acceptance — validate against the real HubSpot template list first.
  const templates = await listQuoteTemplates();
  const validIds = new Set(templates.map(t => t.id));
  for (const [quoteType, templateId] of Object.entries(input) as [QuoteType, string][]) {
    if (!validIds.has(templateId)) {
      throw new Error(`"${templateId}" (${quoteType}) is not a known HubSpot quote template`);
    }
  }

  const [existing] = await db.select({ id: quoteTemplatePolicy.id }).from(quoteTemplatePolicy).where(eq(quoteTemplatePolicy.isActive, true)).limit(1);
  const values = {
    fullPosTemplateId: input.full_pos,
    foodTruckTemplateId: input.food_truck,
    marketingOnlyTemplateId: input.marketing_only,
    updatedByUserId: effective.userId,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(quoteTemplatePolicy).set(values).where(eq(quoteTemplatePolicy.id, existing.id));
  } else {
    await db.insert(quoteTemplatePolicy).values(values);
  }
}

// AIO's quote template list changes rarely — same TTL-cache shape as
// src/lib/actions/catalog.ts's product catalog cache.
const TEMPLATE_CACHE_TTL_MS = 10 * 60 * 1000;

let cache: { templates: QuoteTemplate[]; fetchedAt: number } | null = null;
let inFlight: Promise<QuoteTemplate[]> | null = null;

async function getCachedTemplates(): Promise<QuoteTemplate[]> {
  if (cache && Date.now() - cache.fetchedAt < TEMPLATE_CACHE_TTL_MS) return cache.templates;
  if (!inFlight) {
    inFlight = listQuoteTemplates()
      .then(templates => {
        cache = { templates, fetchedAt: Date.now() };
        return templates;
      })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

export type QuoteTemplateListResult = {
  templates: QuoteTemplate[];
  error: string | null;
};

/**
 * Admin-only wrapper over listQuoteTemplates() for the settings page's
 * dropdowns. Degrades gracefully when HubSpot is unreachable or the token is
 * unset: returns an empty list + an error string rather than throwing, so the
 * page can still render the currently-saved ids with a warning.
 */
export async function listQuoteTemplatesAction(): Promise<QuoteTemplateListResult> {
  const effective = await getEffectiveRole();
  if (!effective || effective.role !== "admin") throw new Error("Admin only");

  try {
    const templates = await getCachedTemplates();
    return { templates, error: null };
  } catch (err) {
    return { templates: [], error: err instanceof Error ? err.message : "Could not load HubSpot quote templates" };
  }
}
