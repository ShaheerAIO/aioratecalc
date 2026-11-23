"use client";

import { useState, useEffect, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  listApplicationsAction,
  listRepsAction,
  sendMerchantOnboardingLinkAction,
  markApplicationClosedLostAction,
  searchTenantCompaniesAction,
  linkTenantCompanyAction,
  unlinkTenantCompanyAction,
  adoptDealAction,
  markAdyenKycCompleteAction,
  type RepSummary,
} from "@/lib/actions/applications";
import { resendLeadLinkAction, sendDraftAction } from "@/lib/actions/prospects";
import { approveQuoteAction } from "@/lib/actions/quoteApproval";
import EditQuotePanel from "@/components/rep/EditQuotePanel";
import DealPicker, { type ResolvedDeal } from "@/components/rep/DealPicker";
import { fmt$, fmtCycle } from "@/lib/utils";
import { ONBOARDING_STAGES } from "@/lib/stages";
import { getOnboardingModules, type ModuleStatus } from "@/lib/onboardingModules";
import { billingPanelState, hubspotDealUrl } from "@/lib/billingView";
import {
  accountStatus,
  STATUS_LADDER,
  STATUS_LABELS,
  type AccountFlag,
  type AccountStatusResult,
  type FilterGroup,
  type NextAction,
  type NextActionKey,
} from "@/lib/accountStatus";
import { QUOTE_TYPES, quoteTotals, quoteTypeOf } from "@/lib/quoting";
import { BillingPanel, BillingDetails } from "./BillingPanel";
import { Field, Section } from "./DetailSection";
import { locationAddress, type MerchantApplication } from "@/types/merchant";
import type { TenantCompany } from "@/lib/adapters/hubspot";
import styles from "./AccountsDashboard.module.css";

// Stages that are still mid-build in the proposal wizard and can be reopened.
// The wizard hydrates from ?id= and jumps to the right step (Analysis /
// Proposal). `pricing` is here for completeness — nothing sets it today, but a
// deal parked there would otherwise be unreachable from the dashboard.
const RESUMABLE_STAGES = ["analysis", "pricing", "proposal_ready"];
const PROPOSAL_FLOW_LINKED: boolean = false;

// Hidden, not deleted (product owner 2026-11-11: "hide all debugging stuff for
// now"). The provider-id disclosure in the Onboarding section; flip to bring it back.
const SHOW_PROVIDER_IDS = false;

// Grid column templates — admin adds a "Rep" column for commission attribution.
const REP_COLS   = "minmax(0, 1fr) 150px 170px 120px 100px";
const ADMIN_COLS = "minmax(0, 1fr) 120px 140px 170px 120px 100px";

// Cosmetic only — absent, the deal renders as plain text instead of a link.
// Same variable BillingPanel reads for the quote id.
const HUBSPOT_PORTAL_ID = process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID;

const MODULE_STATUS_LABELS: Record<ModuleStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  complete: "Complete",
};

type Role = "rep" | "admin";

// Filter tabs (product owner 2026-11-11): "Needs me" first, then approval,
// sent (sent + signed), onboarding, live, all. Closed lost only shows under All.
type TabId = Exclude<FilterGroup, "closed_lost"> | "all";
const TABS: { id: TabId; label: string }[] = [
  { id: "needs_me",       label: "Needs me" },
  { id: "needs_approval", label: "Needs approval" },
  { id: "sent",           label: "Sent" },
  { id: "onboarding",     label: "Onboarding" },
  { id: "live",           label: "Live" },
  { id: "all",            label: "All" },
];

type SortKey = "edited" | "volume" | "name";
const SORTS: { id: SortKey; label: string }[] = [
  { id: "edited", label: "Last edited" },
  { id: "volume", label: "Volume" },
  { id: "name",   label: "Name" },
];

const FLAG_LABELS: Record<AccountFlag, string> = {
  needs_company_link: "Needs company link",
  sync_error: "Sync error",
};

// Next-step keys that are the rep's own move get the coral button; resends
// and "View" are quieter.
const PRIMARY_KEYS: NextActionKey[] = ["finish_quote", "approve", "send_quote", "link_company", "send_onboarding_link"];

const QUOTE_TYPE_LABELS = new Map(QUOTE_TYPES.map(t => [t.id, t.label]));

const VIEW_ACTION: NextAction = { key: "view", label: "View" };

function merchantName(a: MerchantApplication): string {
  return a.business?.dba || a.business?.legalName || a.analysis?.merchantName || "—";
}

/**
 * The line under a merchant name: where it is and who the contact is, so two
 * accounts with the same name (chains, or test rows) can be told apart.
 */
function merchantSubline(a: MerchantApplication): string {
  const loc = a.business ? locationAddress(a.business) : null;
  const cityState = loc ? [loc.city, loc.state].map(s => s.trim()).filter(Boolean).join(", ") : "";
  const contact = a.ownerContact
    ? `${a.ownerContact.firstName ?? ""} ${a.ownerContact.lastName ?? ""}`.trim() || a.ownerContact.email
    : "";
  const parts = [cityState, loc?.address?.trim(), contact].filter(Boolean);
  if (parts.length === 0 && a.analysis?.currentProcessorName) parts.push(a.analysis.currentProcessorName);
  return parts.join(" · ");
}

/** Monthly volume: the statement's, else the rep-entered basis. */
function volumeOf(a: MerchantApplication): number | null {
  if (a.analysis) return a.analysis.totalVolume;
  if (a.quoteConfig?.monthlyVolume) return a.quoteConfig.monthlyVolume;
  const entered = Number.parseFloat(a.processing?.monthlyVolume ?? "");
  return entered > 0 ? entered : null;
}

/** Last staff edit; rows that predate the column fall back to creation. */
function editedAt(a: MerchantApplication): string {
  return a.lastEditedAt ?? a.createdAt;
}

function relativeTime(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const mins = Math.floor((now - t) / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  const d = new Date(t);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}),
  });
}

/**
 * Where the onboarding (customer sign-in) link may be sent from. The old
 * dashboard's gate (legacy `proposal_sent` with no KYC link, or a resend from
 * `merchant_link_sent`) plus `quote_accepted`, the Signed step. Never from a
 * later onboarding stage: sendMerchantOnboardingLinkAction writes
 * `merchant_link_sent` unconditionally, so a resend there would drag a deal
 * that is filling its form or in KYC backwards.
 */
function canSendOnboarding(a: MerchantApplication): boolean {
  if (a.quoteStatus || !a.ownerContact?.email) return false;
  return a.stage === "merchant_link_sent"
    || a.stage === "quote_accepted"
    || (a.stage === "proposal_sent" && !a.adyenOnboardingUrl);
}

/** Same lock as the Edit Quote toggle: the customer confirming their details. */
function canEditQuote(a: MerchantApplication): boolean {
  return !a.quoteAcceptedAt && !a.detailsConfirmedAt;
}

type SendKind = "draft" | "quote_link" | "onboarding";

/** The merged send button: its label, and exactly what goes out to whom. */
function sendCopy(a: MerchantApplication, kind: SendKind): { label: string; caption: string } {
  const first = a.ownerContact?.firstName?.trim() || "";
  const email = a.ownerContact?.email?.trim() || "";
  if (kind === "draft") {
    return {
      label: first ? `Send quote to ${first}` : "Send quote to merchant",
      caption: a.customerLinkToken
        ? "Puts the merchant's existing quote link live again. Nothing is emailed."
        : email
          ? `Emails the quote link to ${email}.`
          : "No contact email on file, so the link is created but not emailed.",
    };
  }
  if (kind === "quote_link") {
    const resend = a.customerLinkPurpose === "lead_upload" && !!a.customerLinkToken;
    return {
      label: resend ? "Resend quote link" : "Send quote link",
      caption: email
        ? `Emails ${resend ? "the" : "a"} quote link to ${email}. It is valid for 14 days.`
        : "No contact email on file — you'll get the link to share yourself.",
    };
  }
  return {
    label: a.stage === "merchant_link_sent" ? "Resend onboarding link" : "Send onboarding link",
    caption: `Emails ${email} a sign-in link to their onboarding checklist. It expires in 30 minutes.`,
  };
}

function StatusBadge({ s }: { s: AccountStatusResult }) {
  return <span className={styles.statusBadge} data-status={s.status}>{s.label}</span>;
}

