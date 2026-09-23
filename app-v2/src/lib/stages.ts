// Canonical stage ordering for MerchantApplication.stage, and the dashboard
// stage-group buckets derived from it. Single source of truth: STAGE_RANK
// used to live duplicated as a hand-copied array in three dashboard files
// (AdminDashboard.tsx, AccountsDashboard.tsx, admin/users/page.tsx) plus its
// own definition in adyenWebhook.ts — every one of those hand lists omitted
// `merchant_filling`, so an application sitting in that stage vanished from
// every onboarding metric. Derive the groups from rank ranges instead so a
// newly inserted stage can't silently miss a bucket again.
import type { DealStage } from "@/types/merchant";

// Forward-only stage ranking. Adyen delivers webhooks at-least-once and out
// of order, so shouldAdvance() only ever advances a deal, never regresses it
// (a stale "pending" event must not undo an "approved" one). `satisfies
// Record<DealStage, number>` makes a missing/misspelled DealStage a compile
// error rather than a silent runtime gap.
export const STAGE_RANK = {
  prospect_created: 0,
  lead_link_sent: 1,
  lead_analysis_pending: 2,
  analysis: 3,
  pricing: 4,
  proposal_ready: 5,
  // Both rep flows now end by sending the customer a /lead/{token} quote link,
  // so `quote_sent` is reached from the wizard's `proposal_ready` as well as
  // straight from prospect creation. It ranks above the working stages
  // accordingly — it used to sit at rank 2, which made the wizard's own
  // terminus a backwards move and forced PROPOSAL_STAGES to be a disjunction
  // rather than a range.
  quote_sent: 6,
  proposal_sent: 7,
  // Sits above every quoting stage and below onboarding: a customer can
  // accept from a prepared quote (quote_sent) or from one they generated
  // themselves (analysis), and either way acceptance is what starts
  // onboarding.
  quote_accepted: 8,
  merchant_link_sent: 9,
  merchant_filling: 10,
  adyen_kyc_pending: 11,
  adyen_kyc_complete: 12,
  adyen_approved: 13,
  closed_lost: 14,
} satisfies Record<DealStage, number>;

/** True if `next` is strictly further along than `current` (forward-only guard).
 *  Lives here rather than beside any one caller: it started out in the Adyen
 *  webhook adapter, but four of its five consumers were never Adyen (the two
 *  /lead/[token] routes and prospects.ts), and it outlived that adapter. */
export function shouldAdvance(current: string, next: DealStage): boolean {
  return (STAGE_RANK[next] ?? -1) > (STAGE_RANK[current as DealStage] ?? -1);
}

export const STAGE_ORDER = (Object.keys(STAGE_RANK) as DealStage[]).sort(
  (a, b) => STAGE_RANK[a] - STAGE_RANK[b]
);

// "Proposal phase" — a quote/proposal has been produced and put in front of
// the customer, but they haven't accepted yet. Now a genuine rank RANGE: with
// the two rep flows merged onto one terminus, `quote_sent` sits inside the
// proposal span instead of below the working stages, so the old special-case
// disjunction is gone. The working states below it (`lead_analysis_pending`,
// `analysis`, `pricing`) stay excluded — nothing has been sent yet.
export const PROPOSAL_STAGES: DealStage[] = STAGE_ORDER.filter(
  s => STAGE_RANK[s] >= STAGE_RANK.proposal_ready && STAGE_RANK[s] <= STAGE_RANK.proposal_sent
);

// "Onboarding phase" — the customer accepted and is moving through
// KYC/onboarding, up to (but excluding) the terminal `adyen_approved` /
// `closed_lost` states. A genuine rank RANGE on purpose: it's exactly the
// span from `quote_accepted` to `adyen_kyc_complete`, so a stage inserted
// anywhere in between (like `merchant_filling` was) is picked up
// automatically instead of requiring every dashboard to be updated by hand.
export const ONBOARDING_STAGES: DealStage[] = STAGE_ORDER.filter(
  s => STAGE_RANK[s] > STAGE_RANK.proposal_sent && STAGE_RANK[s] < STAGE_RANK.adyen_approved
);
