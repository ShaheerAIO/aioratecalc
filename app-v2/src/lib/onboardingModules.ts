import type { HubspotSubscriptionSnapshot, MerchantApplication } from "@/types/merchant";

export type ModuleStatus = "not_started" | "in_progress" | "complete" | "coming_soon";

export type OnboardingModule = {
  key: string;
  label: string;
  status: ModuleStatus;
  description: string;
  href?: string;
  ctaLabel?: string;
};

export function getOnboardingModules(app: MerchantApplication): OnboardingModule[] {
  // Billing first: it's the money step and the direct continuation of the
  // acceptance the customer just performed (PHASE-E-SPEC.md §7.1). Adyen and
  // payroll follow in the order a merchant actually uses them post-signup —
  // get paid, then get set up to pay staff. Foodbuy goes after those two.
  // scheduleDemoModule goes last: it's still a placeholder with no completion
  // signal, and both ModuleChecklist (suppresses its CTA) and the dashboard
  // count (src/app/customer/page.tsx:28 filters coming_soon out) already
  // treat it as non-actionable, so nothing is lost by putting it at the
  // bottom. foodbuyModule is NOT coming_soon anymore — see its comment.
  //
  // billingModule can return null (a rate-only accepted quote — see its
  // comment), so this list is variable-length. Every caller already maps
  // over whatever it gets, so filtering nulls out here is sufficient.
  return [billingModule(app), adyenModule(app), payrollModule(app), foodbuyModule(app), scheduleDemoModule(app)]
    .filter((m): m is OnboardingModule => m !== null);
}

