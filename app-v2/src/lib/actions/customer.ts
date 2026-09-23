"use server";

import { randomUUID } from "crypto";
import { hash } from "bcryptjs";
import { eq } from "drizzle-orm";
import { AuthError } from "next-auth";
import { auth, signIn } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { customerLoginTokens, users } from "@/lib/db/schema";
import { postgresStorage } from "@/lib/storage/postgresAdapter";
import { sendMagicLinkEmail, type SendMagicLinkResult } from "@/lib/adapters/email";
import {
  checkEnvironment,
  createCheckCompany,
  createCheckOnboardLink,
  getCheckOnboardStatus,
  type PayrollSigner,
} from "@/lib/adapters/check";
import {
  findSubscriptionsForQuote, getQuoteSnapshot, syncDealFromApplication,
  getDealById, listMeetingsForDeal, listDemoMeetingsForCompany,
} from "@/lib/adapters/hubspot";
import { buildCustomerSafeQuote } from "@/lib/leadQuote";
import { refreshDemoStatus as syncDemoStatus } from "@/lib/demoSync";
import {
  validateOnboardingFields,
  validateOnboardingSubmission,
  type OnboardingFieldErrors,
} from "@/lib/onboardingValidation";
import { usStateCode } from "@/lib/utils";
import { rollUpSubscriptionStatus } from "@/types/merchant";
import type {
  MerchantApplication, BusinessInfo, OwnerContact, ProcessingInfo, AgreementInfo, CustomerSafeQuote,
} from "@/types/merchant";

const LOGIN_TOKEN_TTL_MINUTES = 30;

// The onboarding form's State box is free text, so a customer can type
// "California". adapters/adyen.ts normalizes on the way out, but Check and
// HubSpot read app.business.state as-is — so normalize once, here, and persist
// the USPS code every consumer expects.
function withStateCode(business: BusinessInfo): BusinessInfo {
  return { ...business, state: usStateCode(business.state) ?? "" };
}

async function requireCustomer(): Promise<{ userId: string }> {
  const session = await auth();
  if (!session?.user || session.user.role !== "customer") throw new Error("Not authenticated");
  return { userId: session.user.id };
}

// Returning-visitor login (no specific application context). Deliberately
// does NOT create a new user for an unknown/non-customer email — avoids
// orphan accounts and email enumeration from a bare login screen. Always
// responds the same way regardless of whether the email matched.
export async function requestCustomerLoginAction(email: string): Promise<SendMagicLinkResult> {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user || user.role !== "customer" || user.disabledAt) {
    return { sent: true, devUrl: null };
  }

  const token = randomUUID();
  const expiresAt = new Date(Date.now() + LOGIN_TOKEN_TTL_MINUTES * 60 * 1000);
  await db.insert(customerLoginTokens).values({ email, token, expiresAt });

  const base = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
  return sendMagicLinkEmail(email, `${base}/api/customer/verify?token=${token}`);
}

// Password sign-in for customers who've set one — skips the magic-link round
// trip entirely. Customers without a password yet should use the "email me
// a link" path on /customer/login instead.
export async function customerLoginAction(formData: FormData): Promise<string | undefined> {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      // Restricts this form to customer rows — staff have no password login
      // (Entra) beyond the unlisted admin breakglass. See lib/auth.ts.
      scope: "customer",
      redirectTo: "/customer",
    });
  } catch (error) {
    if (error instanceof AuthError) return "Invalid email or password";
    throw error; // rethrow the internal NEXT_REDIRECT "error" so navigation still happens
  }
}

// Lets an already-authenticated customer set (or change) their password, so
// future sign-ins don't require requesting a fresh magic link every time.
export async function setCustomerPasswordAction(password: string): Promise<void> {
  const { userId } = await requireCustomer();
  if (password.length < 8) throw new Error("Password must be at least 8 characters");
  const passwordHash = await hash(password, 10);
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
}

export async function listMyApplicationsAction(): Promise<MerchantApplication[]> {
  const { userId } = await requireCustomer();
  return postgresStorage.listApplicationsForCustomer(userId);
}

export async function getMyApplicationAction(id: string): Promise<MerchantApplication | null> {
  const { userId } = await requireCustomer();
  return postgresStorage.getApplicationForCustomer(userId, id);
}

