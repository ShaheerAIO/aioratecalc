import type { HubspotSubscriptionSnapshot, MerchantApplication } from "@/types/merchant";

export type ModuleStatus = "not_started" | "in_progress" | "complete";

export type OnboardingModule = {
  key: string;
  label: string;
  status: ModuleStatus;
  description: string;
  href?: string;
  ctaLabel?: string;
  // Whether the customer may act on this module yet — orthogonal to `status`,
  // which answers "how far along", not "may you start". Set only by the lock
  // post-pass at the bottom of this file, never by an individual module
  // function. Kept as its own field rather than folded into `status` (the
  // way the old `coming_soon` was) because the dashboard's "N of M complete"
  // count (src/app/customer/page.tsx) counts every module, locked included —
  // if locked modules were filtered out the way `coming_soon` was, the
  // denominator would *grow* as the customer progressed.
  locked?: { reason: "demo" | "quote"; message: string };
};

export type OnboardingModulesOpts = {
  // Defaults to `/customer/applications/${app.id}` so the two existing
  // authenticated call sites are unchanged; a token-scoped host (a later
  // task) will pass a different path.
  basePath?: string;
  // Where the quote module's own CTA points. Defaults to `basePath` — on the
  // authenticated host the quote is a TAB on the application page, so its
  // href really is just basePath, and that host's call sites need no edit.
  // The token host has no tabs: its quote lives on its own route one level
  // below the checklist, so it must pass a DIFFERENT quoteHref
  // (`/lead/{token}/quote`) than its basePath (`/lead/{token}`). Without this
  // split, quoteModule used to reuse `basePath` itself, which forced the
  // token host to set basePath to the quote route just to make that one
  // module work — making every OTHER module's `${basePath}/...` href resolve
  // to a nonexistent nested route (`/lead/{token}/quote/billing`, etc). Don't
  // collapse this back into `basePath`.
  quoteHref?: string;
  // Whether there's a quote ready to show (a rep-configured basis or a
  // readable statement). MUST be computed by the caller via `hasQuoteBasis`
  // in leadQuote.ts, never here — that module imports pricing.ts, and
  // pulling it into this file would ship MARGIN_REQS, AIO's true margin
  // floors, into the browser bundle. Defaults to false.
  hasQuote?: boolean;
  // The org-wide demo-booking link (AppSettings.demoBookingUrl) — admin-
  // editable since AIO's HubSpot calendar isn't live yet. Absent/null means
  // no CTA and no href are rendered for the demo module — never a dead
  // button; the rep's manual "mark held" override works regardless of
  // whether this is set.
  demoBookingUrl?: string | null;
  // Injected so tests can pin a clock — the registry is now time-dependent
  // (a demo can be booked for a future date). Defaults to Date.now().
  now?: number;
};

// Order: demo → quote → everything else. The quote is signed after the demo
// in real life, so `schedule_demo` — previously a `coming_soon` placeholder
// at the bottom of this list — is now a real gate at the top: the quote
// module is locked until the demo is held, and billing/adyen/payroll/foodbuy
// are all locked until the quote is signed (see `applyLock` below). Within
// that back half, the order is still the one a merchant actually uses them
// in post-signup: get paid (billing, then Adyen), then get set up to pay
// staff (payroll), then Foodbuy.
//
// demoModule/quoteModule are pure, reading only the cached `app.demo` /
// `app.quoteAcceptedAt` — same constraint billingModule/payrollModule below
// already document: getOnboardingModules runs in a loop over every row on
// both the customer dashboard (src/app/customer/page.tsx) and the admin
// accounts dashboard (AccountsDashboard.tsx), so a network call here would
// fan out one request per row. This file imports only types — keep it that
// way.
//
// billingModule can return null (a rate-only accepted quote — see its
// comment), so the list below is variable-length before the lock pass runs.
export function getOnboardingModules(
  app: MerchantApplication,
  opts?: OnboardingModulesOpts,
): OnboardingModule[] {
  const basePath = opts?.basePath ?? `/customer/applications/${app.id}`;
  const quoteHref = opts?.quoteHref ?? basePath;
  const now = opts?.now ?? Date.now();
  const demoHeld = !!app.demo?.heldAt;
  const quoteAccepted = !!app.quoteAcceptedAt;

  // Forced false until the demo is held, regardless of what the caller
  // passed in. This is what makes "the locked quote row never reveals
  // whether a quote exists" structural rather than a copy choice: quoteModule
  // is simply never TOLD a quote exists before the gate that's supposed to
  // withhold it has actually opened, so there is no description branch left
  // for a future edit to leak by accident.
  const hasQuote = demoHeld && (opts?.hasQuote ?? false);

  const modules = [
    demoModule(app, { demoBookingUrl: opts?.demoBookingUrl ?? null, now }),
    quoteModule(app, { hasQuote, quoteHref }),
    billingModule(app, basePath),
    adyenModule(app, basePath),
    payrollModule(app, basePath),
    foodbuyModule(app, basePath),
  ].filter((m): m is OnboardingModule => m !== null);

  return modules.map(m => applyLock(m, { demoHeld, quoteAccepted }));
}

