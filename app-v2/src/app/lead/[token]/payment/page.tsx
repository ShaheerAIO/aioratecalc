import Link from "next/link";
import { redirect } from "next/navigation";
import { getLeadApplicationByToken } from "@/lib/leadToken";
import { rowToApp } from "@/lib/storage/applicationRow";
import { invoiceLinesFor } from "@/lib/billing/oneTimeInvoice";
import { invoiceTotalFor, requiresPaymentPlan } from "@/lib/paymentPlan";
import PaymentPlanForm from "@/components/customer/PaymentPlanForm";
import styles from "./payment.module.css";
import leadStyles from "../lead.module.css";

// HOW THE MERCHANT PAYS THE ONE-TIME INVOICE — between the quote preview and
// the confirmation step. Public and token-gated like the rest of /lead/[token].
//
// Skipped (straight to ../confirm) when there is no invoice to pay, which
// includes every rate-only quote. Skipped to the quote once confirmed: the
// choice is part of what the confirmation publishes.
export default async function LeadPaymentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const lookup = await getLeadApplicationByToken(token);

  if (!lookup.ok) {
    return (
      <div className={leadStyles.centered}>
        <div className={leadStyles.centeredInner}>
          <h1 className={leadStyles.title}>{lookup.reason === "expired" ? "Link Expired" : "Invalid Link"}</h1>
          <p className={leadStyles.subtitle}>Ask your AIO representative for a new link.</p>
        </div>
      </div>
    );
  }

  const app = rowToApp(lookup.row);
  if (app.detailsConfirmedAt) redirect(`/lead/${token}/quote`);
  if (!requiresPaymentPlan(app)) redirect(`/lead/${token}/confirm`);

  const { invoiceLines, total } = invoiceLinesFor(app);

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <Link href={`/lead/${token}/quote`} className={styles.backLink}>← Back to your quote</Link>
        <h1 className={styles.title}>How would you like to pay?</h1>
        <p className={styles.lede}>
          This covers your one-time charges. Your recurring subscription is unchanged.
        </p>
        <PaymentPlanForm
          token={token}
          total={total}
          fullTotal={invoiceTotalFor("full", invoiceLines)}
          initial={app.paymentPlan ?? null}
        />
      </div>
    </div>
  );
}
