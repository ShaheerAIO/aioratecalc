"use client";

import { useState, useRef } from "react";
import type { CustomerSafeQuote } from "@/types/merchant";
import { prepareStatement, postStatement, type PreparedStatement } from "@/lib/statementUpload";
import LeadQuoteView from "./LeadQuoteView";
import styles from "./LeadUploadStep.module.css";

// The public lead flow's client shell — reached at /lead/[token]/quote, which
// owns the page title/subtitle/back-to-checklist chrome. This component is
// pared to the dropzone + progress bar + the toggle between the upload form
// and LeadQuoteView; it doesn't render its own page shell.
//
// Two entries into the same destination: a quote the rep prepared arrives as
// `preparedQuote` and renders immediately, and a customer who has none
// uploads a statement to generate one. Both end on LeadQuoteView. The quote
// is always a CustomerSafeQuote — this component never sees the raw analysis.
type Props = {
  token: string;
  businessName: string | null;
  contactEmail: string | null;
  preparedQuote?: CustomerSafeQuote | null;
  /** HubSpot's hosted sign-and-pay page, once the rep has sent the quote. */
  checkoutUrl?: string | null;
  /** Rate-only quote — no HubSpot document, so acceptance happens in-app. */
  canAcceptHere?: boolean;
  alreadyAccepted?: boolean;
};

type Phase = "idle" | "preparing" | "uploading" | "analyzing";

export default function LeadUploadStep({
  token, businessName, contactEmail, preparedQuote = null,
  checkoutUrl = null, canAcceptHere = false, alreadyAccepted = false,
}: Props) {
  const [file, setFile]         = useState<File | null>(null);
  const [prepared, setPrepared] = useState<PreparedStatement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [phase, setPhase]       = useState<Phase>("idle");
  const [uploadPct, setUploadPct] = useState(0);
  const [error, setError]       = useState<string | null>(null);
  const [quote, setQuote]       = useState<CustomerSafeQuote | null>(preparedQuote);
  const fileRef = useRef<HTMLInputElement>(null);
  // Downscaling takes real time, so a second pick can resolve before the first.
  // Only the newest one may write state, or the dropzone shows one file while
  // the payload holds another.
  const pickRef = useRef(0);

  const busy = phase !== "idle";

  // Prepared as soon as the customer picks the file, so the downscale of a
  // phone photo overlaps with them reaching for the button instead of adding
  // to the wait after they tap it.
  const handleFile = async (f: File) => {
    const pick = ++pickRef.current;
    setFile(f);
    setPrepared(null);
    setError(null);
    setPhase("preparing");
    try {
      const ready = await prepareStatement(f);
      if (pick !== pickRef.current) return;
      setPrepared(ready);
    } catch (err) {
      if (pick !== pickRef.current) return;
      setError(err instanceof Error ? err.message : "Could not read that file");
      setFile(null);
    }
    setPhase("idle");
  };

  const analyze = async () => {
    if (!prepared) return;
    setError(null);
    setUploadPct(0);
    setPhase("uploading");
    try {
      const data = await postStatement<{ quote: CustomerSafeQuote }>(
        `/api/lead/${token}/analyze`,
        { fileData: prepared.data, mediaType: prepared.mediaType },
        { onProgress: setUploadPct, onUploadDone: () => setPhase("analyzing") }
      );
      setQuote(data.quote);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
    }
    setPhase("idle");
  };

  if (quote) {
    return (
      <LeadQuoteView
        token={token}
        quote={quote}
        businessName={businessName}
        contactEmail={contactEmail}
        checkoutUrl={checkoutUrl}
        canAcceptHere={canAcceptHere}
        alreadyAccepted={alreadyAccepted}
        // Offered only when the quote came prepared — a customer who just
        // uploaded a statement has nothing better to replace it with — and
        // never once the quote is accepted: the accepted quote's basis is
        // frozen server-side, so a re-upload would produce no new quote.
        onUploadStatement={
          !alreadyAccepted && preparedQuote && quote === preparedQuote ? () => setQuote(null) : undefined
        }
      />
    );
  }

  const dropzoneState = file ? "done" : dragOver ? "dragging" : undefined;

  const buttonLabel = () => {
    switch (phase) {
      case "preparing": return "Preparing…";
      case "uploading": return "Uploading your statement…";
      case "analyzing": return "Reading your statement…";
      default:          return "Get My Quote →";
    }
  };

  return (
    <div className={styles.formArea}>
      <div
        className={styles.dropzone}
        data-state={dropzoneState}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
        onClick={() => { if (!busy) fileRef.current?.click(); }}
      >
        <input ref={fileRef} type="file" accept=".pdf,image/*" className={styles.fileInput} onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
        {file ? (
          <>
            <div className={styles.dropzoneIcon} data-state="done">✓</div>
            <p className={styles.dropzoneTitle} data-state="done">{file.name}</p>
            <p className={styles.dropzoneSubtitle}>
              {phase === "preparing" ? "Optimizing…" : "Click to replace"}
            </p>
          </>
        ) : (
          <>
            <div className={styles.dropzoneIcon}>⬆</div>
            <p className={styles.dropzoneTitle}>Drop statement here or click to browse</p>
            <p className={styles.dropzoneSubtitle}>PDF or image · Any processor format</p>
          </>
        )}
      </div>

      {error && (
        <div className={styles.error}>
          {error}
        </div>
      )}

      <button
        className={styles.btnPrimary}
        disabled={!prepared || busy}
        onClick={analyze}
      >
        {buttonLabel()}
      </button>

      {/* Only the upload half is measurable. Once the bytes are gone the bar
          goes indeterminate rather than faking server-side progress. */}
      {(phase === "uploading" || phase === "analyzing") && (
        <>
          <div
            className={styles.progress}
            role="progressbar"
            aria-label="Analyzing your statement"
            {...(phase === "uploading"
              ? { "aria-valuenow": uploadPct, "aria-valuemin": 0, "aria-valuemax": 100 }
              : {})}
          >
            <div
              className={styles.progressBar}
              data-indeterminate={phase === "analyzing"}
              style={phase === "uploading" ? { width: `${uploadPct}%` } : undefined}
            />
          </div>
          <p className={styles.status} aria-live="polite">
            {phase === "uploading" ? `Uploading… ${uploadPct}%` : "Reading your statement…"}
          </p>
          {phase === "analyzing" && (
            <p className={styles.statusHint}>Pulling out your volume, fees, and effective rate.</p>
          )}
        </>
      )}

      {preparedQuote && (
        <button className={styles.btnGhostLink} onClick={() => setQuote(preparedQuote)}>
          ← Back to my quote
        </button>
      )}
    </div>
  );
}
