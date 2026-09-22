import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications } from "@/lib/db/schema";
import { rowToApp } from "@/lib/storage/applicationRow";
import { getLeadApplicationByToken } from "@/lib/leadToken";
import { refreshDemoStatus } from "@/lib/demoSync";
import { getDealById, listMeetingsForDeal, listDemoMeetingsForCompany } from "@/lib/adapters/hubspot";
import { getOnboardingModules } from "@/lib/onboardingModules";
import { buildCustomerSafeQuote } from "@/lib/leadQuote";
import { isDemoHeld } from "@/lib/demo";
import { getSettingsAction } from "@/lib/actions/applications";
import OnboardingChecklistPanel from "@/components/customer/OnboardingChecklistPanel";
import type { DemoState, MerchantApplication } from "@/types/merchant";
import styles from "./lead.module.css";
import shellStyles from "../../customer/customer.module.css";

// Public route — not matched by middleware.ts, no auth. The token itself
// (validated here, server-side) is the only gate. This is now the checklist
// host: the statement upload/quote it used to open on moved down to
// /lead/[token]/quote. Demo booking has no route of its own here — the demo
// module's CTA is always the raw external booking URL (or none), same as
// the authenticated host.
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

  const { row } = lookup;
  let app = rowToApp(row);

  // Same TTL/terminal-heldAt/swallow-failures rules as the authenticated
  // dashboard (lib/demoSync.ts) — only the persistence differs: there's no
  // customer session to scope a write to, so this writes the row directly by
  // id, the same way the accept/analyze routes already do.
  app = await refreshDemoStatus(app, {
    // Thunked so a mocked-in-test hubspot module that doesn't stub these
    // isn't forced to, when the early-returns inside refreshDemoStatus mean
    // they're never actually invoked — see the identical note in
    // lib/actions/customer.ts.
    getDeal: dealId => getDealById(dealId),
    listDealMeetings: dealId => listMeetingsForDeal(dealId),
    listCompanyMeetings: companyId => listDemoMeetingsForCompany(companyId),
    persist: async (demo: DemoState): Promise<MerchantApplication> => {
      const [updated] = await db
        .update(merchantApplications)
        .set({ demo, updatedAt: new Date() })
        .where(eq(merchantApplications.id, row.id))
        .returning();
      return rowToApp(updated ?? { ...row, demo });
    },
  });

  const settings = await getSettingsAction();
  const businessName = app.business?.dba || app.business?.legalName || null;
  const demoHeld = isDemoHeld(app.demo);

  // THE DATA-LEAK BOUNDARY: buildCustomerSafeQuote (which pulls in
  // pricing.ts) is never even called before the demo is held — not called-
  // and-discarded, simply never called. A value that was computed and merely
  // not rendered would still sit in scope for a later edit to accidentally
  // forward to the client; not calling the function at all is what makes
  // that impossible rather than just avoided. Same rule enforced again,
  // independently, in /lead/[token]/quote (redirect) and both API routes
  // (409 demo_not_held).
  //
  // The quote object built here, when present, is used ONLY to derive the
  // `hasQuote` boolean below — it is never passed to a component or returned
  // from this function, so it never crosses to the client either way.
  const quote = demoHeld
    ? buildCustomerSafeQuote({
        quoteType: app.quoteType,
        analysis: app.analysis,
        quoteConfig: app.quoteConfig,
        targetMargin: app.targetMargin,
        pricingModel: app.pricingModel,
        quoteLines: app.quoteLines,
        orderPoints: app.orderPoints,
      })
    : null;

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
    hasQuote: quote !== null,
    demoBookingUrl: settings.demoBookingUrl,
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
