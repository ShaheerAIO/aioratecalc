import { describe, it, expect } from "vitest";
import {
  agreementToSubmit,
  customerOnboardInitial,
  flattenSections,
  isFromHubspotField,
  mergeChannels,
  mergeReviewPrefill,
  recordedConsent,
  NO_REVIEW_PREFILL_APPLIED,
  type AppliedReviewFields,
  type ReviewSections,
} from "@/lib/prefillMerge";
import type { ProspectPrefill } from "@/lib/hubspotPrefill";
import type { AgreementInfo, MerchantApplication, StatementAnalysis } from "@/types/merchant";

function prefill(over: Partial<ProspectPrefill> = {}): ProspectPrefill {
  return {
    business: {}, ownerContact: {}, processing: {}, channels: [], fromHubspot: [],
    ...over,
  };
}

const ACME = prefill({
  business: { legalName: "Acme Pizza", dba: "Acme Pizza", city: "Anaheim" },
  ownerContact: { email: "owner@acme.com" },
  channels: ["website", "qr"],
  fromHubspot: ["business.legalName", "business.dba", "business.city", "ownerContact.email", "channels"],
});

const BETA = prefill({
  business: { legalName: "Beta Tacos", dba: "Beta Tacos" },
  ownerContact: { email: "hi@beta.com" },
  channels: ["third_party_delivery"],
  fromHubspot: ["business.legalName", "business.dba", "ownerContact.email", "channels"],
});

const BLANK_SECTIONS: ReviewSections = {
  business: {
    legalName: "", dba: "", bizType: "llc", address: "", city: "", state: "", zip: "",
    phone: "", website: "", yearsInBusiness: "", annualRevenue: "",
  },
  ownerContact: { firstName: "", lastName: "", title: "", email: "", phone: "" },
  processing: {
    monthlyVolume: "", avgTicket: "", cardPresentPct: "", mcc: "", businessDescription: "",
    previouslyTerminated: "no", bankruptcy: "no", currentProcessor: "",
  },
};

// ── Rep side: prefill vs. what the rep typed ────────────────────────────────

describe("mergeReviewPrefill", () => {
  it("fills a blank form from the prefill", () => {
    const r = mergeReviewPrefill(BLANK_SECTIONS, NO_REVIEW_PREFILL_APPLIED, ACME);
    expect(r.values.business.legalName).toBe("Acme Pizza");
    expect(r.values.business.city).toBe("Anaheim");
    expect(r.values.ownerContact.email).toBe("owner@acme.com");
    expect(r.applied).toEqual({
      "business.legalName": "Acme Pizza", "business.dba": "Acme Pizza", "business.city": "Anaheim",
      "ownerContact.email": "owner@acme.com",
    });
  });

  it("never overwrites what the rep typed", () => {
    const typed: ReviewSections = {
      ...BLANK_SECTIONS,
      business: { ...BLANK_SECTIONS.business, legalName: "Acme Pizza LLC" },
      ownerContact: { ...BLANK_SECTIONS.ownerContact, email: "gm@acme.com" },
    };
    const r = mergeReviewPrefill(typed, NO_REVIEW_PREFILL_APPLIED, ACME);
    expect(r.values.business.legalName).toBe("Acme Pizza LLC");
    expect(r.values.ownerContact.email).toBe("gm@acme.com");
    // Rep-owned now, so no "from HubSpot" hint and nothing for a later switch to replace.
    expect(r.applied["business.legalName"]).toBeUndefined();
    expect(r.applied["ownerContact.email"]).toBeUndefined();
  });

  it("treats a whitespace-only field as blank, not as rep input", () => {
    const r = mergeReviewPrefill(
      { ...BLANK_SECTIONS, business: { ...BLANK_SECTIONS.business, legalName: "   " } },
      NO_REVIEW_PREFILL_APPLIED, ACME
    );
    expect(r.values.business.legalName).toBe("Acme Pizza");
  });

  it("replaces the previous company's values on a switch rather than merging", () => {
    const first = mergeReviewPrefill(BLANK_SECTIONS, NO_REVIEW_PREFILL_APPLIED, ACME);
    const second = mergeReviewPrefill(first.values, first.applied, BETA);
    expect(second.values.business.legalName).toBe("Beta Tacos");
    expect(second.values.ownerContact.email).toBe("hi@beta.com");
    expect(second.values.business.city).toBe(""); // BETA has no city → withdrawn
  });

  it("keeps rep edits across a company switch", () => {
    const first = mergeReviewPrefill(BLANK_SECTIONS, NO_REVIEW_PREFILL_APPLIED, ACME);
    const edited: ReviewSections = { ...first.values, ownerContact: { ...first.values.ownerContact, email: "gm@acme.com" } };
    const second = mergeReviewPrefill(edited, first.applied, BETA);
    expect(second.values.business.legalName).toBe("Beta Tacos"); // untouched → follows HubSpot
    expect(second.values.ownerContact.email).toBe("gm@acme.com"); // typed → the rep's
  });

  it("withdraws what HubSpot filled when the company is cleared", () => {
    const first = mergeReviewPrefill(BLANK_SECTIONS, NO_REVIEW_PREFILL_APPLIED, ACME);
    const edited: ReviewSections = { ...first.values, ownerContact: { ...first.values.ownerContact, email: "gm@acme.com" } };
    const cleared = mergeReviewPrefill(edited, first.applied, null);
    expect(cleared.values.business.legalName).toBe("");
    expect(cleared.values.ownerContact.email).toBe("gm@acme.com");
    expect(cleared.applied).toEqual({});
  });

  it("leaves a field alone when HubSpot has nothing for it", () => {
    const r = mergeReviewPrefill(BLANK_SECTIONS, NO_REVIEW_PREFILL_APPLIED, prefill({ business: { city: "Anaheim" } }));
    expect(r.values.business.legalName).toBe("");
    expect(r.applied["business.legalName"]).toBeUndefined();
  });
});

