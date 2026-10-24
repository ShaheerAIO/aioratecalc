"use client";

import { useState } from "react";
import Link from "next/link";
import {
  createPayrollInvoiceAction,
  linkCheckCompanyAction,
  previewCheckUsageAction,
  searchHubspotCompaniesAction,
  type HubspotCompanyOption,
  type PayrollPreview,
  type PayrollRow,
} from "@/lib/actions/checkPayroll";
import { hubspotCompanyUrl } from "@/lib/billingView";
import styles from "./payroll-billing.module.css";

const HUBSPOT_PORTAL_ID = process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID;

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

type RunState = { busy: boolean; error?: string };

/**
 * Check payroll billing (2026-10-23). Outside EasyOB's own scope, so it sits
 * in the admin's name menu rather than the top rail. Upload Check's monthly
 * usage export; companies whose HubSpot record carries their Check id link
 * themselves, the rest an admin confirms once. Then create one DRAFT invoice
 * per company. Nothing is sent to a merchant from here.
 */
export default function PayrollBillingPage() {
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<PayrollPreview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [creatingAll, setCreatingAll] = useState(false);

  async function onFile(file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    setFileName(file.name);
    setCsvText(text);
    setPreview(null);
    setRuns({});
    setLoadError("");
    setLoading(true);
    try {
      const result = await previewCheckUsageAction(text);
      if ("error" in result) setLoadError(result.error);
      else setPreview(result);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function updateRow(checkCompanyId: string, patch: Partial<PayrollRow>) {
    setPreview(p => p && { ...p, rows: p.rows.map(r => r.checkCompanyId === checkCompanyId ? { ...r, ...patch } : r) });
  }

  async function createOne(row: PayrollRow) {
    setRuns(r => ({ ...r, [row.checkCompanyId]: { busy: true } }));
    try {
      const result = await createPayrollInvoiceAction(csvText, row.checkCompanyId);
      if (result.status === "failed") {
        setRuns(r => ({ ...r, [row.checkCompanyId]: { busy: false, error: result.error } }));
      } else {
        setRuns(r => ({ ...r, [row.checkCompanyId]: { busy: false } }));
        updateRow(row.checkCompanyId, { invoice: { invoiceId: result.invoiceId, invoiced: true, lastError: null } });
      }
    } catch (err) {
      setRuns(r => ({ ...r, [row.checkCompanyId]: { busy: false, error: err instanceof Error ? err.message : String(err) } }));
    }
  }

  const ready = preview?.rows.filter(isReady) ?? [];

  async function createAll() {
    setCreatingAll(true);
    for (const row of ready) await createOne(row);
    setCreatingAll(false);
  }

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <Link href="/admin" className={styles.back}>← Back to Admin</Link>

        <div className={styles.header}>
          <h1 className={styles.headerTitle}>Payroll Billing</h1>
          <p className={styles.headerSubtitle}>
            Upload Check&apos;s monthly usage summary (CSV). Each company gets one draft HubSpot invoice for
            its employees, addressed to the contact on its subscription. Companies with their Check company
            id in HubSpot (&ldquo;checkhq_company_id&rdquo;) link automatically. Drafts are not sent; review
            and send them from HubSpot.
          </p>
        </div>

        <div className={styles.panel}>
          <label className={styles.fileLabel}>
            <input
              type="file"
              accept=".csv,text/csv"
              className={styles.fileInput}
              onChange={e => onFile(e.target.files?.[0])}
              disabled={loading || creatingAll}
            />
            <span className={styles.fileButton}>{fileName ? "Choose another file" : "Choose CSV"}</span>
            {fileName && <span className={styles.fileName}>{fileName}</span>}
          </label>
        </div>

        {loading && <div className={styles.loading}>Reading the file and looking up HubSpot…</div>}
        {loadError && <div className={styles.notice}>{loadError}</div>}

        {preview && (
          <>
            <div className={styles.summary}>
              <strong>{preview.periodLabel}</strong>
              <span>{preview.rows.filter(r => r.employees > 0).length} companies with employees</span>
              <span>{money(preview.unitPrice)} per employee</span>
              <span>
                {money(preview.rows.reduce((n, r) => n + r.amount, 0))} total
              </span>
            </div>

            <div className={styles.panel}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Check company</th>
                    <th>Employees</th>
                    <th>Amount</th>
                    <th>HubSpot company</th>
                    <th>Bill to</th>
                    <th>Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map(row => (
                    <Row
                      key={row.checkCompanyId}
                      row={row}
                      run={runs[row.checkCompanyId]}
                      disabled={creatingAll}
                      onLinked={patch => updateRow(row.checkCompanyId, patch)}
                      onCreate={() => createOne(row)}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            <div className={styles.actions}>
              <button className={styles.primaryButton} onClick={createAll} disabled={creatingAll || ready.length === 0}>
                {creatingAll ? "Creating…" : `Create ${ready.length} draft invoice${ready.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function isReady(row: PayrollRow): boolean {
  return row.employees > 0 && !!row.link && !!row.billing && !row.invoice?.invoiced;
}

function Row({ row, run, disabled, onLinked, onCreate }: {
  row: PayrollRow;
  run: RunState | undefined;
  disabled: boolean;
  onLinked: (patch: Partial<PayrollRow>) => void;
  onCreate: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const muted = row.employees === 0;
  const companyUrl = row.link ? hubspotCompanyUrl(row.link.id, HUBSPOT_PORTAL_ID) : null;

  return (
    <tr className={muted ? styles.mutedRow : undefined}>
      <td>
        <div className={styles.name}>{row.checkCompanyName}</div>
        <div className={styles.sub}>{row.checkCompanyId}</div>
      </td>
      <td className={styles.num}>{row.employees}</td>
      <td className={styles.num}>{row.employees > 0 ? money(row.amount) : "—"}</td>
      <td>
        {row.link && !editing ? (
          <div>
            {companyUrl
              ? <a href={companyUrl} target="_blank" rel="noreferrer" className={styles.link}>{row.link.name}</a>
              : <span>{row.link.name}</span>}
            {!row.invoice?.invoiced && (
              <button className={styles.textButton} onClick={() => setEditing(true)} disabled={disabled}>Change</button>
            )}
          </div>
        ) : (
          <CompanyPicker
            row={row}
            disabled={disabled}
            onCancel={row.link ? () => setEditing(false) : undefined}
            onLinked={patch => { setEditing(false); onLinked(patch); }}
          />
        )}
      </td>
      <td>
        {row.billing ? (
          <div>
            <div>{row.billing.contactName}</div>
            {row.billing.contactEmail && <div className={styles.sub}>{row.billing.contactEmail}</div>}
            {row.billing.subscriptionStatus !== "active" && (
              <div className={styles.warn}>Subscription {row.billing.subscriptionStatus ?? "status unknown"}</div>
            )}
          </div>
        ) : row.billingError ? (
          <div className={styles.error}>{row.billingError}</div>
        ) : null}
      </td>
      <td>
        {row.invoice?.invoiced ? (
          // To the company, not the invoice: HubSpot's record URL for invoices
          // 404s, and the company sidebar lists its invoices.
          companyUrl
            ? <a href={companyUrl} target="_blank" rel="noreferrer" className={styles.link}>Draft {row.invoice.invoiceId}</a>
            : <span>Draft {row.invoice.invoiceId}</span>
        ) : muted ? (
          <span className={styles.sub}>Not billed</span>
        ) : (
          <>
            <button className={styles.smallButton} onClick={onCreate} disabled={disabled || run?.busy || !isReady(row)}>
              {run?.busy ? "Creating…" : row.invoice ? "Retry" : "Create"}
            </button>
            {(run?.error || row.invoice?.lastError) && (
              <div className={styles.error}>{run?.error ?? row.invoice?.lastError}</div>
            )}
          </>
        )}
      </td>
    </tr>
  );
}

function CompanyPicker({ row, disabled, onCancel, onLinked }: {
  row: PayrollRow;
  disabled: boolean;
  onCancel?: () => void;
  onLinked: (patch: Partial<PayrollRow>) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HubspotCompanyOption[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const options = results ?? row.suggestions;

  async function search() {
    if (query.trim().length < 2) return;
    setBusy(true);
    setError("");
    try {
      setResults(await searchHubspotCompaniesAction(query));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function pick(option: HubspotCompanyOption) {
    setBusy(true);
    setError("");
    try {
      const result = await linkCheckCompanyAction(row.checkCompanyId, row.checkCompanyName, option.id);
      if ("error" in result) setError(result.error);
      else onLinked({ link: result.link, billing: result.billing, billingError: result.billingError, suggestions: [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.picker}>
      {options.length > 0 ? (
        <div className={styles.options}>
          {results === null && <div className={styles.sub}>Suggested:</div>}
          {options.map(o => (
            <button key={o.id} className={styles.option} onClick={() => pick(o)} disabled={busy || disabled}>
              {o.name}
            </button>
          ))}
        </div>
      ) : (
        <div className={styles.sub}>{results === null ? "No suggestion — search HubSpot:" : "No matches."}</div>
      )}
      <form className={styles.searchRow} onSubmit={e => { e.preventDefault(); search(); }}>
        <input
          className={styles.searchInput}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search HubSpot companies"
          disabled={busy || disabled}
        />
        <button type="submit" className={styles.textButton} disabled={busy || disabled}>Search</button>
        {onCancel && <button type="button" className={styles.textButton} onClick={onCancel}>Cancel</button>}
      </form>
      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}
