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
//
// AIO deactivates the old template when it ships a new one, and HubSpot
// REFUSES association 286 to an inactive template ("Quote template is not
// active", 400 VALIDATION_ERROR) — so a default left on a retired version
// strands every build at the association step, after the line items and the
// draft quote have already been created. "AIO Quote v3" (817263673055) was
// retired for v4 on 2026-10-09, which is how that was found. When AIO ships
// v5, this constant moves too, or an admin re-points it in
// Admin → Quote templates.
const DEFAULT_TEMPLATE_IDS: Record<QuoteType, string> = {
  order_pay_only: "854670598854",  // AIO Quote v4
  all_in_one: "854670598854",      // AIO Quote v4
  marketing_only: "817697352408",  // Marketing Only (one-time hardware payment) Quote
  // Marketing Only (2-year term) Quote — BAY AREA ONLY. HubSpot carries a
  // second, equally active "OUTSIDE BAY AREA" version (850518393534); EasyOB
  // has no notion of a merchant's region, so the default is the Bay Area one
  // (Shaheer, 2026-10-09) and an outside-the-Bay deal is an admin re-point in
  // Admin → Quote templates. If that becomes common, it wants a region on the
  // quote rather than a global default.
  marketing_term: "854671277804",
};

export type QuoteTemplatePolicy = Record<QuoteType, string>;

function rowToPolicy(row: typeof quoteTemplatePolicy.$inferSelect): QuoteTemplatePolicy {
  return {
    order_pay_only: row.orderPayOnlyTemplateId,
    all_in_one: row.allInOneTemplateId,
    marketing_only: row.marketingOnlyTemplateId,
    marketing_term: row.marketingTermTemplateId,
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
  //
  // An INACTIVE one is refused here too, which reverses the rule this had
  // until 2026-10-09. It used to be savable on the theory that the choice was
  // the admin's; it isn't, because HubSpot rejects association 286 to an
  // inactive template outright. Saving one is therefore not a preference, it
  // is a guaranteed failed publish for every quote of that type.
  const templates = await listQuoteTemplates();
  const byId = new Map(templates.map(t => [t.id, t]));
  for (const [quoteType, templateId] of Object.entries(input) as [QuoteType, string][]) {
    const template = byId.get(templateId);
    if (!template) {
      throw new Error(`"${templateId}" (${quoteType}) is not a known HubSpot quote template`);
    }
    if (!template.active) {
      throw new Error(
        `"${template.name}" (${quoteType}) is inactive in HubSpot, which refuses to attach it to a quote. Pick an active template.`
      );
    }
  }

  const [existing] = await db.select({ id: quoteTemplatePolicy.id }).from(quoteTemplatePolicy).where(eq(quoteTemplatePolicy.isActive, true)).limit(1);
  const values = {
    allInOneTemplateId: input.all_in_one,
    orderPayOnlyTemplateId: input.order_pay_only,
    marketingOnlyTemplateId: input.marketing_only,
    marketingTermTemplateId: input.marketing_term,
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

export type ResolvedQuoteTemplate = {
  id: string;
  /** Whether HubSpot will accept it on association 286. An inactive one 400s. */
  active: boolean;
};

/**
 * The template this quote type publishes against, AND whether HubSpot still
 * accepts it — resolved together because the publish path needs both.
 *
 * Reads the live list rather than `getCachedTemplates()`: this sits in front of
 * an irreversible build, and the one thing being checked is a flag that changes
 * exactly when a stale cache would be wrong. One request for a list of a dozen,
 * on an operation that happens once per merchant.
 *
 * Throws when HubSpot can't be reached. Deliberate: the caller resolves this in
 * the same preflight as the sender and the catalog, so an unanswerable check
 * refuses before the first write instead of discovering it at step 4 of 5.
 */
export async function resolveQuoteTemplate(quoteType: QuoteType): Promise<ResolvedQuoteTemplate> {
  const [policy, templates] = await Promise.all([getQuoteTemplatePolicy(), listQuoteTemplates()]);
  const id = policy[quoteType];
  return { id, active: templates.some(t => t.id === id && t.active) };
}

export type QuoteTemplateAudit = {
  /** One entry per quote type whose configured template HubSpot would now refuse. */
  stale: Array<{ quoteType: QuoteType; templateId: string; name: string | null; reason: "inactive" | "missing" }>;
  checked: number;
};

/**
 * Compare the policy against HubSpot's live template list.
 *
 * Runs nightly (/api/cron/hubspot-links) because nobody tells EasyOB when AIO
 * retires a template, and the first thing that notices otherwise is a refused
 * publish with a merchant standing at the door. Finding it the night it
 * happens turns a blocked checkout into a settings change made in advance.
 *
 * It ALERTS, it does not heal. Which template replaces a retired one is a
 * human's call — "AIO Quote v3 → v4" looks obvious, but the two region-split
 * marketing templates are the counter-example, and guessing wrong puts the
 * wrong document in front of a merchant irreversibly.
 */
export async function auditQuoteTemplatePolicy(): Promise<QuoteTemplateAudit> {
  const [policy, templates] = await Promise.all([getQuoteTemplatePolicy(), listQuoteTemplates()]);
  const byId = new Map(templates.map(t => [t.id, t]));

  const stale: QuoteTemplateAudit["stale"] = [];
  for (const [quoteType, templateId] of Object.entries(policy) as [QuoteType, string][]) {
    const template = byId.get(templateId);
    if (!template) stale.push({ quoteType, templateId, name: null, reason: "missing" });
    else if (!template.active) stale.push({ quoteType, templateId, name: template.name, reason: "inactive" });
  }
  return { stale, checked: Object.keys(policy).length };
}
