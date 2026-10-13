"use server";

// Admin-only commission report (2026-10-13) — the full picture that moved
// OFF PricingStep/EditQuotePanel: AIO Revenue, processor cost, net margin,
// the true floor, and the commission breakdown, per deal. Backs the
// Commissions tab at /admin?view=commissions (see AdminDashboard.tsx and
// CommissionsPanel.tsx), following the Revenue tab's precedent rather than a
// new nav item — CLAUDE.md caps the admin nav at 4 items.

import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import { listApplicationsAction, getSettingsAction } from "@/lib/actions/applications";
import { getHardwareCommissionPolicy } from "@/lib/actions/pricing";
import { buildCommissionReport, type DealCommissionRow } from "@/lib/billing/commissionReport";
import type { ProcessorTier } from "@/types/merchant";

export async function getCommissionReportAction(): Promise<DealCommissionRow[]> {
  const effective = await getEffectiveRole();
  if (!effective || effective.role !== "admin") throw new Error("Admin only");

  // listApplicationsAction is already role-scoped (admin -> every account);
  // getSettingsAction gives the processor tier the true cost figures are
  // computed against, same source PricingStep/EditQuotePanel already read.
  const [apps, settings, hardwarePolicy] = await Promise.all([
    listApplicationsAction(),
    getSettingsAction(),
    getHardwareCommissionPolicy(),
  ]);

  const activeTier: ProcessorTier | null =
    settings.processors?.find(p => p.isDefault)?.tiers?.find(t => t.isDefault)
    ?? settings.processors?.[0]?.tiers?.[0]
    ?? null;

  return buildCommissionReport(apps, activeTier, hardwarePolicy);
}
