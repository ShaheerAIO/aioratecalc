// One status ladder for the rep dashboard, collapsing the three vocabularies an
// account carries today: DealStage, quoteStatus, and the HubSpot billing state
// (billingView). Pure; no I/O. There is deliberately no Paid step: payment is
// folded into Signed and exposed as `paid` for a note.
import { billingPanelState, hasBillingSyncError } from "@/lib/billingView";
import type { MerchantApplication } from "@/types/merchant";

export type AccountStatus =
  | "draft" | "needs_approval" | "ready_to_send" | "sent" | "signed" | "onboarding" | "live" | "closed_lost";

export const STATUS_LADDER: readonly AccountStatus[] = [
  "draft", "needs_approval", "ready_to_send", "sent", "signed", "onboarding", "live",
];

export const STATUS_LABELS: Record<AccountStatus, string> = {
  draft: "Draft",
  needs_approval: "Needs approval",
  ready_to_send: "Ready to send",
  sent: "Sent",
  signed: "Signed",
  onboarding: "Onboarding",
  live: "Live",
  closed_lost: "Closed lost",
};

export type AccountFlag = "needs_company_link" | "sync_error";
export type FilterGroup = "needs_me" | "needs_approval" | "sent" | "onboarding" | "live" | "closed_lost";
export type NextActionKey =
  | "finish_quote" | "waiting_on_admin" | "approve" | "send_quote" | "link_company"
  | "resend_quote_link" | "send_onboarding_link" | "resend_onboarding_link" | "view";
export type NextAction = { key: NextActionKey; label: string; disabled?: boolean };

export type AccountStatusInput = Pick<
  MerchantApplication,
  "stage" | "quoteStatus" | "quoteAcceptedAt" | "aioTenant" | "quoteLines" | "hubspotIds" | "tenantLink"
>;

export type AccountStatusResult = {
  status: AccountStatus;
  label: string;
  /** Extra detail, only set for onboarding ("Filling in form", "KYC in review", ...). */
  subLabel: string | null;
  flags: AccountFlag[];
  /** Payment is a note on Signed, not a step. null = no HubSpot quote to ask. */
  paid: boolean | "unknown";
  nextAction: NextAction | null;
  filterGroup: FilterGroup;
};

const ONBOARDING_SUBLABELS: Record<string, string> = {
  merchant_link_sent: "Link sent to merchant",
  merchant_filling: "Filling in form",
  adyen_kyc_pending: "KYC in review",
  adyen_kyc_complete: "KYC complete",
};
const PRE_SEND_STAGES = ["prospect_created", "lead_analysis_pending", "analysis", "pricing", "proposal_ready"];

export function deriveStatus(app: AccountStatusInput): { status: AccountStatus; subLabel: string | null } {
  const { stage, quoteStatus } = app;
  if (stage === "closed_lost") return { status: "closed_lost", subLabel: null };
  if (stage === "adyen_approved") return { status: "live", subLabel: null };
  if (stage in ONBOARDING_SUBLABELS) return { status: "onboarding", subLabel: ONBOARDING_SUBLABELS[stage] };
  // Code check (AccountsDashboard): accepted = quoteAcceptedAt || aioTenant || onboarding stage.
  // Matches it: a provisioned aioTenant only exists after acceptance, so it counts too.
  if (app.quoteAcceptedAt || app.aioTenant || stage === "quote_accepted" || app.hubspotIds?.esignStatus === "SIGNED") {
    return { status: "signed", subLabel: null };
  }
  if (quoteStatus === "pending_approval") return { status: "needs_approval", subLabel: null };
  if (quoteStatus === "approved") return { status: "ready_to_send", subLabel: null };
  if (quoteStatus === "draft" || PRE_SEND_STAGES.includes(stage)) return { status: "draft", subLabel: null };
  // quoteStatus null = live with the merchant (lead_link_sent, quote_sent, proposal_sent).
  return { status: "sent", subLabel: null };
}

function paidState(app: AccountStatusInput): boolean | "unknown" {
  const ids = app.hubspotIds;
  if (!ids?.publishedAt) return "unknown";
  if (ids.paymentStatus === "PAID") return true;
  // PAID lags checkout ~5.7 days (billingView.PAYMENT_STATUS_LAG_DAYS), so not-PAID is not proof of unpaid.
  return ids.paymentStatus ? false : "unknown";
}

export function nextActionFor(
  status: AccountStatus,
  role: "rep" | "admin",
  flags: AccountFlag[] = [],
): NextAction | null {
  switch (status) {
    case "draft": return { key: "finish_quote", label: "Finish quote" };
    case "needs_approval":
      return role === "admin"
        ? { key: "approve", label: "Approve" }
        : { key: "waiting_on_admin", label: "Waiting on admin", disabled: true };
    case "ready_to_send":
      // Judgement: sending is refused until a HubSpot company is linked (billingView.canSendQuote),
      // so the useful move is linking. Draft keeps "Finish quote" since the quote is not done yet.
      return flags.includes("needs_company_link")
        ? { key: "link_company", label: "Link company" }
        : { key: "send_quote", label: "Send quote" };
    case "sent": return { key: "resend_quote_link", label: "Resend quote link" };
    case "signed": return { key: "send_onboarding_link", label: "Send onboarding link" };
    case "onboarding": return { key: "resend_onboarding_link", label: "Resend onboarding link" };
    case "live": return { key: "view", label: "View" };
    case "closed_lost": return null;
  }
}

export function filterGroupFor(status: AccountStatus, flags: AccountFlag[], role: "rep" | "admin"): FilterGroup {
  switch (status) {
    case "draft":
    case "ready_to_send": return "needs_me";
    case "needs_approval": return "needs_approval";
    case "sent":
    case "signed": return flags.includes("needs_company_link") && role === "rep" ? "needs_me" : "sent";
    case "onboarding": return "onboarding";
    case "live": return "live";
    case "closed_lost": return "closed_lost";
  }
}

export function accountStatus(app: AccountStatusInput, role: "rep" | "admin"): AccountStatusResult {
  const { status, subLabel } = deriveStatus(app);
  const flags: AccountFlag[] = [];
  if (status !== "closed_lost" && billingPanelState(app) === "awaiting_tenant_link") flags.push("needs_company_link");
  if (hasBillingSyncError(app.hubspotIds)) flags.push("sync_error");
  return {
    status,
    label: STATUS_LABELS[status],
    subLabel,
    flags,
    paid: paidState(app),
    nextAction: nextActionFor(status, role, flags),
    filterGroup: filterGroupFor(status, flags, role),
  };
}
