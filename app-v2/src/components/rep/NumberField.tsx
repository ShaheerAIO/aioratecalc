"use client";

import { useEffect, useState } from "react";

/**
 * Number inputs that look like the thing they hold, so a rep can see a typo
 * rather than having to notice one.
 *
 * Both exist for the same reason (product owner, 2026-10-09): a plain
 * `<input type="number">` shows whatever characters were typed. A rate reads
 * "2" or "2.5" or "20", a volume reads "10000" — and "10000" and "100000" are
 * the same shape at a glance, which is how a merchant gets quoted on a tenth
 * of their real volume.
 *
 * Both keep the half-typed text WHILE FOCUSED and reformat on blur. Formatting
 * on every keystroke fights the person typing: "2." loses its point, and a
 * cursor in the middle of a comma-grouped number jumps on each change.
 */

/** What the field shows when it isn't being typed in. */
function useEditable(formatted: string) {
  const [draft, setDraft] = useState<string | null>(null);
  // A value changed from outside — the AMEX lanes following V/MC/D, a
  // statement overwriting the volume — has to reach a field nobody is typing
  // in. One being edited keeps its draft; overwriting it mid-keystroke is the
  // bug this whole file exists to avoid, in the other direction.
  useEffect(() => { setDraft(null); }, [formatted]);
  return [draft, setDraft] as const;
}

export type DecimalFieldProps = {
  /** The value as a NUMBER, in the unit shown (2.49 for 2.49%, 0.15 for $0.15). */
  value: number;
  onChange: (next: number) => void;
  /** How many decimal places the field always shows. 2 everywhere today. */
  decimals?: number;
  min?: number;
  max?: number;
  className?: string;
  "aria-label": string;
};

/**
 * A fixed-decimal field: `_ _ . _ _`, always.
 *
 * On a card rate that is the whole point — "2.5" and "2.50" and "20" are three
 * different-looking things, and the one that is a tenfold error looks the most
 * normal of the three. Showing every rate as two decimals makes the magnitude
 * the first thing read, and it is the shape the merchant sees on their quote.
 *
 * `max` is a real guard rather than decoration: a card rate over it is a typo,
 * not a deal, and the clamp means the rep sees it corrected instead of
 * discovering it in a blocker.
 */
export function DecimalField({
  value, onChange, decimals = 2, min = 0, max, className, ...rest
}: DecimalFieldProps) {
  const formatted = Number.isFinite(value) ? value.toFixed(decimals) : (0).toFixed(decimals);
  const [draft, setDraft] = useEditable(formatted);

  const commit = (raw: string) => {
    const n = parseFloat(raw);
    const safe = Number.isFinite(n) ? n : 0;
    const clamped = Math.min(max ?? Infinity, Math.max(min, safe));
    // Rounded to the places shown, so what is stored is what is displayed.
    // Otherwise a pasted 2.4987 quotes at 2.4987 under a label reading 2.50.
    const rounded = Number(clamped.toFixed(decimals));
    setDraft(null);
    if (rounded !== value) onChange(rounded);
  };

  return (
    <input
      type="number"
      inputMode="decimal"
      step={1 / 10 ** decimals}
      min={min}
      max={max}
      className={className}
      value={draft ?? formatted}
      onChange={e => setDraft(e.target.value)}
      onBlur={e => commit(e.target.value)}
      onKeyDown={e => { if (e.key === "Enter") commit((e.target as HTMLInputElement).value); }}
      {...rest}
    />
  );
}

export type MoneyFieldProps = {
  /** Held as a STRING, because the host stores it as one (ProcessingInfo). */
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
};

/** Digits only — what we keep, and what the parent's string holds. */
function digitsOf(raw: string): string {
  return raw.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "");
}

/**
 * A whole-dollar field shown comma-grouped: `100,000`, never `100000`.
 *
 * `type="text"`, deliberately — a number input cannot display a comma, which
 * is the entire request. Non-digits are stripped on the way in, so pasting
 * "$1,250,000/mo" from a statement lands as 1250000, and the parent keeps
 * storing a plain numeric string.
 */
export function MoneyField({ value, onChange, placeholder, className, ...rest }: MoneyFieldProps) {
  const digits = digitsOf(value);
  const formatted = digits === "" ? "" : Number(digits).toLocaleString("en-US");
  const [draft, setDraft] = useEditable(formatted);

  return (
    <input
      type="text"
      inputMode="numeric"
      className={className}
      placeholder={placeholder}
      value={draft ?? formatted}
      onChange={e => {
        const next = digitsOf(e.target.value);
        // Grouped live, which is safe here in a way it isn't for a decimal:
        // there is no half-typed state to protect (no trailing point, no
        // partial fraction), and seeing the commas appear is what makes a
        // missing zero visible while it is still being typed.
        setDraft(next === "" ? "" : Number(next).toLocaleString("en-US"));
        if (next !== value) onChange(next);
      }}
      onBlur={() => setDraft(null)}
      {...rest}
    />
  );
}
