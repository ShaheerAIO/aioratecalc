// Pure view-model helpers for the rep/admin HubSpot billing surfaces
// (BillingPanel, AccountsDashboard, admin/users, AdminDashboard). Extracted
// so the frequency-grouped money math and the retry/error/empty-state
// predicates are unit-testable without a React render — same precedent as
// src/lib/adapters/hubspotCrmCard.ts's pure view-model extracted out of a
// HubSpot concern.
//
// This is a DIFFERENT audience than src/lib/onboardingModules.ts's
// billingModule(): that one renders customer-facing status copy and is
// deliberately vague ("Contact your AIO representative"). This module backs
// the rep/admin diagnostic surface, which is allowed — and required — to show
// the raw ids, the sync error, and a retry affordance. Both read the same
// `hubspotIds` snapshot and must never call HubSpot themselves.
import { fmt$, fmtFrequency, monthlyEquivalent } from "@/lib/utils";
import type { BillingFrequency, HubspotIds, HubspotSubscriptionSnapshot, MerchantApplication } from "@/types/merchant";

// ── Money: recovering a per-cycle amount from HubSpot's own MRR ────────────

// hs_recurring_billing_frequency values that actually appear on a live AIO
// subscription (PHASE-E-SPEC.md §3.3 — only weekly/monthly are quotable
// today). Anything else falls through to "unknown" rather than being guessed
// at, because inverting monthlyEquivalent() for an unconfirmed factor would
// fabricate a number nobody verified.
const KNOWN_SUBSCRIPTION_FREQUENCIES: readonly BillingFrequency[] = ["weekly", "monthly"];

export type SubscriptionMoney = {
  /** e.g. "$99.00/week" — the per-cycle amount, recovered from mrr. */
  perCycleLabel: string;
  /** e.g. "(~$428.67/mo)" — HubSpot's own mrr, formatted. */
  monthlyLabel: string;
};

/**
 * The subscription snapshot carries only HubSpot's own `mrr` (already a
 * monthly-equivalent figure), not a per-cycle amount. Recover the per-cycle
 * amount by inverting the same monthlyEquivalent() factor quoting.ts uses
 * everywhere else, so a $99/week platform subscription reads as
 * "$99.00/week (~$428.67/mo)" instead of a bare, easy-to-misread MRR number.
 * Returns null when the frequency is missing/unrecognised or mrr is null —
 * never fabricate a per-cycle figure from a guess.
 */
export function subscriptionMoney(
  sub: Pick<HubspotSubscriptionSnapshot, "mrr" | "billingFrequency">
): SubscriptionMoney | null {
  const freq = sub.billingFrequency as BillingFrequency | null;
  if (sub.mrr == null || !freq || !KNOWN_SUBSCRIPTION_FREQUENCIES.includes(freq)) return null;
  const factor = monthlyEquivalent(1, freq);
  if (!factor) return null;
  const perCycle = sub.mrr / factor;
  return {
    perCycleLabel: `${fmt$(perCycle)}/${fmtFrequency(freq)}`,
    monthlyLabel: `(~${fmt$(sub.mrr)}/mo)`,
  };
}

// ── Empty states and retry eligibility ──────────────────────────────────────

export type BillingPanelState =
  | "not_accepted" // the merchant hasn't accepted a quote yet — nothing to show
  | "rate_only"    // accepted, but no billable lines — no HubSpot quote will ever exist
  | "pending"      // accepted with billable lines, but no HubSpot quote yet (building, or failed before creating one)
  | "draft"        // a HubSpot quote exists but auto-publish hasn't completed
  | "published";   // publishedAt is set — the one-way door has been gone through

type BillingStateInput = Pick<MerchantApplication, "quoteAcceptedAt" | "quoteLines" | "hubspotIds">;

/**
 * Mirrors the same three facts onboardingModules.ts's billingModule() reads
 * (quoteAcceptedAt / quoteLines / hubspotIds), but for a rep/admin diagnostic
 * view rather than customer-facing copy: it distinguishes "draft" from
 * "pending" (billingModule treats both as "not yet actionable by the
 * customer", but a rep deciding whether to hit Retry needs to know whether a
 * HubSpot quote id exists at all).
 */
// Compact label for the additive HubSpot billing rows on the admin/rep list
// and detail grids — the full picture (ids, links, subscriptions, sync
// error, retry) lives in BillingPanel; this is just enough to scan a table.
export const BILLING_STATE_LABELS: Record<BillingPanelState, string> = {
  not_accepted: "Not started",
  rate_only: "Rate-only (no quote)",
  pending: "Building…",
  draft: "Draft",
  published: "Published",
};

export function billingPanelState(app: BillingStateInput): BillingPanelState {
  const hubspotIds = app.hubspotIds;
  const hasBillableLines = !!app.quoteLines && app.quoteLines.length > 0;

  if (!app.quoteAcceptedAt) return "not_accepted";
  if (!hasBillableLines) return "rate_only";
  if (hubspotIds?.publishedAt) return "published";
  if (hubspotIds?.quoteId) return "draft";
  return "pending";
}

