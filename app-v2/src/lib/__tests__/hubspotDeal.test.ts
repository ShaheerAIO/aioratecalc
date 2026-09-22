import { describe, it, expect, vi, afterEach } from "vitest";
import {
  STAGE_MAP,
  HUBSPOT_DEAL_PIPELINE_ID,
  DEAL_PROPERTIES,
  DEAL_TO_COMPANY_ASSOCIATION_TYPE_ID,
  SALES_PIPELINE_STAGES,
  dealStageRank,
  classifyDealStage,
  guardDealStageProps,
  omitStageOnUnreadableDeal,
  buildDealProperties,
  buildDealAssociations,
  dedupeCompanyIds,
  parseDealIdInput,
} from "@/lib/adapters/hubspot";
import { STAGE_RANK } from "@/lib/stages";
import type { DealStage, MerchantApplication, TenantLink } from "@/types/merchant";

// Ids this module used to write that no longer exist on the live pipeline at
// all (verified 2026-09-21, portal 244508708 — don't re-probe): `3262845631`
// ("Sales Accepted") was STAGE_MAP's old target for prospect_created/
// lead_link_sent; `appointmentscheduled` ("Appointment Scheduled") was never
// used but was carried as a real stage. Neither appears in
// SALES_PIPELINE_STAGES. Kept alongside the older phantom stage-id names
// (never real ids on this portal at all) as one combined regression list —
// SALES_PIPELINE_STAGES is the single source of truth for what's real now,
// so there's no separate hand-copied "REAL_PIPELINE_STAGE_IDS" list to drift
// out of sync with it.
const DEAD_STAGE_IDS = [
  "3262845631", "appointmentscheduled",
  "qualifiedtobuy", "presentationscheduled", "decisionmakerboughtin", "contractsent",
];

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

describe("SALES_PIPELINE_STAGES", () => {
  it("names none of the dead stage ids", () => {
    const ids = SALES_PIPELINE_STAGES.map(s => s.id);
    for (const dead of DEAD_STAGE_IDS) expect(ids).not.toContain(dead);
  });

  it("marks closedwon as the only won, closed stage", () => {
    const won = SALES_PIPELINE_STAGES.filter(s => s.won);
    expect(won).toEqual([expect.objectContaining({ id: "closedwon", closed: true })]);
  });

  it("marks every terminal outcome closed: won or lost, cancelled, churned, non-start", () => {
    const closedIds = SALES_PIPELINE_STAGES.filter(s => s.closed).map(s => s.id);
    expect(closedIds.sort()).toEqual(
      ["closedwon", "closedlost", "3060460231", "3069369052", "3888148174"].sort()
    );
  });
});

describe("dealStageRank", () => {
  it("is -1 for null", () => {
    expect(dealStageRank(null)).toBe(-1);
  });

  it("is -1 for an id this build doesn't recognize, including the dead ones", () => {
    for (const dead of DEAD_STAGE_IDS) expect(dealStageRank(dead)).toBe(-1);
  });

  it("assigns strictly increasing ranks in pipeline order, with no ties", () => {
    const ranks = SALES_PIPELINE_STAGES.map(s => dealStageRank(s.id));
    for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeGreaterThan(ranks[i - 1]);
  });

  it("ranks Discovery Meeting before Signed/Awaiting Payment Info before Closed Won", () => {
    expect(dealStageRank("2717103849")).toBeLessThan(dealStageRank("2767738593"));
    expect(dealStageRank("2767738593")).toBeLessThan(dealStageRank("closedwon"));
  });
});

describe("classifyDealStage", () => {
  it("returns the label and closed/won flags for a known stage", () => {
    expect(classifyDealStage("closedwon")).toEqual({ label: "Closed Won", closed: true, won: true });
    expect(classifyDealStage("2767738593")).toEqual({
      label: "Signed/Awaiting Payment Info", closed: false, won: false,
    });
  });

  it("returns null/false for a null or unrecognized id", () => {
    expect(classifyDealStage(null)).toEqual({ label: null, closed: false, won: false });
    expect(classifyDealStage("3262845631")).toEqual({ label: null, closed: false, won: false });
  });
});

