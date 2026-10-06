import { NextRequest, NextResponse } from "next/server";
import { generateProposal } from "@/lib/claude";
import type { StatementAnalysis, PricingModel, QuoteRates } from "@/types/merchant";
import type { FeeOverrides } from "@/lib/pricing";
import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";

// Rep/admin only. middleware.ts's matcher covers /rep, /admin and /customer but
// NOT /api, so the session check has to live in the route itself. Every call
// bills the Anthropic API, and the response is rep-internal proposal copy built
// from the true pricing numbers — there is no customer-facing counterpart.
export async function POST(req: NextRequest) {
  if (!(await getEffectiveRole())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { analysis, pricingModel, quoteRates, feeOverrides } = await req.json() as {
      analysis: StatementAnalysis;
      pricingModel: PricingModel;
      quoteRates: QuoteRates | null;
      feeOverrides: FeeOverrides;
    };

    // quoteRates is optional, unlike the targetMargin it replaced: a missing
    // margin meant "work one out", which needed a number, while missing rates
    // mean the standard ones.
    if (!analysis || !pricingModel) {
      return NextResponse.json({ error: "analysis and pricingModel are required" }, { status: 400 });
    }

    const proposal = await generateProposal(analysis, pricingModel, quoteRates ?? null, feeOverrides);
    return NextResponse.json({ proposal });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Proposal generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
