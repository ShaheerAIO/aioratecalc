import Link from "next/link";
import { getLeadApplicationByToken } from "@/lib/leadToken";
import { rowToApp } from "@/lib/storage/applicationRow";
import { buildCustomerSafeQuote } from "@/lib/leadQuote";
import { refreshLeadBilling } from "@/lib/billing/leadRefresh";
import { hasSignedWithoutPaying } from "@/lib/onboardingModules";
import LeadUploadStep from "@/components/customer/LeadUploadStep";
import styles from "./quote.module.css";
import leadStyles from "../lead.module.css";

// The upload/quote step — the same content LeadUploadStep/LeadQuoteView once
// rendered directly at /lead/[token], one level down now that /lead/[token] is
// the checklist.
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

  // The same projection used on the checklist page and by
  // /api/lead/[token]/analyze.
  const preparedQuote = buildCustomerSafeQuote({
    quoteType: app.quoteType,
    analysis: app.analysis,
    quoteConfig: app.quoteConfig,
    targetMargin: app.targetMargin,
    pricingModel: app.pricingModel,
    quoteLines: app.quoteLines,
    orderPoints: app.orderPoints,
  });

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <Link href={`/lead/${token}`} className={styles.backLink}>← Back to checklist</Link>

        {/* Only shown for the plain-upload state — a prepared quote (or one the
            customer just generated) renders its own heading via LeadQuoteView,
            and duplicating a page-level title above it would be redundant. */}
        {!preparedQuote && (
          <>
            <h1 className={styles.title}>
              {businessName ? `Hi ${businessName}, upload your statement` : "Upload Your Statement"}
            </h1>
            <p className={styles.subtitle}>
              Upload a recent processing statement (PDF or image) and get an instant estimate of your savings with AIO.
            </p>
          </>
        )}

        <LeadUploadStep
          token={token}
          businessName={businessName}
          contactEmail={contactEmail}
          preparedQuote={preparedQuote}
          checkoutUrl={checkoutUrl}
          canAcceptHere={canAcceptHere}
          alreadyAccepted={!!app.quoteAcceptedAt}
          signedWithoutPaying={signedWithoutPaying}
        />
      </div>
    </div>
  );
}
