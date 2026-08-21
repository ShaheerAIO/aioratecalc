import { describe, it, expect, vi, afterEach } from "vitest";
import {
  STAGE_MAP,
  HUBSPOT_DEAL_PIPELINE_ID,
  DEAL_PROPERTIES,
  DEAL_TO_COMPANY_ASSOCIATION_TYPE_ID,
  buildDealProperties,
  buildDealAssociations,
} from "@/lib/adapters/hubspot";
import { STAGE_RANK } from "@/lib/stages";
import type { DealStage, MerchantApplication, TenantLink } from "@/types/merchant";

// The 19 stage ids of AIO's real deal pipeline (id "default", label "Sales "),
// read from the live portal 2026-08-20 and recorded in PAYMENT-TEST-PLAN.md
// §1.8 (O-5). Order is pipeline order — the index doubles as "how far along".
const REAL_PIPELINE_STAGE_IDS = [
  "3262845631",         // Sales Accepted
  "appointmentscheduled", // Appointment Scheduled
  "2717103849",         // Discovery Meeting
  "stage_0",            // Demo Meeting
  "3634617027",         // Quote Sent
  "3891166952",         // Signing Delayed
  "3814929108",         // Signed Awaiting Features
  "2767738593",         // Signed/Awaiting Payment Info
  "closedwon",
  "2992070353",         // Onboarding
  "3888148172",         // Onboarding Delayed
  "2986384064",         // Configuration
  "2986384063",         // Deployment/Training
  "3888148173",         // Deployment/Training Delayed
  "3888148174",         // Non-Start
  "3452539597",         // Deal Active
  "3060460231",         // Cancelled Before Live
  "3069369052",         // Churned
  "closedlost",
];

// The names the old map used, none of which exist in this portal.
const PHANTOM_STAGE_IDS = ["qualifiedtobuy", "presentationscheduled", "decisionmakerboughtin", "contractsent"];

// The five properties the payload used to send that don't exist on DEAL. Any
// one of them makes HubSpot 400 the whole request with PROPERTY_DOESNT_EXIST.
const PHANTOM_DEAL_PROPERTIES = [
  "current_processor", "current_monthly_fees", "projected_annual_savings",
  "proposed_effective_rate", "mcc_code",
];

const TENANT_LINK: TenantLink = {
  hubspotCompanyId: "334295287484",
  companyName: "Torta Palace",
  tenantRef: "prod-1024",
  adyenAccountHolderId: null,
  linkedAt: "2026-08-19T00:00:00.000Z",
  linkedByUserId: "rep-1",
};

function appAt(stage: DealStage | string, extra: Partial<MerchantApplication> = {}): MerchantApplication {
  return {
    id: "app-1",
    stage: stage as DealStage,
    hubspotDealId: null,
    tenantLink: null,
    business: { dba: "Torta Palace", legalName: "Torta Palace LLC" },
    processing: { monthlyVolume: "100000" },
    ...extra,
  } as unknown as MerchantApplication;
}

describe("STAGE_MAP", () => {
  it("is total over DealStage", () => {
    // STAGE_RANK is itself `satisfies Record<DealStage, number>`, so its keys
    // are the authoritative DealStage list.
    expect(Object.keys(STAGE_MAP).sort()).toEqual(Object.keys(STAGE_RANK).sort());
  });

  it("maps every stage onto a real pipeline stage id", () => {
    for (const [stage, id] of Object.entries(STAGE_MAP)) {
      expect(REAL_PIPELINE_STAGE_IDS, `${stage} → ${id}`).toContain(id);
    }
  });

  it("names none of the four stage ids that don't exist in this portal", () => {
    const mapped = Object.values(STAGE_MAP);
    for (const phantom of PHANTOM_STAGE_IDS) expect(mapped).not.toContain(phantom);
  });

  it("never moves a deal backwards as the EasyOB stage advances", () => {
    const ordered = (Object.keys(STAGE_RANK) as DealStage[])
      .filter(s => s !== "closed_lost") // terminal loss isn't a forward step
      .sort((a, b) => STAGE_RANK[a] - STAGE_RANK[b]);
    let previous = -1;
    for (const stage of ordered) {
      const position = REAL_PIPELINE_STAGE_IDS.indexOf(STAGE_MAP[stage]);
      expect(position, `${stage} → ${STAGE_MAP[stage]}`).toBeGreaterThanOrEqual(previous);
      previous = position;
    }
  });

  it("does not send merchant_filling back to the pipeline's first stage", () => {
    // The regression this fix exists for: merchant_filling was unmapped and
    // fell back to the first stage, on the most common push of all.
    expect(STAGE_MAP.merchant_filling).not.toBe(REAL_PIPELINE_STAGE_IDS[0]);
    expect(REAL_PIPELINE_STAGE_IDS.indexOf(STAGE_MAP.merchant_filling))
      .toBeGreaterThan(REAL_PIPELINE_STAGE_IDS.indexOf(STAGE_MAP.analysis));
  });
});

