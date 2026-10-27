import { describe, it, expect } from "vitest";
import {
  applyPayInFullDiscount,
  invoiceTotalFor,
  isPaymentPlan,
  requiresPaymentPlan,
} from "@/lib/paymentPlan";
import { lineNetAmount } from "@/lib/quoting";
import type { QuoteLine } from "@/types/merchant";

const line = (over: Partial<QuoteLine> = {}): QuoteLine => ({
  hubspotProductId: "p1",
  name: "Terminal",
  qty: 2,
  unitPrice: 499.99,
  billingFrequency: "one_time",
  productType: "hardware",
  ...over,
});

describe("pay-in-full discount", () => {
  it("takes 5% off the line's net amount", () => {
    expect(invoiceTotalFor("full", [line({ qty: 1, unitPrice: 1000 })])).toBe(950);
  });

  it("stacks on a rep's percent discount without leaving both set", () => {
    const [out] = applyPayInFullDiscount([line({ qty: 1, unitPrice: 1000, discountPercent: 10 })]);
    expect(out.discountPercent).toBeNull();
    expect(lineNetAmount(out)).toBe(855);
  });

  it("stacks on a rep's dollar discount", () => {
    const [out] = applyPayInFullDiscount([line({ qty: 1, unitPrice: 1000, discountAmount: 100 })]);
    expect(lineNetAmount(out)).toBe(855);
  });

  it("leaves the input lines alone", () => {
    const input = [line()];
    applyPayInFullDiscount(input);
    expect(input[0].discountAmount).toBeUndefined();
  });

  it("charges list for a payment plan", () => {
    expect(invoiceTotalFor("later", [line({ qty: 1, unitPrice: 1000 })])).toBe(1000);
  });
});

describe("requiresPaymentPlan", () => {
  it("is false for a rate-only quote", () => {
    expect(requiresPaymentPlan({ quoteLines: [] })).toBe(false);
    expect(requiresPaymentPlan({ quoteLines: null })).toBe(false);
  });

  it("is true with a one-time line to invoice", () => {
    expect(requiresPaymentPlan({ quoteLines: [line()] })).toBe(true);
  });

  it("is false when only recurring lines exist", () => {
    expect(requiresPaymentPlan({ quoteLines: [line({ billingFrequency: "monthly" })] })).toBe(false);
  });
});

describe("isPaymentPlan", () => {
  it("accepts only the three plans", () => {
    expect(["full", "later"].every(isPaymentPlan)).toBe(true);
    expect(isPaymentPlan("4")).toBe(false);
    expect(isPaymentPlan(null)).toBe(false);
  });
});
