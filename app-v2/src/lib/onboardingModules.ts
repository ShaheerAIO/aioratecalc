import type { HubspotSubscriptionSnapshot, MerchantApplication } from "@/types/merchant";
// The ONLY value import in this file, and deliberately a narrow one. The
// "types only" rule below exists to keep pricing.ts — and therefore AIO's true
// margin floors — out of the browser bundle. quoting.ts imports nothing but
// `monthlyEquivalent` from utils and a few types, so it carries no margin data.
// Don't widen this to anything that reaches pricing.ts.
import { quoteHasProcessing, quoteTypeOf } from "@/lib/quoting";

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
  locked?: { reason: "quote" | "billing"; message: string };
};

/**
 * A banner above the checklist, for a state the row itself can't carry.
 *
 * Exactly one today: signed but not paid. The merchant believes they are
 * finished — they signed a document and closed the tab — and everything below
 * the first row is locked because of a bank account they never entered. One
 * checklist row, however worded, is a weak way to say "you are not done";
 * this says it in as many words, before the list.
 *
 * Pure and shared, so the public token host and the authenticated one cannot
 * tell them different stories.
 */
export type ChecklistNotice = {
  title: string;
  body: string;
  href?: string;
  ctaLabel?: string;
};

export function checklistNotice(
  app: MerchantApplication,
  opts?: { billingHref?: string },
): ChecklistNotice | null {
  if (!hasSignedWithoutPaying(app.hubspotIds)) return null;
  return {
    title: "One step left: your bank details",
    body:
      "Thanks for signing your quote. We still need the bank account you'd like to pay from " +
      "before we can create your account and open the rest of the steps below. It's the same " +
      "secure page you signed on, and it only takes a minute.",
    ...(opts?.billingHref ? { href: opts.billingHref, ctaLabel: "Enter Billing Details" } : {}),
  };
}

export type OnboardingModulesOpts = {
  // Defaults to `/customer/applications/${app.id}` so the two existing
  // authenticated call sites are unchanged; a token-scoped host (a later
  // task) will pass a different path.
  basePath?: string;
  // Where the quote row's CTA points BEFORE HubSpot holds a published quote —
  // EasyOB's own rendering of it. Defaults to `basePath` — on the
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
  // Where the HOSTED HubSpot quote is reached — the page that collects the
  // signature and the bank details, and the CTA target for every state from
  // publish onwards. Each host gets there differently: the authenticated one
  // through `${basePath}/billing` (the read-or-refresh redirect, which needs
  // a session), the public token one through its own quote route, which
  // carries the same link. Defaults to the authenticated path; the token host
  // MUST pass its quote route instead, or the row's CTA 404s.
  billingHref?: string;
  // Whether there's a quote ready to show (a rep-configured basis or a
  // readable statement). MUST be computed by the caller via `hasQuoteBasis`
  // in leadQuote.ts, never here — that module imports pricing.ts, and
  // pulling it into this file would ship MARGIN_REQS, AIO's true margin
  // floors, into the browser bundle. Defaults to false.
  hasQuote?: boolean;
};

// Order: quote & billing first, then everything else. The quote is the gate —
// the customer reviews, signs and pays for it, and adyen/payroll/foodbuy are
// all locked until they do (see `applyLock` below). Within that back half, the
// order is the one a merchant actually uses them in post-signup: get paid
// (Adyen), then get set up to pay staff (payroll), then Foodbuy.
//
// Every module here is pure, reading only cached fields — getOnboardingModules
// runs in a loop over every row on both the customer dashboard
// (src/app/customer/page.tsx) and the admin accounts dashboard
// (AccountsDashboard.tsx), so a network call in any of them would fan out one
// request per row. This file imports only types — keep it that way.
//
// adyenModule can return null (a marketing-only quote — see its comment), so
// the list below is variable-length before the lock pass runs.
export function getOnboardingModules(
  app: MerchantApplication,
  opts?: OnboardingModulesOpts,
): OnboardingModule[] {
  const basePath = opts?.basePath ?? `/customer/applications/${app.id}`;
  const quoteHref = opts?.quoteHref ?? basePath;
  const billingHref = opts?.billingHref ?? `${basePath}/billing`;
  const quoteAccepted = !!app.quoteAcceptedAt;

  const modules = [
    quoteBillingModule(app, { hasQuote: opts?.hasQuote ?? false, quoteHref, billingHref }),
    adyenModule(app, basePath),
    payrollModule(app, basePath),
    foodbuyModule(app, basePath),
  ].filter((m): m is OnboardingModule => m !== null);

  return modules.map(m => applyLock(m, quoteAccepted, hasSignedWithoutPaying(app.hubspotIds)));
}

