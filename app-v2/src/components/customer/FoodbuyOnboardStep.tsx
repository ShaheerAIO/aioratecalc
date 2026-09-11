"use client";

import { useState } from "react";
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
// The customer completes the remaining fields (EIN, GPO affiliation,
// signature) by hand and sends it on themselves.
export default function FoodbuyOnboardStep({ app }: Props) {
  const [generating, setGenerating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const alreadyGenerated = !!app.foodbuyIds?.generatedAt;

  const handleGenerate = async () => {
    if (!app.business || !app.ownerContact) return;
    setGenerating(true);
    setErr(null);
    try {
      const html = buildFoodbuyFormHtml(app.business, app.ownerContact);
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
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
        pre-fill what we already know about your business, and you'll complete the rest (your Federal ID #,
        GPO affiliation, and signature) and send it to your AIO representative or Foodbuy account executive.
      </p>

      {err && <div className={styles.errorBanner}>{err}</div>}

      <button className={styles.btnPrimary} disabled={generating} onClick={handleGenerate}>
        {generating ? "Preparing…" : alreadyGenerated ? "Download Again →" : "Download Enrollment Form →"}
      </button>
    </div>
  );
}
