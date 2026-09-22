import Link from "next/link";
import { listMyApplicationsAction } from "@/lib/actions/customer";
import { getSettingsAction } from "@/lib/actions/applications";
import { getOnboardingModules } from "@/lib/onboardingModules";
import { hasQuoteBasis } from "@/lib/leadQuote";
import MyDataSection, { pickProfileApp } from "@/components/customer/MyDataSection";
import styles from "./customer.module.css";

export default async function CustomerDashboardPage() {
  const [apps, settings] = await Promise.all([listMyApplicationsAction(), getSettingsAction()]);

  return (
    <div className={styles.shell}>
      <div className={styles.container}>
        <div className={styles.headerRow}>
          <h1 className={styles.title}>Your Applications</h1>
          <Link href="/customer/set-password" className={styles.accountLink}>Change password</Link>
        </div>
        <p className={styles.subtitle}>
          Pick up where you left off, or continue onboarding with AIO.
        </p>

        {apps.length === 0 ? (
          <div className={styles.panel}>
            <div className={styles.emptyState}>No applications yet. Use the link your AIO representative sent you to get started.</div>
          </div>
        ) : (
          <div className={styles.panel}>
            {apps.map(app => {
              const modules = getOnboardingModules(app, {
                hasQuote: hasQuoteBasis(app),
                demoBookingUrl: settings.demoBookingUrl,
              });
              const complete = modules.filter(m => m.status === "complete").length;
              return (
                <Link key={app.id} href={`/customer/applications/${app.id}`} className={styles.appRow}>
                  <div>
                    <div className={styles.appName}>
                      {app.business?.dba || app.business?.legalName || "Your Business"}
                    </div>
                    <div className={styles.appProgress}>
                      {complete} of {modules.length} modules complete
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}

        <MyDataSection app={pickProfileApp(apps)} />
      </div>
    </div>
  );
}