// The one lock rule, applied once over the built list rather than scattered
// through the module functions above, so each one stays about its own
// domain:
//   - quote is never locked — it's the first thing the customer does, and
//     since the merge it is also the only row that can ask for the billing
//     details everything else waits on. Locking it would gate a row on its
//     own completion.
//   - everything else is locked until the quote is signed AND paid — gated on
//     `quoteAcceptedAt`, which is only ever set by `applyDetectedAcceptance`
//     once HubSpot reports both.
// A `complete` module is never downgraded to locked, regardless of key.
//
// The MESSAGE splits on why, because "Available after your quote is signed"
// is actively wrong for the merchant who just signed it and stopped before
// paying — they read it as a broken page rather than as the one thing they
// still have to do. Same lock, different sentence.
function applyLock(
  m: OnboardingModule,
  quoteAccepted: boolean,
  signedWithoutPaying: boolean,
): OnboardingModule {
  if (m.status === "complete") return m;
  if (m.key === "quote") return m;
  if (quoteAccepted) return m;
  return {
    ...m,
    locked: signedWithoutPaying
      ? { reason: "billing", message: "Available once your billing details are in" }
      : { reason: "quote", message: "Available after your quote is signed" },
  };
}

// The quote and the billing details are ONE row, because for the merchant
// they are one act. HubSpot's hosted quote is a single page: the signature
// and the bank account are collected back to back on it, and only the second
// half accepts the quote. Two rows described that one page twice, and could
// only ever contradict each other — the quote row saying billing was all that
// was left, beside a billing row saying it was unavailable until billing
// was in.
//
// Keyed "quote" rather than "billing", and that is load-bearing in two other
// files: `applyLock` exempts this key as the one row that is never gated, and
// `withSignInOverride` (OnboardingChecklistPanel.tsx) exempts it as the one
// CTA the public token host can serve itself. Both remain exactly true of the
// merged row; neither would be true of a row keyed "billing".
//
// MUST NOT import `hasQuoteBasis` from leadQuote.ts — the caller computes
// `hasQuote` and passes it in: see OnboardingModulesOpts.
const QUOTE_MODULE = { key: "quote", label: "Quote & Billing" } as const;

function quoteBillingModule(
  app: MerchantApplication,
  opts: { hasQuote: boolean; quoteHref: string; billingHref: string },
): OnboardingModule {
  // A PUBLISHED HubSpot quote is the hosted page existing. Before that there
  // is nothing to sign and nothing to pay, so the row is about the quote;
  // from then on every state the merchant can be in is a billing-snapshot
  // state, and `hostedQuoteRow` owns all of them. A DRAFT quote is not
  // hosted: its link is never surfaced, the rep hasn't sent it.
  const hubspotIds = app.hubspotIds;
  if (hubspotIds?.quoteId && hubspotIds.publishedAt) {
    return hostedQuoteRow(app, hubspotIds, opts.billingHref);
  }
  return unpublishedQuoteRow(app, opts);
}

// Before HubSpot holds a published quote. Links point at EasyOB's own
// rendering of it (`quoteHref`) — there is no hosted page to send anyone to.
function unpublishedQuoteRow(
  app: MerchantApplication,
  opts: { hasQuote: boolean; quoteHref: string },
): OnboardingModule {
  if (app.quoteAcceptedAt) {
    // Accepted with no HubSpot quote behind it. Two ways to get here, and
    // they are not the same state:
    //
    //  - A RATE-ONLY quote (empty quoteLines — commit c65b4b1) has nothing
    //    for HubSpot to bill: AIO's margin on it comes out of Adyen
    //    settlement, and the catalog's processing products are $0
    //    placeholders. No quote is ever built, so this row is done at the
    //    signature and must say so — a permanently-pending billing half
    //    would be a promise nobody is ever going to keep. (Re-viewing a
    //    frozen quote is harmless, same as foodbuyModule's "Download Again".)
    //  - Billable lines but no published quote yet: the publish is OURS to
    //    do, so this is a wait on AIO, not on the merchant.
    const hasBillableLines = !!app.quoteLines && app.quoteLines.length > 0;
    return hasBillableLines
      ? {
          ...QUOTE_MODULE, status: "in_progress",
          description: "You've signed your quote. We're setting up your billing — no action needed.",
        }
      : {
          ...QUOTE_MODULE, status: "complete",
          description: "You've reviewed and signed your quote.",
          href: opts.quoteHref,
          ctaLabel: "View Quote",
        };
  }

  if (opts.hasQuote) {
    // "Review & Sign" is literal, not a euphemism for a second accept step:
    // for anyone with products on their quote this leads to HubSpot's hosted
    // page, where signing it and entering billing details IS the acceptance.
    return {
      ...QUOTE_MODULE, status: "not_started",
      description: "Your quote is ready to review, sign and set up billing.",
      href: opts.quoteHref,
      ctaLabel: "Review & Sign",
    };
  }

  return {
    ...QUOTE_MODULE, status: "not_started",
    description: "Your rep is preparing your quote.",
  };
}

