"use client";

import { Suspense, useState, useEffect } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  listApplicationsAction,
  listSubmissionsAction,
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
import { resendLeadLinkAction } from "@/lib/actions/prospects";
import EditQuotePanel from "@/components/rep/EditQuotePanel";
import DealPicker, { type ResolvedDeal } from "@/components/rep/DealPicker";
import { fmt$, fmtCycle } from "@/lib/utils";
import { STAGE_COLORS } from "@/lib/stageColors";
import { PROPOSAL_STAGES, ONBOARDING_STAGES } from "@/lib/stages";
import { getOnboardingModules, type ModuleStatus } from "@/lib/onboardingModules";
import { hubspotDealUrl } from "@/lib/billingView";
import { QUOTE_TYPES, quoteTotals, quoteTypeOf } from "@/lib/quoting";
import { BillingPanel } from "./BillingPanel";
import { Field, Section } from "./DetailSection";
import type { MerchantApplication, CustomerSubmission } from "@/types/merchant";
import type { TenantCompany } from "@/lib/adapters/hubspot";
import styles from "./AccountsDashboard.module.css";

// Neutral fallback for a stage not present in STAGE_COLORS (should not occur in practice).
const FALLBACK_STAGE_COLOR = "#9ca3af";

// Stages that are still mid-build in the proposal wizard and can be reopened.
// The wizard hydrates from ?id= and jumps to the right step (Analysis /
// Proposal). `pricing` is here for completeness — nothing sets it today, but a
// deal parked there would otherwise be unreachable from the dashboard.
const RESUMABLE_STAGES = ["analysis", "pricing", "proposal_ready"];
const PROPOSAL_FLOW_LINKED: boolean = false;

// Grid column templates — admin adds a "Rep" column for commission attribution.
const REP_COLS   = "1fr 140px 110px 100px 100px 90px";
const ADMIN_COLS = "1fr 110px 140px 110px 100px 100px 90px";

// Cosmetic only — absent, the deal id renders as plain text instead of a link.
// Same variable BillingPanel reads for the quote id.
const HUBSPOT_PORTAL_ID = process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID;

const MODULE_STATUS_LABELS: Record<ModuleStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  complete: "Complete",
};

type Role = "rep" | "admin";

function StageBadge({ stage }: { stage: string }) {
  const color = STAGE_COLORS[stage] || FALLBACK_STAGE_COLOR;
  return (
    <span className={styles.badge} style={{ background: `${color}20`, color }}>
      {stage.replace(/_/g, " ")}
    </span>
  );
}

const QUOTE_TYPE_LABELS = new Map(QUOTE_TYPES.map(t => [t.id, t.label]));

/**
 * The provider ids worth showing, and ONLY the ones that exist.
 *
 * Since EasyOB stopped creating Adyen objects (2026-09-23) the provisioner
 * writes just `legalEntityId`, `tenantNumber` and `environment` — every other
 * field on `adyenIds` is permanently null on any row created since. Rendering
 * them as fixed grid cells meant five of the panel's most prominent rows read
 * "Not created" forever, which is what buried the fields that do carry
 * something. Folded into a disclosure and filtered, so the section shows what
 * is real and nothing else.
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
  // page owns the title, the stat hero and the accounts/leads switch, so all
  // three are suppressed here to avoid showing them twice. Unset = the
  // standalone /rep behaviour, unchanged.
  embedded?: boolean;
  // Controlled sub-view, used with `embedded` so the host page's own view param
  // drives which table renders instead of this component's ?tab=.
  view?: "accounts" | "leads";
  // ownerUserId to narrow the accounts table to (drill-down from a rep row).
  repFilter?: string | null;
  onClearRepFilter?: () => void;
  /** DEBUG-BILLING-BYPASS — see lib/debug/billingBypass.ts. */
  debugBillingBypass?: boolean;
};

// useSearchParams (for the ?tab= param below) requires a Suspense boundary
// above it, so the actual implementation is wrapped here rather than at every
// call site (rep/page.tsx renders this directly; AdminDashboard.tsx nests it).
export function AccountsDashboard(props: AccountsDashboardProps) {
  return (
    <Suspense>
      <AccountsDashboardInner {...props} />
    </Suspense>
  );
}