// The one lock rule, applied once over the built list rather than scattered
// through the module functions above, so each one stays about its own
// domain:
//   - demo is never locked.
//   - quote is locked until the demo is held.
//   - everything else is locked until the quote is signed — gated on
//     `quoteAcceptedAt`, NOT on billing being complete: billingModule
//     returns null for a rate-only quote (see its comment), which would
//     otherwise lock those merchants out of Adyen forever.
// A `complete` module is never downgraded to locked, regardless of key.
function applyLock(
  m: OnboardingModule,
  gates: { demoHeld: boolean; quoteAccepted: boolean },
): OnboardingModule {
  if (m.status === "complete") return m;
  if (m.key === "demo") return m;
  if (m.key === "quote") {
    return gates.demoHeld ? m : { ...m, locked: { reason: "demo", message: "Available after your demo" } };
  }
  return gates.quoteAccepted
    ? m
    : { ...m, locked: { reason: "quote", message: "Available after your quote is signed" } };
}

// Reads the cached `app.demo` (DemoState, src/types/merchant.ts) — never a
// network call, see the purity note above. Replaces the old
// `scheduleDemoModule` shell now that the demo gate is real.
function demoModule(
  app: MerchantApplication,
  opts: { demoBookingUrl: string | null; now: number },
): OnboardingModule {
  const key = "demo";
  const label = "Schedule a Demo";
  const demo = app.demo;

  if (demo?.heldAt) {
    const date = new Date(demo.heldAt).toLocaleDateString();
    return {
      key, label, status: "complete",
      description: demo.source === "manual"
        ? `Your demo was recorded by your AIO representative on ${date}.`
        : `Your demo was held on ${date}.`,
    };
  }

  if (demo?.bookedAt && Date.parse(demo.bookedAt) > opts.now) {
    const date = new Date(demo.bookedAt).toLocaleDateString();
    return {
      key, label, status: "in_progress",
      description: `Your demo is scheduled for ${date}.`,
      ...(opts.demoBookingUrl ? { href: opts.demoBookingUrl, ctaLabel: "Reschedule" } : {}),
    };
  }

  // Past bookedAt, not held: HubSpot hasn't synced the outcome yet, or a rep
  // hasn't marked it. There's nothing for the customer to do — no CTA.
  if (demo?.bookedAt) {
    return {
      key, label, status: "in_progress",
      description: "We're confirming your demo — no action needed yet.",
    };
  }

  return {
    key, label, status: "not_started",
    description: opts.demoBookingUrl
      ? "Book a time to see AIO in action."
      : "Your AIO representative will reach out to schedule your demo.",
    ...(opts.demoBookingUrl ? { href: opts.demoBookingUrl, ctaLabel: "Book Your Demo" } : {}),
  };
}

