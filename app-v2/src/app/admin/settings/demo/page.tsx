"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { getSettingsAction, updateDemoBookingUrlAction } from "@/lib/actions/applications";
import styles from "./demo.module.css";

export default function DemoBookingSettingsPage() {
  const [url, setUrl]         = useState<string | null | undefined>(undefined);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);

  useEffect(() => {
    getSettingsAction().then(s => setUrl(s.demoBookingUrl ?? null)).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    setSaveError("");
    try {
      const updated = await updateDemoBookingUrlAction(url?.trim() || null);
      setUrl(updated.demoBookingUrl ?? null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    setSaveError("");
    try {
      await updateDemoBookingUrlAction(null);
      setUrl(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not clear");
    } finally {
      setSaving(false);
    }
  };

  if (url === undefined) return <div className={styles.loading}>Loading…</div>;

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <Link href="/admin" className={styles.back}>← Back to Admin</Link>
        <div className={styles.header}>
          <h1 className={styles.headerTitle}>Demo Booking Link</h1>
          <p className={styles.headerSubtitle}>
            The org-wide calendar link every merchant&apos;s onboarding checklist points at. AIO&apos;s
            booking calendar is moving into HubSpot but isn&apos;t live yet, so this is a runtime-editable
            link rather than something wired into the code. While it&apos;s unset, the demo row on every
            customer&apos;s checklist shows no booking button, and reps mark demos held manually instead.
          </p>
        </div>

        {url === null && (
          <div className={styles.warning}>
            No demo booking link is set. Customers see no booking button on their checklist until one is
            added here.
          </div>
        )}

        <div className={styles.panel}>
          <div className={styles.field}>
            <label className={styles.label}>Demo booking URL</label>
            <input
              type="url" placeholder="https://meetings.hubspot.com/aio/demo"
              value={url ?? ""}
              onChange={e => setUrl(e.target.value)}
              className={styles.input}
            />
          </div>
        </div>

        <div className={styles.actions}>
          <button
            onClick={save} disabled={saving}
            data-saved={saved}
            className={styles.saveButton}
          >
            {saved ? "✓ Saved" : saving ? "Saving…" : "Save Link"}
          </button>
          <button
            onClick={clear} disabled={saving || !url}
            className={styles.clearButton}
          >
            Clear
          </button>
        </div>
        {saveError && <p className={styles.errorText}>{saveError}</p>}
      </div>
    </div>
  );
}
