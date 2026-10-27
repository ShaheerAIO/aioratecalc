// How the merchant pays the one-time invoice (2026-10-26, product owner).
//
// Chosen on /lead/[token]/payment, between the quote preview and the
// confirmation step. "full" takes 5% off the one-time invoice and is charged
// to the payment method HubSpot stored at the quote's checkout; "later" bills
// list price and the merchant pays on HubSpot's checkout, where they pick card,
// ACH, Klarna or Affirm and so choose their own installments (2026-10-27 —
// HubSpot can't create a payment plan through the API).
//
// ONE-TIME LINES ONLY. The recurring lines ride on the HubSpot quote, which
// cannot be edited once published, so the discount does not
// touch them — see `invoiceLinesFor` in billing/oneTimeInvoice.ts.
//
// Pure: no I/O, so the discount is testable without HubSpot.

import { MIN_CHECKOUT_AMOUNT, lineListAmount, lineNetAmount, splitQuoteLines } from "@/lib/quoting";
import type { MerchantApplication, QuoteLine } from "@/types/merchant";

export const PAYMENT_PLANS = ["full", "later"] as const;
export type PaymentPlan = (typeof PAYMENT_PLANS)[number];

export const PAY_IN_FULL_DISCOUNT_PERCENT = 5;

export function isPaymentPlan(value: unknown): value is PaymentPlan {
  return typeof value === "string" && (PAYMENT_PLANS as readonly string[]).includes(value);
}

/**
 * The lines with the pay-in-full discount applied on top of whatever the rep
 * already gave. Expressed as a dollar discount rather than a second percent,
 * because `discountPercent` and `discountAmount` are mutually exclusive and a
 * dollar figure is exact — the total HubSpot bills is the total shown here.
 * The stored `quoteLines` are never changed.
 */
export function applyPayInFullDiscount(lines: QuoteLine[]): QuoteLine[] {
  return lines.map(line => {
    const net = lineNetAmount(line);
    const discounted = Math.round(net * (1 - PAY_IN_FULL_DISCOUNT_PERCENT / 100) * 100) / 100;
    const discountAmount = Math.round((lineListAmount(line) - discounted) * 100) / 100;
    return { ...line, discountPercent: null, discountAmount };
  });
}

/** What the invoice bills under a plan, in dollars. */
export function invoiceTotalFor(plan: PaymentPlan, lines: QuoteLine[]): number {
  const billed = plan === "full" ? applyPayInFullDiscount(lines) : lines;
  return Math.round(billed.reduce((n, l) => n + lineNetAmount(l), 0) * 100) / 100;
}

/**
 * Whether this merchant is asked at all. Only when there is an invoice to pay:
 * a rate-only quote builds no HubSpot objects, and a kit comped below
 * HubSpot's payment floor owes nothing (the same test `buildOneTimeInvoice`
 * uses to skip the invoice).
 */
export function requiresPaymentPlan(app: Pick<MerchantApplication, "quoteLines">): boolean {
  const { invoiceLines } = splitQuoteLines(app.quoteLines ?? []);
  const total = invoiceLines.reduce((n, l) => n + lineNetAmount(l), 0);
  return invoiceLines.length > 0 && total >= MIN_CHECKOUT_AMOUNT;
}
