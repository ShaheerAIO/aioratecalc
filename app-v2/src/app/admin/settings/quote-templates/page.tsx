"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  getQuoteTemplatePolicy,
  updateQuoteTemplatePolicyAction,
  listQuoteTemplatesAction,
  type QuoteTemplatePolicy,
} from "@/lib/actions/quoteTemplates";
import type { QuoteTemplate } from "@/lib/adapters/hubspot";
import type { QuoteType } from "@/types/merchant";
import styles from "./quote-templates.module.css";

const QUOTE_TYPES: { type: QuoteType; label: string }[] = [
  { type: "full_pos", label: "Full POS" },
  { type: "food_truck", label: "Food Truck" },
  { type: "marketing_only", label: "Marketing Only" },
];

export default function QuoteTemplatesSettingsPage() {
  const [policy, setPolicy]       = useState<QuoteTemplatePolicy | null>(null);
  const [templates, setTemplates] = useState<QuoteTemplate[]>([]);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving]       = useState(false);
  const [saved, setSaved]         = useState(false);

  useEffect(() => {
    getQuoteTemplatePolicy().then(setPolicy).catch(() => {});
    listQuoteTemplatesAction().then(result => {
      setTemplates(result.templates);
      if (result.error) setLoadError(result.error);
    }).catch(() => {
      setLoadError("Could not load HubSpot quote templates");
    });
  }, []);

  const save = async () => {
    if (!policy) return;
    setSaving(true);
    setSaveError("");
    try {
      await updateQuoteTemplatePolicyAction(policy);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  if (!policy) return <div className={styles.loading}>Loading…</div>;

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <Link href="/admin" className={styles.back}>← Back to Admin</Link>
        <div className={styles.header}>
          <h1 className={styles.headerTitle}>Quote Templates</h1>
          <p className={styles.headerSubtitle}>
            Maps each EasyOB quote type to the HubSpot quote template it publishes against. Re-point
            these when AIO ships a new template version — no code change needed.
          </p>
        </div>

        {loadError && (
          <div className={styles.warning}>
            Couldn&apos;t reach HubSpot to load the template list ({loadError}). Showing the currently
            saved template ids — you can still view them, but re-selecting a different template
            isn&apos;t possible until HubSpot is reachable.
          </div>
        )}

        <div className={styles.panel}>
          {QUOTE_TYPES.map(({ type, label }) => (
            <div className={styles.field} key={type}>
              <label className={styles.label}>{label} quote template</label>
              <select
                className={styles.select}
                value={policy[type]}
                onChange={e => setPolicy(p => p && ({ ...p, [type]: e.target.value }))}
              >
                {/* If the saved id isn't in the live list (e.g. HubSpot unreachable,
                    or the template was deleted), still render it so the dropdown
                    doesn't silently show a different template than what's saved. */}
                {!templates.some(t => t.id === policy[type]) && (
                  <option value={policy[type]}>{policy[type]} (unknown)</option>
                )}
                {templates.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.name} — {t.id}{!t.active ? " (inactive)" : ""}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>

        <button
          onClick={save} disabled={saving}
          data-saved={saved}
          className={styles.saveButton}
        >
          {saved ? "✓ Saved" : saving ? "Saving…" : "Save Templates"}
        </button>
        {saveError && <p className={styles.errorText}>{saveError}</p>}
      </div>
    </div>
  );
}
