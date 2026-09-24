import { rowToApp } from "@/lib/storage/applicationRow";
import { getLeadApplicationByToken } from "@/lib/leadToken";
import { getOnboardingModules } from "@/lib/onboardingModules";
import { hasQuoteBasis } from "@/lib/leadQuote";
import { refreshLeadBilling } from "@/lib/billing/leadRefresh";
import OnboardingChecklistPanel from "@/components/customer/OnboardingChecklistPanel";
import styles from "./lead.module.css";
import shellStyles from "../../customer/customer.module.css";

// Public route — not matched by middleware.ts, no auth. The token itself
// (validated here, server-side) is the only gate. This is the checklist host:
// the statement upload/quote it used to open on lives at /lead/[token]/quote.
export default async function LeadPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const lookup = await getLeadApplicationByToken(token);

  if (!lookup.ok) {
    return (
      <div className={styles.centered}>
        <div className={styles.centeredInner}>
          <h1 className={styles.title}>{lookup.reason === "expired" ? "Link Expired" : "Invalid Link"}</h1>
          <p className={styles.subtitle}>Ask your AIO representative for a new link.</p>
        </div>
      </div>
    );
  }

  // The merchant signs and pays on HubSpot, which never sends them back here
  // — so viewing this page is one of only two moments we can notice they did.
  // Records the acceptance and emails their account link when it fires; a
  // no-op otherwise. See lib/billing/leadRefresh.ts.
  const app = await refreshLeadBilling(rowToApp(lookup.row));
  const businessName = app.business?.dba || app.business?.legalName || null;

  // basePath is THIS checklist route — every other module's href
  // (billing/adyen/payroll/foodbuy/edit) is irrelevant regardless of what it
  // resolves to under it: OnboardingChecklistPanel's signInHref override
  // replaces it whenever the module is unlocked, and the lock note replaces
  // it otherwise. quoteHref is separate (see OnboardingModulesOpts in
  // onboardingModules.ts) because this host, unlike the authenticated one,
  // has no tabs — the quote lives one level below, on its own route — so
  // "Review & Sign"/"View Quote" must point there directly rather than back
  // at this page.
  const basePath = `/lead/${token}`;
  const modules = getOnboardingModules(app, {
    basePath,
    quoteHref: `${basePath}/quote`,
    hasQuote: hasQuoteBasis(app),
  });

  return (
    <div className={shellStyles.shell}>
      <div className={shellStyles.container}>
        <h1 className={shellStyles.title}>{businessName || "Your Application"}</h1>
        <p className={shellStyles.subtitle}>Here&apos;s what&apos;s left to finish setting up your account.</p>
        <OnboardingChecklistPanel modules={modules} signInHref="/customer/login" />
      </div>
    </div>
  );
}
