import { parseJSON } from "./utils";
import type { StatementAnalysis, ProposalOutput, PricingModel, ProposedRates, QuoteRates } from "@/types/merchant";
import { derivePricing, blendedInterchangeEstimate, type FeeOverrides } from "./pricing";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

function apiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  return key;
}

export async function analyzeStatement(
  fileData: string,
  mediaType: string
): Promise<StatementAnalysis> {
  const isImage = mediaType.startsWith("image/");

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: isImage ? "image" : "document",
              source: {
                type: "base64",
                media_type: isImage ? mediaType : "application/pdf",
                data: fileData,
              },
            },
            {
              type: "text",
              text: `Analyze this merchant processing statement. Return ONLY valid JSON — no markdown, no explanation.

FIELDS:
{
  "merchantName": string,
  "processingMonth": string,
  "totalVolume": number (total card volume processed this month in USD),
  "totalTransactions": number,
  "totalFees": number (ONLY the fees actually shown on this statement — see rules below),
  "interchangeFees": number (interchange/network fees in USD if shown; 0 if NOT shown),
  "processorFees": number (processor markup fees — see rules below),
  "otherFees": number (monthly fee, PCI fee, statement fee, misc — USD),
  "effectiveRate": number (totalFees / totalVolume as decimal),
  "interchangeRate": number (interchangeFees / totalVolume; 0 if interchange not shown),
  "processorMarkup": number (the markup RATE as decimal e.g. 0.0025 for 0.25% — NOT a dollar amount),
  "statedMarkupRate": number (the explicit % markup rate printed on the statement, as decimal; 0 if not stated),
  "statedPerTxnFee": number (the explicit per-transaction fee printed on the statement in USD; 0 if not stated),
  "interchangeNotShown": boolean (true if this is IC+ but interchange fees are NOT itemized on the statement),
  "averageTicket": number,
  "cardPresentVolume": number,
  "cardNotPresentVolume": number,
  "cardPresentPct": number,
  "cardNotPresentPct": number,
  "visaVolume": number,
  "mastercardVolume": number,
  "amexVolume": number,
  "discoverVolume": number,
  "rewardCardPct": number,
  "corporateCardPct": number,
  "currentPricingModel": "tiered|interchange-plus|flat-rate|unknown",
  "currentProcessorName": string,
  "annualVolume": number,
  "confidence": "high|medium|low",
  "notes": string
}

CRITICAL RULES — READ CAREFULLY:

RULE 1 — IC+ STATEMENTS WHERE INTERCHANGE IS NOT BROKEN OUT (e.g. Toast, some Heartland/TSYS):
These statements show the TOTAL fees (interchange + markup combined) but do not itemize interchange separately.
They DO show the markup rate (e.g. 0.25% + $0.10/txn) which is what the processor charges ABOVE interchange.

If this is interchange-plus pricing AND interchange is NOT itemized as a separate line:
  • Set interchangeNotShown = true
  • totalFees = the TOTAL fees shown on the statement (this INCLUDES interchange — use the grand total)
  • statedMarkupRate = the explicit % markup rate printed (e.g. 0.0025 for 0.25%)
  • statedPerTxnFee = the explicit per-transaction markup fee printed (e.g. 0.10)
  • processorFees = markup-only dollar amount = totalVolume × statedMarkupRate + totalTransactions × statedPerTxnFee
  • interchangeFees = totalFees − processorFees − otherFees  (back-calculated — the remainder IS interchange)
  • interchangeRate = interchangeFees / totalVolume
  • effectiveRate = totalFees / totalVolume  (true full effective rate including interchange)
  • processorMarkup = statedMarkupRate

RULE 2 — IC+ STATEMENTS WHERE INTERCHANGE IS ITEMIZED:
  • Set interchangeNotShown = false
  • interchangeFees = the interchange dollar amount explicitly shown
  • processorFees = fees shown above interchange (the markup)
  • totalFees = interchangeFees + processorFees + otherFees

RULE 3 — FLAT-RATE OR TIERED STATEMENTS:
  • Set interchangeNotShown = false
  • totalFees = all fees on the statement
  • interchangeFees = 0  (interchange is bundled, cannot be separated)
  • processorFees = totalFees − otherFees

RULE 4 — processorMarkup is always a RATE (decimal), never a dollar amount.
  e.g. 0.25% = 0.0025, 1.5% = 0.015

Use 0 for unknown numerics. Never null.`,
            },
          ],
        },
      ],
    }),
  });

  const data = await res.json();
  if (data.type === "error" || data.error) {
    throw new Error(data.error?.message || JSON.stringify(data.error || data));
  }

  const rawText = (data.content as { text?: string }[])?.map(b => b.text || "").join("") || "";
  const parsed = parseJSON(rawText) as Partial<StatementAnalysis> | null;
  if (!parsed) throw new Error("Could not parse statement analysis");

  // Normalize rate fields: >0.5 is likely a percentage integer, convert to decimal
  const rateFields: (keyof StatementAnalysis)[] = [
    "effectiveRate", "interchangeRate", "processorMarkup", "statedMarkupRate",
    "cardPresentPct", "cardNotPresentPct", "rewardCardPct", "corporateCardPct",
  ];
  rateFields.forEach(f => {
    const v = parsed[f] as number | undefined;
    if (v != null && v > 0.5) (parsed as Record<string, number>)[f as string] = v / 100;
  });

  const vol  = (parsed.totalVolume  || 0) as number;
  const txns = (parsed.totalTransactions || 0) as number;

  // IC+ where interchange is not itemized — recalculate from stated rates
  if (parsed.interchangeNotShown && vol > 0) {
    const markupRate = (parsed.statedMarkupRate || parsed.processorMarkup || 0) as number;
    const perTxnFee  = (parsed.statedPerTxnFee  || 0) as number;
    const calcMarkup = vol * markupRate + txns * perTxnFee;
    if (calcMarkup > 0) parsed.processorFees = calcMarkup;
    parsed.processorMarkup = markupRate;
    const backCalcIC = ((parsed.totalFees || 0) as number) - (parsed.processorFees || 0) - ((parsed.otherFees || 0) as number);
    parsed.interchangeFees = Math.max(0, backCalcIC);
    parsed.interchangeRate = parsed.interchangeFees / vol;
    if ((parsed.totalFees || 0) > 0) parsed.effectiveRate = (parsed.totalFees as number) / vol;
  }

  // Normalize volume-derived pcts
  if (vol > 0) {
    if ((parsed.cardPresentVolume || 0) > 0)    parsed.cardPresentPct    = (parsed.cardPresentVolume    as number) / vol;
    if ((parsed.cardNotPresentVolume || 0) > 0) parsed.cardNotPresentPct = (parsed.cardNotPresentVolume as number) / vol;
    (["cardPresentPct", "cardNotPresentPct", "rewardCardPct", "corporateCardPct"] as const).forEach(f => {
      if ((parsed[f] || 0) > 1) (parsed as Record<string, number>)[f] = 0;
    });
    if ((parsed.totalFees || 0) > 0 && !parsed.interchangeNotShown) {
      const derived = (parsed.totalFees as number) / vol;
      if (Math.abs(((parsed.effectiveRate || 0) as number) - derived) > 0.01) parsed.effectiveRate = derived;
    } else if ((parsed.totalFees || 0) > 0) {
      parsed.effectiveRate = (parsed.totalFees as number) / vol;
    }
    if ((parsed.interchangeFees || 0) > 0) {
      const derivedIC = (parsed.interchangeFees as number) / vol;
      if (Math.abs(((parsed.interchangeRate || 0) as number) - derivedIC) > 0.01) parsed.interchangeRate = derivedIC;
    }
  }

  // Interchange estimate when the statement doesn't itemize it (flat-rate / tiered —
  // RULE 3 leaves interchangeFees = 0 because interchange is bundled and can't be
  // separated). Steve 2026-07-23: assume 2.10% CP / 2.50% CNP. icEstimated tells the
  // pricing engine to use the exact per-lane estimate, and feeding it into currentMargin
  // below stops the merchant's "current markup" from reading as their full effective rate.
  if (vol > 0 && (parsed.interchangeFees || 0) === 0 && !parsed.interchangeNotShown) {
    const rawCp  = (parsed.cardPresentPct    || 0) as number;
    const rawCnp = (parsed.cardNotPresentPct || 0) as number;
    const cpPct  = (rawCp > 0 || rawCnp > 0) ? rawCp  : 0.9;
    const cnpPct = (rawCp > 0 || rawCnp > 0) ? (rawCnp || 1 - rawCp) : 0.1;
    parsed.interchangeRate = blendedInterchangeEstimate(cpPct, cnpPct);
    parsed.icEstimated = true;
  }

  parsed.currentMargin = ((parsed.effectiveRate || 0) as number) - ((parsed.interchangeRate || 0) as number);

  return parsed as StatementAnalysis;
}