// `hasQuote` arrives pre-gated by getOnboardingModules (forced false before
// the demo is held) — this function never reads `app.demo` itself. MUST NOT
// import `hasQuoteBasis` from leadQuote.ts: see OnboardingModulesOpts.
function quoteModule(
  app: MerchantApplication,
  opts: { hasQuote: boolean; quoteHref: string },
): OnboardingModule {
  const key = "quote";
  const label = "Quote";

  if (app.quoteAcceptedAt) {
    // Re-viewing a frozen quote is harmless — same reasoning as
    // foodbuyModule's "Download Again" below.
    return {
      key, label, status: "complete",
      description: "You've reviewed and signed your quote.",
      href: opts.quoteHref,
      ctaLabel: "View Quote",
    };
  }

  if (opts.hasQuote) {
    return {
      key, label, status: "not_started",
      description: "Your quote is ready to review.",
      href: opts.quoteHref,
      ctaLabel: "Review & Sign",
    };
  }

  return {
    key, label, status: "not_started",
    description: "Your rep is preparing your quote.",
  };
}

// Billing is a pure function of the cached hubspotIds snapshot — see the
// payrollModule note below, which documents the same constraint for Check.
// getOnboardingModules is called in a loop over every application on the
// customer dashboard (src/app/customer/page.tsx) and the admin accounts
// dashboard (src/components/dashboard/AccountsDashboard.tsx); a network
// call here would fan out one HubSpot request per row.
//
// The status matrix below is PAYMENT-TEST-PLAN.md §1.5, NOT PHASE-E-SPEC.md
// §7.2 — the spec's matrix gates completion on the quote's hs_payment_status,
// but that field lags the customer's actual payment by a median of 5.7 days
// (ACH settlement batch), while the subscription HubSpot creates from
// checkout appears within 1–9 minutes. Gating on paymentStatus would tell a
// merchant who already paid to "Review & Pay" for most of a week, so
// completion is derived from the subscription instead.
// Subscription rollup states that are NOT "the merchant is paying us". A
// canceled or unpaid subscription can still carry a paymentMethod from when it
// was first authorized, so these have to be excluded before the
// has-a-payment-method check below, exactly as billingModule does it.
const NOT_PAYING = new Set(["canceled", "unpaid", "past_due", "paused", "expired"]);

/** "Has this merchant's billing actually gone through?" — the single rule
 *  shared by the customer checklist and AIO tenant provisioning.
 *
 *  It exists because provisioning is triggered by payment: if this disagreed
 *  with what billingModule renders, the checklist could say "Billing is set
 *  up" while nothing ever provisioned (or the reverse). billingModule keeps
 *  its own branches because each bad state needs its own copy; a test in
 *  onboardingModules.test.ts asserts the two can never disagree on the
 *  complete/not-complete verdict. */
export function hasBillingCompleted(hubspotIds: MerchantApplication["hubspotIds"]): boolean {
  if (!hubspotIds?.quoteId || !hubspotIds.publishedAt) return false;
  const { subscriptionStatus, subscriptions } = hubspotIds;
  if (subscriptionStatus && NOT_PAYING.has(subscriptionStatus)) return false;
  if (subscriptionStatus === "active") return true;
  // A non-null paymentMethod proves the buyer completed checkout. Gating on
  // the SUBSCRIPTION, never on hs_payment_status — PAID lags checkout by a
  // median of 5.7 days on ACH.
  return (subscriptions ?? []).some(s => s.paymentMethod);
}

function billingModule(app: MerchantApplication, basePath: string): OnboardingModule | null {
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
      href: `${basePath}/billing`,
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

function adyenModule(app: MerchantApplication, basePath: string): OnboardingModule {
  const editHref = `${basePath}/edit`;

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
      href: `${basePath}/continue`,
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
function payrollModule(app: MerchantApplication, basePath: string): OnboardingModule {
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
      href: `${basePath}/payroll/continue`,
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
    href: `${basePath}/payroll`,
    ctaLabel: "Set Up Payroll",
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
function foodbuyModule(app: MerchantApplication, basePath: string): OnboardingModule {
  const label = "Foodbuy";
  const href = `${basePath}/foodbuy`;

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