// The quote the customer accepted, re-projected for their signed-in dashboard.
// Loads through getApplicationForCustomer, which scopes on customerUserId, so
// an id belonging to someone else simply doesn't resolve — same gate as
// getMyApplicationAction. Returns the CustomerSafeQuote and nothing else: the
// application row it was built from never crosses to the client.
// Null means "no quote to show" — either the id isn't theirs, or the row has no
// statement and no rep-entered configs to price from (hasQuoteBasis).
export async function getMyQuoteAction(id: string): Promise<CustomerSafeQuote | null> {
  const { userId } = await requireCustomer();
  const app = await postgresStorage.getApplicationForCustomer(userId, id);
  if (!app) return null;
  return buildCustomerSafeQuote({
    quoteType: app.quoteType,
    analysis: app.analysis,
    quoteConfig: app.quoteConfig,
    targetMargin: app.targetMargin,
    pricingModel: app.pricingModel,
    quoteLines: app.quoteLines,
    orderPoints: app.orderPoints,
  });
}


// Saves the customer's self-serve business/owner/processing/agreement
// details, then chains into Adyen (legal entity + hosted onboarding URL) and
// HubSpot (deal sync). Both are caught independently and logged rather than
// thrown — ADYEN_LEM_API_KEY/HUBSPOT_PRIVATE_APP_TOKEN aren't configured yet,
// and a missing-credential error there shouldn't block the customer's save
// or surface a 500 to them.
//
// Adyen is validated against BEFORE it's called: this is the real gate, since
// the client-side copy of the same rules is bypassable. That includes the
// merchant's consent — the checkboxes were enforced in the browser only, so a
// bypassed client could reach Adyen's KYC pages having agreed to nothing.
// Missing consent is a validation failure, not an outage: it's the customer's
// to fix, and lib/consent.ts decides what counts (a legacy agreement with no
// recorded author is not the merchant's consent, and is refused here too).
//
// The customer's input is still saved when validation fails — losing what they
// typed would be worse than the rejection — but the stage doesn't advance,
// because onboarding hasn't started. `fieldErrors` (validation, the customer can
// fix it) and `adyenFailed` (our side broke) are separate outcomes and the form
// renders them differently.
// The deal sync both customer-side saves make, best-effort as it always was
// — the merchant is mid-form and a HubSpot outage must not cost them the save.
//
// PATCH-only: `syncDealFromApplication` never creates a deal, so this simply
// does nothing for an application with no `hubspotDealId` yet. Under the
// mandatory-deal model that's only ever a legacy row from before deal
// adoption existed — every new row carries a deal from the moment
// `createProspectAction` saves it — and its recovery is `adoptDealAction`/
// `linkTenantCompanyAction`'s repair path, not this function creating one on
// the fly. Nothing to persist locally on success either: the sync only
// changes HubSpot's copy of the deal, never `hubspotDealId` itself (a PATCH
// can't change the id it's targeting).
async function syncDealBestEffort(app: MerchantApplication): Promise<MerchantApplication> {
  if (!app.hubspotDealId) return app;
  try {
    await syncDealFromApplication(app);
  } catch (err) {
    console.error("HubSpot sync not available yet:", err instanceof Error ? err.message : err);
  }
  return app;
}

export async function saveMyApplicationOnboardingAction(
  id: string,
  fields: { business: BusinessInfo; ownerContact: OwnerContact; processing: ProcessingInfo; agreement: AgreementInfo }
): Promise<{
  app: MerchantApplication;
  fieldErrors: OnboardingFieldErrors | null;
}> {
  const { userId } = await requireCustomer();
  const existing = await postgresStorage.getApplicationForCustomer(userId, id);
  if (!existing) throw new Error("Application not found");

  const errors = validateOnboardingSubmission({
    business: fields.business,
    ownerContact: fields.ownerContact,
    agreement: fields.agreement,
  });
  const hasFieldErrors = Object.keys(errors).length > 0;

  let app = await postgresStorage.updateApplicationAsCustomer(userId, id, {
    business: withStateCode(fields.business),
    ownerContact: fields.ownerContact,
    processing: fields.processing,
    agreement: fields.agreement,
    ...(hasFieldErrors ? {} : { stage: "merchant_filling" as const }),
  });

  // Nothing reaches Adyen here any more. EasyOB no longer creates Adyen
  // objects at all: AIO's platform does, and only once billing has been paid
  // (see lib/aio/provision.ts). So this action now just records the merchant's
  // details — the ordering is inverted from the old flow, where submitting
  // details redirected straight to Adyen.
  app = await syncDealBestEffort(app);

  return { app, fieldErrors: hasFieldErrors ? errors : null };
}