function AccountsDashboardInner({
  role,
  userId,
  embedded,
  view,
  repFilter,
  onClearRepFilter,
  debugBillingBypass = false,
}: AccountsDashboardProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isAdmin = role === "admin";

  const [apps, setApps]         = useState<MerchantApplication[]>([]);
  const [subs, setSubs]         = useState<CustomerSubmission[]>([]);
  const [reps, setReps]         = useState<RepSummary[]>([]);
  // Sourced straight from the URL (not local state) so a link into this page
  // (/rep?tab=leads) actually switches the panel, and so the URL and the panel
  // always agree on which one is active. When embedded, the host page passes
  // the resolved view in instead — see AdminDashboard.tsx.
  const tab: "accounts" | "leads" =
    view ?? (isAdmin && searchParams.get("tab") === "leads" ? "leads" : "accounts");
  const setTab = (next: "accounts" | "leads") => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "leads") params.set("tab", "leads");
    else params.delete("tab");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const [selected, setSelected] = useState<MerchantApplication | null>(null);
  const [busyId, setBusyId]     = useState<string | null>(null);
  const [search, setSearch]     = useState("");
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

  useEffect(() => {
    listApplicationsAction().then(setApps).catch(() => {});
    if (isAdmin) {
      listSubmissionsAction().then(setSubs).catch(() => {});
      listRepsAction().then(setReps).catch(() => {});
    }
  }, [isAdmin]);

  const repMap = new Map(reps.map(r => [r.id, r]));

  const cols = isAdmin ? ADMIN_COLS : REP_COLS;

  const metrics = {
    total:     apps.length,
    proposals: apps.filter(a => PROPOSAL_STAGES.includes(a.stage)).length,
    applying:  apps.filter(a => ONBOARDING_STAGES.includes(a.stage)).length,
    approved:  apps.filter(a => a.stage === "adyen_approved").length,
    volume:    apps.reduce((sum, a) => sum + (a.analysis?.totalVolume || 0), 0),
    savings:   apps.reduce((sum, a) => sum + (a.proposal?.savings?.annual || 0), 0),
  };

  const updateOne = (updated: MerchantApplication) => {
    setApps(prev => prev.map(a => (a.id === updated.id ? updated : a)));
    setSelected(prev => (prev?.id === updated.id ? updated : prev));
  };

  const filteredApps = apps.filter(a => {
    if (repFilter && a.ownerUserId !== repFilter) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      (a.business?.dba || "").toLowerCase().includes(q) ||
      (a.business?.legalName || "").toLowerCase().includes(q) ||
      (a.analysis?.merchantName || "").toLowerCase().includes(q) ||
      (a.adyenIds?.tenantNumber || "").toLowerCase().includes(q) ||
      (`prod-${a.adyenIds?.tenantNumber || ""}`).toLowerCase().includes(q) ||
      (a.adyenIds?.storeId || "").toLowerCase().includes(q)
    );
  });

  const canManageSelected = selected != null && (isAdmin || selected.ownerUserId === userId);
  const showQuoteLink = canManageSelected;
  const showOnboardingSend = selected != null && canManageSelected && !!selected.ownerContact?.email && (
    (selected.stage === "proposal_sent" && !selected.adyenOnboardingUrl) ||
    selected.stage === "merchant_link_sent"
  );
  // Resume actually works the deal, so it stays owner-only even for an admin —
  // unlike the two resend buttons, which are operational (an admin covering a
  // bounced email needs them on accounts they don't own).
  // PROPOSAL_FLOW_LINKED gates the only link into /rep/proposals/new, which is
  // hidden from the UI but kept for reference.
  const canResume = PROPOSAL_FLOW_LINKED
    && selected != null
    && selected.ownerUserId === userId
    && RESUMABLE_STAGES.includes(selected.stage);
  // Exactly one action is primary: the next thing to do. The header used to
  // carry up to five coral buttons at once, which made none of them read as
  // the next step.
  const primaryAction = canResume ? "resume" : showQuoteLink ? "quote" : showOnboardingSend ? "onboarding" : null;

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

  // Reset the tenant picker whenever a different account is opened.
  useEffect(() => {
    setTenantQuery("");
    setTenantResults([]);
    setEditQuoteOpen(false);
    setTenantMismatch(null);
    setDealAdoptPreview(null);
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
    ? "No accounts yet. They appear here as reps start proposals and customers submit leads."
    : "No accounts yet. Upload a statement or send a customer link to get started.";

  return (
    <div className={embedded ? styles.mainEmbedded : styles.main}>
      {!embedded && (
        <div className={styles.header}>
          <h1 className={styles.headerTitle}>Accounts</h1>
          <p className={styles.headerSubtitle}>
            {isAdmin
              ? "Every account across all reps, plus customer self-serve leads — with margin oversight for approved deals."
              : "Your merchants across the whole pipeline, from first statement to approved onboarding."}
          </p>
        </div>
      )}

      {/* Stat-led hero — no card shape, sits directly on the page. The embedding
          page (/admin) shows its own org-wide hero, so it is dropped there. */}
      {!embedded && (
        <div className={styles.stats}>
          <div className={styles.statHero}>{fmt$(metrics.volume)}</div>
          <p className={styles.statCaption}>
            {isAdmin ? "Total volume across the pipeline" : "Total volume across your pipeline"}
          </p>
          <div className={styles.statTicker}>
            <span><b>{metrics.total}</b> Accounts</span>
            <span className={styles.statDot}>·</span>
            <span><b>{metrics.proposals}</b> Proposals Sent</span>
            <span className={styles.statDot}>·</span>
            <span><b>{metrics.applying}</b> In Onboarding</span>
            <span className={styles.statDot}>·</span>
            <span><b>{metrics.approved}</b> Approved</span>
            <span className={styles.statDot}>·</span>
            <span><b className={styles.statSuccess}>{fmt$(metrics.savings)}/yr</b> Projected Savings</span>
          </div>
        </div>
      )}

      {/* Admin gets a Leads sub-view alongside Accounts; reps only have Accounts.
          Embedded, the host page's own view toggle takes over this job. */}
      {isAdmin && !embedded && (
        <div className={styles.tabsRow}>
          <div className={styles.tabs} data-active={tab} role="tablist">
            <button role="tab" aria-selected={tab === "accounts"} className={styles.tab} onClick={() => setTab("accounts")}>
              Accounts ({apps.length})
            </button>
            <button role="tab" aria-selected={tab === "leads"} className={styles.tab} onClick={() => setTab("leads")}>
              Leads ({subs.length})
            </button>
          </div>
        </div>
      )}

      {tab === "accounts" && (
        <>
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

          {/* Full table — shown when nothing is selected */}
          {!selected && (
            <>
              <div className={styles.tableSearch} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="search"
                  className={styles.tableSearchInput}
                  placeholder="Search accounts… (name, merchant account, store)"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={{ flex: 1 }}
                />
                {isAdmin && apps.length > 0 && (
                  <button className={styles.btnGhost} onClick={handleExportCsv}>Export CSV</button>
                )}
              </div>
              <div className={styles.panel}>
                <div className={styles.tableHeader} style={{ gridTemplateColumns: cols }}>
                  {(isAdmin
                    ? ["Merchant", "Rep", "Stage", "Volume", "Fees", "Savings/yr", "Created"]
                    : ["Merchant", "Stage", "Volume", "Fees", "Savings/yr", "Created"]
                  ).map(h => (
                    <div key={h} className={styles.tableHeaderCell}>{h}</div>
                  ))}
                </div>
                {filteredApps.length === 0 && (
                  <div className={styles.emptyState}>{search ? "No results." : emptyCopy}</div>
                )}
                {filteredApps.map(a => {
                  const rep = repMap.get(a.ownerUserId);
                  return (
                    <button key={a.id} onClick={() => setSelected(a)} className={styles.tableRow} style={{ gridTemplateColumns: cols }}>
                      <div className={styles.tableCell} data-label="Merchant">
                        <div className={styles.merchantName}>{a.business?.dba || a.business?.legalName || a.analysis?.merchantName || "—"}</div>
                        <div className={styles.merchantSub}>{a.analysis?.currentProcessorName || "—"}</div>
                      </div>
                      {isAdmin && <div className={styles.tableCell} data-label="Rep">{rep?.name || rep?.email || "—"}</div>}
                      <div className={styles.tableCell} data-label="Stage">
                        <StageBadge stage={a.stage} />
                      </div>
                      <div className={`${styles.tableCell} ${styles["tableCell--numeric"]}`} data-label="Volume">{a.analysis ? fmt$(a.analysis.totalVolume) : "—"}</div>
                      <div className={`${styles.tableCell} ${styles["tableCell--accent"]}`} data-label="Fees">{a.analysis ? fmt$(a.analysis.totalFees) : "—"}</div>
                      <div className={`${styles.tableCell} ${styles["tableCell--success"]}`} data-label="Savings/yr">{a.proposal ? fmt$(a.proposal.savings?.annual || 0) : "—"}</div>
                      <div className={`${styles.tableCell} ${styles["tableCell--muted"]}`} data-label="Created">{new Date(a.createdAt).toLocaleDateString()}</div>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {/* Split view — shown once an account is selected */}
          {selected && (
            <div className={styles.splitLayout}>
              {/* Left: searchable compact list */}
              <div className={styles.splitListPanel}>
                <div className={styles.splitSearch}>
                  <input
                    type="search"
                    className={styles.splitSearchInput}
                    placeholder="Search accounts…"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                  />
                </div>
                <div className={styles.splitListScroll}>
                  {filteredApps.length === 0 && (
                    <div className={styles.emptyState}>{search ? "No results." : "No accounts yet."}</div>
                  )}
                  {filteredApps.map(a => (
                    <button
                      key={a.id}
                      onClick={() => setSelected(a === selected ? null : a)}
                      className={styles.splitRow}
                      data-selected={selected?.id === a.id}
                    >
                      <span className={styles.splitRowName}>
                        {a.business?.dba || a.business?.legalName || a.analysis?.merchantName || "—"}
                      </span>
                      <StageBadge stage={a.stage} />
                    </button>
                  ))}
                </div>
              </div>

              {/* Right: detail panel */}
              <div className={styles.splitDetailPanel}>
                <div className={styles.detail}>
                  <div className={styles.detailHeader}>
                    <div>
                      <div className={styles.detailTitleRow}>
                        <h2 className={styles.detailTitle}>
                          {selected.business?.dba || selected.business?.legalName || selected.analysis?.merchantName || "Account Detail"}
                        </h2>
                        <StageBadge stage={selected.stage} />
                      </div>
                      <div className={styles.detailMeta}>
                        {selected.business?.legalName && selected.business.legalName !== selected.business.dba
                          ? `${selected.business.legalName} · `
                          : ""}
                        Created {new Date(selected.createdAt).toLocaleDateString()} · {selected.id}
                      </div>
                    </div>
                    <button
                      onClick={() => { setSelected(null); setSearch(""); }}
                      className={styles.detailClose}
                      aria-label="Close account detail"
                    >
                      ×
                    </button>
                  </div>

                  {primaryAction && (
                    <div className={styles.detailActions}>
                      {canResume && (
                        <button onClick={() => router.push(`/rep/proposals/new?id=${selected.id}`)} className={styles.btnPrimary}>
                          {selected.stage === "analysis" ? "Continue Analysis" : "Resume Proposal"}
                        </button>
                      )}
                      {showQuoteLink && (
                        <button
                          onClick={() => handleResendQuoteLink(selected)}
                          disabled={busyId === selected.id}
                          className={primaryAction === "quote" ? styles.btnPrimary : styles.btnGhost}
                        >
                          {selected.customerLinkPurpose === "lead_upload" && selected.customerLinkToken
                            ? "Resend Quote Link"
                            : "Send Quote Link"}
                        </button>
                      )}
                      {showOnboardingSend && (
                        <button
                          onClick={() => handleSendLink(selected)}
                          disabled={busyId === selected.id}
                          className={primaryAction === "onboarding" ? styles.btnPrimary : styles.btnGhost}
                        >
                          {selected.stage === "merchant_link_sent" ? "Resend Onboarding Link" : "Send Onboarding Link"}
                        </button>
                      )}
                    </div>
                  )}

                  {/* The three numbers the table was showing right up until the
                      moment a row was opened — the detail panel used to drop
                      them entirely in favour of eighteen id fields. */}
                  {selected.analysis && (
                    <div className={styles.snapshot}>
                      <div className={styles.snapshotItem}>
                        <span className={styles.snapshotValue}>{fmt$(selected.analysis.totalVolume)}</span>
                        <span className={styles.snapshotLabel}>Monthly volume</span>
                      </div>
                      <div className={styles.snapshotItem}>
                        <span className={`${styles.snapshotValue} ${styles["snapshotValue--accent"]}`}>
                          {fmt$(selected.analysis.totalFees)}
                        </span>
                        <span className={styles.snapshotLabel}>Current fees/mo</span>
                      </div>
                      {selected.proposal && (
                        <div className={styles.snapshotItem}>
                          <span className={`${styles.snapshotValue} ${styles["snapshotValue--success"]}`}>
                            {fmt$(selected.proposal.savings?.annual || 0)}
                          </span>
                          <span className={styles.snapshotLabel}>Savings/yr</span>
                        </div>
                      )}
                    </div>
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

                  {/* Who's on this deal. `Rep` is the commission owner AND the
                      address a published HubSpot quote is sent from
                      (resolveSender), which is why an admin sees the email and
                      not just the name. `ownerContact` is the merchant's own
                      contact person — a different "owner" entirely. */}
                  <Section label="Deal">
                    <div className={styles.detailGrid}>
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
                    </div>
                  </Section>

                  {/* HubSpot linkage — the company (AIO tenant) and the deal.
                      Owner rep or any admin may edit; a rep never sees another
                      rep's accounts, so ownership is the only gate. Recording
                      only — no Adyen call. */}
                  {(isAdmin || selected.ownerUserId === userId) && (
                    <Section label="HubSpot">
                      <div>
                        <div className={styles.subLabel}>HubSpot Tenant</div>
                        {selected.tenantLink ? (
                          <div className={styles.linkedRow}>
                            <div className={styles.linkedRowMain}>
                              <div className={styles.detailFieldValue} style={{ fontWeight: 600 }}>
                                {selected.tenantLink.companyName}
                              </div>
                              <div className={styles.detailMeta}>
                                {selected.tenantLink.tenantRef || "no tenant ref"}
                                {selected.tenantLink.adyenAccountHolderId ? ` · ${selected.tenantLink.adyenAccountHolderId}` : ""}
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
                                          {c.tenantRef || "no tenant ref"}{c.adyenAccountHolderId ? ` · ${c.adyenAccountHolderId}` : ""}
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
                          <div className={styles.subLabel}>HubSpot Deal</div>
                          <div className={styles.detailFieldValue}>
                            {selectedDealUrl
                              ? <a href={selectedDealUrl} target="_blank" rel="noreferrer">{selected.hubspotDealId}</a>
                              : selected.hubspotDealId}
                          </div>
                          {selected.dealLink?.dealName && (
                            <div className={styles.detailMeta}>
                              {selected.dealLink.dealName}
                              {selected.dealLink.origin === "adopted" ? " · adopted" : ""}
                            </div>
                          )}
                        </div>
                      )}
                    </Section>
                  )}

                  {/* HubSpot deal adoption — the account has NO deal at all (a
                      legacy row from before deal adoption existed, or a
                      company whose deal was never attached). This is the
                      "go pick one" destination sendQuoteAction's
                      `ambiguous` refusal points reps at; it disappears the
                      moment a deal is attached, in favor of the "HubSpot
                      Deal" field above. Existing-deal only — creating a
                      brand-new deal for a company with none is
                      sendQuoteAction's job (mode: "create"). */}
                  {(isAdmin || selected.ownerUserId === userId) && !selected.hubspotDealId && (
                    <Section label="HubSpot Deal">
                      {!selected.tenantLink ? (
                        <div className={styles.sectionNote}>
                          Link the HubSpot tenant company above first — the deal picker needs to know
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
                    </Section>
                  )}

                  {/* What the merchant is buying. The HubSpot document built
                      from it — quote id, signature, payment, subscriptions —
                      is the Billing section below; keeping the two apart is
                      what stopped the quote's state being reported twice in
                      two different vocabularies.
                      Rework is allowed at any time up to acceptance — things
                      change. Owner rep or any admin, same gate as the tenant
                      link above. saveQuoteConfigurationAction (which this
                      calls) refuses once quoteAcceptedAt is set; EditQuotePanel
                      shows the frozen notice instead of the form in that case. */}
                  {(isAdmin || selected.ownerUserId === userId) && (
                    <Section
                      label="Quote"
                      action={
                        !selected.quoteAcceptedAt ? (
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
                          {selected.quoteAcceptedAt && (
                            <div className={styles.detailMeta}>
                              Accepted {new Date(selected.quoteAcceptedAt).toLocaleDateString()} — locked. Start a new
                              quote to change terms.
                            </div>
                          )}
                        </>
                      )}
                      {editQuoteOpen && (
                        <EditQuotePanel
                          app={selected}
                          onSaved={updated => { updateOne(updated); setEditQuoteOpen(false); }}
                          onCancel={() => setEditQuoteOpen(false)}
                        />
                      )}
                    </Section>
                  )}

                  <BillingPanel
                    app={selected}
                    canManage={isAdmin || selected.ownerUserId === userId}
                    onUpdated={updateOne}
                    debugBillingBypass={debugBillingBypass}
                  />

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
                    ) : selected.quoteAcceptedAt ? (
                      <div className={styles.sectionNote}>
                        Nothing provisioned yet — the AIO tenant and the Adyen verification link are
                        created once billing is paid.
                      </div>
                    ) : null}
                  </Section>

                  {/* Owner-only: this actually works the deal. */}
                  {selected.ownerUserId === userId
                    && selected.stage !== "closed_lost"
                    && selected.stage !== "adyen_approved" && (
                    <div className={styles.detailFooter}>
                      <button
                        onClick={() => handleMarkClosedLost(selected)}
                        disabled={busyId === selected.id}
                        className={styles.btnQuietDanger}
                      >
                        Mark Closed Lost
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {isAdmin && tab === "leads" && (
        <div className={styles.tabPanel}>
          <div className={styles.panel}>
            <div className={styles.tableHeader} style={{ gridTemplateColumns: "1fr 110px 110px 110px 100px" }}>
              {["Merchant", "Volume", "Fees", "Processor", "Submitted"].map(h => (
                <div key={h} className={styles.tableHeaderCell}>{h}</div>
              ))}
            </div>
            {subs.length === 0 && (
              <div className={styles.emptyState}>No customer leads yet. Share the customer portal to collect submissions.</div>
            )}
            {subs.map((s, i) => (
              <div key={i} className={styles.tableRow} style={{ gridTemplateColumns: "1fr 110px 110px 110px 100px", cursor: "default" }}>
                <div className={styles.tableCell} data-label="Merchant">
                  <div className={styles.merchantName}>{s.analysis?.merchantName || "—"}</div>
                  <div className={styles.merchantSub}>{s.contactInfo?.email || "—"}</div>
                </div>
                <div className={`${styles.tableCell} ${styles["tableCell--numeric"]}`} data-label="Volume">{s.analysis ? fmt$(s.analysis.totalVolume) : "—"}</div>
                <div className={`${styles.tableCell} ${styles["tableCell--accent"]}`} data-label="Fees">{s.analysis ? fmt$(s.analysis.totalFees) : "—"}</div>
                <div className={`${styles.tableCell} ${styles["tableCell--muted"]}`} data-label="Processor">{s.analysis?.currentProcessorName || "—"}</div>
                <div className={`${styles.tableCell} ${styles["tableCell--muted"]}`} data-label="Submitted">{new Date(s.submittedAt).toLocaleDateString()}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
