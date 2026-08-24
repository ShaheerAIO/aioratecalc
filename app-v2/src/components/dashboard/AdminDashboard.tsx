"use client";

import { Suspense, useState, useEffect } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  listApplicationsAction,
  listSubmissionsAction,
  listRepsAction,
  type RepSummary,
} from "@/lib/actions/applications";
import { fmt$ } from "@/lib/utils";
import { countHubspotSyncErrors } from "@/lib/billingView";
import { AccountsDashboard } from "./AccountsDashboard";
import { parseAdminView, type AdminView } from "@/lib/adminView";
import { PROPOSAL_STAGES, ONBOARDING_STAGES } from "@/lib/stages";
import type { MerchantApplication, CustomerSubmission } from "@/types/merchant";
import styles from "./AdminDashboard.module.css";

type RepRow = RepSummary & {
  count: number;
  volume: number;
  proposals: number;
  approved: number;
  savings: number;
};

function summarizeRep(rep: RepSummary, apps: MerchantApplication[]): RepRow {
  const owned = apps.filter(a => a.ownerUserId === rep.id);
  return {
    ...rep,
    count: owned.length,
    volume: owned.reduce((sum, a) => sum + (a.analysis?.totalVolume || 0), 0),
    proposals: owned.filter(a => PROPOSAL_STAGES.includes(a.stage)).length,
    approved: owned.filter(a => a.stage === "adyen_approved").length,
    savings: owned.reduce((sum, a) => sum + (a.proposal?.savings?.annual || 0), 0),
  };
}

const VIEW_TABS: { id: AdminView; label: string }[] = [
  { id: "reps",     label: "By Rep" },
  { id: "accounts", label: "Accounts" },
  { id: "leads",    label: "Leads" },
];

// useSearchParams (?view=/?rep= below) needs a Suspense boundary above it.
export function AdminDashboard(props: { userId: string }) {
  return (
    <Suspense>
      <AdminDashboardInner {...props} />
    </Suspense>
  );
}

