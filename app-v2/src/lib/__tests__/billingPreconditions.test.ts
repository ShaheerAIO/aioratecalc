import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { canPublishBillingQuote } from "@/lib/billing/preconditions";
import { ORDER_POINT_RULES } from "@/lib/quoting";
import type { CatalogProduct, MerchantApplication, QuoteLine } from "@/types/merchant";

// The only compensating control left after the rep confirmation modal was
// cancelled (PHASE-E-SPEC.md §6.2), so every branch gets its own case with its
// own code — a silently-skipped check here is a published, unamendable quote
// with the wrong numbers on it.

const PLATFORM: CatalogProduct = {
  hubspotProductId: "217526517443",
  name: "AIO Platform (1 to 5 Order Points)",
  price: 99,
  billingFrequency: "weekly",
  productType: "Software",
};

const POS: CatalogProduct = {
  hubspotProductId: "217445755632",
  name: "POS Unit",
  price: 1200,
  billingFrequency: "one_time",
  productType: "inventory",
};

// Both tablets were resolved to a flat 0 points on 2026-09-17, so NO catalog
// product carries `needsReview` any more — and rule 6 still has to work for the
// next product nobody can classify from its record. Registered by name only:
// quoting.ts indexes the rules by product id at module load, so a rule added
// here would never be found by id.
const REVIEWABLE: CatalogProduct = {
  hubspotProductId: "900000000001",
  name: "Mystery Ordering Device",
  price: 400,
  billingFrequency: "one_time",
  productType: "inventory",
};

beforeAll(() => {
  ORDER_POINT_RULES[REVIEWABLE.name] = {
    pointsPerUnit: 0,
    needsReview: "Nobody can tell from the catalog whether this takes orders.",
  };
});
afterAll(() => { delete ORDER_POINT_RULES[REVIEWABLE.name]; });

const CATALOG = [PLATFORM, POS, REVIEWABLE];

function line(p: CatalogProduct, qty = 1): QuoteLine {
  return {
    hubspotProductId: p.hubspotProductId,
    name: p.name,
    qty,
    unitPrice: p.price,
    billingFrequency: p.billingFrequency,
    productType: p.productType,
  };
}

const LINES = [line(PLATFORM), line(POS)];

function app(extra: Partial<MerchantApplication> = {}): MerchantApplication {
  return {
    id: "app-1",
    ownerUserId: "rep-1",
    customerUserId: null,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    stage: "quote_accepted",
    hubspotDealId: "deal-1",
    // Linked by default: an unlinked account is its own refusal
    // (`no_tenant_company`), and leaving it null here would make every other
    // case in this file assert against two reasons instead of the one it tests.
    tenantLink: {
      hubspotCompanyId: "334295287484",
      companyName: "TEST COMPANY",
      tenantRef: "prod-1024",
      adyenAccountHolderId: null,
      linkedAt: "2026-08-21T00:00:00.000Z",
      linkedByUserId: "rep-1",
    },
    adyenIds: null,
    adyenOnboardingUrl: null,
    checkIds: null,
    foodbuyIds: null,
    hubspotIds: null,
    quoteType: "full_pos",
    quoteConfig: { avgTicket: 30, monthlyVolume: 40000 },
    quoteLines: LINES,
    orderPoints: { hardware: { "POS Unit": 1 }, channels: [], total: 1 },
    quoteAcceptedAt: "2026-08-21T00:00:00.000Z",
    targetMargin: 0.019,
    pricingModel: "2-tier",
    customerLinkToken: "tok",
    customerLinkPurpose: "lead_upload",
    customerLinkSentAt: null,
    customerLinkExpiresAt: null,
    analysis: null,
    proposal: null,
    business: { legalName: "Torta Palace LLC", dba: "Torta Palace" } as MerchantApplication["business"],
    ownerContact: null,
    processing: null,
    agreement: null,
    ...extra,
  };
}

function check(extra: Partial<MerchantApplication> = {}, overrides: Partial<Parameters<typeof canPublishBillingQuote>[0]> = {}) {
  return canPublishBillingQuote({
    app: app(extra),
    catalog: CATALOG,
    senderEmail: "rita@aioapp.com",
    signerEmail: "ana@tortapalace.com",
    templateId: "817263673055",
    ...overrides,
  });
}

function codes(result: ReturnType<typeof canPublishBillingQuote>): string[] {
  return result.ok ? [] : result.reasons.map(r => r.code);
}