// Edits after the first submission — e.g. after Adyen onboarding has already
// started. Doesn't touch stage (editing shouldn't regress/advance the deal's
// state machine) and pushes the change to Adyen/HubSpot if those already
// have a record for this application.
//
// The edit pushes the same registeredAddress to Adyen that the first submission
// did, so it's gated by the same server-side validator: an edit that blanks the
// ZIP would otherwise 422 at Adyen, be swallowed to a log, and leave the record
// here disagreeing with the one Adyen holds. Consent isn't re-demanded — this
// path can't reach the KYC handoff, and the agreement already on the record
// stands — so only the field rules run.
//
// Two outcomes now: saved either way, and `fieldErrors` is the customer's to
// fix. There is no longer anything to push: EasyOB does not own the merchant's
// Adyen legal entity, AIO does, and AIO exposes no update endpoint we know of
// (open question for their team). So an edit after provisioning changes our
// record and NOT the record Adyen holds — worth knowing before a merchant is
// told an address change took effect everywhere.
export async function updateMyApplicationDetailsAction(
  id: string,
  fields: { business: BusinessInfo; ownerContact: OwnerContact; processing: ProcessingInfo; agreement: AgreementInfo }
): Promise<{
  app: MerchantApplication;
  fieldErrors: OnboardingFieldErrors | null;
}> {
  const { userId } = await requireCustomer();
  const existing = await postgresStorage.getApplicationForCustomer(userId, id);
  if (!existing) throw new Error("Application not found");

  const errors = validateOnboardingFields({ business: fields.business, ownerContact: fields.ownerContact });
  const hasFieldErrors = Object.keys(errors).length > 0;

  let app = await postgresStorage.updateApplicationAsCustomer(userId, id, {
    business: withStateCode(fields.business),
    ownerContact: fields.ownerContact,
    processing: fields.processing,
    agreement: fields.agreement,
  });

  app = await syncDealBestEffort(app);

  return { app, fieldErrors: hasFieldErrors ? errors : null };
}

// ── Payroll (Check) ─────────────────────────────────────────────────────────
// Opt-in, unlike Adyen: nothing is sent to Check until the customer starts the
// payroll module themselves, so merchants who don't want AIO payroll never get
// a Check company. Errors here DO throw (the customer clicked a button and is
// waiting on a link) rather than following the fire-and-log convention the
// Adyen/HubSpot chaining above uses.

// Creates the Check company and returns the first onboard link. The signer is
// whoever is authorized to onboard for the company; startDate is their first
// payday on Check, which we can't derive from anything AIO stores.
export async function startPayrollOnboardingAction(
  id: string,
  fields: { startDate: string; signer: PayrollSigner }
): Promise<{ url: string }> {
  const { userId } = await requireCustomer();
  const app = await postgresStorage.getApplicationForCustomer(userId, id);
  if (!app) throw new Error("Application not found");
  if (!app.business || !app.ownerContact) {
    throw new Error("Add your business details before setting up payroll");
  }

  // Already opted in — hand back a fresh link instead of creating a second
  // Check company for the same merchant.
  if (app.checkIds?.companyId) {
    return { url: await createCheckOnboardLink(app.checkIds.companyId, app.checkIds.signer) };
  }

  const companyId = await createCheckCompany(app, fields.startDate);
  await postgresStorage.updateApplicationAsCustomer(userId, id, {
    checkIds: {
      companyId,
      environment: checkEnvironment(),
      startDate: fields.startDate,
      signer: fields.signer,
      createdAt: new Date().toISOString(),
      onboardStatus: null,
      onboardStatusAt: null,
    },
  });

  return { url: await createCheckOnboardLink(companyId, fields.signer) };
}

// Refreshes the cached Check onboard status on an already-loaded row and
// returns the latest row (the same one back, if nothing needed writing).
// Check's onboard links have no redirect-back URL, so the customer never
// returns through AIO after finishing — viewing the application is the only
// reliable moment to re-read status.
// Failures are swallowed — a Check outage must not break the application page.
async function refreshCheckOnboardStatus(
  userId: string,
  id: string,
  app: MerchantApplication
): Promise<MerchantApplication> {
  if (!app.checkIds?.companyId || app.checkIds.onboardStatus === "completed") return app;

  try {
    const onboardStatus = await getCheckOnboardStatus(app.checkIds.companyId);
    if (onboardStatus === app.checkIds.onboardStatus) return app;
    return await postgresStorage.updateApplicationAsCustomer(userId, id, {
      checkIds: { ...app.checkIds, onboardStatus, onboardStatusAt: new Date().toISOString() },
    });
  } catch (err) {
    console.error("Check onboard status refresh failed:", err instanceof Error ? err.message : err);
    return app;
  }
}

