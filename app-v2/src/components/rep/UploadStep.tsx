"use client";

import { useState, useRef } from "react";
import { prepareStatement, postStatement, type PreparedStatement } from "@/lib/statementUpload";
import styles from "./UploadStep.module.css";

type Props = {
  onAnalyzed: (analysis: Record<string, unknown>) => void;
};

type Phase = "idle" | "preparing" | "uploading" | "analyzing";

export default function UploadStep({ onAnalyzed }: Props) {
  const [file, setFile]         = useState<File | null>(null);
  const [prepared, setPrepared] = useState<PreparedStatement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [phase, setPhase]       = useState<Phase>("idle");
  const [uploadPct, setUploadPct] = useState(0);
  const [error, setError]       = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Downscaling takes real time, so a second pick can resolve before the first.
  // Only the newest one may write state, or the dropzone shows one file while
  // the payload holds another.
  const pickRef = useRef(0);

  const busy = phase !== "idle";

  // Prepared at pick time rather than on click, so the downscale happens while
  // the rep is still looking at the dropzone instead of adding to the wait
  // after they commit.
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
      const data = await postStatement<{ analysis: Record<string, unknown> }>(
        "/api/analyze",
        { fileData: prepared.data, mediaType: prepared.mediaType },
        { onProgress: setUploadPct, onUploadDone: () => setPhase("analyzing") }
      );
      onAnalyzed(data.analysis);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
    }
    setPhase("idle");
  };

  const dropzoneState = file ? "done" : dragOver ? "dragging" : undefined;

  const buttonLabel = () => {
    switch (phase) {
      case "preparing": return "Preparing…";
      // Hold at "Uploading" until the transfer actually completes — the jump to
      // "Reading" is driven by onUploadDone, not by a timer.
      case "uploading": return `Uploading statement… ${uploadPct}%`;
      case "analyzing": return "Reading your statement…";
      default:          return "Analyze Statement →";
    }
  };

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>Upload Merchant Statement</h1>
      <p className={styles.subtitle}>Upload a PDF or image of any merchant processing statement.</p>

      <div
        className={styles.dropzone}
        data-state={dropzoneState}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
        onClick={() => { if (!busy) fileRef.current?.click(); }}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,image/*"
          className={styles.fileInput}
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
        />
        {file ? (
          <>
            <div className={styles.dropzoneIcon} data-state="done">✓</div>
            <p className={styles.dropzoneTitle} data-state="done">{file.name}</p>
            <p className={styles.dropzoneSubtitle}>
              {phase === "preparing"
                ? "Optimizing…"
                : prepared
                  // Show the size actually being sent, which is the downscaled
                  // one for a phone photo.
                  ? `${(prepared.bytes / 1024).toFixed(1)} KB${prepared.bytes < file.size ? " (optimized)" : ""} · Click to replace`
                  : `${(file.size / 1024).toFixed(1)} KB · Click to replace`}
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

      <div className={styles.chips}>
        {["Stripe", "Square", "First Data", "TSYS", "Heartland", "Worldpay", "Chase Paymentech", "Elavon"].map(p => (
          <div key={p} className={styles.chip}>{p}</div>
        ))}
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
        {busy ? (
          <>
            <span className={`${styles.spinner} spin`} />
            {buttonLabel()}
          </>
        ) : buttonLabel()}
      </button>
    </div>
  );
}
