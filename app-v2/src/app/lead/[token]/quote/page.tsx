import Link from "next/link";
import { getLeadApplicationByToken } from "@/lib/leadToken";
import { rowToApp } from "@/lib/storage/applicationRow";
import { buildCustomerSafeQuote } from "@/lib/leadQuote";
import { refreshLeadBilling } from "@/lib/billing/leadRefresh";
import { hasSignedWithoutPaying } from "@/lib/onboardingModules";
import LeadQuoteView from "@/components/customer/LeadQuoteView";
import styles from "./quote.module.css";
import leadStyles from "../lead.module.css";

// The customer's quote, one level below /lead/[token] (the checklist).
//
// THERE IS NO STATEMENT UPLOAD HERE ANY MORE (2026-10-13, product owner). This
// page used to open on a dropzone whenever buildCustomerSafeQuote came back
// null, on the theory that a customer with no quote could generate one by
// uploading their statement. In practice the state it actually fired in was a
// quote the rep HAD built — lines, HubSpot document, published checkout — on a
// merchant whose volume nobody had entered, so the merchant was asked for a
// statement instead of being shown the quote they came to sign. The quote is
// the rep's to build; this page only ever renders one.
export default async function LeadQuotePage({ params }: { params: Promise<{ token: string }> }) {
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

  const { row } = lookup;

  // This page is where the merchant lands coming BACK from HubSpot's hosted
  // quote — they signed, maybe paid, and nothing sent them anywhere else. So
  // re-read the billing snapshot before deciding what to show them, exactly as
  // the checklist does, or a merchant who just paid is offered the checkout
  // again and one who signed without paying is told nothing at all.
  const app = await refreshLeadBilling(rowToApp(row));
  const businessName = app.business?.dba || app.business?.legalName || null;
  const contactEmail = app.ownerContact?.email || null;

  // `publishedAt` is the one-way-door marker: null means no HubSpot document
  // exists yet, which is now the ORDINARY state rather than a wait — pressing
  // "Continue to Billing" is what creates and publishes it
  // (/api/lead/[token]/checkout). Same surfacing rule as the authenticated
  // /customer/applications/[id]/billing route: a draft's link is never shown,
  // because a draft has none.
  const checkoutUrl = app.hubspotIds?.publishedAt ? app.hubspotIds.quoteLink ?? null : null;
  // Signed but never finished checkout — the state the merchant is least
  // likely to understand on their own, so it gets its own panel.
  const signedWithoutPaying = hasSignedWithoutPaying(app.hubspotIds);
  // A rate-only quote builds no HubSpot quote at all, so there is no document
  // to sign — those merchants accept on this page instead. Everyone else must
  // not, or they'd be accepting twice. See /api/lead/[token]/accept.
  const canAcceptHere = (app.quoteLines?.length ?? 0) === 0;

  // The same projection the checklist page gates its quote row on.
  const preparedQuote = buildCustomerSafeQuote({
    quoteType: app.quoteType,
    analysis: app.analysis,
    quoteConfig: app.quoteConfig,
    quoteRates: app.quoteRates,
    targetMargin: app.targetMargin,
    pricingModel: app.pricingModel,
    quoteLines: app.quoteLines,
    orderPoints: app.orderPoints,
  });

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <Link href={`/lead/${token}`} className={styles.backLink}>← Back to checklist</Link>

        {/* Nothing priced on the application yet — no lines and no rate basis.
            There is no action the merchant can take from here, so this says so
            rather than offering one. It matches the checklist's own wording
            for the same state ("Your rep is preparing your quote"), which is
            where they came from. A prepared quote renders its own heading via
            LeadQuoteView, so the page-level title is only for this state. */}
        {preparedQuote ? (
          <LeadQuoteView
            token={token}
            quote={preparedQuote}
            businessName={businessName}
            contactEmail={contactEmail}
            checkoutUrl={checkoutUrl}
            canAcceptHere={canAcceptHere}
            alreadyAccepted={!!app.quoteAcceptedAt}
            signedWithoutPaying={signedWithoutPaying}
          />
        ) : (
          <>
            <h1 className={styles.title}>
              {businessName ? `Hi ${businessName}, your quote is on its way` : "Your Quote Is On Its Way"}
            </h1>
            <p className={styles.subtitle}>
              Your AIO representative is still putting your quote together. We&apos;ll let you know the
              moment it&apos;s ready to review.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
