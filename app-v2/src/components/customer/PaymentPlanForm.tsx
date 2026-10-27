"use client";

import { useState } from "react";
import { savePaymentPlanAction } from "@/lib/actions/leadPaymentPlan";
import { PAY_IN_FULL_DISCOUNT_PERCENT, type PaymentPlan } from "@/lib/paymentPlan";
import { fmt$ } from "@/lib/utils";
import styles from "./PaymentPlanForm.module.css";
import quoteStyles from "./LeadQuoteView.module.css";

type Props = {
  token: string;
  /** The one-time invoice total at list, and with the pay-in-full discount. */
  total: number;
  fullTotal: number;
  initial: PaymentPlan | null;
};

// The merchant's choice of how to pay the one-time invoice, saved before the
// confirmation step that publishes it. See lib/paymentPlan.ts.
export default function PaymentPlanForm({ token, total, fullTotal, initial }: Props) {
  const [plan, setPlan] = useState<PaymentPlan | null>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options: { value: PaymentPlan; title: string; detail: string }[] = [
    {
      value: "full",
      title: `Pay in full — save ${PAY_IN_FULL_DISCOUNT_PERCENT}%`,
      detail: `${fmt$(fullTotal)} charged to the payment method you set up when you sign. You save ${fmt$(total - fullTotal)}.`,
    },
    {
      value: "later",
      title: "Pay over time",
      detail: `${fmt$(total)}. Choose card, bank, or a pay-over-time option like Klarna or Affirm at checkout. You'll enter payment details then.`,
    },
  ];

  async function save() {
    if (!plan) return;
    setSaving(true);
    setError(null);
    try {
      const result = await savePaymentPlanAction(token, plan);
      if (!result.ok) {
        setError(result.formError);
        setSaving(false);
        return;
      }
      window.location.href = `/lead/${token}/confirm`;
    } catch {
      setError("Something went wrong. Please try again.");
      setSaving(false);
    }
  }

  return (
    <div>
      <div role="radiogroup" aria-label="Payment plan" className={styles.options}>
        {options.map(o => (
          <label key={o.value} className={`${styles.option} ${plan === o.value ? styles.selected : ""}`}>
            <input
              type="radio"
              name="paymentPlan"
              value={o.value}
              checked={plan === o.value}
              onChange={() => setPlan(o.value)}
            />
            <span>
              <span className={styles.optionTitle}>{o.title}</span>
              <span className={styles.optionDetail}>{o.detail}</span>
            </span>
          </label>
        ))}
      </div>
      <button onClick={save} disabled={!plan || saving} className={quoteStyles.acceptBtn}>
        {saving ? "Saving…" : "Continue"}
      </button>
      {error && <div className={quoteStyles.acceptError}>{error}</div>}
    </div>
  );
}
