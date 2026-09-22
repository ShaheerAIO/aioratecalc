import Link from "next/link";
import { redirect } from "next/navigation";
import { getLeadApplicationByToken } from "@/lib/leadToken";
import { rowToApp } from "@/lib/storage/applicationRow";
import { buildCustomerSafeQuote } from "@/lib/leadQuote";
import { isDemoHeld } from "@/lib/demo";
import LeadUploadStep from "@/components/customer/LeadUploadStep";
import styles from "./quote.module.css";
import leadStyles from "../lead.module.css";

// The upload/quote step, reached only once the demo is held — same content
// LeadUploadStep/LeadQuoteView rendered directly at /lead/[token] before this
// task, moved down one level now that /lead/[token] is the checklist.
//
// The redirect below is the SECOND of three independent enforcement points for
// the demo gate (the checklist page never calls buildCustomerSafeQuote at all
// pre-demo; the two API routes refuse with 409 demo_not_held). This route is
// the one a customer could otherwise reach directly by URL even with a locked
// checklist row, so it re-checks rather than trusting that nobody linked here
// early.
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

  if (!isDemoHeld(row.demo)) {
    redirect(`/lead/${token}`);
  }

  const app = rowToApp(row);
  const businessName = app.business?.dba || app.business?.legalName || null;
  const contactEmail = app.ownerContact?.email || null;

  // Reachable now that the demo gate above has cleared — the same projection
  // used on the checklist page and by /api/lead/[token]/analyze.
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
          alreadyAccepted={!!app.quoteAcceptedAt}
        />
      </div>
    </div>
  );
}