/**
 * Whether the rep/admin billing panel should offer a Retry button at all.
 * Mirrors retryBillingQuoteAction's own refusal (already published) plus the
 * two states that are working-as-intended rather than broken — nothing
 * accepted yet, and a rate-only quote that will never produce a HubSpot
 * quote. Deliberately NOT gated on lastSyncError being set: an auto-publish
 * can be stuck on an unmet precondition (§6.1) without ever having recorded
 * an error.
 */
export function canRetryBillingSync(app: BillingStateInput): boolean {
  const state = billingPanelState(app);
  return state === "pending" || state === "draft";
}

export function hasBillingSyncError(hubspotIds: HubspotIds | null): boolean {
  return !!hubspotIds?.lastSyncError;
}

/** The admin dashboard tripwire: how many applications currently have a
 *  persisted HubSpot sync failure. This is the number that would have caught
 *  the original silent deal-sync failure on day one. */
export function countHubspotSyncErrors(apps: Array<Pick<MerchantApplication, "hubspotIds">>): number {
  return apps.reduce((n, a) => n + (hasBillingSyncError(a.hubspotIds) ? 1 : 0), 0);
}

// ── HubSpot record links ────────────────────────────────────────────────────

// Standard HubSpot object-type ids for the record URL pattern
// `https://app.hubspot.com/contacts/{portalId}/record/{objectTypeId}/{objectId}`.
// Deals are the built-in "0-3". Quotes are "0-14" (verified live —
// src/lib/adapters/hubspot.ts's quote-template association comment).
const DEAL_OBJECT_TYPE_ID = "0-3";
const QUOTE_OBJECT_TYPE_ID = "0-14";

function hubspotRecordUrl(portalId: string | undefined, objectTypeId: string, objectId: string): string | null {
  if (!portalId) return null;
  return `https://app.hubspot.com/contacts/${portalId}/record/${objectTypeId}/${objectId}`;
}

/** Null when NEXT_PUBLIC_HUBSPOT_PORTAL_ID isn't configured — callers should
 *  fall back to showing the bare id as copyable text rather than a link. */
export function hubspotDealUrl(dealId: string, portalId: string | undefined): string | null {
  return hubspotRecordUrl(portalId, DEAL_OBJECT_TYPE_ID, dealId);
}

export function hubspotQuoteUrl(quoteId: string, portalId: string | undefined): string | null {
  return hubspotRecordUrl(portalId, QUOTE_OBJECT_TYPE_ID, quoteId);
}

// ── Subscription status colour ──────────────────────────────────────────────

// `paused` / `canceled` / `unpaid` / `past_due` are the NORMAL case here (35 of
// 91 live subscriptions, per PHASE-E-SPEC.md), not an edge case, so they must
// render as distinctly as `active` rather than falling through to one muted
// "everything else" bucket. Colours reference the same semantic CSS custom
// properties the rest of the app uses (globals.css) — this function only
// decides which one applies.
export type StatusColor = { fg: string; bg: string };

const SUBSCRIPTION_STATUS_COLORS: Record<string, StatusColor> = {
  active:    { fg: "var(--success)", bg: "var(--success-bg)" },
  scheduled: { fg: "var(--info)",    bg: "var(--info-bg)" },
  paused:    { fg: "var(--warning)", bg: "var(--warning-bg)" },
  past_due:  { fg: "var(--warning)", bg: "var(--warning-bg)" },
  unpaid:    { fg: "var(--danger)",  bg: "var(--danger-bg)" },
  canceled:  { fg: "var(--danger)",  bg: "var(--danger-bg)" },
  expired:   { fg: "var(--danger)",  bg: "var(--danger-bg)" },
};

const UNKNOWN_STATUS_COLOR: StatusColor = { fg: "var(--ink-3)", bg: "var(--paper)" };

/** Never throws on an unrecognised or null status — falls back to a neutral
 *  colour rather than defaulting to the "healthy" green. */
export function subscriptionStatusColor(status: string | null | undefined): StatusColor {
  if (!status) return UNKNOWN_STATUS_COLOR;
  return SUBSCRIPTION_STATUS_COLORS[status] ?? UNKNOWN_STATUS_COLOR;
}

// ── Payment lag ──────────────────────────────────────────────────────────────

// Real, verified behaviour (PAYMENT-TEST-PLAN.md §1.5): hs_payment_status is
// a daily ACH settlement batch, so PAID lags the customer's actual checkout
// by a median of 5.7 days. Surfaced as a constant so the panel's copy and any
// future caller agree on the number instead of two hand-typed strings drifting.
export const PAYMENT_STATUS_LAG_DAYS = 5.7;
