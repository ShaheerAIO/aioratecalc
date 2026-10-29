"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getMaxDiscountPercent, getQuoteLimits, updateQuoteLimitsAction } from "@/lib/actions/pricing";
import { listQuotableProductsAction } from "@/lib/actions/catalog";
import {
  DEFAULT_MAX_DISCOUNT_PERCENT, DEFAULT_UNIT_CAPS, MAX_BILLING_DELAY_DAYS, type QuoteLimits,
} from "@/lib/quoting";
import type { CatalogProduct } from "@/types/merchant";
import styles from "./quote-limits.module.css";

/**
 * Everything an admin sets about what a rep may put on a quote without
 * asking: how many of each product, how far they may discount each one, how
 * long billing may be delayed, and whether the tablets are offered at all.
 *
 * Unit caps and discount caps are ONE table (2026-10-21): Product | Unit cap |
 * Max discount %. A blank discount box means "the fallback" — the stored
 * `margin_policy.maxDiscountPercent` (default 50), which no longer has an
 * editor of its own and is shown as the box's placeholder.
 *
 * The product list comes from the live catalog, so a cap is always set against
 * a product that exists and is named the way HubSpot names it today. A cap
 * SAVED against a product since retired is kept rather than dropped — it costs
 * nothing, and silently discarding policy because a catalog read failed is how
 * every cap disappears on a bad afternoon. Those rows are shown last under
 * their raw id.
 */
export default function QuoteLimitsSettingsPage() {
  const [limits, setLimits]   = useState<QuoteLimits | null>(null);
  // Read-only now: the fallback shown as the discount box's placeholder.
  const [maxDiscount, setMaxDiscount] = useState<number>(DEFAULT_MAX_DISCOUNT_PERCENT);
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);

  useEffect(() => {
    getQuoteLimits().then(setLimits).catch(() => setLoadError("Could not load the saved limits"));
    getMaxDiscountPercent().then(setMaxDiscount).catch(() => setLoadError("Could not load the discount cap"));
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
    const orphans = [...new Set([...Object.keys(limits?.unitCaps ?? {}), ...Object.keys(limits?.discountCaps ?? {})])]
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

  // Same interaction as setCap above — blank REMOVES the entry, which is how a
  // product falls back to the standing fallback cap rather than being capped
  // at 0%, the one discount a rep could never give.
  const setDiscountCap = (productId: string, raw: string) => {
    setLimits(prev => {
      if (!prev) return prev;
      const next = { ...prev.discountCaps };
      const n = raw.trim() === "" ? null : Math.floor(Number(raw));
      if (n === null || !Number.isFinite(n) || n < 0 || n > 100) delete next[productId];
      else next[productId] = n;
      return { ...prev, discountCaps: next };
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
  const discountCapped = Object.keys(limits.discountCaps).length;

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

        {/* Raising a ceiling IS the approval for going past it — deliberately
            not a request queue — so the delay ceiling sits above the long list. */}
        <div className={styles.panel}>
          <div className={styles.pair}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="delay">Maximum billing delay</label>
              <span className={styles.affix}>
                <input
                  id="delay"
                  type="number" step="1" min="1" max={MAX_BILLING_DELAY_DAYS}
                  className={styles.numInput}
                  value={limits.maxBillingDelayDays}
                  onChange={e =>
                    setLimits(prev => prev && ({ ...prev, maxBillingDelayDays: Math.floor(Number(e.target.value) || 0) }))
                  }
                />
                <span className={styles.unit}>days</span>
              </span>
              <p className={styles.hint}>
                The longest a rep may push a recurring line&apos;s first charge out. New All-in-One
                and Order &amp; Pay quotes start at 45 days. HubSpot itself refuses a start more
                than {MAX_BILLING_DELAY_DAYS} days out.
              </p>
            </div>
          </div>

          <label className={styles.toggleRow}>
            <input
              type="checkbox"
              checked={limits.showTablets}
              onChange={e => setLimits(prev => prev && ({ ...prev, showTablets: e.target.checked }))}
            />
            <span>
              Offer the Orders Hub and Clock-in tablets in the quote builder
              <span className={styles.toggleHint}>
                Visibility only — a tablet already on a quote stays on it either way, and no quote
                is ever refused over this.
              </span>
            </span>
          </label>
        </div>

        <div className={styles.header}>
          <h2 className={styles.sectionHead}>Unit caps and discount limits</h2>
          <p className={styles.headerSubtitle}>
            Per product. The unit cap is the most one quote may carry, counted across every line
            of it; leave it blank for no cap. The max discount is the most a rep may take off
            that product&apos;s line; leave it blank to use the standing {maxDiscount}%. Raising a
            limit here is how a bigger discount gets approved. The two comped services, anything a
            package already covers, and the plan line (which can never be discounted) are exempt.
            {" "}{capped} of {rows.length} have a unit cap and {discountCapped} have their own discount
            limit today.
          </p>
        </div>

        {loadError && <div className={styles.notice}>{loadError}</div>}

        <div className={styles.panel}>
          <table className={styles.limitsTable}>
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Unit cap</th>
                <th scope="col">Max discount %</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td>
                    <input
                      type="number" step="1" min="1"
                      className={styles.capInput}
                      value={limits.unitCaps[row.id] ?? ""}
                      placeholder="∞"
                      onChange={e => setCap(row.id, e.target.value)}
                      aria-label={`Maximum quantity of ${row.name} on one quote`}
                    />
                  </td>
                  <td>
                    <span className={styles.affix}>
                      <input
                        type="number" step="1" min="0" max="100"
                        className={styles.capInput}
                        value={limits.discountCaps[row.id] ?? ""}
                        placeholder={`${maxDiscount}`}
                        onChange={e => setDiscountCap(row.id, e.target.value)}
                        aria-label={`Maximum discount percent for ${row.name}`}
                      />
                      <span className={styles.unit}>%</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <p className={styles.headerSubtitle}>
              The catalog didn&apos;t load, so there are no products to list. Any limits already
              saved are still in force.
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