describe("isFromHubspotField", () => {
  const applied: AppliedReviewFields = { "business.legalName": "Acme Pizza" };

  it("marks a field still showing the prefilled value", () => {
    expect(isFromHubspotField(applied, "business.legalName", "Acme Pizza")).toBe(true);
  });

  it("stops marking it once the value differs", () => {
    expect(isFromHubspotField(applied, "business.legalName", "Acme Pizza LLC")).toBe(false);
  });

  it("never marks a field HubSpot didn't fill", () => {
    expect(isFromHubspotField(applied, "ownerContact.email", "")).toBe(false);
  });
});

describe("mergeChannels", () => {
  it("keeps rep-ticked channels and replaces only the seeded ones", () => {
    const first = mergeChannels([], [], ACME.channels);
    expect(first.channels).toEqual(["website", "qr"]);
    const edited = [...first.channels, "phone_ai"];
    const second = mergeChannels(edited, first.applied, BETA.channels);
    expect(second.channels).toEqual(["phone_ai", "third_party_delivery"]);
  });

  it("hands a channel to the rep when they ticked it themselves, so a later switch can't take it", () => {
    const first = mergeChannels(["website"], [], ACME.channels);
    expect(first.channels).toEqual(["website", "qr"]);
    expect(first.applied).toEqual(["qr"]);
    const second = mergeChannels(first.channels, first.applied, BETA.channels);
    expect(second.channels).toEqual(["website", "third_party_delivery"]);
  });

  it("withdraws HubSpot's channels when the company is cleared", () => {
    const first = mergeChannels([], [], ACME.channels);
    const cleared = mergeChannels(first.channels, first.applied, []);
    expect(cleared.channels).toEqual([]);
    expect(cleared.applied).toEqual([]);
  });
});

// ── Customer side: the onboarding form ──────────────────────────────────────

const ANALYSIS: StatementAnalysis = {
  merchantName: "Little Arabia", processingMonth: "2026-06", totalVolume: 124_500,
  totalTransactions: 3_100, totalFees: 3_800, interchangeFees: 2_400, processorFees: 1_100,
  otherFees: 300, effectiveRate: 0.0305, interchangeRate: 0.0193, processorMarkup: 0.0088,
  statedMarkupRate: 0, statedPerTxnFee: 0, interchangeNotShown: false, averageTicket: 40.16,
  cardPresentVolume: 100_000, cardNotPresentVolume: 24_500, cardPresentPct: 0.803,
  cardNotPresentPct: 0.197, visaVolume: 0, mastercardVolume: 0, amexVolume: 0, discoverVolume: 0,
  rewardCardPct: 0, corporateCardPct: 0, currentPricingModel: "2-tier",
  currentProcessorName: "Clover", annualVolume: 1_494_000, confidence: "high", notes: "",
  currentMargin: 0.0088,
};

type OnboardSource = Pick<MerchantApplication, "analysis" | "business" | "ownerContact" | "processing">;

const NO_SOURCE: OnboardSource = { analysis: null, business: null, ownerContact: null, processing: null };

