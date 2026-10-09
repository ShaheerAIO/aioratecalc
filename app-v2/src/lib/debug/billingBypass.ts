// DEBUG-BILLING-BYPASS: temporary, so the post-billing half of onboarding
// (account email, unlocked checklist) can be walked through without entering
// real bank details on HubSpot's hosted quote. Hard-gated on
// ENABLE_DEBUG_BILLING_BYPASS. Safe to delete: this file,
// src/lib/actions/debugBilling.ts, `recordAcceptance`'s `syncDeal` option in
// lib/billing/acceptance.ts, and the `debugBillingBypass` prop threaded from
// app/rep/page.tsx + app/admin/page.tsx down to BillingPanel.tsx.

export function isBillingBypassEnabled(): boolean {
  return process.env.ENABLE_DEBUG_BILLING_BYPASS === "true";
}