describe("canPublishBillingQuote", () => {
  it("passes a complete quote and carries the recomputed totals", () => {
    const result = check();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lineCount).toBe(2);
    expect(result.totals.oneTime).toBe(1200);
    expect(result.totals.recurring).toEqual([{ frequency: "weekly", amount: 99 }]);
    // The figure that reaches the log line, not a summed-together single number.
    expect(result.totals.monthlyEquivalent).toBeCloseTo(99 * 52 / 12, 6);
  });

  it("reports an already-published quote as a no-op, not a failure", () => {
    const result = check({
      hubspotIds: {
        quoteId: "q-1", quoteTemplateId: null, lineItemIds: null, contactId: null, quoteLink: null,
        publishedAt: "2026-08-20T10:00:00.000Z", paymentStatus: "PENDING", paymentDate: null,
        subscriptions: null, subscriptionStatus: null, syncedAt: null, lastSyncError: null, lastSyncErrorAt: null,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.alreadyPublished).toBe(true);
    expect(codes(result)).toEqual(["already_published"]);
  });

  it("refuses with no HubSpot deal — association 64 is a publish requirement", () => {
    const result = check({ hubspotDealId: null });
    expect(codes(result)).toContain("no_deal");
    expect(result.ok ? true : result.alreadyPublished).toBe(false);
  });

  it("refuses an empty line set", () => {
    expect(codes(check({ quoteLines: [] }))).toContain("no_quote_lines");
    expect(codes(check({ quoteLines: null }))).toContain("no_quote_lines");
  });

  it("refuses a line with no HubSpot product behind it", () => {
    const orphan: QuoteLine = { ...line(POS), hubspotProductId: "  " };
    const result = check({ quoteLines: [line(PLATFORM), orphan] });
    expect(codes(result)).toContain("line_missing_product_id");
    if (!result.ok) expect(result.reasons.find(r => r.code === "line_missing_product_id")!.message).toContain("POS Unit");
  });

  it("refuses a frequency toLineItemProperties would throw on mid-graph", () => {
    const quarterly: QuoteLine = { ...line(POS), billingFrequency: "quarterly" };
    expect(codes(check({ quoteLines: [line(PLATFORM), quarterly] }))).toContain("unsupported_billing_frequency");
  });

  it("refuses when the platform tier product is missing from the catalog", () => {
    // The largest recurring line on the quote. Publishing without it undercharges
    // permanently, so the catalog not yielding it must block.
    const result = check({}, { catalog: [POS, REVIEWABLE] });
    expect(codes(result)).toContain("platform_tier_unresolved");
  });

  it("still resolves the platform line for a food truck, which is flat-rated", () => {
    const foodTruck: CatalogProduct = {
      hubspotProductId: "247900575472", name: "AIO Platform - Food Truck",
      price: 79, billingFrequency: "weekly", productType: "Software",
    };
    const result = check(
      { quoteType: "food_truck", quoteLines: [line(foodTruck), line(POS)] },
      { catalog: [foodTruck, POS] }
    );
    expect(result.ok).toBe(true);
  });

  it("passes a marketing-only quote, which owes no platform line at all", () => {
    const marketing: CatalogProduct = {
      hubspotProductId: "223152695997", name: "AIO Marketing Platform",
      price: 49, billingFrequency: "weekly", productType: "Software",
    };
    const result = check(
      { quoteType: "marketing_only", quoteLines: [line(marketing)], orderPoints: null },
      { catalog: [marketing] }
    );
    expect(result.ok).toBe(true);
  });

  it("REFUSES an unreviewed order-point line rather than letting it through", () => {
    // §6.1 item 9 allowed a rep to acknowledge these. Under auto-publish there
    // is no rep at acceptance time, and a device on the wrong side of the 1–5/6+
    // boundary is ~$433/mo on a document nobody can amend.
    const result = check({ quoteLines: [line(PLATFORM), line(POS), line(REVIEWABLE)] });
    expect(codes(result)).toContain("order_points_need_review");
    if (!result.ok) {
      expect(result.reasons.find(r => r.code === "order_points_need_review")!.message).toContain("Mystery Ordering Device");
    }
  });

  it("does NOT refuse a quote carrying either tablet — both resolved to 0 points", () => {
    // The live failure this rule caused: a real deal picked "Clock in Tablet",
    // auto-publish refused, and nothing a rep could click cleared it because the
    // flag was re-derived from the line every time.
    const clockIn: CatalogProduct = {
      hubspotProductId: "276754193118", name: "Clock in Tablet",
      price: 400, billingFrequency: "one_time", productType: "inventory",
    };
    const ordersHub: CatalogProduct = {
      hubspotProductId: "276751313619", name: "Orders Hub Tablet",
      price: 400, billingFrequency: "one_time", productType: "inventory",
    };
    const result = check(
      { quoteLines: [line(PLATFORM), line(POS), line(clockIn), line(ordersHub)] },
      { catalog: [PLATFORM, POS, clockIn, ordersHub] }
    );
    expect(codes(result)).not.toContain("order_points_need_review");
    expect(result.ok).toBe(true);
  });

  it("refuses with no signer email — 702 makes that contact the legal signer", () => {
    expect(codes(check({}, { signerEmail: null }))).toContain("no_signer_email");
    expect(codes(check({}, { signerEmail: "   " }))).toContain("no_signer_email");
  });

  it("refuses with no sender email — the publish PATCH 400s without hs_sender_email", () => {
    expect(codes(check({}, { senderEmail: null }))).toContain("no_sender_email");
  });

  it("refuses with no quote template configured", () => {
    expect(codes(check({}, { templateId: null }))).toContain("no_template");
  });

  it("refuses a closed-lost deal", () => {
    expect(codes(check({ stage: "closed_lost" }))).toContain("closed_lost");
  });

  it("refuses an account with no linked HubSpot company", () => {
    expect(codes(check({ tenantLink: null }))).toEqual(["no_tenant_company"]);
    expect(codes(check({ tenantLink: { ...app().tenantLink!, hubspotCompanyId: "  " } })))
      .toEqual(["no_tenant_company"]);
  });

  it("returns every problem at once, not the first one", () => {
    const result = check(
      { hubspotDealId: null, tenantLink: null, stage: "closed_lost", quoteLines: [] },
      { senderEmail: null, signerEmail: null, templateId: null }
    );
    expect(codes(result).sort()).toEqual(
      ["closed_lost", "no_deal", "no_quote_lines", "no_sender_email", "no_signer_email", "no_template", "no_tenant_company"].sort()
    );
  });

  it("gives every refusal a message that names what to fix", () => {
    const result = check({ hubspotDealId: null }, { senderEmail: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const reason of result.reasons) {
      expect(reason.message.length).toBeGreaterThan(20);
    }
  });
});