describe("STAGE_MAP", () => {
  it("maps exactly the ten milestones EasyOB genuinely observes, and no others", () => {
    expect(Object.keys(STAGE_MAP).sort()).toEqual([
      "lead_link_sent", "quote_sent", "proposal_sent",
      "quote_accepted", "merchant_link_sent", "merchant_filling",
      "adyen_kyc_pending", "adyen_kyc_complete", "adyen_approved", "closed_lost",
    ].sort());
  });

  it("leaves the five purely-internal DealStage values deliberately unmapped", () => {
    const unmapped = (Object.keys(STAGE_RANK) as DealStage[]).filter(s => !(s in STAGE_MAP));
    expect(unmapped.sort()).toEqual(
      ["prospect_created", "lead_analysis_pending", "analysis", "pricing", "proposal_ready"].sort()
    );
  });

  it("maps every value onto a real, current SALES_PIPELINE_STAGES id", () => {
    const realIds = SALES_PIPELINE_STAGES.map(s => s.id);
    for (const [stage, id] of Object.entries(STAGE_MAP)) {
      expect(realIds, `${stage} → ${id}`).toContain(id);
    }
  });

  it("names none of the dead stage ids", () => {
    const mapped = Object.values(STAGE_MAP);
    for (const dead of DEAD_STAGE_IDS) expect(mapped).not.toContain(dead);
  });

  it("never maps a later EasyOB milestone to an earlier pipeline stage", () => {
    // Only meaningful across the stages that ARE mapped — the five left
    // unmapped above are silent on purpose and carry no ordering claim.
    const mappedInOrder = (Object.keys(STAGE_RANK) as DealStage[])
      .filter((s): s is keyof typeof STAGE_MAP => s in STAGE_MAP)
      .sort((a, b) => STAGE_RANK[a] - STAGE_RANK[b]);
    let previous = -1;
    for (const stage of mappedInOrder) {
      const position = dealStageRank(STAGE_MAP[stage]);
      expect(position, `${stage} → ${STAGE_MAP[stage]}`).toBeGreaterThanOrEqual(previous);
      previous = position;
    }
  });
});