function FlagChips({ flags }: { flags: AccountFlag[] }) {
  if (flags.length === 0) return null;
  return (
    <>
      {flags.map(f => (
        <span key={f} className={styles.flagChip} data-flag={f}>{FLAG_LABELS[f]}</span>
      ))}
    </>
  );
}

/** The ladder in the detail header. Paid is a note under Signed, not a step. */
function StatusLadder({ s, app }: { s: AccountStatusResult; app: MerchantApplication }) {
  if (s.status === "closed_lost") return null;
  const current = STATUS_LADDER.indexOf(s.status);
  return (
    <ol className={styles.ladder} aria-label="Status">
      {STATUS_LADDER.map((step, i) => {
        const skipped = step === "needs_approval" && i < current && !app.quoteApproval;
        const state = i === current ? "current" : skipped ? "skipped" : i < current ? "done" : "todo";
        return (
          <li key={step} className={styles.ladderStep} data-state={state} aria-current={i === current ? "step" : undefined}>
            <span className={styles.ladderDot} aria-hidden="true" />
            <span className={styles.ladderLabel}>{STATUS_LABELS[step]}</span>
            {step === "signed" && i <= current && s.paid !== "unknown" && (
              <span className={styles.ladderNote}>{s.paid ? "Paid" : "Payment pending"}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The provider ids worth showing, and ONLY the ones that exist.
 *
 * Since EasyOB stopped creating Adyen objects (2026-09-23) the provisioner
 * writes just `legalEntityId`, `tenantNumber` and `environment` — every other
 * field on `adyenIds` is permanently null on any row created since. Rendering
 * them as fixed grid cells meant five of the panel's most prominent rows read
 * "Not created" forever, which is what buried the fields that do carry
 * something. Folded into a disclosure and filtered, so the section shows what
 * is real and nothing else. Hidden for now (SHOW_PROVIDER_IDS).
 */
function providerIds(app: MerchantApplication): Array<{ label: string; value: string }> {
  const entries: Array<[string, string | number | null | undefined]> = [
    ["AIO tenant", app.aioTenant?.businessId],
    ["AIO location", app.aioTenant?.locationId],
    ["AIO environment", app.aioTenant?.environment],
    // The settlement-attribution reference the P&L joins on — see the
    // `adyenIds.tenantNumber` constraint in CLAUDE.md.
    ["Store ref", app.adyenIds?.tenantNumber ? `prod-${app.adyenIds.tenantNumber}` : null],
    ["Adyen legal entity", app.adyenIds?.legalEntityId],
    ["Adyen environment", app.adyenIds?.environment],
    ["Adyen store", app.adyenIds?.storeId],
    ["Adyen merchant account", app.adyenIds?.merchantAccountId],
    ["Adyen balance account", app.adyenIds?.balanceAccountId],
    ["Check company", app.checkIds?.companyId],
  ];
  return entries
    .filter((e): e is [string, string | number] => e[1] != null && e[1] !== "")
    .map(([label, value]) => ({ label, value: String(value) }));
}

type AccountsDashboardProps = {
  role: Role;
  userId: string;
  // Set when this is nested inside another page's chrome (/admin). The embedding
  // page owns the title and the stat line, so both are suppressed here to
  // avoid showing them twice. Unset = the standalone /rep behaviour, unchanged.
  embedded?: boolean;
  // ownerUserId to narrow the accounts table to (drill-down from a rep row).
  repFilter?: string | null;
  onClearRepFilter?: () => void;
  /** DEBUG-BILLING-BYPASS — see lib/debug/billingBypass.ts. */
  debugBillingBypass?: boolean;
};

export function AccountsDashboard({
  role,
  userId,
  embedded,
  repFilter,
  onClearRepFilter,
  debugBillingBypass = false,
}: AccountsDashboardProps) {
  const router = useRouter();
  const isAdmin = role === "admin";

  const [apps, setApps]         = useState<MerchantApplication[]>([]);
  const [reps, setReps]         = useState<RepSummary[]>([]);
  const [selected, setSelected] = useState<MerchantApplication | null>(null);
  const [busyId, setBusyId]     = useState<string | null>(null);
  const [search, setSearch]     = useState("");
  // Reps land on what needs them; admins on everything (the admin view is an
  // oversight table, and a drill-down from a rep row should show all of theirs).
  const [tab, setTab]           = useState<TabId>(isAdmin ? "all" : "needs_me");
  const [sort, setSort]         = useState<SortKey>("edited");
  // The link the staff just (re)sent, kept per-account so it can't leak onto
  // the next row they open. `kind` picks the expiry copy; `smsSent` is null
  // when no phone was on file (so we don't claim a text that was never tried).
  const [sentLink, setSentLink] = useState<{
    appId: string;
    url: string;
    kind: "quote" | "onboarding";
    emailSent: boolean;
    smsSent: boolean | null;
  } | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [quoteLinkCopied, setQuoteLinkCopied] = useState(false);

  // Tenant-linking (HubSpot Company picker for the selected account)
  const [tenantQuery, setTenantQuery]       = useState("");
  const [tenantResults, setTenantResults]   = useState<TenantCompany[]>([]);
  const [tenantSearching, setTenantSearching] = useState(false);
  const [linking, setLinking]               = useState(false);
  // A deal-company mismatch found while linking — see handleLinkTenant. Kept
  // as a persistent banner (not an alert()) because it names something that
  // needs a human to go fix in HubSpot, not a click a rep can dismiss and
  // forget.
  const [tenantMismatch, setTenantMismatch] = useState<{
    appId: string;
    dealId: string;
    otherCompanyIds: string[];
  } | null>(null);

  // Deal adoption (existing-deal picker for a row with no HubSpot deal at
  // all). A resolved-but-not-yet-committed pick, so the account gets one
  // extra confirm click before the (possibly billing-publishing) adoption
  // actually happens — see handleAdoptDeal.
  const [dealAdoptPreview, setDealAdoptPreview] = useState<ResolvedDeal | null>(null);
  const [adoptingDeal, setAdoptingDeal] = useState(false);

  // Rep quote editing (account-detail "Edit Quote" panel).
  const [editQuoteOpen, setEditQuoteOpen] = useState(false);
  // Set by a "Link company" next step: opens the Contacts & HubSpot drawer.
  const [hubspotFocus, setHubspotFocus] = useState(false);
  // What a row's next-step button wants once its account is open ("edit" =
  // open the quote editor, "hubspot" = open the HubSpot drawer). Consumed by
  // the reset effect below, which would otherwise close both again.
  const intentRef = useRef<"edit" | "hubspot" | null>(null);
  const quoteSectionRef = useRef<HTMLDivElement>(null);
  const hubspotDrawerRef = useRef<HTMLDetailsElement>(null);

  // Approving a quote that waits on an admin, plus the outcome line shown
  // after approving / sending a draft.
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [quoteNotice, setQuoteNotice] = useState<{ appId: string; text: string } | null>(null);

  // Deep link from the approval emails: ?account=<id> selects that row once
  // the list has loaded. Read from window in an effect (not useSearchParams)
  // so no Suspense boundary is needed; done once.
  const [deepLinkDone, setDeepLinkDone] = useState(false);
  useEffect(() => {
    if (deepLinkDone || apps.length === 0) return;
    setDeepLinkDone(true);
    const id = new URLSearchParams(window.location.search).get("account");
    const match = id ? apps.find(a => a.id === id) : undefined;
    if (match) {
      // The linked account may sit outside the default tab.
      setTab("all");
      setSelected(match);
    }
  }, [apps, deepLinkDone]);

  useEffect(() => {
    listApplicationsAction().then(setApps).catch(() => {});
    if (isAdmin) {
      listRepsAction().then(setReps).catch(() => {});
    }
  }, [isAdmin]);

  const repMap = new Map(reps.map(r => [r.id, r]));
  const now = Date.now();

  const cols = isAdmin ? ADMIN_COLS : REP_COLS;

  const statusById = new Map(apps.map(a => [a.id, accountStatus(a, role)]));
  const statusOf = (a: MerchantApplication) => statusById.get(a.id) ?? accountStatus(a, role);

  const metrics = {
    total:   apps.length,
    volume:  apps.reduce((sum, a) => sum + (a.analysis?.totalVolume || 0), 0),
    savings: apps.reduce((sum, a) => sum + (a.proposal?.savings?.annual || 0), 0),
  };

  const updateOne = (updated: MerchantApplication) => {
    setApps(prev => prev.map(a => (a.id === updated.id ? updated : a)));
    setSelected(prev => (prev?.id === updated.id ? updated : prev));
  };

  // Accounts whose AIO provisioning cron has recorded an error and not since
  // succeeded. The detail panel already says why, but only for the account a
  // human happens to open; an expired service-account password (2026-11-02)
  // stalls every paid merchant at once, so admins see the count up front.
  const provisioningStuck = isAdmin
    ? apps.filter(a => a.aioTenant?.lastError && !a.aioTenant.provisionedAt)
    : [];
  const latestProvisioningError = provisioningStuck
    .map(a => a.aioTenant!)
    .sort((x, y) => (y.lastErrorAt ?? "").localeCompare(x.lastErrorAt ?? ""))[0]?.lastError;

  // Rep filter + search first; the tab counts are taken from this, so they
  // always agree with what clicking the tab shows.
  const searchedApps = apps.filter(a => {
    if (repFilter && a.ownerUserId !== repFilter) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      (a.business?.dba || "").toLowerCase().includes(q) ||
      (a.business?.legalName || "").toLowerCase().includes(q) ||
      (a.analysis?.merchantName || "").toLowerCase().includes(q) ||
      merchantSubline(a).toLowerCase().includes(q) ||
      (a.ownerContact?.email || "").toLowerCase().includes(q) ||
      (a.adyenIds?.tenantNumber || "").toLowerCase().includes(q) ||
      (`prod-${a.adyenIds?.tenantNumber || ""}`).toLowerCase().includes(q) ||
      (a.adyenIds?.storeId || "").toLowerCase().includes(q)
    );
  });

  const tabCounts = new Map<TabId, number>(TABS.map(t => [t.id, 0]));
  for (const a of searchedApps) {
    const g = statusOf(a).filterGroup;
    if (g !== "closed_lost") tabCounts.set(g, (tabCounts.get(g) ?? 0) + 1);
  }
  tabCounts.set("all", searchedApps.length);

  const filteredApps = searchedApps
    .filter(a => tab === "all" || statusOf(a).filterGroup === tab)
    .sort((x, y) => {
      if (sort === "volume") return (volumeOf(y) ?? -1) - (volumeOf(x) ?? -1);
      if (sort === "name") {
        return merchantName(x).localeCompare(merchantName(y)) || merchantSubline(x).localeCompare(merchantSubline(y));
      }
      return editedAt(y).localeCompare(editedAt(x));
    });

  const canManageApp = (a: MerchantApplication) => isAdmin || a.ownerUserId === userId;
  const canManageSelected = selected != null && canManageApp(selected);
  // Resume actually works the deal, so it stays owner-only even for an admin —
  // unlike the resend buttons, which are operational (an admin covering a
  // bounced email needs them on accounts they don't own).
  // PROPOSAL_FLOW_LINKED gates the only link into /rep/proposals/new, which is
  // hidden from the UI but kept for reference.
  const canResume = PROPOSAL_FLOW_LINKED
    && selected != null
    && selected.ownerUserId === userId
    && RESUMABLE_STAGES.includes(selected.stage);
  const quoteStatus = selected?.quoteStatus ?? null;
  const isOwner = selected != null && selected.ownerUserId === userId;
  // The approval details: any admin, or the rep who owns the quote.
  const approvalPending = quoteStatus === "pending_approval" && !!selected?.quoteApproval && (isAdmin || isOwner);
  const requester = selected?.quoteApproval ? repMap.get(selected.quoteApproval.requestedByUserId) : undefined;
  const requesterName = requester?.name || requester?.email || null;
  const showOnboarding = selected != null && (
    !!selected.quoteAcceptedAt || !!selected.aioTenant || ONBOARDING_STAGES.includes(selected.stage)
    || selected.stage === "adyen_approved"
  );

  const selectedStatus  = selected ? statusOf(selected) : null;
  const selectedRep     = selected ? repMap.get(selected.ownerUserId) : undefined;
  const selectedContact = selected?.ownerContact ?? null;
  const contactName     = selectedContact
    ? `${selectedContact.firstName} ${selectedContact.lastName}`.trim()
    : "";
  const selectedLines   = selected?.quoteLines ?? [];
  const selectedTotals  = quoteTotals(selectedLines);
  const selectedIds     = selected ? providerIds(selected) : [];
  const selectedDealUrl = selected?.hubspotDealId
    ? hubspotDealUrl(selected.hubspotDealId, HUBSPOT_PORTAL_ID)
    : null;
  const hasBillingDetails = !!(
    selected?.hubspotIds?.quoteId || selected?.hubspotIds?.lastSyncError || selected?.hubspotInvoice
  );
  // The merchant's live quote link, for "Copy quote link" under More actions.
  const quoteLinkToken = selected && canManageSelected && !selected.quoteStatus
    && selected.customerLinkPurpose === "lead_upload" && selected.customerLinkToken
    && (!selected.customerLinkExpiresAt || new Date(selected.customerLinkExpiresAt).getTime() > now)
    ? selected.customerLinkToken
    : null;
  const canCloseLost = selected != null
    && selected.ownerUserId === userId
    && selected.stage !== "closed_lost"
    && selected.stage !== "adyen_approved";

  const handleSendLink = async (app: MerchantApplication) => {
    setBusyId(app.id);
    try {
      const { app: updated, result, url } = await sendMerchantOnboardingLinkAction(app.id);
      updateOne(updated);
      setSentLink({ appId: app.id, url, kind: "onboarding", emailSent: result.sent, smsSent: null });
      setLinkCopied(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to send onboarding link");
    }
    setBusyId(null);
  };

  const handleResendQuoteLink = async (app: MerchantApplication) => {
    setBusyId(app.id);
    try {
      const { app: updated, linkUrl, emailResult, smsResult } = await resendLeadLinkAction(app.id);
      updateOne(updated);
      setSentLink({
        appId: app.id,
        url: linkUrl,
        kind: "quote",
        emailSent: emailResult.sent,
        smsSent: smsResult ? smsResult.sent : null,
      });
      setLinkCopied(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to resend quote link");
    }
    setBusyId(null);
  };

  const handleApprove = async (app: MerchantApplication) => {
    setApproving(true);
    setApproveError(null);
    try {
      await approveQuoteAction(app.id);
      const fresh = await listApplicationsAction();
      setApps(fresh);
      const updated = fresh.find(a => a.id === app.id);
      if (updated) setSelected(updated);
      setQuoteNotice({ appId: app.id, text: "Approved. The rep has been emailed and the HubSpot ticket closed." });
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : "Failed to approve the quote");
    }
    setApproving(false);
  };

  const handleSendDraft = async (app: MerchantApplication) => {
    setBusyId(app.id);
    try {
      const res = await sendDraftAction(app.id);
      updateOne(res.app);
      setQuoteNotice({
        appId: app.id,
        text: res.delivered ? "Sent to the merchant." : "The merchant's link is live again.",
      });
    } catch (e) {
      setQuoteNotice({ appId: app.id, text: e instanceof Error ? e.message : "Failed to send to the merchant" });
    }
    setBusyId(null);
  };

  const handleMarkClosedLost = async (app: MerchantApplication) => {
    if (!window.confirm(`Mark ${app.business?.legalName || app.analysis?.merchantName || "this account"} as closed lost?`)) return;
    setBusyId(app.id);
    try {
      const updated = await markApplicationClosedLostAction(app.id);
      updateOne(updated);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to update stage");
    }
    setBusyId(null);
  };

  const handleCopyQuoteLink = (token: string) => {
    const base = process.env.NEXT_PUBLIC_BASE_URL || window.location.origin;
    navigator.clipboard.writeText(`${base}/lead/${token}`);
    setQuoteLinkCopied(true);
    setTimeout(() => setQuoteLinkCopied(false), 2000);
  };

  const applyIntent = (intent: "edit" | "hubspot" | null) => {
    setEditQuoteOpen(intent === "edit");
    setHubspotFocus(intent === "hubspot");
    const target = intent === "edit" ? quoteSectionRef : intent === "hubspot" ? hubspotDrawerRef : null;
    if (target) setTimeout(() => target.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 0);
  };

  const openAccount = (app: MerchantApplication, intent: "edit" | "hubspot" | null = null) => {
    if (selected?.id === app.id) {
      if (intent) applyIntent(intent);
      return;
    }
    intentRef.current = intent;
    setSelected(app);
  };

  /**
   * The next-step button as it is actually offered: the helper's action when
   * an existing handler can carry it out for this user, otherwise "View"
   * (which opens the account, where the card says why).
   */
  const offeredAction = (a: MerchantApplication, s: AccountStatusResult): NextAction | null => {
    const act = s.nextAction;
    if (!act) return null;
    const manage = canManageApp(a);
    switch (act.key) {
      case "finish_quote":
        return manage && canEditQuote(a) ? act : VIEW_ACTION;
      case "send_quote":
      case "link_company":
        return manage ? act : VIEW_ACTION;
      case "resend_quote_link":
        return manage && !a.quoteStatus ? act : VIEW_ACTION;
      case "send_onboarding_link":
      case "resend_onboarding_link":
        return manage && canSendOnboarding(a) ? act : VIEW_ACTION;
      default:
        return act;
    }
  };

  // One place every next-step button goes through, from a row or from the
  // account's own card. From a row the "what gets sent" line isn't on screen,
  // so it is shown in a confirm first.
  const runAction = async (a: MerchantApplication, key: NextActionKey, fromRow: boolean) => {
    const confirmSend = (kind: SendKind) => {
      if (!fromRow) return true;
      const { label, caption } = sendCopy(a, kind);
      return window.confirm(`${label} — ${merchantName(a)}?\n\n${caption}`);
    };
    switch (key) {
      case "finish_quote":
        openAccount(a, "edit");
        return;
      case "link_company":
        openAccount(a, "hubspot");
        return;
      case "approve": {
        if (!isAdmin) return;
        if (fromRow) {
          const lines = (a.quoteApproval?.overrides ?? []).map(o => `• ${o.message}`).join("\n");
          if (!window.confirm(`Approve the over-limit pricing on ${merchantName(a)}?${lines ? `\n\n${lines}` : ""}`)) return;
        }
        openAccount(a);
        await handleApprove(a);
        return;
      }
      case "send_quote":
        if (!confirmSend("draft")) return;
        openAccount(a);
        await handleSendDraft(a);
        return;
      case "resend_quote_link":
        if (!confirmSend("quote_link")) return;
        openAccount(a);
        await handleResendQuoteLink(a);
        return;
      case "send_onboarding_link":
      case "resend_onboarding_link":
        if (!confirmSend("onboarding")) return;
        openAccount(a);
        await handleSendLink(a);
        return;
      default:
        openAccount(a);
    }
  };

  // Reset the per-account state whenever a different account is opened,
  // honouring whatever the next-step button that opened it asked for.
  useEffect(() => {
    const intent = intentRef.current;
    intentRef.current = null;
    setTenantQuery("");
    setTenantResults([]);
    setApproveError(null);
    setQuoteNotice(null);
    setTenantMismatch(null);
    setDealAdoptPreview(null);
    setQuoteLinkCopied(false);
    applyIntent(intent);
    // applyIntent only touches setters and refs.
  }, [selected?.id]);

  // Debounced HubSpot Company search for the tenant picker.
  useEffect(() => {
    const q = tenantQuery.trim();
    if (q.length < 2) { setTenantResults([]); setTenantSearching(false); return; }
    setTenantSearching(true);
    let cancelled = false;
    const t = setTimeout(() => {
      searchTenantCompaniesAction(q)
        .then(r => { if (!cancelled) setTenantResults(r); })
        .catch(() => { if (!cancelled) setTenantResults([]); })
        .finally(() => { if (!cancelled) setTenantSearching(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [tenantQuery]);

  // Linking is also what unblocks the deferred HubSpot work — the deal, and
  // the billing quote if the merchant already accepted — so the outcome of
  // that catch-up is reported here rather than left to a silent log.
  const handleLinkTenant = async (app: MerchantApplication, companyId: string) => {
    setLinking(true);
    try {
      const res = await linkTenantCompanyAction(app.id, companyId);
      updateOne(res.app);
      setTenantQuery("");
      setTenantResults([]);
      setTenantMismatch(
        res.dealCompanyMismatch
          ? { appId: app.id, dealId: res.dealCompanyMismatch.dealId, otherCompanyIds: res.dealCompanyMismatch.otherCompanyIds }
          : null
      );
      if (res.error) {
        alert(`Company linked, but the HubSpot catch-up failed: ${res.error}`);
      } else if (res.billingReasons?.length) {
        alert(
          "Company linked" + (res.dealCreated ? " and the deal created" : "") +
          ", but the billing quote is still on hold:\n\n" +
          res.billingReasons.map(r => `• ${r.message}`).join("\n")
        );
      } else if (res.dealCompanyRepaired) {
        alert("Company linked. Its HubSpot deal had no company on it, so we attached this one.");
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to link tenant");
    }
    setLinking(false);
  };

  const handleUnlinkTenant = async (app: MerchantApplication) => {
    if (!window.confirm("Unlink this account from its HubSpot tenant?")) return;
    setLinking(true);
    try {
      const updated = await unlinkTenantCompanyAction(app.id);
      updateOne(updated);
      setTenantMismatch(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to unlink tenant");
    }
    setLinking(false);
  };

  // Adopts a deal DealPicker resolved (mode: "existing" only — see
  // adoptDealAction's comment) onto a row with no HubSpot deal at all. Same
  // deferred-billing-catch-up posture as handleLinkTenant: if the merchant
  // already accepted, this call can publish a live HubSpot quote, which is
  // why the confirm panel below warns about that before this ever runs.
  const handleAdoptDeal = async (app: MerchantApplication, dealId: string) => {
    setAdoptingDeal(true);
    try {
      const res = await adoptDealAction(app.id, dealId);
      if (!res.ok) {
        alert(res.error);
        return;
      }
      updateOne(res.app);
      setDealAdoptPreview(null);
      if (res.error) {
        alert(`Deal adopted, but the billing catch-up failed: ${res.error}`);
      } else if (res.billingReasons?.length) {
        alert(
          "Deal adopted, but the billing quote is still on hold:\n\n" +
          res.billingReasons.map(r => `• ${r.message}`).join("\n")
        );
      } else if (res.quotePublished) {
        alert("Deal adopted — the merchant's billing quote has been published to HubSpot.");
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to adopt deal");
    } finally {
      setAdoptingDeal(false);
    }
  };

  const handleMarkKyc = async (app: MerchantApplication) => {
    setBusyId(app.id);
    try {
      const updated = await markAdyenKycCompleteAction(app.id, "adyen_approved");
      updateOne(updated);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to mark KYC complete");
    }
    setBusyId(null);
  };

  // Client-side CSV of every account and its Adyen ids — admin-only view, data
  // is already loaded, so no server round-trip. Same Blob download pattern as
  // the proposal export.
  const handleExportCsv = () => {
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const headers = [
      "Restaurant", "Rep", "Stage", "Tenant Number", "Store Ref", "Store ID",
      "Merchant Account", "Balance Account", "Legal Entity", "Environment", "KYC Link", "Created",
    ];
    const rows = apps.map(a => [
      a.business?.dba || a.business?.legalName || a.analysis?.merchantName || "",
      repMap.get(a.ownerUserId)?.name || repMap.get(a.ownerUserId)?.email || "",
      a.stage.replace(/_/g, " "),
      a.adyenIds?.tenantNumber || "",
      a.adyenIds?.tenantNumber ? `prod-${a.adyenIds.tenantNumber}` : "",
      a.adyenIds?.storeId || "",
      a.adyenIds?.merchantAccountId || "",
      a.adyenIds?.balanceAccountId || "",
      a.adyenIds?.legalEntityId || "",
      a.adyenIds?.environment || "",
      a.adyenOnboardingUrl ? "generated" : "",
      new Date(a.createdAt).toISOString().slice(0, 10),
    ]);
    const csv = [headers, ...rows].map(r => r.map(cell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `aio-accounts-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const emptyCopy = isAdmin
    ? "No accounts yet. They appear here as reps start proposals."
    : "No accounts yet. Upload a statement or send a customer link to get started.";
  const emptyTabCopy = search ? "No results." : apps.length === 0 ? emptyCopy : "Nothing here.";

  const rowButton = (a: MerchantApplication) => {
    const act = offeredAction(a, statusOf(a));
    if (!act) return <span className={styles.cellMuted}>—</span>;
    return (
      <button
        type="button"
        className={act.disabled ? styles.btnWaiting : PRIMARY_KEYS.includes(act.key) ? styles.btnPrimary : styles.btnGhost}
        disabled={act.disabled || busyId === a.id || (act.key === "approve" && approving)}
        onClick={e => { e.stopPropagation(); void runAction(a, act.key, true); }}
      >
        {act.label}
      </button>
    );
  };

  // ---- The account's one next-step card ----
  const renderNextStep = (a: MerchantApplication, s: AccountStatusResult) => {
    const manage = canManageApp(a);
    const busy = busyId === a.id;
    const contact = a.ownerContact?.firstName?.trim() || "the merchant";
    let title = "";
    let body: ReactNode = null;
    let primary: { label: string; caption?: string; onClick?: () => void; disabled?: boolean } | null = null;
    let secondary: { label: string; caption: string; onClick: () => void } | null = null;

    const sendButton = (kind: SendKind, run: () => void) => {
      const { label, caption } = sendCopy(a, kind);
      return { label, caption, onClick: run };
    };
    const draftSend = () => sendButton("draft", () => void handleSendDraft(a));
    const quoteLinkSend = () => sendButton("quote_link", () => void handleResendQuoteLink(a));
    const onboardingSend = () => sendButton("onboarding", () => void handleSendLink(a));

    switch (s.status) {
      case "draft":
        title = "Finish the quote";
        body = "Nothing has gone to the merchant yet.";
        if (manage && canEditQuote(a)) {
          primary = { label: "Finish quote", onClick: () => applyIntent("edit") };
        }
        if (manage) {
          if (a.quoteStatus === "draft") secondary = draftSend();
          else if (!a.quoteStatus) secondary = quoteLinkSend();
        }
        break;
      case "needs_approval":
        // One card for the whole approval: what it goes past, who asked and
        // when, and the button (Approve for an admin, a waiting state for the
        // rep). The rep's name is only known to an admin (listRepsAction).
        title = isAdmin ? "Approve the over-limit pricing" : "Waiting on an admin";
        body = approvalPending ? (
          <>
            <div className={styles.nextMeta}>
              Requested{requesterName ? ` by ${requesterName}` : ""}{" "}
              {new Date(a.quoteApproval!.requestedAt).toLocaleDateString()}
            </div>
            <ul className={styles.overrideList}>
              {a.quoteApproval!.overrides.map((o, i) => <li key={i}>{o.message}</li>)}
            </ul>
          </>
        ) : "An admin has to approve this quote before it can be sent.";
        primary = isAdmin
          ? {
              label: approving ? "Approving…" : "Approve",
              caption: "Emails the rep, who then sends the quote.",
              onClick: () => void handleApprove(a),
              disabled: approving,
            }
          : { label: "Waiting on admin", disabled: true };
        break;
      case "ready_to_send":
        if (s.flags.includes("needs_company_link")) {
          title = "Link the HubSpot company";
          body = "Nothing reaches HubSpot until this account is linked to its company.";
          if (manage) primary = { label: "Link company", onClick: () => applyIntent("hubspot") };
          if (manage) secondary = draftSend();
        } else {
          title = "Send the approved quote";
          if (manage) primary = draftSend();
        }
        break;
      case "sent":
        title = `Waiting on ${contact}`;
        body = canEditQuote(a)
          ? "The quote is with the merchant. You can still edit it until they confirm their details."
          : "The merchant confirmed their details; the quote is published and locked.";
        if (manage && !a.quoteStatus) primary = quoteLinkSend();
        // Legacy wizard rows (proposal_sent) could go straight to onboarding.
        if (manage && canSendOnboarding(a)) secondary = onboardingSend();
        break;
      case "signed":
        if (manage && canSendOnboarding(a)) {
          title = "Signed — send the onboarding link";
          primary = onboardingSend();
        } else if (!a.quoteAcceptedAt && a.stage !== "quote_accepted") {
          title = "Signed, checkout not finished";
          body = "The merchant finishes payment from their quote link. Their onboarding unlocks once they do.";
          if (manage && !a.quoteStatus) secondary = quoteLinkSend();
        } else {
          title = "Signed";
          body = "The merchant's account link was emailed when they accepted.";
        }
        break;
      case "onboarding":
        title = `Onboarding: ${s.subLabel ?? "in progress"}`;
        if (manage && canSendOnboarding(a)) {
          primary = onboardingSend();
        } else {
          body = "The merchant is working through their checklist. Progress is under Onboarding below.";
        }
        break;
      case "live":
        title = "Live";
        body = "Adyen approved this merchant. Nothing to do.";
        break;
      case "closed_lost":
        title = "Closed lost";
        body = "This deal is closed.";
        break;
    }

    return (
      <div className={styles.nextCard} data-status={s.status}>
        <div className={styles.nextLabel}>Next step</div>
        <div className={styles.nextTitle}>{title}</div>
        {body && <div className={styles.nextBody}>{body}</div>}
        {primary && (
          <div className={styles.nextRow}>
            <button
              type="button"
              className={primary.onClick ? styles.btnPrimary : styles.btnWaiting}
              disabled={primary.disabled || busy || !primary.onClick}
              onClick={primary.onClick}
            >
              {primary.label}
            </button>
            {primary.caption && <span className={styles.nextCaption}>{primary.caption}</span>}
          </div>
        )}
        {s.status === "needs_approval" && approveError && (
          <div className={styles.approvalError} role="alert">{approveError}</div>
        )}
        {secondary && (
          <div className={styles.nextRow}>
            <button type="button" className={styles.btnGhost} disabled={busy} onClick={secondary.onClick}>
              {secondary.label}
            </button>
            <span className={styles.nextCaption}>{secondary.caption}</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={embedded ? styles.mainEmbedded : styles.main} data-wide={selected ? "true" : undefined}>
      {!embedded && (
        <div className={styles.header}>
          <h1 className={styles.headerTitle}>Accounts</h1>
          <p className={styles.headerSubtitle}>
            {isAdmin
              ? "Every account across all reps, with margin oversight for approved deals."
              : "Your merchants across the whole pipeline, from first statement to approved onboarding."}
          </p>
          {/* The old stat hero, shrunk to a line: the tabs below carry the
              counts that matter. The embedding page (/admin) has its own. */}
          <p className={styles.summaryLine}>
            <b>{metrics.total}</b> accounts
            <span className={styles.statDot}> · </span>
            <b>{fmt$(metrics.volume)}</b> monthly volume
            <span className={styles.statDot}> · </span>
            <b>{fmt$(metrics.savings)}/yr</b> projected savings
          </p>
        </div>
      )}

      {/* Drill-down chip — set when the host page narrowed this list to one
          rep; dismissing it clears the filter back to every account. */}
      {repFilter && (
        <div className={styles.filterChipRow}>
          <span className={styles.filterChip}>
            Rep: {repMap.get(repFilter)?.name || repMap.get(repFilter)?.email || repFilter}
            <button
              type="button"
              className={styles.filterChipClear}
              onClick={onClearRepFilter}
              aria-label="Clear rep filter"
            >
              ×
            </button>
          </span>
        </div>
      )}

      {!selected && provisioningStuck.length > 0 && (
        <div className={styles.warningBanner} role="alert">
          <strong>
            AIO provisioning is stuck for {provisioningStuck.length}{" "}
            {provisioningStuck.length === 1 ? "account" : "accounts"}.
          </strong>{" "}
          Latest error: {latestProvisioningError}{" "}
          {provisioningStuck.map((a, i) => (
            <span key={a.id}>
              {i > 0 && ", "}
              <button type="button" className={styles.bannerLink} onClick={() => setSelected(a)}>
                {a.business?.dba || a.business?.legalName || a.id}
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Tabs, search and sort — shared by the table and the split list. */}
      <div className={styles.tabs} role="tablist" aria-label="Filter accounts">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={styles.tab}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            <span className={styles.tabCount}>{tabCounts.get(t.id) ?? 0}</span>
          </button>
        ))}
      </div>
      <div className={styles.toolbar}>
        <input
          type="search"
          className={styles.tableSearchInput}
          placeholder="Search name, location, contact or merchant account"
          aria-label="Search accounts"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className={styles.sortGroup} role="group" aria-label="Sort by">
          <span className={styles.sortLabel}>Sort</span>
          {SORTS.map(s => (
            <button
              key={s.id}
              type="button"
              aria-pressed={sort === s.id}
              className={styles.sortBtn}
              onClick={() => setSort(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        {isAdmin && apps.length > 0 && (
          <button className={styles.btnGhost} onClick={handleExportCsv}>Export CSV</button>
        )}
      </div>

      {/* Full table — shown when nothing is selected */}
      {!selected && (
        <div className={styles.panel}>
          <div className={styles.tableHeader} style={{ gridTemplateColumns: cols }}>
            {(isAdmin
              ? ["Merchant", "Rep", "Status", "Next step", "Monthly volume", "Last edited"]
              : ["Merchant", "Status", "Next step", "Monthly volume", "Last edited"]
            ).map(h => (
              <div key={h} className={styles.tableHeaderCell}>{h}</div>
            ))}
          </div>
          {filteredApps.length === 0 && (
            <div className={styles.emptyState}>{emptyTabCopy}</div>
          )}
          {filteredApps.map(a => {
            const rep = repMap.get(a.ownerUserId);
            const s = statusOf(a);
            const vol = volumeOf(a);
            const sub = merchantSubline(a);
            return (
              <div
                key={a.id}
                className={styles.tableRow}
                style={{ gridTemplateColumns: cols }}
                data-testid="account-row"
                onClick={() => openAccount(a)}
              >
                <div className={styles.tableCell} data-label="Merchant">
                  <button type="button" className={styles.rowNameBtn} onClick={e => { e.stopPropagation(); openAccount(a); }}>
                    {merchantName(a)}
                  </button>
                  {sub && <div className={styles.merchantSub}>{sub}</div>}
                </div>
                {isAdmin && <div className={styles.tableCell} data-label="Rep">{rep?.name || rep?.email || "—"}</div>}
                <div className={styles.tableCell} data-label="Status">
                  <div className={styles.statusCell}>
                    <StatusBadge s={s} />
                    <FlagChips flags={s.flags} />
                  </div>
                  {s.subLabel && <div className={styles.merchantSub}>{s.subLabel}</div>}
                </div>
                <div className={styles.tableCell} data-label="Next step">{rowButton(a)}</div>
                <div className={`${styles.tableCell} ${styles["tableCell--numeric"]}`} data-label="Monthly volume">
                  {vol != null ? fmt$(vol) : "—"}
                </div>
                <div
                  className={`${styles.tableCell} ${styles["tableCell--muted"]}`}
                  data-label="Last edited"
                  title={new Date(editedAt(a)).toLocaleString()}
                >
                  {relativeTime(editedAt(a), now)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Split view — shown once an account is selected */}
      {selected && selectedStatus && (
        <div className={styles.splitLayout}>
          {/* Left: the same filtered, sorted list, compact */}
          <div className={styles.splitListPanel}>
            <div className={styles.splitListScroll}>
              {filteredApps.length === 0 && (
                <div className={styles.emptyState}>{emptyTabCopy}</div>
              )}
              {filteredApps.map(a => (
                <button
                  key={a.id}
                  onClick={() => (a.id === selected.id ? setSelected(null) : openAccount(a))}
                  className={styles.splitRow}
                  data-selected={selected.id === a.id}
                >
                  <span className={styles.splitRowName}>{merchantName(a)}</span>
                  <span className={styles.splitRowMeta}>
                    <StatusBadge s={statusOf(a)} />
                    <span className={styles.splitRowSub}>{merchantSubline(a) || relativeTime(editedAt(a), now)}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Right: detail panel */}
          <div className={styles.splitDetailPanel}>
            <div className={styles.detail}>
              <div className={styles.detailHeader}>
                <div className={styles.detailHeaderMain}>
                  <div className={styles.detailTitleRow}>
                    <h2 className={styles.detailTitle}>
                      {selected.business?.dba || selected.business?.legalName || selected.analysis?.merchantName || "Account Detail"}
                    </h2>
                    <StatusBadge s={selectedStatus} />
                    {selectedStatus.subLabel && <span className={styles.detailMeta}>{selectedStatus.subLabel}</span>}
                    <FlagChips flags={selectedStatus.flags} />
                  </div>
                  <div className={styles.detailMeta}>
                    {[
                      merchantSubline(selected),
                      selected.business?.legalName && selected.business.legalName !== selected.business.dba
                        ? selected.business.legalName
                        : null,
                      `Created ${new Date(selected.createdAt).toLocaleDateString()}`,
                      `Edited ${relativeTime(editedAt(selected), now).replace(/^(Just now|Yesterday)$/, w => w.toLowerCase())}`,
                    ].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <button
                  onClick={() => setSelected(null)}
                  className={styles.detailClose}
                  aria-label="Close account detail"
                >
                  ×
                </button>
              </div>

              <StatusLadder s={selectedStatus} app={selected} />

              {/* Two columns: the work (next step, quote, billing, onboarding)
                  on the left, the facts and secondary actions in a rail on the
                  right. Collapses to one column when the panel is narrow. */}
              <div className={styles.detailColumns}>
              <div className={styles.detailMain}>
              {renderNextStep(selected, selectedStatus)}

              {quoteNotice?.appId === selected.id && (
                <div className={styles.detailMeta} role="status">{quoteNotice.text}</div>
              )}

              {/* The link the staff just (re)sent. Shown in full with a copy
                  affordance because email/SMS delivery is optional — without
                  this the click would surface nothing they can hand over. */}
              {sentLink?.appId === selected.id && (
                <Section label={sentLink.kind === "quote" ? "Quote Link" : "Merchant Onboarding Link"}>
                  <div className={styles.linkRow}>
                    <code className={styles.linkCode}>{sentLink.url}</code>
                    <button
                      className={styles.btnCopy}
                      data-copied={linkCopied}
                      onClick={() => { navigator.clipboard.writeText(sentLink.url); setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2000); }}
                    >
                      {linkCopied ? "Copied!" : "Copy"}
                    </button>
                  </div>
                  <div className={styles.detailMeta}>
                    {sentLink.kind === "quote" ? (
                      <>
                        {sentLink.emailSent
                          ? `Emailed to ${selected.ownerContact?.email}. Valid for 14 days.`
                          : "Email delivery isn't configured yet — send this link to the merchant yourself. It is valid for 14 days."}
                        {selected.ownerContact?.phone && (
                          <> {sentLink.smsSent
                            ? `Texted to ${selected.ownerContact.phone}.`
                            : "Text delivery isn't configured yet."}</>
                        )}
                      </>
                    ) : sentLink.emailSent
                      ? `Emailed to ${selected.ownerContact?.email}. Expires in 30 minutes.`
                      : "Email delivery isn't configured yet — send this link to the merchant yourself. It expires in 30 minutes."}
                  </div>
                </Section>
              )}

              {/* What the merchant is buying. The HubSpot document built
                  from it — signature, payment — is the Billing section below;
                  keeping the two apart is what stopped the quote's state being
                  reported twice in two different vocabularies.
                  Rework is allowed at any time up to acceptance — things
                  change. Owner rep or any admin, same gate as the tenant
                  link. saveQuoteConfigurationAction (which this
                  calls) refuses once detailsConfirmedAt is set — the
                  customer confirming their details is what publishes the
                  quote, so that is the real end of the window, earlier
                  than both publishedAt and quoteAcceptedAt. EditQuotePanel
                  shows the frozen notice instead of the form in that case. */}
              {(isAdmin || selected.ownerUserId === userId) && (
                <div ref={quoteSectionRef} className={styles.anchor}>
                  <Section
                    label="Quote"
                    action={
                      !selected.quoteAcceptedAt && !selected.detailsConfirmedAt ? (
                        <button className={styles.btnGhost} onClick={() => setEditQuoteOpen(o => !o)}>
                          {editQuoteOpen ? "Close" : "Edit Quote"}
                        </button>
                      ) : undefined
                    }
                  >
                    {!editQuoteOpen && (
                      <>
                        {selectedLines.length > 0 ? (
                          <>
                            <div className={styles.detailFieldValue}>
                              {QUOTE_TYPE_LABELS.get(quoteTypeOf(selected.quoteType)) ?? "Quote"}
                              {" · "}
                              {selectedLines.length} line{selectedLines.length === 1 ? "" : "s"}
                            </div>
                            <div className={styles.moneyRow}>
                              {selectedTotals.oneTime > 0 && <span>{fmt$(selectedTotals.oneTime)} one-time</span>}
                              {selectedTotals.recurring.map(r => (
                                <span key={r.frequency}>{fmt$(r.amount)}/{fmtCycle(r.frequency)}</span>
                              ))}
                              {selectedTotals.monthlyEquivalent > 0 && !selectedTotals.recurring.every(r => r.frequency === "monthly") && (
                                <span className={styles.moneyMeta}>
                                  (~{fmt$(selectedTotals.monthlyEquivalent)}/mo recurring)
                                </span>
                              )}
                            </div>
                          </>
                        ) : (
                          <div className={styles.sectionNote}>
                            {selected.quoteAcceptedAt
                              ? "Rate-only — no billable lines, so AIO's margin here comes out of Adyen settlement rather than HubSpot billing."
                              : "No products configured yet."}
                          </div>
                        )}
                        {selected.quoteAcceptedAt ? (
                          <div className={styles.detailMeta}>
                            Accepted {new Date(selected.quoteAcceptedAt).toLocaleDateString()}. Locked: start a new
                            quote to change terms.
                          </div>
                        ) : selected.detailsConfirmedAt ? (
                          // The lock, stamped. Confirming is what published
                          // this quote, so it is the moment the rep's window
                          // shut — days before acceptance, and seconds
                          // before `publishedAt`.
                          <div className={styles.detailMeta}>
                            Customer confirmed {new Date(selected.detailsConfirmedAt).toLocaleDateString()}. Locked and
                            published to HubSpot.
                          </div>
                        ) : (
                          // The window, while it is open. Worth saying out
                          // loud: before 2026-10-15 sending the link
                          // published the quote and ended this immediately,
                          // so "I already sent it" used to mean "too late"
                          // and no longer does.
                          <div className={styles.detailMeta}>
                            Editable until the customer confirms their details.
                          </div>
                        )}
                      </>
                    )}
                    {editQuoteOpen && (
                      <EditQuotePanel
                        app={selected}
                        isAdmin={isAdmin}
                        onSaved={updated => { updateOne(updated); setEditQuoteOpen(false); }}
                        onCancel={() => setEditQuoteOpen(false)}
                      />
                    )}
                  </Section>
                </div>
              )}

              {billingPanelState(selected) !== "not_configured" && billingPanelState(selected) !== "rate_only" && (
                <BillingPanel
                  app={selected}
                  canManage={isAdmin || selected.ownerUserId === userId}
                  onUpdated={updateOne}
                  debugBillingBypass={debugBillingBypass}
                  isAdmin={isAdmin}
                />
              )}

              {/* Before the quote is accepted every module is "not
                  started", which says nothing. */}
              {showOnboarding && (
                <Section label="Onboarding">
                  {/* Provisioning is a cron with no human in the loop, so a
                      failure that only ever reached a Vercel log is a failure
                      nobody acts on — the same mistake HubspotIds.lastSyncError
                      was added to fix. */}
                  {selected.aioTenant?.lastError && !selected.aioTenant.provisionedAt && (
                    <div className={styles.warningBanner} role="alert">
                      <strong>AIO provisioning hasn&rsquo;t completed.</strong> {selected.aioTenant.lastError}
                      {selected.aioTenant.lastErrorAt
                        ? ` (${new Date(selected.aioTenant.lastErrorAt).toLocaleString()})`
                        : ""}
                    </div>
                  )}

                  <div className={styles.moduleList}>
                    {getOnboardingModules(selected).map(m => (
                      <div
                        key={m.key}
                        className={styles.moduleRow}
                        data-status={m.status}
                        data-locked={!!m.locked}
                      >
                        <span className={styles.moduleDot} />
                        <span className={styles.moduleName}>{m.label}</span>
                        <span className={styles.moduleStatus}>
                          {m.locked ? "Locked" : MODULE_STATUS_LABELS[m.status]}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Adyen KYC has no automatic completion signal any more. The
                      Balance Platform webhook went when EasyOB stopped creating
                      Adyen objects, and AIO's API exposes no onboarding status we
                      can read. The nightly settlement backstop catches merchants
                      who actually transact (see lib/aio/approvedFromSettlement.ts);
                      this is for everyone else. Forward-only server-side, so it
                      can't drag a further-along deal backwards. */}
                  {selected.aioTenant?.provisionedAt &&
                    selected.stage !== "adyen_approved" &&
                    selected.stage !== "closed_lost" && (
                      <div className={styles.confirmStack}>
                        <div className={styles.sectionNote}>
                          {selected.stage === "adyen_kyc_complete"
                            ? "KYC submitted, awaiting approval."
                            : "Waiting on the merchant to finish identity verification."}
                          {" "}Adyen sends us no completion signal, so mark it once you have confirmed it.
                        </div>
                        <button
                          className={styles.btnGhost}
                          disabled={busyId === selected.id}
                          onClick={() => handleMarkKyc(selected)}
                        >
                          Mark Adyen Approved
                        </button>
                      </div>
                    )}

                  {selectedIds.length > 0 ? (
                    SHOW_PROVIDER_IDS ? (
                      <details>
                        <summary className={styles.disclosureSummary}>
                          Provider ids ({selectedIds.length})
                        </summary>
                        <div className={styles.idGrid}>
                          {selectedIds.map(({ label, value }) => (
                            <div key={label}>
                              <div className={styles.detailFieldLabel}>{label}</div>
                              <div className={styles.idValue}>{value}</div>
                            </div>
                          ))}
                        </div>
                      </details>
                    ) : null
                  ) : selected.quoteAcceptedAt ? (
                    <div className={styles.sectionNote}>
                      Nothing provisioned yet — the AIO tenant and the Adyen verification link are
                      created once billing is paid.
                    </div>
                  ) : null}
                </Section>
              )}

              </div>

              <aside className={styles.detailRail}>
              <div className={styles.railCard}>
                <div className={styles.railTitle}>Account</div>
                <dl className={styles.facts}>
                  <dt>Monthly volume</dt>
                  <dd>{volumeOf(selected) != null ? fmt$(volumeOf(selected)!) : "—"}</dd>
                  {(selected.analysis?.averageTicket || selected.quoteConfig?.avgTicket) ? (
                    <>
                      <dt>Average ticket</dt>
                      <dd>{fmt$(selected.analysis?.averageTicket || selected.quoteConfig!.avgTicket)}</dd>
                    </>
                  ) : null}
                  {selected.analysis && (
                    <>
                      <dt>Current fees/mo</dt>
                      <dd className={styles.factAccent}>{fmt$(selected.analysis.totalFees)}</dd>
                    </>
                  )}
                  {selected.proposal && (
                    <>
                      <dt>Savings/yr</dt>
                      <dd className={styles.factSuccess}>{fmt$(selected.proposal.savings?.annual || 0)}</dd>
                    </>
                  )}
                  <dt>Created</dt>
                  <dd>{new Date(selected.createdAt).toLocaleDateString()}</dd>
                  <dt>Last edited</dt>
                  <dd title={new Date(editedAt(selected)).toLocaleString()}>{relativeTime(editedAt(selected), now)}</dd>
                </dl>
              </div>

              {/* WHO and WHERE: the people stay visible; the HubSpot company
                  and deal sit in a disclosure, closed by default (product
                  owner, 2026-11-09: "hide all the stuff that can be hidden
                  away in a drawer"), open on arrival when the company still
                  needs linking — nothing reaches HubSpot until it is — or
                  when a "Link company" next step opened it. */}
              <div className={styles.railCard}>
                <div className={styles.railTitle}>Contact &amp; HubSpot</div>
                {isAdmin && (
                  <Field
                    label="Rep (commission)"
                    value={selectedRep?.name || selectedRep?.email || "Unassigned"}
                    meta={selectedRep?.name ? selectedRep.email : undefined}
                  />
                )}
                {selectedContact && (contactName || selectedContact.email) && (
                  <Field
                    label="Merchant contact"
                    value={contactName || selectedContact.email}
                    meta={[contactName ? selectedContact.email : null, selectedContact.phone]
                      .filter(Boolean)
                      .join(" · ") || undefined}
                  />
                )}
                {selected.analysis?.currentProcessorName && (
                  <Field label="Current processor" value={selected.analysis.currentProcessorName} />
                )}
                <details
                  key={selected.id}
                  ref={hubspotDrawerRef}
                  className={styles.railDrawer}
                  open={(canManageSelected && !selected.tenantLink) || hubspotFocus || tenantMismatch?.appId === selected.id ? true : undefined}
                >
                  <summary className={styles.disclosureSummary}>
                    <span>HubSpot</span>
                    <span className={styles.drawerHint} data-warn={canManageSelected && !selected.tenantLink}>
                      {selected.tenantLink ? selected.tenantLink.companyName : "Not linked"}
                    </span>
                  </summary>
                  <div className={styles.drawerBody}>
                  {canManageSelected && (
                    <>
                      <div>
                        <div className={styles.subLabel}>HubSpot company</div>
                        {selected.tenantLink ? (
                          <div className={styles.linkedRow}>
                            <div className={styles.linkedRowMain}>
                              <div className={styles.detailFieldValue} style={{ fontWeight: 600 }}>
                                {selected.tenantLink.companyName}
                              </div>
                              <div className={styles.detailMeta}>
                                {selected.tenantLink.tenantRef || "no tenant ref"}
                                {isAdmin && selected.tenantLink.adyenAccountHolderId ? ` · ${selected.tenantLink.adyenAccountHolderId}` : ""}
                              </div>
                            </div>
                            <button className={styles.btnGhost} disabled={linking} onClick={() => handleUnlinkTenant(selected)}>
                              Unlink
                            </button>
                          </div>
                        ) : (
                          <div>
                            <input
                              type="search"
                              className={styles.splitSearchInput}
                              placeholder="Search HubSpot companies to link a tenant…"
                              value={tenantQuery}
                              onChange={e => setTenantQuery(e.target.value)}
                            />
                            {tenantQuery.trim().length >= 2 && (
                              <>
                                {tenantSearching && <div className={styles.pickerStatus}>Searching…</div>}
                                {!tenantSearching && tenantResults.length === 0 && (
                                  <div className={styles.pickerStatus}>No matching companies.</div>
                                )}
                                {tenantResults.length > 0 && (
                                  <div className={styles.pickerResults}>
                                    {tenantResults.map(c => (
                                      <button
                                        key={c.id}
                                        className={styles.splitRow}
                                        disabled={linking}
                                        onClick={() => handleLinkTenant(selected, c.id)}
                                      >
                                        <span className={styles.splitRowName}>{c.name}</span>
                                        <span className={styles.detailMeta}>
                                          {c.tenantRef || "no tenant ref"}
                                          {isAdmin && c.adyenAccountHolderId ? ` · ${c.adyenAccountHolderId}` : ""}
                                        </span>
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        )}
                        {tenantMismatch?.appId === selected.id && (
                          <div className={styles.warningBanner} role="alert">
                            <strong>Deal attached to a different company.</strong> HubSpot deal{" "}
                            {tenantMismatch.dealId} is still linked to{" "}
                            {tenantMismatch.otherCompanyIds.length > 1 ? "companies" : "company"}{" "}
                            {tenantMismatch.otherCompanyIds.join(", ")} — not this tenant. We left it
                            alone rather than silently give one deal two companies. Resolve the
                            deal&rsquo;s company association in HubSpot directly.
                          </div>
                        )}
                      </div>

                      {selected.hubspotDealId && (
                        <div>
                          <div className={styles.subLabel}>HubSpot deal</div>
                          <div className={styles.detailFieldValue}>
                            {selectedDealUrl
                              ? <a href={selectedDealUrl} target="_blank" rel="noreferrer">{selected.dealLink?.dealName || "Open in HubSpot"}</a>
                              : selected.dealLink?.dealName || (isAdmin ? selected.hubspotDealId : "Linked")}
                          </div>
                          {selected.dealLink?.origin === "adopted" && (
                            <div className={styles.detailMeta}>Adopted</div>
                          )}
                        </div>
                      )}
                      {!selected.hubspotDealId && (
                        <div>
                          <div className={styles.subLabel}>HubSpot deal</div>
                          {!selected.tenantLink ? (
                            <div className={styles.sectionNote}>
                              Link the HubSpot company above first — the deal picker needs to know
                              which company&apos;s deals to search.
                            </div>
                          ) : dealAdoptPreview ? (
                            <div className={styles.confirmStack}>
                              <div>
                                <div className={styles.detailFieldValue} style={{ fontWeight: 600 }}>
                                  {dealAdoptPreview.deal.name}
                                </div>
                                <div className={styles.detailMeta}>
                                  {dealAdoptPreview.deal.stageLabel ?? "no stage"}
                                </div>
                              </div>
                              <div className={styles.warningBanner} role="alert">
                                {selected.quoteAcceptedAt
                                  ? "This merchant already accepted their quote. Adopting this deal will immediately build and PUBLISH a live HubSpot billing quote — a one-way door: no edit, no delete, no void through the API."
                                  : "No quote has been accepted yet, so adopting this deal just attaches it — nothing publishes."}
                              </div>
                              <div className={styles.confirmActions}>
                                <button
                                  className={styles.btnPrimary}
                                  disabled={adoptingDeal}
                                  onClick={() => handleAdoptDeal(selected, dealAdoptPreview.deal.id)}
                                >
                                  {adoptingDeal ? "Adopting…" : "Confirm & Adopt Deal"}
                                </button>
                                <button className={styles.btnGhost} disabled={adoptingDeal} onClick={() => setDealAdoptPreview(null)}>
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <DealPicker
                              companyId={selected.tenantLink.hubspotCompanyId}
                              companyName={selected.tenantLink.companyName}
                              defaultDealName={selected.business?.dba || selected.business?.legalName || selected.analysis?.merchantName || ""}
                              resolved={null}
                              onResolved={setDealAdoptPreview}
                              allowCreate={false}
                            />
                          )}
                        </div>
                      )}
                    </>
                  )}
                  {isAdmin && <div className={styles.detailMeta}>Account {selected.id}</div>}
                  </div>
                </details>
              </div>

              {/* Admin-only HubSpot billing diagnostics. Never rendered for a rep. */}
              {isAdmin && (selected.quoteApproval?.approvedAt || hasBillingDetails) && (
                <div className={styles.railCard} data-tone="admin">
                  <div className={styles.railTitle}>Admin</div>
                  {selected.quoteApproval?.approvedAt && quoteStatus !== "pending_approval" && (
                    <div className={styles.detailMeta}>
                      Over-limit pricing approved {new Date(selected.quoteApproval.approvedAt).toLocaleDateString()}.
                    </div>
                  )}
                  {hasBillingDetails && <BillingDetails app={selected} />}
                </div>
              )}

              {/* Secondary actions, away from the next step. Closed lost is
                  owner-only: it actually works the deal. */}
              {(quoteLinkToken || canResume || canCloseLost) && (
                <div className={styles.railCard}>
                  <div className={styles.railTitle}>More actions</div>
                  <div className={styles.moreRow}>
                    {quoteLinkToken && (
                      <button type="button" className={styles.btnGhost} onClick={() => handleCopyQuoteLink(quoteLinkToken)}>
                        {quoteLinkCopied ? "Copied!" : "Copy quote link"}
                      </button>
                    )}
                    {canResume && (
                      <button onClick={() => router.push(`/rep/proposals/new?id=${selected.id}`)} className={styles.btnGhost}>
                        {selected.stage === "analysis" ? "Continue Analysis" : "Resume Proposal"}
                      </button>
                    )}
                    {canCloseLost && (
                      <button
                        onClick={() => handleMarkClosedLost(selected)}
                        disabled={busyId === selected.id}
                        className={styles.btnQuietDanger}
                      >
                        Mark Closed Lost
                      </button>
                    )}
                  </div>
                </div>
              )}
              </aside>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