// Billing is a pure function of the cached hubspotIds snapshot — see the
// payrollModule note below, which documents the same constraint for Check.
// getOnboardingModules is called in a loop over every application on the
// customer dashboard (src/app/customer/page.tsx:28) and the admin accounts
// dashboard (src/components/dashboard/AccountsDashboard.tsx:603); a network
// call here would fan out one HubSpot request per row.
//
// The status matrix below is PAYMENT-TEST-PLAN.md §1.5, NOT PHASE-E-SPEC.md
// §7.2 — the spec's matrix gates completion on the quote's hs_payment_status,
// but that field lags the customer's actual payment by a median of 5.7 days
// (ACH settlement batch), while the subscription HubSpot creates from
// checkout appears within 1–9 minutes. Gating on paymentStatus would tell a
// merchant who already paid to "Review & Pay" for most of a week, so
// completion is derived from the subscription instead.
function billingModule(app: MerchantApplication): OnboardingModule | null {
  const key = "billing";
  const label = "Billing";
  const notStarted = (): OnboardingModule => ({
    key,
    label,
    status: "not_started",
    description: "Your quote is being prepared. We'll email you when it's ready.",
  });

  const hubspotIds = app.hubspotIds;
  const noHubspotQuote = !hubspotIds || !hubspotIds.quoteId;
  const hasBillableLines = !!app.quoteLines && app.quoteLines.length > 0;

  // A rate-only quote (empty quoteLines — commit c65b4b1, "Skip the install
  // services on a rate-only quote") has nothing for HubSpot to bill: AIO's
  // margin on it comes out of Adyen settlement, not HubSpot billing, and the
  // catalog's processing products are $0 placeholders. So a HubSpot quote is
  // never built for this deal and hubspotIds.quoteId stays null FOREVER, not
  // just "for now." Once the deal is actually frozen (quoteAcceptedAt set)
  // with still no billable lines, there is nothing pending and nothing ever
  // will be — this is not the same as "not_started," where a quote really is
  // coming. OMIT the module entirely instead of showing a permanently-stuck
  // status: a checklist row promising a quote that's never coming is noise,
  // and leaving it out keeps the dashboard's "N of M complete" count honest.
  // Before quoteAcceptedAt, empty quoteLines just means the rep hasn't
  // configured the quote yet, so that case still falls through to the normal
  // not_started "being prepared" copy below — don't collapse the two.
  // Do NOT "fix" this back into a visible not_started row; that reintroduces
  // the permanent-false-promise bug this branch exists to prevent.
  if (app.quoteAcceptedAt && !hasBillableLines && noHubspotQuote) return null;

  // Repeats the noHubspotQuote condition rather than branching on the boolean
  // directly — TS can't narrow `hubspotIds` from a derived boolean, only from
  // a check on the value itself, and everything below needs that narrowing.
  if (!hubspotIds || !hubspotIds.quoteId) return notStarted();

  const { publishedAt, paymentStatus, subscriptions, subscriptionStatus } = hubspotIds;

  // A draft quote's link is never surfaced — same copy as "no quote yet",
  // because there's nothing actionable for the customer to do either way.
  if (!publishedAt) return notStarted();

  const subs: HubspotSubscriptionSnapshot[] = subscriptions ?? [];

  // Check the rolled-up "bad" subscription states BEFORE the "has a payment
  // method" complete-check below. subscriptionStatus is a worst-of rollup
  // (PAYMENT-TEST-PLAN.md §1.6: canceled > unpaid > past_due > paused >
  // expired > scheduled > active), so a subscription that is e.g. `canceled`
  // can still carry a non-null paymentMethod from when it was first
  // authorized. Checking these first stops a canceled/unpaid subscription
  // from ever reading as "complete" — the brief is explicit that this must
  // never happen. These are common (35 of 91 live subscriptions per the test
  // plan), so each gets its own copy rather than a generic fallback. None of
  // them gets an href: there's no self-serve recovery flow for any of these,
  // so the customer's only path forward is contacting their rep.
  if (subscriptionStatus === "canceled") {
    return {
      key, label, status: "in_progress",
      description: "Your billing was canceled. Contact your AIO representative to reactivate it.",
    };
  }
  if (subscriptionStatus === "unpaid") {
    return {
      key, label, status: "in_progress",
      description: "There's a problem with your last payment. Contact your AIO representative to update your billing details.",
    };
  }
  if (subscriptionStatus === "past_due") {
    return {
      key, label, status: "in_progress",
      description: "Your last payment is past due. We're retrying automatically — no action needed yet.",
    };
  }
  if (subscriptionStatus === "paused") {
    return {
      key, label, status: "in_progress",
      description: "Your billing is temporarily paused. Contact your AIO representative to resume it.",
    };
  }
  if (subscriptionStatus === "expired") {
    return {
      key, label, status: "in_progress",
      description: "Your billing subscription has expired. Contact your AIO representative.",
    };
  }

  if (subscriptionStatus === "active") {
    return { key, label, status: "complete", description: "Billing is active." };
  }

  // At least one subscription is authorized (non-null paymentMethod proves
  // the buyer completed checkout) and none of them are in one of the bad
  // states handled above or already fully active — this is the common
  // "just paid, first charge is scheduled" state.
  const authorized = subs.find(s => s.paymentMethod);
  if (authorized) {
    const firstCharge = authorized.billingStartDate
      ? ` Your first charge is scheduled for ${authorized.billingStartDate}.`
      : "";
    return { key, label, status: "complete", description: `Billing is set up.${firstCharge}` };
  }

  // A one-time-charge-only quote (no recurring lines) never produces a
  // subscription at all — PAID is the only completion signal it will ever get.
  if (paymentStatus === "PAID" && subs.length === 0) {
    return { key, label, status: "complete", description: "Your payment has been processed." };
  }

  // This means a quote published without payments enabled — a build defect,
  // not a customer state, so it's surfaced loudly here as well as shown
  // gently to the customer.
  if (paymentStatus === "PAYMENT_NOT_ENABLED") {
    console.error(`billingModule: application ${app.id} has a published quote with PAYMENT_NOT_ENABLED`);
    return {
      key, label, status: "in_progress",
      description: "We're finishing setting up your billing — no action needed.",
    };
  }

  if (subs.length === 0 && (paymentStatus === null || paymentStatus === "PENDING" || paymentStatus === "PROCESSING")) {
    return {
      key, label, status: "in_progress",
      description: "Review your quote and set up billing.",
      href: `/customer/applications/${app.id}/billing`,
      ctaLabel: "Review & Pay",
    };
  }

  // Defensive default: an unrecognised paymentStatus or subscription status
  // combination. Never crash, never silently read as complete.
  return {
    key, label, status: "in_progress",
    description: "We're syncing your billing status. Check back shortly.",
  };
}

