import Link from "next/link";
import { getMyApplicationAction } from "@/lib/actions/customer";
import FoodbuyOnboardStep from "@/components/customer/FoodbuyOnboardStep";
import styles from "../../../customer.module.css";

export default async function CustomerFoodbuyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const app = await getMyApplicationAction(id);

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

  // No redirect for a returning visitor — unlike Adyen/Check, the generated
  // PDF isn't a one-time/expiring link, so re-visiting this page to
  // regenerate or re-download it is the intended, repeatable path.

  // Foodbuy needs the business/contact details already on file. The
  // checklist hides the CTA in this case, but the URL is reachable.
  if (!app.business || !app.ownerContact) {
    return (
      <div className={styles.centered}>
        <div className={styles.centeredInner}>
          <h1 className={styles.centeredTitle}>Business Details Needed</h1>
          <p className={styles.centeredSubtitle}>
            Add your business details before setting up Foodbuy.
          </p>
          <Link href={`/customer/applications/${id}/edit`} className={styles.btnPrimary}>
            Add My Details
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <FoodbuyOnboardStep app={app} />
    </div>
  );
}
