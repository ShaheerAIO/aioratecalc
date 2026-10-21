"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  getMarginReqsAdminAction, getRateMatrix, updateMarginReqsAction, updateRateMatrixAction,
} from "@/lib/actions/rateMatrix";
import type { MarginReqBps } from "@/lib/marginPolicy";
import {
  DEFAULT_RATE_MATRIX, RATE_MATRIX_TICKETS, TICKET_COLUMN_LABELS, VOLUME_BAND_LABELS,
  type RateMatrixPolicy,
} from "@/lib/rateMatrix";
import styles from "./rate-matrix.module.css";

/**
 * The rate card, shown the way the pricing guide prints it and editable cell
 * by cell. Deliberately the same grid rather than a list of fields: an admin
 * checks a rate by reading along its row and down its column, and a form that
 * broke the table apart would make the one check that matters impossible.
 *
 * Cells are typed as PERCENTAGES and stored as whole basis points — the same
 * conversion `RateFields` does on the rep side, and the only one here.
 */
const MARGIN_COLUMNS: [keyof MarginReqBps, string][] = [
  ["minBps", "Min margin"], ["desiredBps", "Desired margin"], ["maxBps", "Max margin"],
];

export default function RateMatrixSettingsPage() {
  const [matrix, setMatrix] = useState<RateMatrixPolicy | null>(null);
  // AIO's true min / desired / max margin per volume band (admin-only data,
  // fetched through an admin-gated action — never bundled into this page).
  const [margins, setMargins] = useState<MarginReqBps[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getRateMatrix().then(setMatrix).catch(() => setLoadError("Could not load the saved rate card"));
    getMarginReqsAdminAction().then(setMargins).catch(() => setLoadError("Could not load the margin table"));
  }, []);

  // A half-typed cell reads as 0, which the save refuses by name rather than
  // rounding into a rate nobody chose. Blank is the same: there is no such
  // thing as an empty cell on a rate card.
  const toBps = (raw: string) => Math.round((Number(raw) || 0) * 100);

  const setCell = (row: number, col: number, raw: string) =>
    setMatrix(prev => {
      if (!prev) return prev;
      const grid = prev.cardPresentBps.map(r => [...r]);
      grid[row][col] = toBps(raw);
      return { ...prev, cardPresentBps: grid };
    });

  const setMargin = (row: number, key: keyof MarginReqBps, raw: string) =>
    setMargins(prev => prev && prev.map((m, i) => (i === row ? { ...m, [key]: toBps(raw) } : m)));

  const save = async () => {
    if (!matrix || !margins) return;
    setSaving(true);
    setSaveError("");
    try {
      await updateRateMatrixAction(matrix);
      await updateMarginReqsAction(margins);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save the rate card");
    } finally {
      setSaving(false);
    }
  };

  if (!matrix || !margins) return <div className={styles.loading}>{loadError || "Loading…"}</div>;

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <Link href="/admin" className={styles.back}>← Back to Admin</Link>

        <div className={styles.header}>
          <h1 className={styles.headerTitle}>Rate Matrix</h1>
          <p className={styles.headerSubtitle}>
            The card-present rate a rep is offered, by the merchant&apos;s monthly volume and average
            ticket. It is a SUGGESTION — the rep can type over it, and every rate is still checked
            against AIO&apos;s margin floor before the quote can be sent. A merchant with no volume
            and no ticket on file is quoted the flat standard rate instead; there is nothing here
            to look one up with.
          </p>
        </div>

        {loadError && <div className={styles.notice}>{loadError}</div>}

        <div className={styles.panel}>
          <p className={styles.caption}>
                Card-present rate · each column covers the range in its header, so a $22
                ticket reads the $25 column ($20 – $24.99). The last three columns are AIO&apos;s
                margin over interchange for the volume band: the minimum is the floor a quote
                is refused below (reps only ever see a padded version), desired is the target, and
                max is the soft ceiling. Reset restores the rates only; margins keep their saved values.
          </p>
          <div className={styles.split}>
          <div className={styles.scroller}>
            <table className={styles.matrix}>
              <thead>
                <tr>
                  <th scope="col" className={styles.corner}>Volume \ Ticket</th>
                  {RATE_MATRIX_TICKETS.map((t, c) => (
                    <th key={t} scope="col" className={styles.colHead}>{TICKET_COLUMN_LABELS[c]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {VOLUME_BAND_LABELS.map((band, r) => (
                  <tr key={band}>
                    <th scope="row" className={styles.rowHead}>{band}</th>
                    {RATE_MATRIX_TICKETS.map((t, c) => (
                      <td key={t} className={styles.cell}>
                        <span className={styles.cellBox}>
                          <input
                            type="number" step="0.01" min="0.01" max="5"
                            className={styles.cellInput}
                            value={(matrix.cardPresentBps[r][c] / 100).toFixed(2)}
                            onChange={e => setCell(r, c, e.target.value)}
                            aria-label={`Card-present rate for ${band} a month at a ${TICKET_COLUMN_LABELS[c]} ticket, percent`}
                          />
                          <span aria-hidden="true">%</span>
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Its own card beside the grid: no band labels of its own, its rows are
              the same fixed height as the grid's so row N sits beside row N. */}
          <div className={styles.marginBubble}>
            <table className={styles.matrix}>
              <thead>
                <tr>
                  {MARGIN_COLUMNS.map(([key, label]) => (
                    <th key={key} scope="col" className={styles.colHead}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {VOLUME_BAND_LABELS.map((band, r) => (
                  <tr key={band}>
                    {MARGIN_COLUMNS.map(([key, label]) => (
                      <td key={key} className={styles.cell}>
                        <span className={styles.cellBox}>
                          <input
                            type="number" step="0.01" min="0" max="10"
                            className={styles.cellInput}
                            value={(margins[r][key] / 100).toFixed(2)}
                            onChange={e => setMargin(r, key, e.target.value)}
                            aria-label={`${label} for ${band} a month, percent`}
                          />
                          <span aria-hidden="true">%</span>
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </div>
        </div>

        <div className={styles.header}>
          <h2 className={styles.sectionHead}>Everything else on the card</h2>
          <p className={styles.headerSubtitle}>
            Card-not-present is one flat rate across every volume and every ticket. When online
            ordering gets a rate card of its own it takes the same shape as the grid above and this
            box goes away. The per-transaction fee is charged on top of the rate, not folded into
            it — the published card above is the $0.15 version, so changing the fee means changing
            the grid too.
          </p>
        </div>

        <div className={styles.panel}>
          <div className={styles.scalarRow}>
            <label className={styles.scalarLabel} htmlFor="cnp">Card-not-present rate</label>
            <span className={styles.cellBox}>
              <input
                id="cnp"
                type="number" step="0.01" min="0.01" max="5"
                className={styles.cellInput}
                value={(matrix.cardNotPresentBps / 100).toFixed(2)}
                onChange={e => setMatrix(prev => prev && ({ ...prev, cardNotPresentBps: toBps(e.target.value) }))}
              />
              <span aria-hidden="true">%</span>
            </span>
          </div>
          <div className={styles.scalarRow}>
            <label className={styles.scalarLabel} htmlFor="fee">Per-transaction fee</label>
            <span className={styles.cellBox}>
              <span aria-hidden="true">$</span>
              <input
                id="fee"
                type="number" step="0.01" min="0" max="5"
                className={styles.cellInput}
                value={(matrix.perTransactionFeeCents / 100).toFixed(2)}
                onChange={e =>
                  setMatrix(prev => prev && ({
                    ...prev,
                    perTransactionFeeCents: Math.round((Number(e.target.value) || 0) * 100),
                  }))
                }
              />
            </span>
          </div>
        </div>

        {saveError && <div className={styles.notice}>{saveError}</div>}

        <div className={styles.actions}>
          <button onClick={save} disabled={saving} data-saved={saved} className={styles.saveButton}>
            {saved ? "✓ Saved" : saving ? "Saving…" : "Save Rate Card"}
          </button>
          <button
            type="button"
            className={styles.resetButton}
            onClick={() => setMatrix({ ...DEFAULT_RATE_MATRIX, cardPresentBps: DEFAULT_RATE_MATRIX.cardPresentBps.map(r => [...r]) })}
          >
            Reset to the pricing guide
          </button>
        </div>
      </div>
    </div>
  );
}