// Subscription rollup states that are NOT "the merchant is paying us". A
// canceled or unpaid subscription can still carry a paymentMethod from when it
// was first authorized, so these have to be excluded before the
// has-a-payment-method check below, exactly as hostedQuoteRow does it.
const NOT_PAYING = new Set(["canceled", "unpaid", "past_due", "paused", "expired"]);

/** "Has this merchant's billing actually gone through?" — the single rule
 *  shared by the customer checklist and AIO tenant provisioning.
 *
 *  It exists because provisioning is triggered by payment: if this disagreed
 *  with what the checklist renders, the checklist could say "Billing is set
 *  up" while nothing ever provisioned (or the reverse). hostedQuoteRow keeps
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

/**
 * The merchant signed the hosted quote and then did NOT finish the checkout.
 *
 * Signing and paying happen on the same HubSpot page but are separate acts,
 * and only the second one accepts the quote (`hasBillingCompleted`, and
 * therefore `quoteAcceptedAt`, and therefore everything the checklist
 * unlocks). So this state is a merchant who believes they are done and is
 * looking at a locked checklist. It exists to be TOLD to them, in as many
 * words, wherever they land.
 *
 * Deliberately expressed as "signed AND not complete" over the same predicate
 * the checklist uses, rather than as its own reading of the snapshot — the
 * two can then never disagree about whether there is anything left to do.
 * Observed live 2026-09-25: quote 330655913691, SIGNED with hs_payment_status
 * PENDING and no subscription.
 */
export function hasSignedWithoutPaying(hubspotIds: MerchantApplication["hubspotIds"]): boolean {
  if (hubspotIds?.esignStatus !== "SIGNED") return false;
  return !hasBillingCompleted(hubspotIds);
}