// The single admin surface: org-wide pipeline totals on top, then exactly one
// of three views — the per-rep breakdown, all accounts, or customer leads —
// chosen by ?view= (default "reps"). The accounts/leads views reuse
// AccountsDashboard embedded, so there is one accounts table in the app, not two.
function AdminDashboardInner({ userId }: { userId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const view = parseAdminView(searchParams.get("view"));
  // Only meaningful in the accounts view; a rep row click sets it.
  const repFilter = view === "accounts" ? searchParams.get("rep") : null;

  const go = (next: AdminView, rep?: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "reps") params.delete("view");
    else params.set("view", next);
    if (rep) params.set("rep", rep);
    else params.delete("rep");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const [apps, setApps] = useState<MerchantApplication[]>([]);
  const [subs, setSubs] = useState<CustomerSubmission[]>([]);
  const [reps, setReps] = useState<RepSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      listApplicationsAction().then(setApps),
      listSubmissionsAction().then(setSubs),
      listRepsAction().then(setReps),
    ]).finally(() => setLoading(false));
  }, []);

  const metrics = {
    total: apps.length,
    proposals: apps.filter(a => PROPOSAL_STAGES.includes(a.stage)).length,
    onboarding: apps.filter(a => ONBOARDING_STAGES.includes(a.stage)).length,
    approved: apps.filter(a => a.stage === "adyen_approved").length,
    volume: apps.reduce((sum, a) => sum + (a.analysis?.totalVolume || 0), 0),
    savings: apps.reduce((sum, a) => sum + (a.proposal?.savings?.annual || 0), 0),
    leads: subs.length,
    // The tripwire: a HubSpot integration failure used to be visible only as
    // a console.error, so the deal sync stayed broken for the entire life of
    // the feature with nobody knowing. This is the number that would have
    // caught it on day one.
    hubspotSyncErrors: countHubspotSyncErrors(apps),
  };

  const repRows = reps
    .map(r => summarizeRep(r, apps))
    .sort((a, b) => b.volume - a.volume);

  const repCols = "1fr 90px 120px 100px 90px 110px";

  return (
    <div>
      <div className={styles.top}>
        <div className={styles.header}>
          <div className={styles.kicker}>Admin Console</div>
          <h1 className={styles.headerTitle}>Dashboard</h1>
          <p className={styles.headerSubtitle}>
            Org-wide pipeline across every rep, plus customer self-serve leads.
          </p>
        </div>

        <div className={styles.stats}>
          <div className={styles.statHero}>{fmt$(metrics.volume)}</div>
          <p className={styles.statCaption}>Total volume across the pipeline</p>
          <div className={styles.statTicker}>
            <span><b>{metrics.total}</b> Accounts</span>
            <span className={styles.statDot}>·</span>
            <span><b>{metrics.proposals}</b> Proposals Sent</span>
            <span className={styles.statDot}>·</span>
            <span><b>{metrics.onboarding}</b> In Onboarding</span>
            <span className={styles.statDot}>·</span>
            <span><b>{metrics.approved}</b> Approved</span>
            <span className={styles.statDot}>·</span>
            <span><b>{metrics.leads}</b> Leads</span>
            <span className={styles.statDot}>·</span>
            <span><b className={styles.statSuccess}>{fmt$(metrics.savings)}/yr</b> Projected Savings</span>
            <span className={styles.statDot}>·</span>
            {/* Always visible, not just when non-zero — a permanently-broken
                integration with no visible failure state is exactly how the
                original HubSpot deal sync went unnoticed for months. */}
            <span>
              <b style={{ color: metrics.hubspotSyncErrors > 0 ? "var(--danger)" : undefined }}>
                {metrics.hubspotSyncErrors}
              </b> HubSpot Sync Errors
            </span>
          </div>
        </div>

        {/* One surface, three views — only one table renders below, so the rep
            breakdown can grow without burying the accounts list. */}
        <div className={styles.tabsRow}>
          <div className={styles.tabs} data-active={view} role="tablist">
            {VIEW_TABS.map(t => (
              <button
                key={t.id}
                role="tab"
                aria-selected={view === t.id}
                className={styles.tab}
                onClick={() => go(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {view === "reps" && (
          <div className={styles.panel}>
            <div className={styles.tableHeader} style={{ gridTemplateColumns: repCols }}>
              {["Rep", "Accounts", "Volume", "Proposals", "Approved", "Savings/yr"].map(h => (
                <div key={h} className={styles.tableHeaderCell}>{h}</div>
              ))}
            </div>
            {!loading && repRows.length === 0 && (
              <div className={styles.emptyState}>No reps yet.</div>
            )}
            {repRows.map(r => (
              // Drills into this rep's accounts in the Accounts view.
              <Link
                key={r.id}
                href={`/admin?view=accounts&rep=${encodeURIComponent(r.id)}`}
                className={`${styles.tableRow} ${styles.repRow}`}
                style={{ gridTemplateColumns: repCols }}
              >
                <div className={styles.tableCell} data-label="Rep">
                  <div className={styles.repName}>{r.name || r.email}</div>
                  <div className={styles.repEmail}>{r.email}</div>
                </div>
                <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Accounts">{r.count}</div>
                <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Volume">{fmt$(r.volume)}</div>
                <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Proposals">{r.proposals}</div>
                <div className={`${styles.tableCell} ${styles.numeric}`} data-label="Approved">{r.approved}</div>
                <div className={`${styles.tableCell} ${styles.numeric} ${styles.success}`} data-label="Savings/yr">{fmt$(r.savings)}</div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {view !== "reps" && (
        <AccountsDashboard
          role="admin"
          userId={userId}
          embedded
          view={view}
          repFilter={repFilter}
          onClearRepFilter={() => go("accounts", null)}
        />
      )}
    </div>
  );
}