// ── Foodbuy ──────────────────────────────────────────────────────────────────
// There is no Foodbuy API — enrollment is a paper participation agreement
// (see lib/foodbuyForm.ts) that asks for the Federal ID #, a wet signature,
// and per-location distributor account numbers, none of which AIO collects.
// So there's no remote object to create and nothing to poll for status; this
// just records that the customer generated their pre-filled copy, so the
// checklist can show it's been done. The client renders the actual PDF
// (FoodbuyOnboardStep.tsx, reusing ProposalStep.tsx's html2pdf pattern) —
// this action only persists the timestamp once that succeeds.
export async function markFoodbuyFormGeneratedAction(id: string): Promise<MerchantApplication> {
  const { userId } = await requireCustomer();
  const app = await postgresStorage.getApplicationForCustomer(userId, id);
  if (!app) throw new Error("Application not found");
  if (!app.business || !app.ownerContact) {
    throw new Error("Add your business details before setting up Foodbuy");
  }

  return postgresStorage.updateApplicationAsCustomer(userId, id, {
    foodbuyIds: { generatedAt: new Date().toISOString() },
  });
}

// ── Demo tracking ────────────────────────────────────────────────────────────

// The TTL/terminal-heldAt/always-write/swallow-failures rules live in
// lib/demoSync.ts — shared with the public /lead/[token] checklist host,
// which injects a token-scoped persist instead of this customer-session-
// scoped one. Don't re-derive the rules here; see that file's comment.
async function refreshDemoStatus(
  userId: string,
  id: string,
  app: MerchantApplication
): Promise<MerchantApplication> {
  return syncDemoStatus(app, {
    // Thunked, not passed directly: demoSync's own early-returns (no deal yet,
    // already held, within the TTL) mean these are often never invoked at
    // all, and a direct reference here would still touch the import binding
    // eagerly on every call regardless of whether demoSync ends up using it.
    getDeal: dealId => getDealById(dealId),
    listDealMeetings: dealId => listMeetingsForDeal(dealId),
    listCompanyMeetings: companyId => listDemoMeetingsForCompany(companyId),
    persist: demo => postgresStorage.updateApplicationAsCustomer(userId, id, { demo }),
  });
}

// ── Billing (HubSpot quote + subscriptions) ─────────────────────────────────

// Skip a re-read within a minute of the last one. The Check refresh above has
// no TTL and re-reads on every page view; that's tolerable at one API call, but
// this one makes up to two (the quote, then its subscriptions) and a customer
// refreshing while waiting for a payment to clear is the EXPECTED behaviour
// here, not an edge case.
const BILLING_SYNC_TTL_MS = 60_000;

