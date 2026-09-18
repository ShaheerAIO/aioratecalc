"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import {
  listStaffUsersAction,
  createUserAction,
  updateUserRoleAction,
  setUserDisabledAction,
  unlinkEntraAction,
  setBreakglassPasswordAction,
  clearBreakglassPasswordAction,
  type AdminUserSummary,
  type StaffRole,
} from "@/lib/actions/users";
import { listApplicationsAction, listRepsAction, type RepSummary } from "@/lib/actions/applications";
import { BILLING_STATE_LABELS, billingPanelState, hasBillingSyncError } from "@/lib/billingView";
import { fmt$ } from "@/lib/utils";
import { STAGE_COLORS } from "@/lib/stageColors";
import { PROPOSAL_STAGES } from "@/lib/stages";
import type { MerchantApplication } from "@/types/merchant";
import styles from "./users.module.css";

const STAFF_ROLES: StaffRole[] = ["rep", "admin"];
const EMPTY_FORM = { email: "", name: "", role: "rep" as StaffRole };

export default function AdminUsersPage() {
  const [tab, setTab]             = useState<"reps" | "customers">("reps");
  const [staff, setStaff]         = useState<AdminUserSummary[]>([]);
  const [apps, setApps]           = useState<MerchantApplication[]>([]);
  const [reps, setReps]           = useState<RepSummary[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState("");

  const [selectedRepId, setSelectedRepId] = useState<string | null>(null);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);

  const [form, setForm]           = useState(EMPTY_FORM);
  const [creating, setCreating]   = useState(false);
  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId]       = useState<string | null>(null);

  const refreshStaff = () => listStaffUsersAction().then(setStaff).catch(e => setError(e.message));

  useEffect(() => {
    Promise.all([
      listStaffUsersAction().then(setStaff),
      listApplicationsAction().then(setApps),
      listRepsAction().then(setReps),
    ]).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, []);

  const repMap = new Map(reps.map(r => [r.id, r]));
  const repLabel = (ownerUserId: string) => repMap.get(ownerUserId)?.name || repMap.get(ownerUserId)?.email || "—";

  const selectedRep = staff.find(u => u.id === selectedRepId) || null;
  const repClients = useMemo(
    () => (selectedRepId ? apps.filter(a => a.ownerUserId === selectedRepId) : []),
    [apps, selectedRepId]
  );
  const repStats = useMemo(() => ({
    count:     repClients.length,
    volume:    repClients.reduce((sum, a) => sum + (a.analysis?.totalVolume || 0), 0),
    savings:   repClients.reduce((sum, a) => sum + (a.proposal?.savings?.annual || 0), 0),
    approved:  repClients.filter(a => a.stage === "adyen_approved").length,
    proposals: repClients.filter(a => PROPOSAL_STAGES.includes(a.stage)).length,
  }), [repClients]);

  const selectedApp = apps.find(a => a.id === selectedAppId) || null;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setCreating(true);
    try {
      await createUserAction(form);
      setForm(EMPTY_FORM);
      await refreshStaff();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create user");
    } finally {
      setCreating(false);
    }
  };

  const handleRoleChange = async (id: string, role: StaffRole) => {
    setError("");
    setBusyId(id);
    try {
      const updated = await updateUserRoleAction(id, role);
      setStaff(us => us.map(u => (u.id === id ? updated : u)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update role");
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleDisabled = async (id: string, disabled: boolean) => {
    setError("");
    setBusyId(id);
    try {
      const updated = await setUserDisabledAction(id, disabled);
      setStaff(us => us.map(u => (u.id === id ? updated : u)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update user");
    } finally {
      setBusyId(null);
    }
  };

  const handleUnlinkEntra = async (id: string) => {
    setError("");
    setNotice("");
    setBusyId(id);
    try {
      const updated = await unlinkEntraAction(id);
      setStaff(us => us.map(u => (u.id === id ? updated : u)));
      setNotice("Unlinked. Their next Microsoft sign-in will re-link this account by email.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to unlink");
    } finally {
      setBusyId(null);
    }
  };

  const handleSetBreakglass = async (id: string) => {
    if (!resetPassword) return;
    setError("");
    setNotice("");
    setBusyId(id);
    try {
      await setBreakglassPasswordAction(id, resetPassword);
      setResetTarget(null);
      setResetPassword("");
      setNotice("Breakglass password set. It only works at /login/breakglass.");
      await refreshStaff();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to set breakglass password");
    } finally {
      setBusyId(null);
    }
  };

  const handleClearBreakglass = async (id: string) => {
    setError("");
    setNotice("");
    setBusyId(id);
    try {
      await clearBreakglassPasswordAction(id);
      setNotice("Password cleared. Microsoft sign-in is now the only way into this account.");
      await refreshStaff();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to clear password");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <Link href="/admin" className={styles.back}>← Back to Admin</Link>
        <div className={styles.header}>
          <h1 className={styles.headerTitle}>Users</h1>
          <p className={styles.headerSubtitle}>
            Reps and admins are managed directly here. Customers are the merchants tied to each
            application — browse those in the Customers tab.
          </p>
        </div>

        {error && <div className={styles.errorBanner}>{error}</div>}
        {notice && <div className={styles.noticeBanner}>{notice}</div>}

        <div className={styles.tabsRow}>
          <div className={styles.tabs} data-active={tab} role="tablist">
            <button role="tab" aria-selected={tab === "reps"} className={styles.tab} onClick={() => setTab("reps")}>
              Reps ({staff.length})
            </button>
            <button role="tab" aria-selected={tab === "customers"} className={styles.tab} onClick={() => setTab("customers")}>
              Customers ({apps.length})
            </button>
          </div>
        </div>

        {tab === "reps" && (
          <div className={styles.columns}>
            <div className={styles.listCol}>
              <form onSubmit={handleCreate} className={styles.panel}>
                <div className={styles.formGrid}>
                  <div className={styles.field}>
                    <label className={styles.label}>Name</label>
                    <input
                      type="text" required value={form.name}
                      onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                      className={styles.input}
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label}>Email</label>
                    <input
                      type="email" required value={form.email}
                      onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                      className={styles.input}
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label}>Role</label>
                    <select
                      value={form.role}
                      onChange={e => setForm(f => ({ ...f, role: e.target.value as StaffRole }))}
                      className={styles.input}
                    >
                      {STAFF_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                </div>
                <p className={styles.formHint}>
                  Use the person&apos;s Microsoft work account address. They sign in with
                  Microsoft; this row is what grants them access, and it links itself to
                  their account the first time they sign in.
                </p>
                <button type="submit" disabled={creating} className={styles.saveButton}>
                  {creating ? "Adding…" : "Add Rep / Admin"}
                </button>
              </form>

              <div className={styles.panel} style={{ padding: 0 }}>
                {loading && <div className={styles.emptyState}>Loading…</div>}
                {!loading && staff.length === 0 && <div className={styles.emptyState}>No reps or admins yet.</div>}
                {staff.map(u => (
                  <button
                    key={u.id}
                    onClick={() => setSelectedRepId(u.id === selectedRepId ? null : u.id)}
                    className={styles.repRow}
                    data-selected={u.id === selectedRepId}
                  >
                    <div>
                      <div className={styles.userName}>{u.name}</div>
                      <div className={styles.userEmail}>{u.email}</div>
                    </div>
                    <div className={styles.repRowMeta}>
                      <span className={styles.roleBadge} data-role={u.role}>{u.role}</span>
                      <span className={styles.badge} data-linked={!!u.entraLinkedAt}>
                        {u.entraLinkedAt ? "Microsoft linked" : "Not signed in yet"}
                      </span>
                      <span className={styles.badge} data-disabled={!!u.disabledAt}>
                        {u.disabledAt ? "Disabled" : "Active"}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className={styles.detailCol}>
              {!selectedRep && (
                <div className={styles.detailEmpty}>Select a rep to view their clients and account controls.</div>
              )}
              {selectedRep && (
                <div className={styles.detail}>
                  <div className={styles.detailHeader}>
                    <div>
                      <h2 className={styles.detailTitle}>{selectedRep.name}</h2>
                      <div className={styles.detailMeta}>{selectedRep.email}</div>
                    </div>
                    <button onClick={() => setSelectedRepId(null)} className={styles.btnGhost}>Close</button>
                  </div>

                  <div className={styles.manageRow}>
                    <div className={styles.field}>
                      <label className={styles.label}>Role</label>
                      <select
                        value={selectedRep.role}
                        disabled={busyId === selectedRep.id}
                        onChange={e => handleRoleChange(selectedRep.id, e.target.value as StaffRole)}
                        className={styles.roleSelect}
                      >
                        {STAFF_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </div>
                    <button
                      disabled={busyId === selectedRep.id}
                      onClick={() => handleToggleDisabled(selectedRep.id, !selectedRep.disabledAt)}
                      className={styles.btnGhost}
                      data-danger={!selectedRep.disabledAt}
                    >
                      {selectedRep.disabledAt ? "Enable account" : "Disable account"}
                    </button>
                    {selectedRep.entraLinkedAt && (
                      <button
                        disabled={busyId === selectedRep.id}
                        onClick={() => handleUnlinkEntra(selectedRep.id)}
                        className={styles.btnGhost}
                      >
                        Unlink Microsoft account
                      </button>
                    )}
                    {selectedRep.role === "admin" && (
                      <button
                        disabled={busyId === selectedRep.id}
                        onClick={() => setResetTarget(resetTarget === selectedRep.id ? null : selectedRep.id)}
                        className={styles.btnGhost}
                      >
                        {selectedRep.hasPassword ? "Change breakglass password" : "Set breakglass password"}
                      </button>
                    )}
                    {selectedRep.hasPassword && (
                      <button
                        disabled={busyId === selectedRep.id}
                        onClick={() => handleClearBreakglass(selectedRep.id)}
                        className={styles.btnGhost}
                        data-danger
                      >
                        Clear password
                      </button>
                    )}
                  </div>

                  <div className={styles.linkState}>
                    {selectedRep.entraLinkedAt
                      ? `Signs in with Microsoft — linked ${new Date(selectedRep.entraLinkedAt).toLocaleString()}.`
                      : "Not linked to a Microsoft account yet. It links itself on their first sign-in, matching on this email address."}
                    {selectedRep.hasPassword && selectedRep.role === "admin" &&
                      " Also has a breakglass password for /login/breakglass."}
                    {selectedRep.hasPassword && selectedRep.role === "rep" &&
                      " Still has a leftover password from before Microsoft sign-in — it no longer works anywhere, and can be cleared."}
                  </div>

                  {resetTarget === selectedRep.id && (
                    <div className={styles.resetRow}>
                      <input
                        type="text"
                        placeholder="Breakglass password (min 12 characters)"
                        value={resetPassword}
                        onChange={e => setResetPassword(e.target.value)}
                        className={styles.input}
                      />
                      <button
                        disabled={busyId === selectedRep.id || !resetPassword}
                        onClick={() => handleSetBreakglass(selectedRep.id)}
                        className={styles.saveButton}
                      >
                        Save
                      </button>
                      <button
                        onClick={() => { setResetTarget(null); setResetPassword(""); }}
                        className={styles.btnGhost}
                      >
                        Cancel
                      </button>
                    </div>
                  )}

                  <div className={styles.statTicker}>
                    <span><b>{repStats.count}</b> Clients</span>
                    <span className={styles.statDot}>·</span>
                    <span><b>{fmt$(repStats.volume)}</b> Volume</span>
                    <span className={styles.statDot}>·</span>
                    <span><b>{repStats.proposals}</b> Proposals</span>
                    <span className={styles.statDot}>·</span>
                    <span><b>{repStats.approved}</b> Approved</span>
                    <span className={styles.statDot}>·</span>
                    <span><b className={styles.statAccent}>{fmt$(repStats.savings)}/yr</b> Savings</span>
                  </div>

                  <div className={styles.clientList}>
                    {repClients.length === 0 && <div className={styles.emptyState}>No clients yet.</div>}
                    {repClients.map(a => (
                      <div key={a.id} className={styles.clientRow}>
                        <div className={styles.clientName}>
                          {a.business?.dba || a.business?.legalName || a.analysis?.merchantName || "—"}
                        </div>
                        <span className={styles.badge} style={{ background: `${STAGE_COLORS[a.stage] || "#64748b"}20`, color: STAGE_COLORS[a.stage] || "#64748b" }}>
                          {a.stage.replace(/_/g, " ")}
                        </span>
                        <div className={styles.clientVolume}>{a.analysis ? fmt$(a.analysis.totalVolume) : "—"}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "customers" && (
          <div className={styles.columns}>
            <div className={styles.listCol}>
              <div className={styles.panel} style={{ padding: 0 }}>
                {loading && <div className={styles.emptyState}>Loading…</div>}
                {!loading && apps.length === 0 && <div className={styles.emptyState}>No customers yet.</div>}
                {apps.map(a => (
                  <button
                    key={a.id}
                    onClick={() => setSelectedAppId(a.id === selectedAppId ? null : a.id)}
                    className={styles.repRow}
                    data-selected={a.id === selectedAppId}
                  >
                    <div>
                      <div className={styles.userName}>
                        {a.business?.dba || a.business?.legalName || a.analysis?.merchantName || "—"}
                      </div>
                      <div className={styles.userEmail}>{repLabel(a.ownerUserId)}</div>
                    </div>
                    <div className={styles.repRowMeta}>
                      <span className={styles.badge} style={{ background: `${STAGE_COLORS[a.stage] || "#64748b"}20`, color: STAGE_COLORS[a.stage] || "#64748b" }}>
                        {a.stage.replace(/_/g, " ")}
                      </span>
                      <span className={styles.clientVolume}>{a.analysis ? fmt$(a.analysis.totalVolume) : "—"}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className={styles.detailCol}>
              {!selectedApp && (
                <div className={styles.detailEmpty}>Select a customer to view their application detail.</div>
              )}
              {selectedApp && (
                <div className={styles.detail}>
                  <div className={styles.detailHeader}>
                    <div>
                      <h2 className={styles.detailTitle}>
                        {selectedApp.business?.legalName || selectedApp.analysis?.merchantName || "Application Detail"}
                      </h2>
                      <div className={styles.detailMeta}>
                        ID: {selectedApp.id} · Created {new Date(selectedApp.createdAt).toLocaleString()}
                      </div>
                    </div>
                    <button onClick={() => setSelectedAppId(null)} className={styles.btnGhost}>Close</button>
                  </div>
                  <div className={styles.detailGrid}>
                    {[
                      { label: "Stage", val: selectedApp.stage.replace(/_/g, " ") },
                      { label: "Rep", val: repLabel(selectedApp.ownerUserId) },
                      { label: "Volume", val: selectedApp.analysis ? fmt$(selectedApp.analysis.totalVolume) : "—" },
                      { label: "Fees", val: selectedApp.analysis ? fmt$(selectedApp.analysis.totalFees) : "—" },
                      { label: "Savings/yr", val: selectedApp.proposal ? fmt$(selectedApp.proposal.savings?.annual || 0) : "—" },
                      { label: "HubSpot Deal ID", val: selectedApp.hubspotDealId || "Not synced" },
                      { label: "HubSpot Quote", val: BILLING_STATE_LABELS[billingPanelState(selectedApp)] },
                      { label: "Payment Status", val: selectedApp.hubspotIds?.paymentStatus || "—" },
                      { label: "Subscription Status", val: selectedApp.hubspotIds?.subscriptionStatus || "—" },
                      {
                        label: "HubSpot Sync",
                        val: hasBillingSyncError(selectedApp.hubspotIds) ? "⚠ Error" : "OK",
                      },
                      { label: "Adyen Legal Entity", val: selectedApp.adyenIds?.legalEntityId || "Not created" },
                      { label: "Onboarding URL", val: selectedApp.adyenOnboardingUrl ? "Set" : "Not generated" },
                      { label: "Merchant Contact", val: selectedApp.ownerContact ? `${selectedApp.ownerContact.firstName} ${selectedApp.ownerContact.lastName}` : "—" },
                      { label: "Merchant Email", val: selectedApp.ownerContact?.email || "—" },
                    ].map(f => (
                      <div key={f.label}>
                        <div className={styles.detailFieldLabel}>{f.label}</div>
                        <div className={styles.detailFieldValue}>{f.val}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
