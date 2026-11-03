"use server";

// An admin approving the overrides on one quote (draft quotes + admin override
// approval, 2026-11-02). A rep's quote with overrides is saved as
// `pending_approval` and the admins are emailed (prospects.ts); this is the
// other half: the admin approves, and the rep is emailed back.
//
// No HubSpot writes and no merchant email here. Approving a never-sent draft
// leaves it `approved` for the rep to send; approving an edit to a quote whose
// link is already out makes that link live again (`quoteStatus` null).

import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import { postgresStorage } from "@/lib/storage/postgresAdapter";
import { sendQuoteApprovedEmail } from "@/lib/adapters/email";
import { getStaffRecipient } from "@/lib/staff";
import { appBaseUrl, approvalCovers, evaluateQuoteOverrides } from "@/lib/quoteEvaluation";
import type { MerchantApplication, QuoteApproval, QuoteOverride, QuoteStatus } from "@/types/merchant";

// The same gate the other admin actions use (users.ts's `requireAdmin`).
async function requireAdmin() {
  const effective = await getEffectiveRole();
  if (!effective || effective.role !== "admin") throw new Error("Admin only");
  return effective;
}

export type ApproveQuoteResult = {
  id: string;
  /** null when the link was already out (it is live again); otherwise "approved". */
  quoteStatus: QuoteStatus | null;
  quoteApproval: QuoteApproval;
  /** Whether the owning rep's "approved" email went out. */
  repNotified: boolean;
};

/**
 * Approve the overrides on a `pending_approval` quote.
 *
 * Re-checks what is being approved: the overrides are recomputed from the
 * saved row against today's limits, and if they no longer fingerprint to what
 * the rep asked about — the quote was edited, or a limit or the rate card
 * moved — this refuses rather than approve something nobody asked for.
 */
export async function approveQuoteAction(applicationId: string): Promise<ApproveQuoteResult> {
  const effective = await requireAdmin();
  const scope = { userId: effective.userId, role: effective.role };

  const app = await postgresStorage.getApplication(scope, applicationId);
  if (!app) throw new Error("Application not found");
  if (app.quoteStatus !== "pending_approval" || !app.quoteApproval) {
    throw new Error("This quote isn't waiting on an approval.");
  }

  const now = new Date().toISOString();
  const quoteApproval: QuoteApproval = { ...app.quoteApproval, approvedAt: now, approvedByUserId: effective.userId };
  const quoteStatus: QuoteStatus | null = app.customerLinkToken ? null : "approved";
  const updated: MerchantApplication = { ...app, quoteStatus, quoteApproval, updatedAt: now };

  // The stamped approval has to cover the quote as it stands now — the same
  // check `sendDraftAction` and the publish gate make — or the request was for
  // a different quote than the one on the row.
  const overrides = await evaluateQuoteOverrides(app);
  if (!approvalCovers(updated, overrides)) {
    throw new Error("The quote changed since approval was requested. Reopen it to see what it carries now.");
  }
  await postgresStorage.saveApplication(scope, updated);

  let repNotified = false;
  if (app.ownerUserId !== effective.userId) {
    try {
      const [rep, approver] = await Promise.all([
        getStaffRecipient(app.ownerUserId), getStaffRecipient(effective.userId),
      ]);
      if (rep?.email) {
        const result = await sendQuoteApprovedEmail({
          to: rep.email,
          merchantName: app.business?.dba || app.business?.legalName || app.analysis?.merchantName || "",
          approverName: approver?.name || approver?.email || effective.name || "An admin",
          url: `${appBaseUrl()}/rep?account=${encodeURIComponent(app.id)}`,
          linkLive: quoteStatus === null,
        });
        repNotified = result.sent;
      }
    } catch (err) {
      console.error("quote approved email failed", app.id, err);
    }
  }

  return { id: app.id, quoteStatus, quoteApproval, repNotified };
}

export type QuoteApprovalView = {
  quoteStatus: QuoteStatus | null;
  /** What was asked for (empty when the quote carries no approval). */
  overrides: QuoteOverride[];
  requestedAt: string | null;
  requestedByName: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
};

/**
 * The review panel's read of a quote's approval: what was asked for, by whom,
 * and who approved it. Open to any admin and to the owning rep — storage keeps
 * a rep off anyone else's row. Rep-safe: the override messages never carry the
 * margin floor (see `rateOverrides`).
 */
export async function getQuoteApprovalAction(applicationId: string): Promise<QuoteApprovalView> {
  const effective = await getEffectiveRole();
  if (!effective) throw new Error("Not authenticated");
  const scope = { userId: effective.userId, role: effective.role };

  const app = await postgresStorage.getApplication(scope, applicationId);
  if (!app) throw new Error("Application not found");

  const approval = app.quoteApproval ?? null;
  const nameOf = async (userId: string | null | undefined) => {
    if (!userId) return null;
    const who = await getStaffRecipient(userId);
    return who ? who.name || who.email : null;
  };
  const [requestedByName, approvedByName] = await Promise.all([
    nameOf(approval?.requestedByUserId), nameOf(approval?.approvedByUserId),
  ]);

  return {
    quoteStatus: app.quoteStatus ?? null,
    overrides: approval?.overrides ?? [],
    requestedAt: approval?.requestedAt ?? null,
    requestedByName,
    approvedAt: approval?.approvedAt ?? null,
    approvedByName,
  };
}