function adyenModule(app: MerchantApplication): OnboardingModule {
  const editHref = `/customer/applications/${app.id}/edit`;

  if (app.stage === "adyen_kyc_complete" || app.stage === "adyen_approved") {
    return {
      key: "adyen",
      label: "Payment Processing (Adyen)",
      status: "complete",
      description: "Verification complete.",
    };
  }

  if (app.adyenOnboardingUrl) {
    return {
      key: "adyen",
      label: "Payment Processing (Adyen)",
      status: "in_progress",
      description: "Finish identity verification with our processing partner.",
      // NOT the stored adyenOnboardingUrl — Adyen links are single-use and
      // expire in minutes, so reusing a stored one fails at startup. This
      // route mints a fresh link on each click, then redirects to Adyen.
      href: `/customer/applications/${app.id}/continue`,
      ctaLabel: "Continue Verification",
    };
  }

  if (app.business && app.ownerContact && app.processing && app.agreement) {
    return {
      key: "adyen",
      label: "Payment Processing (Adyen)",
      status: "in_progress",
      description: "Your details were saved — onboarding link is being generated.",
      href: editHref,
      ctaLabel: "Review Details",
    };
  }

  return {
    key: "adyen",
    label: "Payment Processing (Adyen)",
    status: "not_started",
    description: "Tell us about your business to start verification.",
    href: editHref,
    ctaLabel: "Get Started",
  };
}

// Payroll is opt-in: unlike Adyen, nothing exists on Check's side until the
// customer starts this module themselves. Status reads the cached
// checkIds.onboardStatus snapshot rather than calling Check — the list and
// dashboard views render many applications at once (see syncPayrollStatusAction).
function payrollModule(app: MerchantApplication): OnboardingModule {
  const label = "Payroll (Check)";

  if (app.checkIds?.companyId) {
    if (app.checkIds.onboardStatus === "completed") {
      return {
        key: "payroll",
        label,
        status: "complete",
        description: "Payroll setup is complete.",
      };
    }
    return {
      key: "payroll",
      label,
      status: "in_progress",
      description: app.checkIds.onboardStatus === "blocking"
        ? "Payroll needs a few more details before you can run it."
        : "Finish setting up payroll with our payroll partner.",
      // NOT a stored link — Check onboard links are one-time use and expire
      // after 24h, so this route mints a fresh one per click (same rule as Adyen).
      href: `/customer/applications/${app.id}/payroll/continue`,
      ctaLabel: "Continue Payroll Setup",
    };
  }

  // Check needs the legal name, address, phone, and a contact email to create
  // the company, so payroll can't start before the business details exist.
  if (!app.business || !app.ownerContact) {
    return {
      key: "payroll",
      label,
      status: "not_started",
      description: "Add your business details first to set up payroll.",
    };
  }

  return {
    key: "payroll",
    label,
    status: "not_started",
    description: "Run payroll for your team through AIO.",
    href: `/customer/applications/${app.id}/payroll`,
    ctaLabel: "Set Up Payroll",
  };
}

// Shell only — the user's decision was to ship this row now and paste in the
// HubSpot Meetings link later, once one is chosen. No href yet on purpose:
// ModuleChecklist suppresses the CTA for coming_soon even when href is set
// (ModuleChecklist.tsx:30), so there's nothing to gain from setting one now.
// coming_soon is also filtered out of the dashboard's module count
// (src/app/customer/page.tsx:28), so this only ever renders on the
// application detail page, not on the applications list. Copy reads as
// "not yet available", not as a failure.
function scheduleDemoModule(app: MerchantApplication): OnboardingModule {
  return {
    key: "schedule_demo",
    label: "Schedule a Demo",
    status: "coming_soon",
    description: "Scheduling a demo isn't available yet. We'll let you know when it is.",
  };
}

// Foodbuy has no API — enrollment is a paper participation agreement that
// asks for the Federal ID #, a wet signature, and per-location distributor
// account numbers, none of which AIO collects (see lib/foodbuyForm.ts). So
// there's no remote status to poll, unlike payrollModule/adyenModule: this
// module just tracks whether the customer has generated their pre-filled
// copy of the form (foodbuyIds.generatedAt). The href stays available even
// once "complete" — re-downloading a static PDF is harmless, unlike
// re-serving an expired Adyen/Check link.
function foodbuyModule(app: MerchantApplication): OnboardingModule {
  const label = "Foodbuy";
  const href = `/customer/applications/${app.id}/foodbuy`;

  if (!app.business || !app.ownerContact) {
    return {
      key: "foodbuy",
      label,
      status: "not_started",
      description: "Add your business details first to set up Foodbuy.",
    };
  }

  if (app.foodbuyIds?.generatedAt) {
    return {
      key: "foodbuy",
      label,
      status: "complete",
      description: "You've downloaded your Foodbuy enrollment form. Sign it and send it to your AIO representative or Foodbuy account executive to finish enrolling.",
      href,
      ctaLabel: "Download Again",
    };
  }

  return {
    key: "foodbuy",
    label,
    status: "not_started",
    description: "Download your pre-filled Foodbuy enrollment form, sign it, and send it to your AIO representative or Foodbuy account executive.",
    href,
    ctaLabel: "Get Started",
  };
}
