"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getQuoteLimits, updateQuoteLimitsAction } from "@/lib/actions/pricing";
import { listQuotableProductsAction } from "@/lib/actions/catalog";
import { DEFAULT_UNIT_CAPS, MAX_BILLING_DELAY_DAYS, type QuoteLimits } from "@/lib/quoting";
import type { CatalogProduct } from "@/types/merchant";
import styles from "./quote-limits.module.css";

/**
 * The two limits that aren't the discount cap: how many of each product a
 * quote may carry, and how long billing may be delayed before an admin has to
 * agree to it.
 *
 * The product list comes from the live catalog, so a cap is always set against
 * a product that exists and is named the way HubSpot names it today. A cap
 * SAVED against a product since retired is kept rather than dropped — it costs
 * nothing, and silently discarding policy because a catalog read failed is how
 * every cap disappears on a bad afternoon. Those rows are shown at the bottom
 * under their raw id.
 */
export default function QuoteLimitsSettingsPage() {
  const [limits, setLimits]   = useState<QuoteLimits | null>(null);
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);

  useEffect(() => {
    getQuoteLimits().then(setLimits).catch(() => setLoadError("Could not load the saved limits"));
    listQuotableProductsAction()
      .then(res => {
        setCatalog(res.all);
        if (res.error) setLoadError(res.error);
      })
      .catch(() => setLoadError("Could not load the product catalog"));
  }, []);

  // Catalog order, so the page reads like the picker a rep sees.
  const rows = useMemo(() => {
    const named = [...catalog]
      .sort((a, b) => a.name.trim().localeCompare(b.name.trim()))
      .map(p => ({ id: p.hubspotProductId, name: p.name.trim() }));
    const known = new Set(named.map(r => r.id));
    const orphans = Object.keys(limits?.unitCaps ?? {})
      .filter(id => !known.has(id))
      .map(id => ({ id, name: `Not in the catalog · ${id}` }));
    return [...named, ...orphans];
  }, [catalog, limits]);

  const setCap = (productId: string, raw: string) => {
    setLimits(prev => {
      if (!prev) return prev;
      const next = { ...prev.unitCaps };
      const n = raw.trim() === "" ? null : Math.floor(Number(raw));
      // Blank is how a cap is REMOVED, which is the only way to uncap a
      // product — a cap of 0 would refuse every quote carrying it, with a
      // blocker reading "a merchant can only have 0".
      if (n === null || !Number.isFinite(n) || n < 1) delete next[productId];
      else next[productId] = n;
      return { ...prev, unitCaps: next };
    });
  };

  const save = async () => {
    if (!limits) return;
    setSaving(true);
    setSaveError("");
    try {
      await updateQuoteLimitsAction(limits);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save the limits");
    } finally {
      setSaving(false);
    }
  };

  if (!limits) return <div className={styles.loading}>Loading…</div>;

  const capped = Object.keys(limits.unitCaps).length;

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <Link href="/admin" className={styles.back}>← Back to Admin</Link>

        <div className={styles.header}>
          <h1 className={styles.headerTitle}>Quote Limits</h1>
          <p className={styles.headerSubtitle}>
            What a rep may put on a quote without asking. Over either limit the quote refuses to
            save and refuses to send — which matters because sending it puts it onto a HubSpot
            document that cannot afterwards be edited, deleted or voided.
          </p>
        </div>

        <div className={styles.header}>
          <h2 className={styles.sectionHead}>Billing delay</h2>
          <p className={styles.headerSubtitle}>
            The longest a rep may push a recurring line&apos;s first charge out. Raising this IS the
            approval for a longer delay — there is no separate request queue. New All-in-One and
            Order &amp; Pay quotes start at 60 days and the rep can shorten or lengthen it up to this
            number. HubSpot itself will not accept a start more than {MAX_BILLING_DELAY_DAYS} days out.
          </p>
        </div>

        <div className={styles.panel}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="delay">Maximum billing delay (days)</label>
            <input
              id="delay"
              type="number" step="1" min="1" max={MAX_BILLING_DELAY_DAYS}
              className={styles.input}
              value={limits.maxBillingDelayDays}
              onChange={e =>
                setLimits(prev => prev && ({ ...prev, maxBillingDelayDays: Math.floor(Number(e.target.value) || 0) }))
              }
            />
          </div>
        </div>

        <div className={styles.header}>
          <h2 className={styles.sectionHead}>Unit caps</h2>
          <p className={styles.headerSubtitle}>
            The most of each product one quote may carry, counted across every line of it.
            Leave a box blank to leave that product uncapped — which is the default for anything
            not listed here, and for any product added to HubSpot later. {capped} of {rows.length}{" "}
            are capped today.
          </p>
        </div>

        {loadError && <div className={styles.notice}>{loadError}</div>}

        <div className={styles.panel}>
          {rows.map(row => (
            <div key={row.id} className={styles.capRow}>
              <span className={styles.capName}>{row.name}</span>
              <input
                type="number" step="1" min="1"
                className={styles.capInput}
                value={limits.unitCaps[row.id] ?? ""}
                placeholder="∞"
                onChange={e => setCap(row.id, e.target.value)}
                aria-label={`Maximum quantity of ${row.name} on one quote`}
              />
            </div>
          ))}
          {rows.length === 0 && (
            <p className={styles.headerSubtitle}>
              The catalog didn&apos;t load, so there are no products to cap. Any caps already saved
              are still in force.
            </p>
          )}
        </div>

        {saveError && <div className={styles.notice}>{saveError}</div>}

        <div className={styles.actions}>
          <button onClick={save} disabled={saving} data-saved={saved} className={styles.saveButton}>
            {saved ? "✓ Saved" : saving ? "Saving…" : "Save Limits"}
          </button>
          <button
            type="button"
            className={styles.resetButton}
            onClick={() => setLimits(prev => prev && ({ ...prev, unitCaps: { ...DEFAULT_UNIT_CAPS } }))}
          >
            Reset caps to AIO defaults
          </button>
        </div>
      </div>
    </div>
  );
}
