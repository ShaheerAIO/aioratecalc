import { describe, it, expect } from "vitest";
import {
  toLineItemProperties,
  draftQuoteProperties,
  publishQuoteProperties,
  planLineItemReconciliation,
} from "@/lib/adapters/hubspot";
import { rollUpSubscriptionStatus, EMPTY_HUBSPOT_IDS } from "@/types/merchant";
import type { BillingFrequency, HubspotIds, HubspotSubscriptionSnapshot, QuoteLine } from "@/types/merchant";

function line(over: Partial<QuoteLine> = {}): QuoteLine {
  return {
    hubspotProductId: "p1",
    name: "AIO Platform (1 to 5 Order Points)",
    qty: 1,
    unitPrice: 99,
    billingFrequency: "weekly",
    productType: "Software",
    ...over,
  };
}

describe("toLineItemProperties", () => {
  // Every BillingFrequency, so adding one to the union without deciding how it
  // should be quoted can't slip through onto an unamendable document.
  const SUPPORTED: BillingFrequency[] = ["weekly", "monthly", "one_time"];

  const UNSUPPORTED: BillingFrequency[] = [
    "biweekly",
    "quarterly",
    "per_six_months",
    "annually",
    "per_two_years",
    "per_three_years",
    "per_four_years",
    "per_five_years",
  ];

  it.each(SUPPORTED)("sends the cycle but never a term for %s", frequency => {
    const props = toLineItemProperties(line({ billingFrequency: frequency }));
    // hs_recurring_billing_period is HubSpot's contract TERM, not the cycle.
    // Sending it makes the subscription fixed-term (P7D = one $99 charge, ever),
    // so it is deliberately never written for ANY frequency.
    expect(props).not.toHaveProperty("hs_recurring_billing_period");
    if (frequency === "one_time") expect(props).not.toHaveProperty("recurringbillingfrequency");
    else expect(props.recurringbillingfrequency).toBe(frequency);
  });

  it.each(UNSUPPORTED)("throws on the non-quotable frequency %s", frequency => {
    expect(() => toLineItemProperties(line({ billingFrequency: frequency }))).toThrow(
      /Unsupported billing frequency/
    );
  });

  it("names the frequency and the line in the thrown error", () => {
    const build = () => toLineItemProperties(line({ billingFrequency: "annually", name: "Some Annual Thing" }));
    expect(build).toThrow(/'annually'/);
    expect(build).toThrow(/Some Annual Thing/);
  });

  it("carries the product, quantity and per-cycle price", () => {
    expect(toLineItemProperties(line({ hubspotProductId: "999", qty: 3, unitPrice: 149.5 }))).toEqual({
      hs_product_id: "999",
      quantity: "3",
      price: "149.5",
      recurringbillingfrequency: "weekly",
    });
  });

  it("leaves the weekly platform fee open-ended, matching AIO's live line items", () => {
    // 935 of 1,200 live weekly line items carry no term, and the real invoice
    // stream is 17 consecutive weekly $99 charges. A P7D term would have
    // collected once and stopped.
    const props = toLineItemProperties(line({ billingFrequency: "weekly", unitPrice: 99 }));
    expect(props.recurringbillingfrequency).toBe("weekly");
    expect(Object.keys(props).sort()).toEqual(["hs_product_id", "price", "quantity", "recurringbillingfrequency"]);
  });

  it("never converts a weekly price to a monthly one", () => {
    // $99/week is ~$429/mo. The line item must carry 99, not 429.
    expect(toLineItemProperties(line({ unitPrice: 99 })).price).toBe("99");
  });

  it("omits recurringbillingfrequency and the period entirely for a one-time line", () => {
    expect(
      toLineItemProperties(line({ billingFrequency: "one_time", name: "Onsite Installation", unitPrice: 999 }))
    ).toEqual({
      hs_product_id: "p1",
      quantity: "1",
      price: "999",
    });
  });
});