// Refreshes the cached HubSpot quote/subscription snapshot on an already-loaded
// row and returns the latest row.
//
// The thing it is actually fetching is the SUBSCRIPTION, not the quote's
// payment status. Verified against 47 live quote/subscription pairs: the
// subscription appears 1–9 MINUTES after the customer finishes checkout, while
// the quote's hs_payment_status doesn't flip to PAID for a median of 5.7 DAYS
// (a daily ~12:00 UTC ACH settlement batch). So this on-view refresh — not the
// nightly cron — is the load-bearing mechanism for the customer, and
// billingModule() gates completion on the subscription. paymentStatus is still
// cached, because "the money actually moved" is worth having and Phase G wants
// it, but it is NOT the completion gate.
//
// Failures are swallowed — a HubSpot outage must not break the application page.
async function refreshHubspotBilling(
  userId: string,
  id: string,
  app: MerchantApplication
): Promise<MerchantApplication> {
  const hubspotIds = app.hubspotIds;
  if (!hubspotIds?.quoteId || !hubspotIds.publishedAt) return app;

  // The no-op condition, in the real ordering: there is something left to learn
  // only while no subscription is cached, or every cached one is still merely
  // `scheduled` (its first charge hasn't run), or the settlement batch hasn't
  // marked the quote PAID yet. `scheduled` counts as pending because it becomes
  // `active` on its own, days later, with nothing on our side to trigger it.
  const subs = hubspotIds.subscriptions ?? [];
  const noSubscriptions = subs.length === 0;
  const allScheduled = !noSubscriptions && subs.every(s => s.status === "scheduled");
  const pending = noSubscriptions || allScheduled || hubspotIds.paymentStatus !== "PAID";
  if (!pending) return app;

  const syncedAtMs = hubspotIds.syncedAt ? Date.parse(hubspotIds.syncedAt) : NaN;
  if (!Number.isNaN(syncedAtMs) && Date.now() - syncedAtMs < BILLING_SYNC_TTL_MS) return app;

  try {
    const snapshot = await getQuoteSnapshot(hubspotIds.quoteId);
    if (!snapshot) throw new Error(`quote ${hubspotIds.quoteId} not found in HubSpot`);
    const subscriptions = await findSubscriptionsForQuote(hubspotIds.quoteId);

    // Always written, even when nothing changed — unlike the Check refresh,
    // which returns early on an unchanged status. syncedAt IS the TTL above, so
    // skipping the write would mean the TTL never engages and every page view
    // re-reads HubSpot twice.
    return await postgresStorage.updateApplicationAsCustomer(userId, id, {
      hubspotIds: {
        ...hubspotIds,
        // Never null out a link that works on a read that came back empty.
        quoteLink: snapshot.quoteLink ?? hubspotIds.quoteLink,
        paymentStatus: snapshot.paymentStatus,
        paymentDate: snapshot.paymentDate,
        subscriptions,
        subscriptionStatus: rollUpSubscriptionStatus(subscriptions),
        syncedAt: new Date().toISOString(),
        lastSyncError: null,
        lastSyncErrorAt: null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("HubSpot billing refresh failed:", message);
    // Persisted as well as logged, so a stuck account is visible to a rep
    // instead of living only in a log line nobody reads.
    try {
      return await postgresStorage.updateApplicationAsCustomer(userId, id, {
        hubspotIds: { ...hubspotIds, lastSyncError: message, lastSyncErrorAt: new Date().toISOString() },
      });
    } catch (writeErr) {
      console.error("Failed to persist HubSpot sync error:", writeErr instanceof Error ? writeErr.message : writeErr);
      return app;
    }
  }
}

// Loads the application and refreshes ONLY its cached HubSpot billing snapshot.
// The application page wants both refreshes and calls getMyApplicationWithSync-
// Action below; this one exists for a caller that only cares about billing.
//
// Takes an id and re-loads server-side rather than accepting an application
// object: this is a Server Action, so a caller-supplied app would let a client
// forge the quoteId it queries. Same rule in the combined action below.
export async function getMyApplicationWithBillingSyncAction(id: string): Promise<MerchantApplication | null> {
  const { userId } = await requireCustomer();
  const app = await postgresStorage.getApplicationForCustomer(userId, id);
  if (!app) return null;
  return refreshHubspotBilling(userId, id, app);
}

// What the application detail page calls: one load, all three on-view refreshes.
//
// They run INDEPENDENTLY — each swallows its own failures internally — so a
// HubSpot/Check outage can't suppress either of the others.
//
// They run SEQUENTIALLY and the row is threaded from one into the next, which is
// what keeps updates on the same row from clobbering each other.
// updateApplicationAsCustomer SETs only the columns in its patch, so check_ids,
// demo, and hubspot_ids can't collide in SQL — but each refresh builds its patch
// by spreading the snapshot it was handed, and returns the row from its own
// RETURNING. Handing the next refresh a pre-previous-write row would make the
// value this function returns to the page miss whatever the earlier one wrote.
// Do not "optimise" this into a Promise.all over independent loads.
//
// Demo runs BEFORE billing, deliberately: the demo gate decides whether
// billing is even shown to the merchant, so a page render that skipped this
// ordering could flash a billing module the demo hasn't cleared yet.
//
// No fourth Foodbuy refresh here — there's nothing to poll (see markFoodbuy-
// FormGeneratedAction above).
export async function getMyApplicationWithSyncAction(id: string): Promise<MerchantApplication | null> {
  const { userId } = await requireCustomer();
  const app = await postgresStorage.getApplicationForCustomer(userId, id);
  if (!app) return null;
  const afterPayroll = await refreshCheckOnboardStatus(userId, id, app);
  const afterDemo = await refreshDemoStatus(userId, id, afterPayroll);
  return refreshHubspotBilling(userId, id, afterDemo);
}