// Everything from publish onwards: the merchant has a hosted HubSpot quote,
// so the billing snapshot is the whole story and this row tells it.
//
// A pure function of the cached hubspotIds — see the payrollModule note
// below, which documents the same constraint for Check. getOnboardingModules
// is called in a loop over every application on the customer dashboard
// (src/app/customer/page.tsx) and the admin accounts dashboard
// (src/components/dashboard/AccountsDashboard.tsx); a network call here would
// fan out one HubSpot request per row.
//
// The status matrix below is PAYMENT-TEST-PLAN.md §1.5, NOT PHASE-E-SPEC.md
// §7.2 — the spec's matrix gates completion on the quote's hs_payment_status,
// but that field lags the customer's actual payment by a median of 5.7 days
// (ACH settlement batch), while the subscription HubSpot creates from
// checkout appears within 1–9 minutes. Gating on paymentStatus would tell a
// merchant who already paid to "Review & Pay" for most of a week, so
// completion is derived from the subscription instead.
function hostedQuoteRow(
  app: MerchantApplication,
  hubspotIds: NonNullable<MerchantApplication["hubspotIds"]>,
  billingHref: string,
): OnboardingModule {
  const { paymentStatus, subscriptions, subscriptionStatus } = hubspotIds;
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
      ...QUOTE_MODULE, status: "in_progress",
      description: "Your billing was canceled. Contact your AIO representative to reactivate it.",
    };
  }
  if (subscriptionStatus === "unpaid") {
    return {
      ...QUOTE_MODULE, status: "in_progress",
      description: "There's a problem with your last payment. Contact your AIO representative to update your billing details.",
    };
  }
  if (subscriptionStatus === "past_due") {
    return {
      ...QUOTE_MODULE, status: "in_progress",
      description: "Your last payment is past due. We're retrying automatically — no action needed yet.",
    };
  }
  if (subscriptionStatus === "paused") {
    return {
      ...QUOTE_MODULE, status: "in_progress",
      description: "Your billing is temporarily paused. Contact your AIO representative to resume it.",
    };
  }
  if (subscriptionStatus === "expired") {
    return {
      ...QUOTE_MODULE, status: "in_progress",
      description: "Your billing subscription has expired. Contact your AIO representative.",
    };
  }

  // Done. The CTA stays, pointing at the signed document: `hs_quote_link` is
  // `public_access` and re-servable by design (see the long note in
  // app/customer/applications/[id]/billing/route.ts), unlike the single-use
  // Adyen and Check links — so "View Quote" here is safe, and it's the only
  // copy of their agreement the merchant has.
  const viewQuote = { href: billingHref, ctaLabel: "View Quote" };

  if (subscriptionStatus === "active") {
    return {
      ...QUOTE_MODULE, ...viewQuote, status: "complete",
      description: "You've signed your quote and your billing is active.",
    };
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
    return {
      ...QUOTE_MODULE, ...viewQuote, status: "complete",
      description: `You've signed your quote and your billing is set up.${firstCharge}`,
    };
  }

  // A one-time-charge-only quote (no recurring lines) never produces a
  // subscription at all — PAID is the only completion signal it will ever get.
  if (paymentStatus === "PAID" && subs.length === 0) {
    return {
      ...QUOTE_MODULE, ...viewQuote, status: "complete",
      description: "You've signed your quote and your payment has been processed.",
    };
  }

  // This means a quote published without payments enabled — a build defect,
  // not a customer state, so it's surfaced loudly here as well as shown
  // gently to the customer.
  if (paymentStatus === "PAYMENT_NOT_ENABLED") {
    console.error(`quoteBillingModule: application ${app.id} has a published quote with PAYMENT_NOT_ENABLED`);
    return {
      ...QUOTE_MODULE, status: "in_progress",
      description: "We're finishing setting up your billing — no action needed.",
    };
  }

  // Nothing has come through yet. Both sentences point at the same hosted
  // page, but they are not interchangeable: telling a merchant who has
  // already signed to "review and sign" is how this state reads as a bug to
  // them. They stopped at the payment half, and only that half is left —
  // which is also what `checklistNotice` says above the list.
  if (subs.length === 0 && (paymentStatus === null || paymentStatus === "PENDING" || paymentStatus === "PROCESSING")) {
    return hubspotIds.esignStatus === "SIGNED"
      ? {
          ...QUOTE_MODULE, status: "in_progress",
          description: "You've signed. Your billing details are all that's left.",
          href: billingHref,
          ctaLabel: "Enter Billing Details",
        }
      : {
          ...QUOTE_MODULE, status: "not_started",
          description: "Review your quote, sign it, and enter your billing details.",
          href: billingHref,
          ctaLabel: "Review & Sign",
        };
  }

  // Defensive default: an unrecognised paymentStatus or subscription status
  // combination. Never crash, never silently read as complete.
  return {
    ...QUOTE_MODULE, status: "in_progress",
    description: "We're syncing your billing status. Check back shortly.",
  };
}

function adyenModule(app: MerchantApplication, basePath: string): OnboardingModule | null {
  const key = "adyen";
  const label = "Payment Processing (Adyen)";
  const editHref = `${basePath}/edit`;

  // A marketing merchant who sells nothing through us never needs an Adyen
  // account, and this row would sit permanently incomplete. OMIT it rather
  // than show a promise that will never be kept — same reasoning as
  // billingModule's rate-only branch, and it keeps the dashboard's "N of M
  // complete" count honest. Uses the same predicate the quote itself was built
  // under, LINES included: a marketing merchant who bought the Website takes
  // card payments, so they do need this row.
  if (!quoteHasProcessing(quoteTypeOf(app.quoteType), app.quoteLines)) return null;

  if (app.stage === "adyen_kyc_complete" || app.stage === "adyen_approved") {
    return { key, label, status: "complete", description: "Verification complete." };
  }

  // Provisioned: AIO holds the tenant and the location, so a link can be
  // minted. NOT the stored adyenOnboardingUrl — those are single-use and
  // expire in minutes; the route mints a fresh one per click.
  if (app.aioTenant?.provisionedAt && app.aioTenant.locationId) {
    return {
      key,
      label,
      status: "in_progress",
      description: "Finish identity verification with our processing partner.",
      href: `${basePath}/continue`,
      ctaLabel: "Continue Verification",
    };
  }

  // Claimed but not finished. Nothing for the customer to do, and no href —
  // the provisioning cron is mid-flight or retrying.
  if (app.aioTenant) {
    return {
      key,
      label,
      status: "in_progress",
      description: "We're setting up your account — no action needed.",
    };
  }

  // Details are in, but provisioning waits for billing to be paid. This is the
  // ordering inversion the move to AIO's API introduced: the merchant submits
  // their details well before an Adyen account can exist for them.
  if (app.business && app.ownerContact && app.processing && app.agreement) {
    return {
      key,
      label,
      status: "in_progress",
      description: "Your details are saved. Verification starts once your billing is set up.",
      href: editHref,
      ctaLabel: "Review Details",
    };
  }

  return {
    key,
    label,
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