describe("buildDealProperties", () => {
  it("sends only properties that exist on the DEAL object", () => {
    const props = buildDealProperties(appAt("merchant_filling"));
    for (const key of Object.keys(props)) expect(DEAL_PROPERTIES).toContain(key);
  });

  it("sends none of the five phantom properties", () => {
    const props = buildDealProperties(appAt("proposal_sent", {
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

  it("still writes name and amount when creating a brand-new deal (no hubspotDealId yet)", () => {
    const props = buildDealProperties(appAt("merchant_filling"));
    expect(props.dealname).toBe("Torta Palace");
    expect(props.amount).toBe("1200000");
  });

  // ── dealname/amount ownership: the two live-bug fixes ─────────────────────
  // A rep can now ATTACH an application to a deal they already owned in
  // HubSpot ("adopted") instead of EasyOB always minting its own. Writing
  // dealname/amount to an adopted deal would overwrite the rep's own deal
  // value and fight the portal's own `{company} / Deal-{n}` renaming
  // workflow — see buildDealProperties' own comment and CLAUDE.md.
  describe("dealname/amount ownership on a PATCH (hubspotDealId already set)", () => {
    const ADOPTED = {
      hubspotDealId: "deal-adopted-1",
      dealLink: {
        origin: "adopted" as const,
        dealName: "Torta Palace LLC / Deal - 1",
        pipelineStageAtLink: "2717103849",
        linkedAt: "2026-09-01T00:00:00.000Z",
        linkedByUserId: "rep-1",
      },
    };

    it("omits dealname and amount on an ADOPTED deal", () => {
      const props = buildDealProperties(appAt("merchant_filling", ADOPTED));
      expect(props).not.toHaveProperty("dealname");
      expect(props).not.toHaveProperty("amount");
      // The forward-only stage write is untouched — only name/amount are gated.
      expect(props.dealstage).toBe(STAGE_MAP.merchant_filling);
    });

    it("writes dealname and amount on a deal EasyOB created itself", () => {
      const props = buildDealProperties(appAt("merchant_filling", {
        hubspotDealId: "deal-created-1",
        dealLink: {
          origin: "created", dealName: "Torta Palace", pipelineStageAtLink: null,
          linkedAt: "2026-09-01T00:00:00.000Z", linkedByUserId: "rep-1",
        },
      }));
      expect(props.dealname).toBe("Torta Palace");
      expect(props.amount).toBe("1200000");
    });

    it("treats a null dealLink (every pre-adoption row) as adopted — omits dealname and amount", () => {
      const props = buildDealProperties(appAt("merchant_filling", {
        hubspotDealId: "deal-legacy-1",
        dealLink: null,
      }));
      expect(props).not.toHaveProperty("dealname");
      expect(props).not.toHaveProperty("amount");
    });
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

  it("omits pipeline and dealstage, silently, for a stage this build doesn't know", () => {
    // Silence is the deliberately designed case now: five real DealStage
    // values (asserted above) are unmapped on purpose, and a future one
    // nobody's wired up yet behaves the same way — no warning, since an
    // unmapped stage isn't an anomaly.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const props = buildDealProperties(appAt("some_future_stage"));
    expect(props).not.toHaveProperty("dealstage");
    expect(props).not.toHaveProperty("pipeline");
    expect(props.dealname).toBe("Torta Palace");
    expect(warn).not.toHaveBeenCalled();
  });

  it("omits pipeline and dealstage, silently, for a deliberately-unmapped real stage", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const props = buildDealProperties(appAt("pricing"));
    expect(props).not.toHaveProperty("dealstage");
    expect(props).not.toHaveProperty("pipeline");
    expect(warn).not.toHaveBeenCalled();
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

describe("guardDealStageProps (the forward-only PATCH guard)", () => {
  const forward = buildDealProperties(appAt("adyen_approved")); // → closedwon, rank 6

  it("passes a forward move through untouched", () => {
    // Deal currently at Discovery Meeting (rank 0); writing closedwon (rank 6) is forward.
    expect(guardDealStageProps("2717103849", forward)).toEqual(forward);
  });

  it("drops dealstage/pipeline, keeping the rest, when the write would move the deal backwards", () => {
    // Deal already at Closed Won; a later push carrying an earlier milestone
    // (say a stale retry racing a rep's own progress) must not drag it back.
    const backward = buildDealProperties(appAt("merchant_filling")); // → Signed/Awaiting Payment Info, rank 5
    const guarded = guardDealStageProps("closedwon", backward);
    expect(guarded).not.toHaveProperty("dealstage");
    expect(guarded).not.toHaveProperty("pipeline");
    expect(guarded.dealname).toBe(backward.dealname);
    expect(guarded.amount).toBe(backward.amount);
  });

  it("leaves the write alone when the deal is already at the exact target stage", () => {
    // Re-affirming the current stage is harmless — only a strictly earlier
    // target gets dropped, per guardDealStageProps' own contract.
    expect(guardDealStageProps("closedwon", forward)).toEqual(forward);
  });

  it("never blocks a write for a stage id it doesn't recognize as current", () => {
    // An unrecognized CURRENT stage ranks -1, i.e. "behind everything", so it
    // can never make a real, mapped target look like a backward move.
    expect(guardDealStageProps("some-retired-id", forward)).toEqual(forward);
  });

  it("is a no-op when there's no dealstage to guard in the first place", () => {
    const noStage = buildDealProperties(appAt("pricing")); // unmapped — no dealstage/pipeline
    expect(guardDealStageProps("closedwon", noStage)).toEqual(noStage);
  });
});

describe("omitStageOnUnreadableDeal (the dropBackwardStage degrade path)", () => {
  it("drops dealstage/pipeline, keeping name and amount, when the current stage couldn't be read at all", () => {
    const props = buildDealProperties(appAt("merchant_filling")); // has dealstage + pipeline
    const degraded = omitStageOnUnreadableDeal(props);
    expect(degraded).not.toHaveProperty("dealstage");
    expect(degraded).not.toHaveProperty("pipeline");
    expect(degraded.dealname).toBe(props.dealname);
    expect(degraded.amount).toBe(props.amount);
  });

  it("is a no-op when there's no dealstage to drop in the first place", () => {
    const props = buildDealProperties(appAt("pricing")); // unmapped — no dealstage/pipeline
    expect(omitStageOnUnreadableDeal(props)).toEqual(props);
  });
});

describe("dedupeCompanyIds", () => {
  it("collapses the labeled + unlabeled association rows for the same company to one id", () => {
    // The exact shape HubSpot returns live for a deal on one company (verified
    // 2026-09-21): the company appears twice, as deal_to_company and
    // deal_to_company_unlabeled.
    expect(dedupeCompanyIds([
      { id: "334295287484" },
      { id: "334295287484" },
    ])).toEqual(["334295287484"]);
  });

  it("keeps distinct companies distinct", () => {
    expect(dedupeCompanyIds([{ id: "1" }, { id: "2" }, { id: "1" }])).toEqual(["1", "2"]);
  });

  it("is empty for undefined or no results", () => {
    expect(dedupeCompanyIds(undefined)).toEqual([]);
    expect(dedupeCompanyIds([])).toEqual([]);
  });
});

describe("parseDealIdInput", () => {
  it("accepts a bare numeric id", () => {
    expect(parseDealIdInput("348349741779")).toBe("348349741779");
    expect(parseDealIdInput("  348349741779  ")).toBe("348349741779");
  });

  it("extracts the id from a pasted HubSpot record URL", () => {
    expect(parseDealIdInput("https://app-na2.hubspot.com/contacts/244508708/record/0-3/348349741779"))
      .toBe("348349741779");
  });

  it("extracts the id from a record URL with a trailing slash removed only, no query string assumed", () => {
    expect(parseDealIdInput("https://app-na2.hubspot.com/contacts/244508708/record/0-3/348349741779/"))
      .toBe("348349741779");
  });

  it("returns null for garbage that is neither a numeric id nor a URL", () => {
    expect(parseDealIdInput("not-a-deal-id")).toBeNull();
    expect(parseDealIdInput("")).toBeNull();
  });

  it("returns null for a URL whose last path segment isn't numeric", () => {
    expect(parseDealIdInput("https://app-na2.hubspot.com/contacts/244508708/record/0-3/")).toBeNull();
  });
});

afterEach(() => vi.restoreAllMocks());