describe("customerOnboardInitial", () => {
  it("marks nothing as pre-filled when there's nothing on file", () => {
    const r = customerOnboardInitial(NO_SOURCE);
    expect(r.prefilled).toEqual([]);
    expect(r.business.legalName).toBe("");
    expect(r.business.bizType).toBe("llc");
    expect(r.ownerContact.title).toBe("Owner");
    expect(r.processing.previouslyTerminated).toBe("no");
  });

  it("treats persisted empty strings as not pre-filled", () => {
    // Exactly what createProspectAction writes when HubSpot knew nothing.
    const r = customerOnboardInitial({
      ...NO_SOURCE,
      business: {
        legalName: "Acme Pizza", dba: "Acme Pizza", bizType: "llc",
        address: "", city: "", state: "", zip: "", phone: "", website: "",
        yearsInBusiness: "", annualRevenue: "",
      },
    });
    expect(r.prefilled).toEqual(["business.legalName", "business.dba"]);
    expect(r.business.city).toBe("");
  });

  it("ignores whitespace-only persisted values", () => {
    const r = customerOnboardInitial({
      ...NO_SOURCE,
      ownerContact: { firstName: "  ", lastName: "Nasser", title: "", email: "", phone: "" },
    });
    expect(r.prefilled).toEqual(["ownerContact.lastName"]);
    expect(r.ownerContact.firstName).toBe("");
    // A blank persisted value must not wipe the form's own default.
    expect(r.ownerContact.title).toBe("Owner");
  });

  it("does not mark a form default as pre-filled", () => {
    const r = customerOnboardInitial({
      ...NO_SOURCE,
      business: {
        legalName: "", dba: "", bizType: "llc", address: "", city: "", state: "", zip: "",
        phone: "", website: "", yearsInBusiness: "", annualRevenue: "",
      },
      ownerContact: { firstName: "", lastName: "", title: "Owner", email: "", phone: "" },
    });
    expect(r.prefilled).toEqual([]);
  });

  it("does mark a default-valued field once it holds something else", () => {
    const r = customerOnboardInitial({
      ...NO_SOURCE,
      business: {
        legalName: "", dba: "", bizType: "corp", address: "", city: "", state: "", zip: "",
        phone: "", website: "", yearsInBusiness: "", annualRevenue: "",
      },
    });
    expect(r.prefilled).toEqual(["business.bizType"]);
  });

  it("seeds processing from the statement analysis and marks it pre-filled", () => {
    const r = customerOnboardInitial({ ...NO_SOURCE, analysis: ANALYSIS });
    expect(r.business.legalName).toBe("Little Arabia");
    expect(r.processing.monthlyVolume).toBe("124500");
    expect(r.processing.avgTicket).toBe("40");
    expect(r.processing.cardPresentPct).toBe("80");
    expect(r.processing.currentProcessor).toBe("Clover");
    expect(r.prefilled).toContain("processing.monthlyVolume");
    expect(r.prefilled).toContain("business.dba");
    expect(r.prefilled).not.toContain("processing.mcc");
  });

  it("lets a persisted value win over the analysis-derived one", () => {
    const r = customerOnboardInitial({
      ...NO_SOURCE,
      analysis: ANALYSIS,
      processing: {
        monthlyVolume: "90000", avgTicket: "", cardPresentPct: "", mcc: "5812",
        businessDescription: "", previouslyTerminated: "no", bankruptcy: "no", currentProcessor: "",
      },
    });
    expect(r.processing.monthlyVolume).toBe("90000");
    expect(r.processing.avgTicket).toBe("40");        // blank persisted → analysis survives
    expect(r.processing.currentProcessor).toBe("Clover");
    expect(r.processing.mcc).toBe("5812");
  });

  // The invariant this guards is about the PREFILL mechanism, not about
  // consent in general: nothing that flows through customerOnboardInitial may
  // ever put a tick in a consent box or claim a consent field was "pre-filled".
  // Consent already GIVEN is replayed through recordedConsent instead — a
  // separate, explicit door, tested below.
  it("never carries an agreement forward, even when one is on the record", () => {
    const source = { ...NO_SOURCE, agreement: SIGNED } as OnboardSource;
    const r = customerOnboardInitial(source) as Record<string, unknown>;
    expect(r.agreement).toBeUndefined();
    expect(customerOnboardInitial(source).prefilled.some(p => p.startsWith("agreement."))).toBe(false);
    expect(Object.keys(flattenSections(customerOnboardInitial(source))).some(k => k.startsWith("agreement."))).toBe(false);
  });
});

// ── Customer side: consent already on record ────────────────────────────────

const SIGNED: AgreementInfo = {
  sigName: "Jane Doe", sigDate: "2026-08-19",
  termsAccepted: true, electronicConsentAccepted: true, actor: "customer",
};