describe("draftQuoteProperties", () => {
  const props = draftQuoteProperties({ title: "Taco Shop — AIO Platform Quote", expirationDate: "2026-09-20" });

  it("sets the CPQ template type and the caller's title and expiry", () => {
    expect(props.hs_template_type).toBe("CPQ_QUOTE");
    expect(props.hs_title).toBe("Taco Shop — AIO Platform Quote");
    expect(props.hs_expiration_date).toBe("2026-09-20");
  });

  it("enables billing, payment and payment-method storage", () => {
    expect(props.hs_billing_enabled).toBe(true);
    expect(props.hs_payment_enabled).toBe(true);
    expect(props.hs_store_payment_method_at_checkout).toBe(true);
  });

  it("uses the quote-side AUTO_PAYMENTS spelling, not the subscription's", () => {
    expect(props.hs_collection_process).toBe("AUTO_PAYMENTS");
    expect(props.hs_collection_process).not.toBe("automatic_payments");
  });

  it("forces esignature, which print_and_sign would break payment collection", () => {
    expect(props.hs_acceptance_method).toBe("esignature");
  });

  it("restricts payment to ACH", () => {
    expect(props.hs_allowed_payment_methods).toBe("ACH");
  });

  it("never writes the derived properties", () => {
    // hs_esign_enabled is derived from hs_acceptance_method and silently
    // ignores writes; hs_allowed_commerce_payment_methods likewise.
    expect(props).not.toHaveProperty("hs_esign_enabled");
    expect(props).not.toHaveProperty("hs_allowed_commerce_payment_methods");
  });

  it("leaves hs_sender_email and hs_status to the publish PATCH", () => {
    expect(props).not.toHaveProperty("hs_sender_email");
    expect(props).not.toHaveProperty("hs_status");
  });

  it("leaves hs_quote_auth_method at the portal default", () => {
    expect(props).not.toHaveProperty("hs_quote_auth_method");
  });
});

describe("publishQuoteProperties", () => {
  it("is exactly the sender email and the approval status", () => {
    expect(publishQuoteProperties("rep@aioapp.com")).toEqual({
      hs_sender_email: "rep@aioapp.com",
      hs_status: "APPROVAL_NOT_NEEDED",
    });
  });

  it("adds the sender name only when given", () => {
    expect(publishQuoteProperties("rep@aioapp.com", "Ada", "Lovelace")).toEqual({
      hs_sender_email: "rep@aioapp.com",
      hs_status: "APPROVAL_NOT_NEEDED",
      hs_sender_firstname: "Ada",
      hs_sender_lastname: "Lovelace",
    });
  });

  it("omits an empty name rather than blanking the property", () => {
    expect(publishQuoteProperties("rep@aioapp.com", "", "")).toEqual({
      hs_sender_email: "rep@aioapp.com",
      hs_status: "APPROVAL_NOT_NEEDED",
    });
  });
});

describe("planLineItemReconciliation", () => {
  const platform = line({ hubspotProductId: "platform", name: "AIO Platform", unitPrice: 99 });
  const install = line({
    hubspotProductId: "install",
    name: "Onsite Installation",
    unitPrice: 999,
    billingFrequency: "one_time",
  });
  const terminal = line({ hubspotProductId: "terminal", name: "Terminal", unitPrice: 350, billingFrequency: "one_time" });

  it("creates everything on a first save with no existing ids", () => {
    const plan = planLineItemReconciliation(null, null, [platform, install]);
    expect(plan.keep).toEqual([]);
    expect(plan.create).toEqual([
      { nextIndex: 0, line: platform },
      { nextIndex: 1, line: install },
    ]);
    expect(plan.delete).toEqual([]);
  });

  it("keeps everything when nothing changed", () => {
    const plan = planLineItemReconciliation(["li1", "li2"], [platform, install], [platform, install]);
    expect(plan.keep).toEqual([
      { lineItemId: "li1", nextIndex: 0 },
      { lineItemId: "li2", nextIndex: 1 },
    ]);
    expect(plan.create).toEqual([]);
    expect(plan.delete).toEqual([]);
  });

  it("creates only the added line", () => {
    const plan = planLineItemReconciliation(["li1"], [platform], [platform, terminal]);
    expect(plan.keep).toEqual([{ lineItemId: "li1", nextIndex: 0 }]);
    expect(plan.create).toEqual([{ nextIndex: 1, line: terminal }]);
    expect(plan.delete).toEqual([]);
  });

  it("deletes only the removed line", () => {
    const plan = planLineItemReconciliation(["li1", "li2"], [platform, terminal], [platform]);
    expect(plan.keep).toEqual([{ lineItemId: "li1", nextIndex: 0 }]);
    expect(plan.create).toEqual([]);
    expect(plan.delete).toEqual(["li2"]);
  });

  it("replaces a line whose quantity changed", () => {
    const three = { ...terminal, qty: 3 };
    const plan = planLineItemReconciliation(["li1", "li2"], [platform, terminal], [platform, three]);
    expect(plan.keep).toEqual([{ lineItemId: "li1", nextIndex: 0 }]);
    expect(plan.create).toEqual([{ nextIndex: 1, line: three }]);
    expect(plan.delete).toEqual(["li2"]);
  });

  it("replaces a line whose price changed", () => {
    const discounted = { ...install, unitPrice: 499 };
    const plan = planLineItemReconciliation(["li1"], [install], [discounted]);
    expect(plan.keep).toEqual([]);
    expect(plan.create).toEqual([{ nextIndex: 0, line: discounted }]);
    expect(plan.delete).toEqual(["li1"]);
  });

  it("gives two identical lines their own line items rather than collapsing them", () => {
    const plan = planLineItemReconciliation(["li1", "li2"], [terminal, terminal], [terminal, terminal]);
    expect(plan.keep).toEqual([
      { lineItemId: "li1", nextIndex: 0 },
      { lineItemId: "li2", nextIndex: 1 },
    ]);
    expect(plan.create).toEqual([]);
    expect(plan.delete).toEqual([]);
  });

  it("reuses the surviving item when one of two identical lines is dropped", () => {
    const plan = planLineItemReconciliation(["li1", "li2"], [terminal, terminal], [terminal]);
    expect(plan.keep).toEqual([{ lineItemId: "li1", nextIndex: 0 }]);
    expect(plan.create).toEqual([]);
    expect(plan.delete).toEqual(["li2"]);
  });

  it("treats an id list shorter than the previous lines as a partial create", () => {
    // createQuoteLineItems got through the first line and failed on the second.
    const plan = planLineItemReconciliation(["li1"], [platform, install], [platform, install]);
    expect(plan.keep).toEqual([{ lineItemId: "li1", nextIndex: 0 }]);
    expect(plan.create).toEqual([{ nextIndex: 1, line: install }]);
    expect(plan.delete).toEqual([]);
  });

  it("deletes ids it cannot attribute to any previous line", () => {
    const plan = planLineItemReconciliation(["li1", "stale"], [platform], [platform]);
    expect(plan.keep).toEqual([{ lineItemId: "li1", nextIndex: 0 }]);
    expect(plan.delete).toEqual(["stale"]);
  });

  it("deletes every existing item when the quote is emptied", () => {
    const plan = planLineItemReconciliation(["li1", "li2"], [platform, install], []);
    expect(plan.keep).toEqual([]);
    expect(plan.create).toEqual([]);
    expect(plan.delete).toEqual(["li1", "li2"]);
  });
});

