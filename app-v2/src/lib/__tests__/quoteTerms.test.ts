import { describe, it, expect } from "vitest";
import { QUOTE_TERMS_BASE_HTML, QUOTE_TERMS_MARKETING_HTML, quoteTermsFor } from "@/lib/quoteTerms";

describe("quoteTermsFor", () => {
  it("gives Marketing Only the Order Form with the Marketing Annexure", () => {
    expect(quoteTermsFor("marketing_only")).toBe(QUOTE_TERMS_MARKETING_HTML);
    expect(QUOTE_TERMS_MARKETING_HTML).toContain("This Annexure forms part of");
  });

  it("gives every processing plan the base Order Form, without the annexure", () => {
    for (const plan of ["all_in_one", "order_pay_only", "marketing_partial"] as const) {
      expect(quoteTermsFor(plan), plan).toBe(QUOTE_TERMS_BASE_HTML);
    }
    expect(QUOTE_TERMS_BASE_HTML).not.toContain("Annexure");
  });

  it("carries the Order Form itself, and not HubSpot's editor wrapper", () => {
    for (const html of [QUOTE_TERMS_BASE_HTML, QUOTE_TERMS_MARKETING_HTML]) {
      expect(html).toContain("This Merchant Services Agreement Order Form");
      expect(html).toContain("https://www.aioapp.com/merchant-services-agreement");
      expect(html).toContain("Termination");
      expect(html).not.toContain("data-hs-token");
    }
  });
});
