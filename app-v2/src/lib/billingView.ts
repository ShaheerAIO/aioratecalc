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

// ── Empty states and send eligibility ───────────────────────────────────────

export type BillingPanelState =
  | "not_configured"       // no billable lines and nothing accepted — the rep hasn't built the quote yet
  | "rate_only"            // accepted, but no billable lines — no HubSpot quote will ever exist
  | "awaiting_tenant_link" // billable, but no HubSpot company linked — nothing may be created yet
  | "pending"              // billable lines, ready to send, but no HubSpot quote yet
  | "draft"                // a HubSpot quote exists but was never published
  | "published";           // publishedAt is set — the one-way door has been gone through

type BillingStateInput = Pick<MerchantApplication, "quoteAcceptedAt" | "quoteLines" | "hubspotIds" | "tenantLink">;

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
  not_configured: "Not started",
  rate_only: "Rate-only (no quote)",
  awaiting_tenant_link: "Waiting on company link",
  pending: "Ready to send",
  draft: "Draft",
  published: "Published",
};

export function billingPanelState(app: BillingStateInput): BillingPanelState {
  const hubspotIds = app.hubspotIds;
  const hasBillableLines = !!app.quoteLines && app.quoteLines.length > 0;

  // Acceptance no longer leads this. It used to be the first check, because
  // the quote was built and published INSIDE the merchant's acceptance, so
  // nothing existed in HubSpot before it. Now the rep sends the quote first
  // and acceptance is what comes back (the merchant signing and paying it), so
  // gating on `quoteAcceptedAt` here would hide the send button from every
  // quote that still needs sending.
  if (!hasBillableLines) return app.quoteAcceptedAt ? "rate_only" : "not_configured";
  if (hubspotIds?.publishedAt) return "published";
  if (hubspotIds?.quoteId) return "draft";
  // Checked after the two id-bearing states, not before: a row built before
  // the tenant-link gate existed can carry a quote and no link, and what it
  // already has in HubSpot is the more useful thing to show.
  if (!app.tenantLink?.hubspotCompanyId?.trim()) return "awaiting_tenant_link";
  return "pending";
}

/**
 * Whether the rep/admin billing panel should offer the Send Quote button.
 *
 * Mirrors `sendQuoteAction`'s own refusal (already published — there is no
 * re-publish, no edit and no void) plus the states where sending is not the
 * move: a quote with no lines to bill, and an account still waiting on its
 * HubSpot company link, where the fix is to link the company (which builds
 * and publishes by itself) and this button would only answer with the same
 * refusal.
 *
 * `draft` stays sendable: a quote object that exists but was never published
 * is a send that died mid-graph, and this is what resumes it.
 */
export function canSendQuote(app: BillingStateInput): boolean {
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