export async function generateProposal(
  analysis: StatementAnalysis,
  pricingModel: PricingModel,
  quoteRates: QuoteRates | null,
  feeOverrides: FeeOverrides
): Promise<ProposalOutput> {
  const vol  = analysis.totalVolume || 0;
  const txns = analysis.totalTransactions || 0;
  const annVol = vol * 12;

  const { flatRate, cpRate, cnpRate, amexCpRate, amexCnpRate, perTxnFee, bps, projectedMonthlyFees, cpVol, cnpVol } =
    derivePricing(analysis, quoteRates, pricingModel, feeOverrides);

  const exactRates: ProposedRates =
    pricingModel === "flat-rate"
      ? { pricingModel, flatRate, perTransaction: feeOverrides.perTxnFee || 0, monthlyFee: feeOverrides.monthlyFee || 0 }
      : pricingModel === "2-tier"
      ? {
          pricingModel,
          cardPresentRate: cpRate,
          // One per-transaction fee across both lanes — the quoted rates carry
          // it now, where the two per-lane fee overrides used to.
          cardPresentPerTxn: perTxnFee,
          cardNotPresentRate: cnpRate,
          cardNotPresentPerTxn: perTxnFee,
          // AMEX is a separate price, so the proposal has to state it — a
          // document quoting two of the four rates understates the offer.
          amexCardPresentRate: amexCpRate,
          amexCardNotPresentRate: amexCnpRate,
          monthlyFee: feeOverrides.monthlyFee || 0,
        }
      : {
          pricingModel,
          basisPoints: bps,
          perTransaction: feeOverrides.perTxnFee || 0,
          monthlyFee: feeOverrides.monthlyFee || 0,
        };

  const exactProjected = {
    monthly: projectedMonthlyFees,
    annual: projectedMonthlyFees * 12,
    effectiveRate: vol > 0 ? projectedMonthlyFees / vol : 0,
  };
  const savingsMonthly = (analysis.totalFees || 0) - projectedMonthlyFees;

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: `Generate a payment processing proposal. Use EXACTLY the rates and fees provided — do not recalculate or change any numbers.

MERCHANT: ${JSON.stringify({ merchantName: analysis.merchantName, totalVolume: vol, totalTransactions: txns, totalFees: analysis.totalFees, effectiveRate: analysis.effectiveRate, currentProcessorName: analysis.currentProcessorName, currentPricingModel: analysis.currentPricingModel, annualVolume: annVol })}
PRICING MODEL: ${pricingModel}
PROPOSED RATES (use exactly): ${JSON.stringify(exactRates)}
PROJECTED FEES (use exactly): ${JSON.stringify(exactProjected)}
SAVINGS MONTHLY: ${savingsMonthly.toFixed(2)}
SAVINGS ANNUAL: ${(savingsMonthly * 12).toFixed(2)}

Return ONLY JSON (no markdown, all rate fields as decimals e.g. 0.0272 not 2.72):
{"pricingModel":"${pricingModel}","proposedRates":${JSON.stringify(exactRates)},"projectedFees":${JSON.stringify(exactProjected)},"currentFees":{"monthly":${(analysis.totalFees || 0).toFixed(2)},"annual":${((analysis.totalFees || 0) * 12).toFixed(2)},"effectiveRate":${(analysis.effectiveRate || 0).toFixed(6)}},"savings":{"monthly":${savingsMonthly.toFixed(2)},"annual":${(savingsMonthly * 12).toFixed(2)},"savingsPct":${(analysis.totalFees > 0 ? savingsMonthly / analysis.totalFees : 0).toFixed(6)}},"sellingPoints":["string","string","string","string"],"proposalSummary":"Write 2-3 sentences in this style: AIO combines payments, POS, and restaurant operations into one AI-powered platform. By replacing fragmented systems with a single solution, [merchantName] gains simpler pricing, better visibility into performance, and more predictable costs—while saving $[annualSavings] annually on processing. Use the actual merchant name and actual annual savings amount. Keep the language concise and benefit-focused."}`,
        },
      ],
    }),
  });

  const data = await res.json();
  if (data.type === "error" || data.error) {
    throw new Error(data.error?.message || JSON.stringify(data.error || data));
  }

  const rawText = (data.content as { text?: string }[])?.map(b => b.text || "").join("") || "";
  const parsed = parseJSON(rawText) as Partial<ProposalOutput> | null;
  if (!parsed) throw new Error("Could not parse proposal response");

  // Force exact computed values regardless of what AI returned
  parsed.proposedRates = exactRates;
  parsed.projectedFees = exactProjected;
  parsed.currentFees   = {
    monthly: analysis.totalFees || 0,
    annual:  (analysis.totalFees || 0) * 12,
    effectiveRate: analysis.effectiveRate || 0,
  };
  parsed.savings = {
    monthly: savingsMonthly,
    annual:  savingsMonthly * 12,
    savingsPct: analysis.totalFees > 0 ? savingsMonthly / analysis.totalFees : 0,
  };

  return parsed as ProposalOutput;
}
