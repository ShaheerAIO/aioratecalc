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
// (EIN, GPO affiliation) in the tab, exports the PDF, then signs and sends it
// on themselves. The edits never come back here — the tab is the only place
// they exist, so nothing is saved and nothing can be half-saved.
export default function FoodbuyOnboardStep({ app }: Props) {
  const [generating, setGenerating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const alreadyGenerated = !!app.foodbuyIds?.generatedAt;
  const popupRef = useRef<Window | null>(null);

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

  return (
    <div className={styles.page}>
      <h1 className={styles.pageTitle}>Set Up Foodbuy</h1>
      <p className={styles.pageSubtitle}>
        Foodbuy enrollment is a paper participation agreement, not something we can submit for you. We'll
        pre-fill what we already know about your business and open it for you to edit — fill in the rest
        (your Federal ID # and GPO affiliation), export it as a PDF, then sign it and send it to your AIO
        representative or Foodbuy account executive.
      </p>

      {err && <div className={styles.errorBanner}>{err}</div>}

      <button className={styles.btnPrimary} disabled={generating} onClick={handleGenerate}>
        {generating ? "Preparing…" : alreadyGenerated ? "Open Form Again →" : "Open Enrollment Form →"}
      </button>
    </div>
  );
}
