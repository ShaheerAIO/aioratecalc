import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { canClaimLeadAccount } from "@/lib/leadAccount";
import { rowToApp } from "@/lib/storage/applicationRow";
import { getLeadApplicationByToken } from "@/lib/leadToken";
import { checklistNotice, getOnboardingModules } from "@/lib/onboardingModules";
import { canRepairFromLead, missingTenantFields } from "@/lib/leadDetails";
import { hasQuoteBasis } from "@/lib/leadQuote";
import { refreshLeadBilling, refreshLeadInvoice } from "@/lib/billing/leadRefresh";
import OnboardingChecklistPanel from "@/components/customer/OnboardingChecklistPanel";
import MissingDetailsDialog from "@/components/customer/MissingDetailsDialog";
import styles from "./lead.module.css";
import shellStyles from "../../customer/customer.module.css";

// Public route — not matched by middleware.ts, no auth. The token itself
// (validated here, server-side) is the only gate. This is the checklist host:
// the quote it used to open on lives at /lead/[token]/quote.
export default async function LeadPage({ params, searchParams }: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ fix?: string }>;
}) {
  const { token } = await params;
  const { fix } = await searchParams;
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
  const app = await refreshLeadInvoice(await refreshLeadBilling(rowToApp(lookup.row)));
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

  // The repair dialog is offered ONLY when it can finish the job — a row also
  // missing something it can't touch (a legal address) would otherwise get a
  // CTA that leaves it just as stuck. Those fall through to the default
  // `${basePath}/edit`, which this host's sign-in override then turns into the
  // account path, which is the honest answer for a repair this can't make.
  const repairable = canRepairFromLead(app);
  const missing = repairable ? missingTenantFields(app) : [];

  const modules = getOnboardingModules(app, {
    basePath,
    quoteHref: `${basePath}/quote`,
    // Opens the dialog below. A query param rather than a route because the
    // module model carries an href, not a callback, and because the merchant
    // should land back on their checklist with it open rather than on a page
    // of their own that they then have to navigate out of.
    detailsHref: repairable ? `${basePath}?fix=details` : undefined,
    // The authenticated host's `${basePath}/billing` redirect needs a session,
    // so this host sends a signed-but-unpaid merchant to its own quote route
    // instead — it serves the same hosted-quote link, publicly.
    billingHref: `${basePath}/quote`,
    hasQuote: hasQuoteBasis(app),
  });

  // The emailed account link is one-shot, and /customer/login can't help an
  // address with no account — so until a password exists, the post-payment
  // rows go to account creation instead of a sign-in screen.
  const customerUserId = lookup.row.customerUserId;
  const [linked] = customerUserId
    ? await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, customerUserId)).limit(1)
    : [];
  const needsAccount = canClaimLeadAccount(Boolean(app.quoteAcceptedAt), linked ?? null);

  return (
    <div className={shellStyles.shell}>
      <div className={shellStyles.container}>
        <h1 className={shellStyles.title}>{businessName || "Your Application"}</h1>
        <p className={shellStyles.subtitle}>Here&apos;s what&apos;s left to finish setting up your account.</p>
        <OnboardingChecklistPanel
          modules={modules}
          notice={checklistNotice(app, { billingHref: `${basePath}/quote` })}
          signInHref={needsAccount ? `${basePath}/account` : "/customer/login"}
          signInLabel={needsAccount ? "Create account to continue" : undefined}
        />
        {missing.length > 0 && (
          <MissingDetailsDialog token={token} fields={missing} open={fix === "details"} />
        )}
      </div>
    </div>
  );
}
