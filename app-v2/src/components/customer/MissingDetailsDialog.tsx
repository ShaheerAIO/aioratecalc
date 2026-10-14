"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { saveLeadDetailsAction } from "@/lib/actions/leadDetails";
import type { MissingField } from "@/lib/leadDetails";
import styles from "./MissingDetailsDialog.module.css";

/**
 * The merchant's own repair of whatever is missing before AIO can create their
 * tenant — see lib/leadDetails.ts for why this exists and why it has to work
 * without an account.
 *
 * It asks for the missing fields and NOTHING else. The full onboarding form
 * (/customer/applications/[id]/edit) is ~20 boxes behind a login; a merchant
 * who has already paid should not have to find a password to type one phone
 * number, and must never be sent anywhere that could look like re-entering
 * payment details.
 *
 * A native `<dialog>` opened with `showModal()`, so the browser supplies the
 * focus trap, Escape-to-close, the inert background and `::backdrop`. The
 * `open` ATTRIBUTE is deliberately never set: an attribute-opened dialog is
 * non-modal and renders no backdrop, which is the usual way this ends up
 * looking broken.
 */
export default function MissingDetailsDialog({
  token, fields, open,
}: {
  token: string;
  fields: MissingField[];
  /** Server-decided: the page renders this only when the CTA asked for it. */
  open: boolean;
}) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>(
    () => Object.fromEntries(fields.map(f => [f.path, ""]))
  );
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  // Closing drops the ?fix= param, so a refresh doesn't reopen it. `replace`
  // rather than `push`: the dialog is not a place in the merchant's history.
  const close = () => router.replace(`/lead/${token}`);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFormError("");
    const result = await saveLeadDetailsAction(token, values);
    setSaving(false);
    if (result.ok) {
      setSaved(true);
      // The checklist row this came from is server-rendered, so it only changes
      // once the page re-reads the row.
      router.refresh();
      return;
    }
    if ("formError" in result) setFormError(result.formError);
    else setErrors(result.errors);
  };

  return (
    // `onClose` only: Escape fires `cancel` and THEN `close`, so handling both
    // would navigate twice for one keypress.
    <dialog ref={ref} className={styles.dialog} onClose={close} aria-labelledby="missing-details-title">
      <div className={styles.body}>
        {saved ? (
          <>
            <h2 id="missing-details-title" className={styles.title}>Thanks — that&apos;s everything</h2>
            <p className={styles.done}>
              We have what we need. Setting up your payment processing account starts automatically
              within the next few minutes — there&apos;s nothing else for you to do, and nothing to
              pay again.
            </p>
            <div className={styles.actions}>
              <button type="button" className={styles.btnPrimary} onClick={close}>Done</button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <h2 id="missing-details-title" className={styles.title}>A few missing details</h2>
            <p className={styles.subtitle}>
              We need these before we can set up your payment processing account. Your quote and
              billing are already done — none of this affects them, and you won&apos;t be asked to
              pay anything again.
            </p>

            {formError && <p className={styles.formError}>{formError}</p>}

            <div className={styles.fields}>
              {fields.map(f => {
                // The validator's message on a failed save, otherwise its
                // standing "what this is" message. Never our own copy.
                const message = errors[f.path] || "";
                return (
                  <label key={f.path} className={styles.field}>
                    <span className={styles.label}>{f.label}</span>
                    <input
                      className={`${styles.input} ${message ? styles.inputError : ""}`}
                      value={values[f.path] ?? ""}
                      placeholder={f.placeholder}
                      onChange={e => setValues(v => ({ ...v, [f.path]: e.target.value }))}
                      aria-invalid={message ? true : undefined}
                    />
                    {message && <p className={styles.fieldError}>{message}</p>}
                  </label>
                );
              })}
            </div>

            <div className={styles.actions}>
              <button type="button" className={styles.btnQuiet} onClick={close}>Cancel</button>
              <button type="submit" className={styles.btnPrimary} disabled={saving}>
                {saving ? "Saving…" : "Save Details"}
              </button>
            </div>
          </form>
        )}
      </div>
    </dialog>
  );
}