describe("buildDealProperties", () => {
  it("sends only properties that exist on the DEAL object", () => {
    const props = buildDealProperties(appAt("merchant_filling"));
    for (const key of Object.keys(props)) expect(DEAL_PROPERTIES).toContain(key);
  });

  it("sends none of the five phantom properties", () => {
    const props = buildDealProperties(appAt("analysis", {
      analysis: { currentProcessorName: "Toast", totalFees: 4200 },
      proposal: { savings: { annual: 12000 }, projectedFees: { effectiveRate: 0.0225 } },
    } as unknown as Partial<MerchantApplication>));
    for (const phantom of PHANTOM_DEAL_PROPERTIES) expect(props).not.toHaveProperty(phantom);
  });

  it("sets the pipeline explicitly alongside the stage", () => {
    const props = buildDealProperties(appAt("merchant_filling"));
    expect(props.pipeline).toBe(HUBSPOT_DEAL_PIPELINE_ID);
    expect(props.dealstage).toBe(STAGE_MAP.merchant_filling);
  });

  it("still writes name and amount", () => {
    const props = buildDealProperties(appAt("pricing"));
    expect(props.dealname).toBe("Torta Palace");
    expect(props.amount).toBe("1200000");
  });

  it("falls back to the quoted volume when there is no statement or form", () => {
    // What a deal pushed on acceptance looks like: the merchant hasn't filled
    // the onboarding form and never handed over a statement, so the only volume
    // on the record is the one the rep quoted from. Reading processing/analysis
    // alone put these deals in the pipeline at $0.
    const props = buildDealProperties(appAt("quote_accepted", {
      processing: null,
      analysis: null,
      quoteConfig: { monthlyVolume: 1000, avgTicket: 100 },
    } as unknown as Partial<MerchantApplication>));
    expect(props.amount).toBe("12000");
  });

  it("prefers the statement and the form over the quoted volume", () => {
    const fromStatement = buildDealProperties(appAt("quote_accepted", {
      processing: null,
      analysis: { totalVolume: 50000 },
      quoteConfig: { monthlyVolume: 1000, avgTicket: 100 },
    } as unknown as Partial<MerchantApplication>));
    expect(fromStatement.amount).toBe("600000");
    // processing.monthlyVolume is what the merchant typed themselves — top authority.
    const fromForm = buildDealProperties(appAt("quote_accepted", {
      analysis: { totalVolume: 50000 },
      quoteConfig: { monthlyVolume: 1000, avgTicket: 100 },
    } as unknown as Partial<MerchantApplication>));
    expect(fromForm.amount).toBe("1200000");
  });

  it("amounts a marketing-only quote at zero — it has no card volume", () => {
    const props = buildDealProperties(appAt("quote_accepted", {
      processing: null, analysis: null, quoteType: "marketing_only", quoteConfig: null,
    } as unknown as Partial<MerchantApplication>));
    expect(props.amount).toBe("0");
  });

  it("omits pipeline and dealstage for a stage this build doesn't know", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const props = buildDealProperties(appAt("some_future_stage"));
    expect(props).not.toHaveProperty("dealstage");
    expect(props).not.toHaveProperty("pipeline");
    expect(props.dealname).toBe("Torta Palace");
    expect(warn).toHaveBeenCalled();
  });
});

describe("buildDealAssociations", () => {
  it("associates the deal to its tenant Company", () => {
    expect(buildDealAssociations(appAt("quote_sent", { tenantLink: TENANT_LINK }))).toEqual([
      {
        to: { id: "334295287484" },
        types: [{
          associationCategory: "HUBSPOT_DEFINED",
          associationTypeId: DEAL_TO_COMPANY_ASSOCIATION_TYPE_ID,
        }],
      },
    ]);
  });

  it("uses the confirmed deal → company association type id", () => {
    expect(DEAL_TO_COMPANY_ASSOCIATION_TYPE_ID).toBe(341);
  });

  it("degrades to no associations when the application has no tenant link", () => {
    expect(buildDealAssociations(appAt("quote_sent"))).toEqual([]);
  });

  it("degrades when the tenant link carries a blank company id", () => {
    const blank = { ...TENANT_LINK, hubspotCompanyId: "  " };
    expect(buildDealAssociations(appAt("quote_sent", { tenantLink: blank }))).toEqual([]);
  });
});

afterEach(() => vi.restoreAllMocks());
