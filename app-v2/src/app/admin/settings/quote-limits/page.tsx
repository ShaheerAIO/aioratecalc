"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  getMaxDiscountPercent, getMinRateMarginBps, getQuoteLimits,
  updateMaxDiscountPercentAction, updateMinRateMarginBpsAction, updateQuoteLimitsAction,
} from "@/lib/actions/pricing";
import { listQuotableProductsAction } from "@/lib/actions/catalog";
import {
  DEFAULT_MAX_DISCOUNT_PERCENT, DEFAULT_UNIT_CAPS, MAX_BILLING_DELAY_DAYS, type QuoteLimits,
} from "@/lib/quoting";
import type { CatalogProduct } from "@/types/merchant";
import styles from "./quote-limits.module.css";

/**
 * Everything an admin sets about what a rep may put on a quote without
 * asking: how many of each product, how long billing may be delayed, how far
 * they may discount, and whether the tablets are offered at all.
 *
 * The DISCOUNT CAP moved here on 2026-10-12 from /admin/settings/pillow, which
 * was deleted. It never belonged there — that page was about what a rep may
 * LEARN of AIO's margin, and this is about what they may GIVE AWAY of it,
 * which is the same question as the delay ceiling beside it. It is still
 * stored on `margin_policy` (one row, one accessor each); only its editor
 * moved.
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
  const [maxDiscount, setMaxDiscount] = useState<number>(DEFAULT_MAX_DISCOUNT_PERCENT);
  // The wholesale-plus-minimum rate floor (2026-10-15, product owner: "add
  // floor for rate (wholesale + minimum), editable in settings"). NULL means
  // the floor is OFF, which is the state it shipped in and the state a blank
  // box saves — see DEFAULT_MIN_RATE_MARGIN_BPS in pricing.ts for why off and
  // not 0 bps. Null here is also the pre-load placeholder; it mirrors that
  // default without importing pricing.ts (and the true MARGIN_REQS table it
  // carries) into this client bundle, and getMinRateMarginBps() overwrites it
  // the moment the real policy loads, same as maxDiscount above.
  const [minRateMarginBps, setMinRateMarginBps] = useState<number | null>(null);
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);

  useEffect(() => {
    getQuoteLimits().then(setLimits).catch(() => setLoadError("Could not load the saved limits"));
    getMaxDiscountPercent().then(setMaxDiscount).catch(() => setLoadError("Could not load the discount cap"));
    getMinRateMarginBps().then(setMinRateMarginBps).catch(() => setLoadError("Could not load the minimum rate margin"));
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

  // Per-product discount caps (2026-10-15, product owner: "make max discounts
  // per line item instead of a global"). Same interaction as setCap above —
  // blank REMOVES the entry, which is how a product falls back to the global
  // "Default discount cap" field rather than being capped at 0%, the one
  // discount a rep could never give even with the global at 50%.
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
      // Three rows, three writes. The discount cap goes first: it is the one a
      // rep is most likely waiting on, and if a later write fails the admin
      // has at least granted the thing they came here for.
      await updateMaxDiscountPercentAction(maxDiscount);
      await updateMinRateMarginBpsAction(minRateMarginBps);
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

        {/* The three policy numbers, side by side. Raising either ceiling IS
            the approval for going past it — deliberately not a request queue
            — so they belong together and above the long list. */}
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
                and Order &amp; Pay quotes start at 60 days. HubSpot itself refuses a start more
                than {MAX_BILLING_DELAY_DAYS} days out.
              </p>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="discount">Default discount cap</label>
              <span className={styles.affix}>
                <input
                  id="discount"
                  type="number" step="1" min="0" max="100"
                  className={styles.numInput}
                  value={maxDiscount}
                  onChange={e => setMaxDiscount(Math.floor(Number(e.target.value) || 0))}
                />
                <span className={styles.unit}>%</span>
              </span>
              <p className={styles.hint}>
                The most a rep may take off any line that has no cap of its own below (2026-10-15:
                discount caps moved per-product; this is now the FALLBACK, not the only limit).
                Raising this is how a bigger discount — giving a unit away, say — gets approved. The
                two comped services, anything a package already covers, and the plan line (which can
                never be discounted at all) are exempt and unaffected.
              </p>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="minRateMargin">Minimum rate margin</label>
              <span className={styles.affix}>
                <input
                  id="minRateMargin"
                  type="number" step="1" min="0" max="10000"
                  className={styles.numInput}
                  placeholder="Off"
                  value={minRateMarginBps ?? ""}
                  onChange={e => {
                    // Blank is how the floor is switched OFF — the same way a
                    // blank unit cap removes a cap, rather than meaning zero.
                    const raw = e.target.value.trim();
                    setMinRateMarginBps(raw === "" ? null : Math.max(0, Math.floor(Number(raw) || 0)));
                  }}
                />
                <span className={styles.unit}>bps</span>
              </span>
              <p className={styles.hint}>
                The least a quoted card-present rate may clear above AIO&apos;s wholesale cost for
                this merchant&apos;s average ticket (2026-10-15). Below it the quote refuses to save
                and refuses to send — not padded and not secret, so the refusal names the minimum
                rate itself. 100 basis points = 1.00%.
                {" "}<strong>Leave it blank and the floor is off</strong>, which is how it ships:
                the rate card is built on margin over interchange and the wholesale table is a
                different basis, and at 0 bps this would refuse 48 of the rate card&apos;s own 81
                cells — every ticket from $10 to $50 above $75K a month.
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
          <h2 className={styles.sectionHead}>Unit caps</h2>
          <p className={styles.headerSubtitle}>
            The most of each product one quote may carry, counted across every line of it.
            Leave a box blank to leave that product uncapped — the default for anything not listed
            here, and for any product added to HubSpot later. {capped} of {rows.length} are capped
            today.
          </p>
        </div>

        {loadError && <div className={styles.notice}>{loadError}</div>}

        <div className={styles.panel}>
          <div className={styles.capGrid}>
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
          </div>
          {rows.length === 0 && (
            <p className={styles.headerSubtitle}>
              The catalog didn&apos;t load, so there are no products to cap. Any caps already saved
              are still in force.
            </p>
          )}
        </div>

        {/* Per-product discount caps (2026-10-15, product owner: "make max
            discounts per line item instead of a global"). Same editor pattern
            as unit caps just above, placed directly beside it: a product
            absent here falls back to "Default discount cap" above, and the
            plan/platform line is never listed — it can't be discounted at
            all, whatever an admin sets here (see adjustmentBlockers). */}
        <div className={styles.header}>
          <h2 className={styles.sectionHead}>Discount caps</h2>
          <p className={styles.headerSubtitle}>
            The most a rep may discount a specific product, overriding the default cap above for
            that product only. Leave a box blank to use the default. {discountCapped} of {rows.length}{" "}
            have their own cap today.
          </p>
        </div>

        <div className={styles.panel}>
          <div className={styles.capGrid}>
            {rows.map(row => (
              <div key={row.id} className={styles.capRow}>
                <span className={styles.capName}>{row.name}</span>
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
              </div>
            ))}
          </div>
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
