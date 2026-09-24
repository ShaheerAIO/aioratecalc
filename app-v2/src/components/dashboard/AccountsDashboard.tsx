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
import { fmt$ } from "@/lib/utils";
import { STAGE_COLORS } from "@/lib/stageColors";
import { PROPOSAL_STAGES, ONBOARDING_STAGES } from "@/lib/stages";
import { getOnboardingModules } from "@/lib/onboardingModules";
import { BILLING_STATE_LABELS, billingPanelState, hasBillingSyncError } from "@/lib/billingView";
import { BillingPanel } from "./BillingPanel";
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

// Grid column templates — admin adds a "Rep" column for commission attribution.
const REP_COLS   = "1fr 140px 110px 100px 100px 90px";
const ADMIN_COLS = "1fr 110px 140px 110px 100px 100px 90px";

type Role = "rep" | "admin";

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
                        <span className={styles.badge} style={{ background: `${STAGE_COLORS[a.stage] || FALLBACK_STAGE_COLOR}20`, color: STAGE_COLORS[a.stage] || FALLBACK_STAGE_COLOR }}>
                          {a.stage.replace(/_/g, " ")}
                        </span>
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
                      <span className={styles.badge} style={{ background: `${STAGE_COLORS[a.stage] || FALLBACK_STAGE_COLOR}20`, color: STAGE_COLORS[a.stage] || FALLBACK_STAGE_COLOR }}>
                        {a.stage.replace(/_/g, " ")}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Right: detail panel */}
              <div className={styles.splitDetailPanel}>
                <div className={styles.detail}>
                  <div className={styles.detailHeader}>
                    <div>
                      <h2 className={styles.detailTitle}>{selected.business?.legalName || selected.analysis?.merchantName || "Account Detail"}</h2>
                      <div className={styles.detailMeta}>ID: {selected.id} · Created {new Date(selected.createdAt).toLocaleString()}</div>
                    </div>
                    <div className={styles.detailActions}>
                      {/* Resume / closed-lost stay owner-only: those actually work
                          the deal. Resend is operational — an admin covering for a
                          bounced email needs it on accounts they don't own. */}
                      {selected.ownerUserId === userId && RESUMABLE_STAGES.includes(selected.stage) && (
                        <button onClick={() => router.push(`/rep/proposals/new?id=${selected.id}`)} className={styles.btnPrimary}>
                          {selected.stage === "analysis" ? "Continue Analysis" : "Resume Proposal"}
                        </button>
                      )}
                      {showQuoteLink && (
                        <button onClick={() => handleResendQuoteLink(selected)} disabled={busyId === selected.id} className={styles.btnPrimary}>
                          {selected.customerLinkPurpose === "lead_upload" && selected.customerLinkToken
                            ? "Resend Quote Link"
                            : "Send Quote Link"}
                        </button>
                      )}
                      {showOnboardingSend && (
                        <button onClick={() => handleSendLink(selected)} disabled={busyId === selected.id} className={styles.btnPrimary}>
                          {selected.stage === "merchant_link_sent" ? "Resend Onboarding Link" : "Send Onboarding Link"}
                        </button>
                      )}
                      {selected.ownerUserId === userId && selected.stage !== "closed_lost" && selected.stage !== "adyen_approved" && (
                        <button onClick={() => handleMarkClosedLost(selected)} disabled={busyId === selected.id} className={styles.btnDanger}>
                          Mark Closed Lost
                        </button>
                      )}
                      <button onClick={() => { setSelected(null); setSearch(""); }} className={styles.btnGhost}>Close</button>
                    </div>
                  </div>

                  {/* The link the staff just (re)sent. Shown in full with a copy
                      affordance because email/SMS delivery is optional — without
                      this the click would surface nothing they can hand over. */}
                  {sentLink?.appId === selected.id && (
                    <div>
                      <div className={styles.detailFieldLabel} style={{ marginBottom: 8 }}>
                        {sentLink.kind === "quote" ? "Quote Link" : "Merchant Onboarding Link"}
                      </div>
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
                      <div className={styles.detailMeta} style={{ marginTop: 6 }}>
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
                    </div>
                  )}

                  <div className={styles.detailGrid}>
                    {(isAdmin
                      ? [
                          { label: "Stage", val: selected.stage.replace(/_/g, " ") },
                          { label: "Rep (Commission)", val: repMap.get(selected.ownerUserId)?.name || "—" },
                          { label: "Rep Email", val: repMap.get(selected.ownerUserId)?.email || "—" },
                          { label: "HubSpot Deal ID", val: selected.hubspotDealId || "Not synced" },
                          { label: "HubSpot Quote", val: BILLING_STATE_LABELS[billingPanelState(selected)] },
                          { label: "Payment Status", val: selected.hubspotIds?.paymentStatus || "—" },
                          { label: "Subscription Status", val: selected.hubspotIds?.subscriptionStatus || "—" },
                          {
                            label: "HubSpot Sync",
                            val: hasBillingSyncError(selected.hubspotIds) ? "⚠ Error" : "OK",
                          },
                          { label: "Tenant Number", val: selected.adyenIds?.tenantNumber || "Not set" },
                          { label: "Store (prod-)", val: selected.adyenIds?.tenantNumber ? `prod-${selected.adyenIds.tenantNumber}` : "Not created" },
                          { label: "Store ID", val: selected.adyenIds?.storeId || "Not created" },
                          { label: "Balance Account", val: selected.adyenIds?.balanceAccountId || "Not created" },
                          { label: "Adyen Legal Entity", val: selected.adyenIds?.legalEntityId || "Not created" },
                          { label: "Adyen Environment", val: selected.adyenIds?.environment || "—" },
                          { label: "Onboarding URL", val: selected.adyenOnboardingUrl ? "Set" : "Not generated" },
                          { label: "Merchant Contact", val: selected.ownerContact ? `${selected.ownerContact.firstName} ${selected.ownerContact.lastName}` : "—" },
                          { label: "Merchant Email", val: selected.ownerContact?.email || "—" },
                        ]
                      : [
                          { label: "Stage", val: selected.stage.replace(/_/g, " ") },
                          { label: "HubSpot Deal ID", val: selected.hubspotDealId || "Not synced" },
                          { label: "HubSpot Quote", val: BILLING_STATE_LABELS[billingPanelState(selected)] },
                          {
                            label: "HubSpot Sync",
                            val: hasBillingSyncError(selected.hubspotIds) ? "⚠ Error" : "OK",
                          },
                          { label: "Adyen Legal Entity", val: selected.adyenIds?.legalEntityId || "Not created" },
                          { label: "Onboarding URL", val: selected.adyenOnboardingUrl ? "Set" : "Not generated" },
                          { label: "Owner", val: selected.ownerContact ? `${selected.ownerContact.firstName} ${selected.ownerContact.lastName}` : "—" },
                          { label: "Email", val: selected.ownerContact?.email || "—" },
                        ]
                    ).map(f => (
                      <div key={f.label}>
                        <div className={styles.detailFieldLabel}>{f.label}</div>
                        <div className={styles.detailFieldValue}>{f.val}</div>
                      </div>
                    ))}
                  </div>

                  {/* HubSpot tenant link (ezacc ↔ AIO tenant). Owner rep or any
                      admin may edit; a rep never sees another rep's accounts, so
                      ownership is the only gate. Recording only — no Adyen call. */}
                  {(isAdmin || selected.ownerUserId === userId) && (
                    <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 16 }}>
                      <div className={styles.detailFieldLabel} style={{ marginBottom: 8 }}>HubSpot Tenant</div>
                      {selected.tenantLink ? (
                        <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                          <div style={{ flex: 1, minWidth: 240 }}>
                            <div className={styles.detailFieldValue} style={{ fontWeight: 600 }}>
                              {selected.tenantLink.companyName}
                            </div>
                            <div className={styles.detailMeta} style={{ marginTop: 4 }}>
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
                            className={styles.tableSearchInput}
                            style={{ width: "100%" }}
                            placeholder="Search HubSpot companies to link a tenant…"
                            value={tenantQuery}
                            onChange={e => setTenantQuery(e.target.value)}
                          />
                          {tenantQuery.trim().length >= 2 && (
                            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                              {tenantSearching && <div className={styles.detailMeta}>Searching…</div>}
                              {!tenantSearching && tenantResults.length === 0 && (
                                <div className={styles.detailMeta}>No matching companies.</div>
                              )}
                              {tenantResults.map(c => (
                                <button
                                  key={c.id}
                                  className={styles.splitRow}
                                  disabled={linking}
                                  onClick={() => handleLinkTenant(selected, c.id)}
                                  style={{ textAlign: "left" }}
                                >
                                  <span className={styles.splitRowName}>{c.name}</span>
                                  <span className={styles.detailMeta}>
                                    {c.tenantRef || "no tenant ref"}{c.adyenAccountHolderId ? ` · ${c.adyenAccountHolderId}` : ""}
                                  </span>
                                </button>
                              ))}
                            </div>
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
                          deal's company association in HubSpot directly.
                        </div>
                      )}
                    </div>
                  )}

                  {/* HubSpot deal adoption — the account has NO deal at all (a
                      legacy row from before deal adoption existed, or a
                      company whose deal was never attached). This is the
                      "go pick one" destination sendQuoteAction's
                      `ambiguous` refusal points reps at; it disappears the
                      moment a deal is attached, in favor of the "HubSpot
                      Deal ID" field above. Existing-deal only — creating a
                      brand-new deal for a company with none is
                      sendQuoteAction's job (mode: "create"). */}
                  {(isAdmin || selected.ownerUserId === userId) && !selected.hubspotDealId && (
                    <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 16 }}>
                      <div className={styles.detailFieldLabel} style={{ marginBottom: 8 }}>HubSpot Deal</div>
                      {!selected.tenantLink ? (
                        <div className={styles.detailMeta}>
                          Link the HubSpot tenant company above first — the deal picker needs to know
                          which company&apos;s deals to search.
                        </div>
                      ) : dealAdoptPreview ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          <div>
                            <div className={styles.detailFieldValue} style={{ fontWeight: 600 }}>
                              {dealAdoptPreview.deal.name}
                            </div>
                            <div className={styles.detailMeta} style={{ marginTop: 4 }}>
                              {dealAdoptPreview.deal.stageLabel ?? "no stage"}
                            </div>
                          </div>
                          <div className={styles.warningBanner} role="alert">
                            {selected.quoteAcceptedAt
                              ? "This merchant already accepted their quote. Adopting this deal will immediately build and PUBLISH a live HubSpot billing quote — a one-way door: no edit, no delete, no void through the API."
                              : "No quote has been accepted yet, so adopting this deal just attaches it — nothing publishes."}
                          </div>
                          <div style={{ display: "flex", gap: 8 }}>
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
                      <div style={{ marginTop: 8 }}>
                        <div className={styles.detailFieldLabel}>Adyen verification</div>
                        <div className={styles.detailMeta} style={{ marginBottom: 8 }}>
                          AIO tenant {selected.aioTenant.businessId}
                          {selected.aioTenant.locationId ? ` · location ${selected.aioTenant.locationId}` : ""}
                          {" · "}
                          {selected.stage === "adyen_kyc_complete"
                            ? "KYC submitted, awaiting approval"
                            : "awaiting the merchant"}
                        </div>
                        <button
                          className={styles.btnPrimary}
                          disabled={busyId === selected.id}
                          onClick={() => handleMarkKyc(selected)}
                        >
                          Mark Adyen Approved
                        </button>
                      </div>
                    )}

                  {/* Rework the quote at any time up to acceptance — things change.
                      Owner rep or any admin, same gate as the
                      tenant link above. saveQuoteConfigurationAction (which this
                      calls) refuses once quoteAcceptedAt is set; EditQuotePanel
                      shows the frozen notice instead of the form in that case. */}
                  {(isAdmin || selected.ownerUserId === userId) && (
                    <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 16 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: editQuoteOpen ? 12 : 0 }}>
                        <div className={styles.detailFieldLabel}>Quote</div>
                        {!selected.quoteAcceptedAt && (
                          <button className={styles.btnGhost} onClick={() => setEditQuoteOpen(o => !o)}>
                            {editQuoteOpen ? "Close" : "Edit Quote"}
                          </button>
                        )}
                      </div>
                      {selected.quoteAcceptedAt && !editQuoteOpen && (
                        <div className={styles.detailMeta}>
                          Accepted {new Date(selected.quoteAcceptedAt).toLocaleDateString()} — locked. Start a new
                          quote to change terms.
                        </div>
                      )}
                      {editQuoteOpen && (
                        <EditQuotePanel
                          app={selected}
                          onSaved={updated => { updateOne(updated); setEditQuoteOpen(false); }}
                          onCancel={() => setEditQuoteOpen(false)}
                        />
                      )}
                    </div>
                  )}

                  <BillingPanel
                    app={selected}
                    canManage={isAdmin || selected.ownerUserId === userId}
                    onUpdated={updateOne}
                  />

                  <div>
                    <div className={styles.modulesLabel}>Modules</div>
                    <div className={styles.modules}>
                      {getOnboardingModules(selected).map(m => (
                        <span key={m.key} className={styles.modulePill}>
                          {m.label}: {m.status.replace(/_/g, " ")}
                          {m.locked ? ` · locked (${m.locked.reason})` : ""}
                        </span>
                      ))}
                    </div>
                  </div>
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
