"use client";

import { useEffect, useState } from "react";

/**
 * Number inputs that look like the thing they hold, so a rep can see a typo
 * rather than having to notice one.
 *
 * `DecimalField` and `MoneyField` exist for the same reason (product owner,
 * 2026-10-09): a plain `<input type="number">` shows whatever characters were
 * typed. A rate reads "2" or "2.5" or "20", a volume reads "10000" — and
 * "10000" and "100000" are the same shape at a glance, which is how a
 * merchant gets quoted on a tenth of their real volume.
 *
 * As of 2026-10-13 ("make avg ticket writeable like volume... no arrows")
 * that discipline STOPS at Average Ticket specifically — it moved to
 * `DecimalMoneyField` below, free-typed like `MoneyField`. The reasoning still
 * holds for every RATE in the app (a rep typing a card rate can still turn
 * 2.49 into 20 by a stray keystroke, and that typo is exactly the one this
 * file exists to catch) and for monthly volume (same failure mode, an order
 * of magnitude off and no visual cue). It never actually fit the ticket size:
 * an average ticket is read, not typed against a floor or a typo risk the way
 * a rate is, and forcing it to re-snap to "0.00" on every blur meant a rep
 * could never actually clear the box to retype it — the exact bug this
 * component family was built to prevent, just pointed at the wrong field.
 *
 * Both `DecimalField` and `MoneyField` keep the half-typed text WHILE FOCUSED
 * and reformat on blur. Formatting on every keystroke fights the person
 * typing: "2." loses its point, and a cursor in the middle of a comma-grouped
 * number jumps on each change. `DecimalMoneyField` never reformats at all —
 * see its own doc comment for why that's fine for a ticket size and wouldn't
 * be for a rate.
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
  /** Read-only display — used for the locked card-not-present rate (RateFields.tsx,
   *  2026-10-13). `onChange` is still required by the type but never fires. */
  disabled?: boolean;
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

export type DecimalMoneyFieldProps = {
  /** Held as a STRING, same posture as MoneyField (ProcessingInfo.avgTicket is one). */
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
};

/**
 * A dollars-and-cents field, free-typed: "22", "22.5", "22.50", "" — whatever
 * is actually in the box, the same posture as `MoneyField` and deliberately
 * NOT `DecimalField`'s (2026-10-13, "make avg ticket writeable like volume...
 * no arrows").
 *
 * Average Ticket used to be a `DecimalField`, which made it a native
 * `type="number"` (spinner arrows a rep never wanted) that force-reformats to
 * two decimals ON BLUR — so clearing the box to retype a number always
 * snapped back to "0.00" before a keystroke could land. That discipline is
 * right for a RATE (see NumberField.tsx's top-of-file comment — a typo there
 * is a tenfold pricing mistake) and for Monthly Volume (`MoneyField`, same
 * file). It was never right for a ticket size: nothing downstream treats a
 * half-typed average ticket as dangerous the way it treats a half-typed rate,
 * so the only effect of forcing it through `DecimalField` was making the box
 * impossible to clear.
 *
 * `type="text"`, like `MoneyField` — a number input can't be emptied and
 * retyped from scratch without flashing back to a formatted value in between.
 * Unlike `MoneyField` this keeps a single decimal point rather than stripping
 * it, and does NOT comma-group (ticket sizes don't run into the thousands
 * where grouping would matter) and does NOT reformat on blur at all — the
 * box simply holds whatever was typed, same as `ProcessingInfo.avgTicket`'s
 * own storage shape.
 */
export function DecimalMoneyField({ value, onChange, placeholder, className, ...rest }: DecimalMoneyFieldProps) {
  const [draft, setDraft] = useEditable(value);

  return (
    <input
      type="text"
      inputMode="decimal"
      className={className}
      placeholder={placeholder}
      value={draft ?? value}
      onChange={e => {
        // Digits and at most one decimal point — pasting "$22.50" lands as
        // "22.50". A second "." typed after the first is dropped rather than
        // moving the cursor somewhere confusing.
        let next = e.target.value.replace(/[^\d.]/g, "");
        const firstDot = next.indexOf(".");
        if (firstDot !== -1) {
          next = next.slice(0, firstDot + 1) + next.slice(firstDot + 1).replace(/\./g, "");
        }
        setDraft(next);
        if (next !== value) onChange(next);
      }}
      onBlur={() => setDraft(null)}
      {...rest}
    />
  );
}
