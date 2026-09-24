import Link from "next/link";
import { getMyApplicationWithSyncAction, getMyQuoteAction } from "@/lib/actions/customer";
import { getOnboardingModules } from "@/lib/onboardingModules";
import { hasQuoteBasis } from "@/lib/leadQuote";
import ApplicationTabs from "@/components/customer/ApplicationTabs";
import styles from "../../customer.module.css";

export default async function CustomerApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Two on-view refreshes, run independently server-side. Neither partner sends
  // the customer back through AIO when they finish — Check's onboard links carry
  // no redirect-back URL at all, and HubSpot's checkout ends on HubSpot — so
  // viewing this page is the moment we re-read both. HubSpot's is the more
  // urgent of the two: the subscription that proves the customer paid appears
  // within minutes of checkout, while the quote's own PAID flag lags it by
  // ~6 days. Both no-op unless something is actually pending.
  const app = await getMyApplicationWithSyncAction(id);

  if (!app) {
    return (
      <div className={styles.centered}>
        <div className={styles.centeredInner}>
          <h1 className={styles.centeredTitle}>Application Not Found</h1>
          <p className={styles.centeredSubtitle}>This application doesn&apos;t exist or isn&apos;t linked to your account.</p>
        </div>
      </div>
    );
  }

  const modules = getOnboardingModules(app, { hasQuote: hasQuoteBasis(app) });
  // Built here, server-side: leadQuote.ts pulls in pricing.ts, so only the
  // finished CustomerSafeQuote may cross into the client tabs.
  const quote = await getMyQuoteAction(id);

  return (
    <div className={styles.shell}>
      <div className={styles.container}>
        <div className={styles.headerRow}>
          <h1 className={styles.title}>
            {app.business?.dba || app.business?.legalName || "Your Application"}
          </h1>
          <Link href="/customer/set-password" className={styles.accountLink}>Change password</Link>
        </div>
        <p className={styles.subtitle}>
          Here&apos;s what&apos;s left to finish setting up your account.
        </p>
        <ApplicationTabs app={app} modules={modules} quote={quote} />
      </div>
    </div>
  );
}