describe("rollUpSubscriptionStatus", () => {
  function sub(status: string | null, id = "s1"): HubspotSubscriptionSnapshot {
    return {
      subscriptionId: id,
      status,
      paymentMethod: "ACH - 1117",
      billingFrequency: "weekly",
      billingStartDate: "2026-09-28",
      mrr: 428.67,
      nextPaymentDueDate: "2026-09-28",
      lastPaymentStatus: null,
      completedPayments: 0,
      totalCollected: null,
    };
  }

  it("returns null for no subscriptions at all", () => {
    // Distinct from any status: nobody has checked out yet, or the quote was
    // one-time charges only.
    expect(rollUpSubscriptionStatus([])).toBeNull();
  });

  it("returns the only status when there is one subscription", () => {
    expect(rollUpSubscriptionStatus([sub("active")])).toBe("active");
    expect(rollUpSubscriptionStatus([sub("scheduled")])).toBe("scheduled");
  });

  it("never lets a healthy sibling hide a broken subscription", () => {
    expect(rollUpSubscriptionStatus([sub("active", "weekly"), sub("canceled", "monthly")])).toBe("canceled");
    expect(rollUpSubscriptionStatus([sub("canceled", "weekly"), sub("active", "monthly")])).toBe("canceled");
  });

  it("orders the whole severity chain worst-first", () => {
    const order = ["canceled", "unpaid", "past_due", "paused", "expired", "scheduled", "active"];
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        expect(rollUpSubscriptionStatus([sub(order[j], "a"), sub(order[i], "b")])).toBe(order[i]);
      }
    }
  });

  it("treats paused and canceled as real states rather than falling through", () => {
    expect(rollUpSubscriptionStatus([sub("paused"), sub("active")])).toBe("paused");
    expect(rollUpSubscriptionStatus([sub("expired"), sub("scheduled")])).toBe("expired");
  });

  it("surfaces an unrecognised status ahead of everything known", () => {
    expect(rollUpSubscriptionStatus([sub("active", "a"), sub("something_new", "b")])).toBe("something_new");
  });

  it("ignores null and blank statuses", () => {
    expect(rollUpSubscriptionStatus([sub(null, "a"), sub("active", "b")])).toBe("active");
    expect(rollUpSubscriptionStatus([sub("  ", "a")])).toBeNull();
  });
});

describe("EMPTY_HUBSPOT_IDS", () => {
  it("is every field null — it is the conditional-claim lock's starting value", () => {
    const values = Object.values(EMPTY_HUBSPOT_IDS as Record<keyof HubspotIds, unknown>);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(value).toBeNull();
  });

  it("carries no dealId — the flat hubspotDealId column is canonical", () => {
    expect(EMPTY_HUBSPOT_IDS).not.toHaveProperty("dealId");
  });
});
