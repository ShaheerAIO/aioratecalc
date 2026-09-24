"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  getActivePaddingPolicy, getMaxDiscountPercent, updateMaxDiscountPercentAction, updatePaddingPolicyAction,
} from "@/lib/actions/pricing";
import type { PaddingConfig } from "@/lib/pricing";
import styles from "./pillow.module.css";

export default function PaddingSettingsPage() {
  const [policy, setPolicy]   = useState<PaddingConfig | null>(null);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);

  // Saved separately from the padding: they share a row but not a concern, and
  // one Save button for two unrelated policies is how an admin changes a thing
  // they only meant to read.
  const [maxDiscount, setMaxDiscount] = useState<number | null>(null);
  const [savingDiscount, setSavingDiscount] = useState(false);
  const [savedDiscount, setSavedDiscount] = useState(false);
  const [discountError, setDiscountError] = useState<string | null>(null);

  useEffect(() => {
    getActivePaddingPolicy().then(setPolicy).catch(() => {});
    getMaxDiscountPercent().then(setMaxDiscount).catch(() => {});
  }, []);

  const saveDiscount = async () => {
    if (maxDiscount === null) return;
    setSavingDiscount(true);
    setDiscountError(null);
    try {
      await updateMaxDiscountPercentAction(maxDiscount);
      setSavedDiscount(true);
      setTimeout(() => setSavedDiscount(false), 2500);
    } catch (err) {
      setDiscountError(err instanceof Error ? err.message : "Could not save the discount cap");
    } finally {
      setSavingDiscount(false);
    }
  };

  const save = async () => {
    if (!policy) return;
    setSaving(true);
    await updatePaddingPolicyAction(policy);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  if (!policy) return <div className={styles.loading}>Loading…</div>;

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <Link href="/admin" className={styles.back}>← Back to Admin</Link>
        <div className={styles.header}>
          <h1 className={styles.headerTitle}>Margin Padding</h1>
          <p className={styles.headerSubtitle}>
            Controls the padding added to AIO&apos;s true minimum margin floor and true Adyen processing
            cost. Reps see a padded floor and (optionally) no exact cost figure at all — only admins see the
            real numbers.
          </p>
        </div>

        <div className={styles.panel}>
          <div className={styles.field}>
            <label className={styles.label}>Floor padding (% of AIO&apos;s true min margin — e.g. 50 shows reps a floor 1.5× the true min)</label>
            <input
              type="number" step="1" min="0" value={Math.round(policy.paddingPct * 100)}
              onChange={e => setPolicy(p => p && ({ ...p, paddingPct: Math.max(0, (parseFloat(e.target.value) || 0) / 100) }))}
              className={styles.input}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Floor padding (flat $ added to the true minimum MRR)</label>
            <input
              type="number" step="1" value={policy.paddingMinMrrAdd}
              onChange={e => setPolicy(p => p && ({ ...p, paddingMinMrrAdd: parseFloat(e.target.value) || 0 }))}
              className={styles.input}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox" checked={policy.paddingAdyenCostHide}
                onChange={e => setPolicy(p => p && ({ ...p, paddingAdyenCostHide: e.target.checked }))}
                className={styles.checkbox}
              />
              <span className={styles.checkboxText}>Hide the exact Adyen cost rate from reps entirely</span>
            </label>
          </div>
        </div>

        <button
          onClick={save} disabled={saving}
          data-saved={saved}
          className={styles.saveButton}
        >
          {saved ? "✓ Saved" : saving ? "Saving…" : "Save Padding"}
        </button>

        <div className={styles.header}>
          <h1 className={styles.headerTitle}>Quote Discount Cap</h1>
          <p className={styles.headerSubtitle}>
            The most a rep may discount a single quote line. Over it, the quote refuses to save and
            refuses to send — which matters because sending it puts it onto a HubSpot document
            that cannot afterwards be edited, deleted or voided, and that the merchant signs an
            ACH mandate against. Set 0 to turn discounting off entirely.
          </p>
        </div>

        <div className={styles.panel}>
          <div className={styles.field}>
            <label className={styles.label}>Maximum discount per line (%)</label>
            <input
              type="number" step="1" min="0" max="100"
              value={maxDiscount ?? ""}
              onChange={e => setMaxDiscount(Math.max(0, Math.min(100, Math.round(parseFloat(e.target.value) || 0))))}
              className={styles.input}
            />
          </div>
          {discountError && <p className={styles.headerSubtitle}>{discountError}</p>}
        </div>

        <button
          onClick={saveDiscount} disabled={savingDiscount || maxDiscount === null}
          data-saved={savedDiscount}
          className={styles.saveButton}
        >
          {savedDiscount ? "✓ Saved" : savingDiscount ? "Saving…" : "Save Discount Cap"}
        </button>
      </div>
    </div>
  );
}
