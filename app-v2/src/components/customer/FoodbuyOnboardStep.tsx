"use client";

import { useEffect, useRef, useState } from "react";
import { markFoodbuyFormGeneratedAction } from "@/lib/actions/customer";
import { buildFoodbuyFormHtml } from "@/lib/foodbuyForm";
import type { MerchantApplication } from "@/types/merchant";
// Deliberately reuses CustomerOnboardStep's stylesheet — same customer-facing
// form design as the Adyen/payroll opt-in steps.
import styles from "./CustomerOnboardStep.module.css";

type Props = { app: MerchantApplication };

// Foodbuy has no API to onboard through (see lib/foodbuyForm.ts) — this opens
// a pre-filled copy of Foodbuy's own enrollment PDF in a new tab, using the
// same client-side html2pdf pattern ProposalStep.tsx uses for proposal PDFs.
// That document is EDITABLE: the customer fills the fields AIO doesn't hold
// (EIN, GPO affiliation, signature) in the tab and exports the PDF. The edits
// never come back here; only the exported PDF does, and pressing "Send to
// Foodbuy" emails that PDF to the Foodbuy rep set at /admin/users. Sending is
// a separate press on purpose: an export may be a draft.
const SEND_ERRORS: Record<string, string> = {
  not_configured: "Sending to Foodbuy isn't set up yet. Send the PDF you downloaded to your AIO representative instead.",
  too_large: "That PDF is too large to email. Send the PDF you downloaded to your AIO representative instead.",
};
export default function FoodbuyOnboardStep({ app }: Props) {
  const [generating, setGenerating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const alreadyGenerated = !!app.foodbuyIds?.generatedAt;
  const popupRef = useRef<Window | null>(null);
  // The latest export from the form tab, held until the customer sends it.
  const [exported, setExported] = useState<Blob | null>(null);
  const [sending, setSending] = useState(false);
  const [sentAt, setSentAt] = useState<string | null>(app.foodbuyIds?.sentAt ?? null);
  const [sentThis, setSentThis] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);

  // The form tab posts the exported PDF back here; file it on the merchant's
  // HubSpot Company. Best-effort and silent: the download already happened,
  // and a filing failure is nothing the customer can act on.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== popupRef.current) return;
      const data = e.data as { type?: string; blob?: unknown } | null;
      if (data?.type !== "aio-foodbuy-pdf" || !(data.blob instanceof Blob)) return;
      const body = new FormData();
      body.append("file", data.blob, "foodbuy.pdf");
      fetch(`/api/customer/applications/${encodeURIComponent(app.id)}/foodbuy`, { method: "POST", body }).catch(() => {});
      setExported(data.blob);
      setSentThis(false);
      setSendErr(null);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [app.id]);

  const handleGenerate = async () => {
    if (!app.business || !app.ownerContact) return;
    setGenerating(true);
    setErr(null);
    try {
      const html = buildFoodbuyFormHtml(app.business, app.ownerContact);
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      popupRef.current = window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      await markFoodbuyFormGeneratedAction(app.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not generate the Foodbuy enrollment form");
    } finally {
      setGenerating(false);
    }
  };

  const handleSend = async () => {
    if (!exported) return;
    setSending(true);
    setSendErr(null);
    try {
      const body = new FormData();
      body.append("file", exported, "foodbuy.pdf");
      const res = await fetch(`/api/customer/applications/${encodeURIComponent(app.id)}/foodbuy/send`, { method: "POST", body });
      const data = (await res.json().catch(() => null)) as { sent?: boolean; sentAt?: string; reason?: string } | null;
      if (data?.sent) {
        setSentAt(data.sentAt ?? new Date().toISOString());
        setSentThis(true);
      } else {
        setSendErr(SEND_ERRORS[data?.reason ?? ""] ?? "We couldn't send it just now. Please try again in a minute.");
      }
    } catch {
      setSendErr("We couldn't send it just now. Please try again in a minute.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={styles.page}>
      <h1 className={styles.pageTitle}>Set Up Foodbuy</h1>
      <p className={styles.pageSubtitle}>
        Foodbuy enrollment is a participation agreement you complete and sign yourself. We'll pre-fill
        what we already know about your business and open it for you to edit. Fill in the rest (your
        Federal ID #, GPO affiliation and signature), export it as a PDF, then come back here to send it
        to Foodbuy.
      </p>

      {err && <div className={styles.errorBanner}>{err}</div>}

      <div className={styles.actions} style={{ flexWrap: "wrap", marginBottom: "var(--space-md)" }}>
        <button
          className={exported ? styles.btnSecondary : styles.btnPrimary}
          disabled={generating}
          onClick={handleGenerate}
        >
          {generating ? "Preparing…" : alreadyGenerated ? "Open Form Again →" : "Open Enrollment Form →"}
        </button>
        {exported && !sentThis && (
          <button className={styles.btnPrimary} disabled={sending} onClick={handleSend}>
            {sending ? "Sending…" : "Send to Foodbuy →"}
          </button>
        )}
      </div>

      {sendErr && <div className={styles.errorBanner}>{sendErr}</div>}
      {exported && !sentThis && !sendErr && (
        <p className={styles.hint}>
          Your exported form is ready. Check it&apos;s complete and signed before sending.
        </p>
      )}
      {sentAt && (
        <p className={styles.hint}>
          {sentThis ? "Sent" : "Last sent"} to Foodbuy on {new Date(sentAt).toLocaleDateString()}. Their
          account executive will contact you directly.
          {!sentThis && " To send a corrected copy, open the form again and export it."}
        </p>
      )}
    </div>
  );
}