describe("recordedConsent", () => {
  it("finds nothing to replay when there's no agreement", () => {
    expect(recordedConsent(null)).toBeNull();
    expect(recordedConsent(undefined)).toBeNull();
  });

  it("treats a half-ticked agreement as no consent at all", () => {
    expect(recordedConsent({ ...SIGNED, electronicConsentAccepted: false })).toBeNull();
    expect(recordedConsent({ ...SIGNED, termsAccepted: false })).toBeNull();
  });

  it("replays both-ticked consent verbatim, with its date", () => {
    const r = recordedConsent(SIGNED);
    expect(r?.agreement).toBe(SIGNED);
    expect(r?.dateLabel).toBe("August 19, 2026");
  });

  it("reads a full ISO timestamp as the day it happened", () => {
    expect(recordedConsent({ ...SIGNED, sigDate: "2026-08-19T22:15:00.000Z" })?.dateLabel).toBe("August 19, 2026");
  });

  it("says consent is on file without a date when the record has none", () => {
    // Every agreement written before consent dates were stamped looks like this.
    expect(recordedConsent({ ...SIGNED, sigDate: "" })?.dateLabel).toBeNull();
    expect(recordedConsent({ ...SIGNED, sigDate: "   " })?.dateLabel).toBeNull();
  });

  it("never turns an unreadable date into 'Invalid Date' or a guess", () => {
    for (const junk of ["not a date", "2026-13-45", "🙂"]) {
      const r = recordedConsent({ ...SIGNED, sigDate: junk });
      expect(r).not.toBeNull();
      expect(r?.dateLabel).toBeNull();
    }
  });

  it("refuses to replay a legacy row with no recorded actor, even both-ticked", () => {
    // Every agreement written before `actor` existed, including any a rep
    // ticked pre-0bf5b66, looks exactly like this.
    const { actor, ...legacy } = SIGNED;
    expect(recordedConsent(legacy as AgreementInfo)).toBeNull();
  });

  it("refuses to replay an agreement with an unexpected actor value, even both-ticked", () => {
    // `actor` has exactly one legal value, so this simulates data from before
    // the type existed — the cast is the point, not a workaround.
    const tampered = { ...SIGNED, actor: "rep" } as unknown as AgreementInfo;
    expect(recordedConsent(tampered)).toBeNull();
  });
});

describe("agreementToSubmit", () => {
  const FORM: AgreementInfo = {
    sigName: "Jane Doe", sigDate: "",
    termsAccepted: true, electronicConsentAccepted: true,
  };

  it("dates a first consent today", () => {
    expect(agreementToSubmit(null, FORM, false, "2026-09-01")).toEqual({
      ...FORM, sigDate: "2026-09-01", actor: "customer",
    });
  });

  it("leaves untouched recorded consent exactly as it was", () => {
    const r = recordedConsent(SIGNED)!;
    expect(agreementToSubmit(r, FORM, false, "2026-09-01")).toBe(SIGNED);
  });

  it("does not backfill a date onto recorded consent that never had one", () => {
    const undated = { ...SIGNED, sigDate: "" };
    const r = recordedConsent(undated)!;
    expect(agreementToSubmit(r, FORM, false, "2026-09-01").sigDate).toBe("");
  });

  it("dates re-consent today once the customer changes it", () => {
    const r = recordedConsent(SIGNED)!;
    const reconsented = agreementToSubmit(r, { ...FORM, sigName: "Jane A. Doe" }, true, "2026-09-01");
    expect(reconsented).toEqual({
      sigName: "Jane A. Doe", sigDate: "2026-09-01",
      termsAccepted: true, electronicConsentAccepted: true, actor: "customer",
    });
  });

  it("carries a withdrawal through rather than replaying the record", () => {
    // The submit gate rejects this; what matters here is that the recorded
    // "true" isn't silently substituted back in.
    const r = recordedConsent(SIGNED)!;
    const withdrawn = agreementToSubmit(r, { ...FORM, termsAccepted: false }, true, "2026-09-01");
    expect(withdrawn.termsAccepted).toBe(false);
  });

  it("stamps fresh consent as the customer's own act", () => {
    expect(agreementToSubmit(null, FORM, false, "2026-09-01").actor).toBe("customer");
  });

  it("returns replayed consent by identity, without re-stamping it", () => {
    const r = recordedConsent(SIGNED)!;
    const replayed = agreementToSubmit(r, FORM, false, "2026-09-01");
    expect(replayed).toBe(SIGNED);
    expect(replayed.actor).toBe("customer"); // already there on the record — not applied here
  });
});

describe("flattenSections", () => {
  it("keys every field by its dotted path", () => {
    const initial = customerOnboardInitial({ ...NO_SOURCE, analysis: ANALYSIS });
    const flat = flattenSections(initial);
    expect(flat["business.legalName"]).toBe("Little Arabia");
    expect(flat["ownerContact.title"]).toBe("Owner");
    expect(flat["processing.currentProcessor"]).toBe("Clover");
    // The `prefilled` list must not leak into the flattened values.
    expect(Object.keys(flat).some(k => k.startsWith("prefilled"))).toBe(false);
  });
});
