import Link from "next/link";
import { redirect } from "next/navigation";
import { getLeadApplicationByToken } from "@/lib/leadToken";
import { rowToApp } from "@/lib/storage/applicationRow";
import { analysisFromQuoteConfig } from "@/lib/pricing";
import ConfirmDetailsForm from "@/components/customer/ConfirmDetailsForm";
import styles from "./confirm.module.css";
import leadStyles from "../lead.module.css";

// THE CONFIRMATION STEP — public and token-gated like the rest of
// /lead/[token], and since 2026-10-15 the thing that stands between a rep
// sending a lead link and a HubSpot quote existing at all.
//
// The rep's link-send no longer publishes anything (`publishAtSend` is gone
// from `createProspectAction`), because a published HubSpot quote cannot be
// edited, replaced or voided — so publishing before the merchant had checked
// anything froze a rep's typo of a billing contact or an address onto a
// document nobody could amend. The merchant confirms here, and THAT opens the
// door at /api/lead/[token]/checkout.
//
// The quote SUMMARY stays where it was, one route over at ../quote. This page
// is deliberately only the form: the merchant has already seen what they're
// buying, and repeating it here would bury the fields they're meant to be
// reading.
export default async function LeadConfirmPage({ params }: { params: Promise<{ token: string }> }) {
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

  // Already confirmed — there is nothing to do here and the details are frozen
  // along with the quote. Send them to the quote, which is where their
  // published document (or their accept button, on a rate-only quote) is.
  if (app.detailsConfirmedAt) redirect(`/lead/${token}/quote`);

  // The pricing basis, shown locked. Prefer the statement's own measured
  // figures over the rep's typed ones for exactly the reason
  // `buildCustomerSafeQuote` does: a real statement beats an estimate.
  const configAnalysis = app.analysis ?? (app.quoteConfig ? analysisFromQuoteConfig(app.quoteConfig, null) : null);
  const monthlyVolume = configAnalysis && configAnalysis.totalVolume > 0 ? configAnalysis.totalVolume : null;
  const avgTicket = configAnalysis && configAnalysis.averageTicket > 0 ? configAnalysis.averageTicket : null;

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <Link href={`/lead/${token}/quote`} className={styles.backLink}>← Back to your quote</Link>
        <ConfirmDetailsForm
          token={token}
          businessName={app.business?.dba || app.business?.legalName || null}
          monthlyVolume={monthlyVolume}
          avgTicket={avgTicket}
          initial={{
            business: app.business ?? {},
            ownerContact: app.ownerContact ?? {},
            billingContact: app.billingContact ?? null,
            processing: app.processing ?? {},
          }}
        />
      </div>
    </div>
  );
}
