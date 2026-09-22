// The adoption service — kept separate from the adapter the way `lib/billing/`
// is separate from `syncDealFromApplication` et al. This is the piece that
// lets a rep attach an EXISTING HubSpot deal to an EasyOB application instead
// of EasyOB always minting a new one (which is what created a duplicate deal
// on every account, since a rep typically already has one in the pipeline by
// the time a merchant accepts).
//
// Wired into `createProspectAction` (`lib/actions/prospects.ts`), which
// resolves a deal through this service before a row ever exists, and into
// `retryBillingQuoteAction` (`lib/actions/billing.ts`) for a legacy row
// missing one. The create-on-accept path this replaced is gone —
// `syncDealFromApplication` (adapters/hubspot.ts) is PATCH-only now.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications } from "@/lib/db/schema";
import { getDealById, listDealsForCompany, createDeal, type HubspotDeal } from "@/lib/adapters/hubspot";

export type DealChoice =
  | { mode: "existing"; dealId: string }
  | { mode: "create"; dealName: string; amount?: number };

export type DealRefusalCode =
  | "not_found"
  | "wrong_company"
  | "closed"
  | "already_adopted"
  | "ambiguous"
  | "hubspot_error";

export type DealResolution =
  | { ok: true; deal: HubspotDeal; created: boolean }
  | { ok: false; code: DealRefusalCode; message: string; candidates?: HubspotDeal[] };

/**
 * Every EasyOB application currently pointing at this HubSpot deal id. There
 * should be at most one — this is what `resolveDealForCompany` checks before
 * letting a second application adopt the same deal (the other half of the
 * one-application-one-deal invariant; the first half, one-deal-per-application,
 * is just `hubspotDealId` being a single column).
 */
export async function findApplicationsByDealId(dealId: string): Promise<string[]> {
  const rows = await db
    .select({ id: merchantApplications.id })
    .from(merchantApplications)
    .where(eq(merchantApplications.hubspotDealId, dealId));
  return rows.map(r => r.id);
}

/**
 * Resolve a rep's deal choice into a deal an application may adopt, or a typed
 * refusal. Never throws a string — every failure mode a caller needs to show
 * a rep comes back as a `DealResolution`.
 *
 * `mode: "existing"` validates, in order: the deal exists, it's actually on
 * this company, it isn't closed (unless `allowClosedWon` and it's the won
 * kind), and no OTHER application has already adopted it.
 *
 * `mode: "create"` re-reads the company's deals FIRST and refuses `ambiguous`
 * with the candidates if any exist — a rep has to look before minting a
 * duplicate, which is the exact failure this whole service exists to prevent.
 */
export async function resolveDealForCompany(input: {
  companyId: string;
  choice: DealChoice;
  excludeApplicationId?: string;
  allowClosedWon?: boolean;
}): Promise<DealResolution> {
  const { companyId, choice, excludeApplicationId, allowClosedWon } = input;

  if (choice.mode === "existing") {
    let deal: HubspotDeal | null;
    try {
      deal = await getDealById(choice.dealId);
    } catch (err) {
      return { ok: false, code: "hubspot_error", message: hubspotErrorMessage(err) };
    }
    if (!deal) {
      return { ok: false, code: "not_found", message: `No HubSpot deal found for '${choice.dealId}'.` };
    }
    if (!deal.companyIds.includes(companyId)) {
      return {
        ok: false,
        code: "wrong_company",
        message: `Deal '${deal.name}' isn't associated with this company in HubSpot. Pick a deal that's actually on the company record, or paste a link to the right one.`,
      };
    }
    if (deal.closed && !(allowClosedWon && deal.won)) {
      return {
        ok: false,
        code: "closed",
        message: deal.won
          ? `Deal '${deal.name}' is Closed Won — confirm you mean to adopt an already-won deal before continuing.`
          : `Deal '${deal.name}' is closed (${deal.stageLabel ?? "closed"}) and can't be adopted. Reopen it in HubSpot or pick another.`,
      };
    }

    let owners: string[];
    try {
      owners = await findApplicationsByDealId(deal.id);
    } catch (err) {
      return { ok: false, code: "hubspot_error", message: hubspotErrorMessage(err) };
    }
    const otherOwners = owners.filter(id => id !== excludeApplicationId);
    if (otherOwners.length > 0) {
      // Names the other application(s) — a rep staring at this refusal needs
      // to know WHICH account to go look at, not just that one exists.
      return {
        ok: false,
        code: "already_adopted",
        message: `Deal '${deal.name}' is already attached to another EasyOB application (${otherOwners.join(", ")}). One deal can't back two applications.`,
      };
    }

    return { ok: true, deal, created: false };
  }

  // mode: "create" — look before minting. A company that already has deals
  // refuses outright, with the candidates, so a rep is forced to pick one of
  // those instead of getting a second deal on the same company by accident.
  let existing: HubspotDeal[];
  try {
    existing = await listDealsForCompany(companyId);
  } catch (err) {
    return { ok: false, code: "hubspot_error", message: hubspotErrorMessage(err) };
  }
  if (existing.length > 0) {
    return {
      ok: false,
      code: "ambiguous",
      message: `This company already has ${existing.length} deal${existing.length === 1 ? "" : "s"} in HubSpot. Pick one instead of creating a new one.`,
      candidates: existing,
    };
  }

  let dealId: string;
  try {
    dealId = await createDeal({ name: choice.dealName, companyId, amount: choice.amount });
  } catch (err) {
    return { ok: false, code: "hubspot_error", message: hubspotErrorMessage(err) };
  }

  let deal: HubspotDeal | null;
  try {
    deal = await getDealById(dealId);
  } catch (err) {
    return {
      ok: false,
      code: "hubspot_error",
      message: `Created HubSpot deal ${dealId} but reading it back failed: ${hubspotErrorMessage(err)}`,
    };
  }
  if (!deal) {
    // getDealById is a direct GET, not index-backed like deals/search — a
    // fresh create not showing up here immediately is unexpected. Say so
    // plainly rather than fabricate a stand-in HubspotDeal for the caller to
    // trust; the deal DOES exist in HubSpot at this point, just unread.
    return { ok: false, code: "hubspot_error", message: `Created HubSpot deal ${dealId} but could not read it back.` };
  }
  return { ok: true, deal, created: true };
}

function hubspotErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Could not reach HubSpot";
}
