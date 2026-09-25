// Phase E — publish orchestration.
//
// Turns a configured EasyOB quote into a PUBLISHED HubSpot quote with a hosted
// checkout link, in one server-side pass.
//
// The trigger is the rep's Send Quote click (`sendQuoteAction`), BEFORE the
// merchant has accepted anything — because signing and paying that hosted
// quote is now how they accept (lib/billing/acceptance.ts). It briefly ran
// inside the merchant's own acceptance POST instead, with no human in the
// loop at all; `canPublishBillingQuote` still applies strictly before the
// first write, and is now belt as well as braces.
//
// Graph (PHASE-E-SPEC.md §3.1):
//   Contact ──69/702──▶ Quote ──67──▶ line items
//                         ├──64──▶ Deal   (1393 is added by HubSpot at publish)
//                         └─286──▶ quote_template
//
// Server-side only. No `import "server-only"` marker of its own: it imports
// lib/db/client, which carries one, and the marker throws under vitest — the
// same reason lib/adyen/reportWindow.ts was split out of adyenReports.ts.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications, users } from "@/lib/db/schema";
import {
  associateDealToContact,
  associateQuote,
  createDraftQuote,
  createQuoteLineItems,
  deleteQuoteLineItem,
  draftQuoteProperties,
  ensureQuoteContact,
  findOwnerByEmail,
  listProducts,
  planLineItemReconciliation,
  publishQuote,
  tenantCompanyId,
  type QuoteAssociation,
} from "@/lib/adapters/hubspot";
import { getQuoteTemplatePolicy } from "@/lib/actions/quoteTemplates";
import { getMaxDiscountPercent } from "@/lib/actions/pricing";
import { DEFAULT_MAX_DISCOUNT_PERCENT, quoteTypeOf } from "@/lib/quoting";
import { canPublishBillingQuote, type PublishRefusal, type SenderResolution } from "@/lib/billing/preconditions";
import { EMPTY_HUBSPOT_IDS, type HubspotIds, type MerchantApplication } from "@/types/merchant";

// Association type ids from the quote (PHASE-E-SPEC.md §3.2, all verified live).
// Never create deal↔quote 1393 — HubSpot adds that itself at publish.
const QUOTE_TO_LINE_ITEM = 67;
const QUOTE_TO_DEAL = 64;
const QUOTE_TO_CONTACT = 69;
const QUOTE_TO_SIGNER_CONTACT = 702;
const QUOTE_TO_TEMPLATE = 286;

// 90 days, matching what AIO's own live quotes carry (created 2026-08-21 →
// expires 2026-11-20). PHASE-E-SPEC.md §3.4 defaulted to 30; that is the wrong
// direction to be wrong in. Expiry gates the buyer's E-SIGNATURE, and the
// merchant signs on HubSpot's hosted page AFTER this publish, so a short window
// can strand a merchant who takes a few weeks to get round to signing. It does
// not gate settlement on an already-accepted quote — one live quote took
// payment 8 days past its own expiry (PAYMENT-TEST-PLAN.md §1.8, O-8).
const EXPIRY_DAYS = 90;

// How long a claimed-but-unfinished build is assumed to still be running. The
// whole pass is ~8-12 HubSpot calls plus one ~3s link read, so a minute is
// already generous; past the lease a retry resumes rather than refusing forever
// (a serverless function killed mid-build would otherwise wedge the account).
const BUILD_LEASE_MS = 2 * 60 * 1000;

/** Which step of the graph was in flight. Named in `lastSyncError` so a stuck account self-describes. */
export type BillingStep = "contact" | "line_items" | "draft_quote" | "associations" | "publish";

export type PublishBillingQuoteResult =
  | { status: "published"; quoteId: string; quoteLink: string | null; alreadyPublished: boolean }
  /**
   * Nothing was created and nothing is wrong.
   *  - `nothing_to_bill`: a rate-only quote (see below).
   *  - `already_published`: the one-way door is already shut.
   *  - `build_in_progress`: another request holds the build lease.
   *  - `awaiting_tenant_link`: no HubSpot Company linked yet — see below.
   */
  | { status: "skipped"; reason: "nothing_to_bill" | "already_published" | "build_in_progress" | "awaiting_tenant_link" }
  | { status: "refused"; reasons: PublishRefusal[] }
  | { status: "failed"; step: BillingStep; error: string };

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function quoteTitle(app: MerchantApplication): string {
  const name =
    app.business?.dba?.trim() ||
    app.business?.legalName?.trim() ||
    app.analysis?.merchantName?.trim() ||
    "New Deal";
  return `${name} — AIO Platform Quote`;
}

/**
 * Who signs: `ownerContact.email`, the business contact of record.
 *
 * Association 702 makes this contact the LEGAL SIGNER — HubSpot mails them the
 * e-signature request and takes their signature as acceptance of the quote, and
 * the checkout behind it stores an ACH mandate. `ownerContact.email` is
 * deliberately preferred: it is the business contact of record, populated on
 * every prospect row from what the rep entered (`createProspectAction` writes
 * `contactEmail` straight into it), and on a financial mandate the authorized
 * signer beats whoever happened to open the link. The two are normally the same
 * person; when they differ — a manager opens a link addressed to the owner —
 * this sends the mandate to the owner on purpose.
 *
 * There used to be a fallback to "whatever address the customer typed into the
 * accept form", because the publish ran inside that POST. It is gone with the
 * form: the rep sends the quote BEFORE anyone accepts, so there is no such
 * address to fall back to. A row with no contact email now refuses
 * `no_signer_email`, which names the fix — `createProspectAction` writes this
 * field on every prospect, so a missing one is a data problem to correct, not
 * a gap to paper over with whoever happened to open the link.
 */
function resolveSigner(
  app: MerchantApplication
): { email: string; firstName: string; lastName: string; phone?: string } | null {
  const ownerEmail = app.ownerContact?.email?.trim();
  if (!ownerEmail) return null;
  return {
    email: ownerEmail,
    // Blank strings are dropped by ensureQuoteContact rather than written as
    // empty properties.
    firstName: app.ownerContact?.firstName?.trim() ?? "",
    lastName: app.ownerContact?.lastName?.trim() ?? "",
    phone: app.ownerContact?.phone?.trim() || undefined,
  };
}

/**
 * Who it comes from: the owning rep. `hs_sender_email` is the deal's own rep on
 * all 46 live paid quotes in the portal, never a shared mailbox
 * (PAYMENT-TEST-PLAN.md §1.8, O-1).
 *
 * TWO steps, and the second one is the point. Our `users` row supplies a
 * candidate address; HubSpot's own user list decides whether it is real.
 * HubSpot accepts whatever `hs_sender_email` it is handed without validating
 * it — the gate run proved that with a seeded dev address — so an unchecked
 * `users.email` is a merchant receiving their quote from an address nobody
 * owns, on a document nobody can amend afterwards.
 *
 * On a match, HubSpot's spelling of the address and the name WINS over ours.
 * Its record is the thing the property is supposed to agree with, and taking
 * it removes the only remaining way the two can disagree (a rep whose EasyOB
 * row says `R.Rep@…` and whose portal user says `rita@…`). The `users.name`
 * split survives only as the fallback for an owner with no name on file.
 */
async function resolveSender(ownerUserId: string): Promise<SenderResolution> {
  const [rep] = await db
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, ownerUserId))
    .limit(1);
  const repEmail = rep?.email?.trim();
  if (!repEmail) return { ok: false, code: "no_rep_email" };

  let owner;
  try {
    owner = await findOwnerByEmail(repEmail);
  } catch (err) {
    // Caught rather than rethrown so it lands as a REFUSAL the rep can read
    // and act on, not as the generic "preflight failed" the surrounding
    // try/catch would produce. A missing `crm.objects.owners.read` scope is
    // the likeliest cause and it names its own fix.
    return {
      ok: false,
      code: "owner_lookup_failed",
      repEmail,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!owner) return { ok: false, code: "not_a_portal_owner", repEmail };

  const [firstName, ...rest] = (rep.name ?? "").trim().split(/\s+/);
  return {
    ok: true,
    email: owner.email,
    firstName: owner.firstName ?? (firstName || undefined),
    lastName: owner.lastName ?? (rest.join(" ") || undefined),
    ownerId: owner.id,
  };
}

function progressSummary(ids: HubspotIds): string {
  const done: string[] = [];
  if (ids.contactId) done.push("contact resolved");
  if (ids.lineItemIds?.length) done.push(`${ids.lineItemIds.length} line item(s) created`);
  if (ids.quoteId) done.push(`draft quote ${ids.quoteId} created`);
  return done.length ? done.join(", ") : "nothing created yet";
}

async function persist(applicationId: string, ids: HubspotIds): Promise<void> {
  await db
    .update(merchantApplications)
    .set({ hubspotIds: ids, updatedAt: new Date() })
    .where(eq(merchantApplications.id, applicationId));
}

// A persisted failure, not a console.error. §5.2's whole lesson: the deal sync
// failed on literally every call for the entire life of the feature and produced
// no signal anywhere, because a log line was the only record.
async function persistSyncError(
  applicationId: string,
  ids: HubspotIds,
  message: string
): Promise<HubspotIds> {
  const next: HubspotIds = {
    ...ids,
    lastSyncError: message,
    lastSyncErrorAt: new Date().toISOString(),
  };
  try {
    await persist(applicationId, next);
  } catch (err) {
    // The DB write is the last thing standing between a stuck account and
    // total silence, so say so loudly if even that fails.
    console.error("buildAndPublishBillingQuote: could not persist the failure state", applicationId, err);
  }
  return next;
}

/** Names the step that failed and what was already built, so "stuck at billing" is actionable without the logs. */
function stepFailure(ids: HubspotIds, step: BillingStep, detail: string): string {
  return `${progressSummary(ids)}; ${step} failed: ${detail}`;
}

/**
 * Build and publish this application's HubSpot billing quote.
 *
 * Not a `"use server"` action of its own. Its callers are `sendQuoteAction`
 * (the rep's Send Quote button — the normal trigger) and
 * `linkTenantCompanyAction`, which resumes a build that was held back waiting
 * for the HubSpot company.
 */
export async function buildAndPublishBillingQuote(
  app: MerchantApplication
): Promise<PublishBillingQuoteResult> {
  const lines = app.quoteLines ?? [];

  // A RATE-ONLY quote: a processing deal with no products picked. HubSpot bills
  // nothing on it — AIO's margin comes out of Adyen settlement and the
  // catalog's two processing products are $0 placeholders that never reach a
  // quote. So no contact, no line item, no quote, no HubSpot object at all.
  // This is a real, supported deal shape (commit c65b4b1, which stopped
  // attaching the install services to one), not an error state.
  if (lines.length === 0) return { status: "skipped", reason: "nothing_to_bill" };

  if (app.hubspotIds?.publishedAt) return { status: "skipped", reason: "already_published" };

  // No HubSpot Company linked yet → nothing may be built. `canPublishBillingQuote`
  // refuses on the same fact, but this short-circuits BEFORE the build claim so
  // the wait leaves no trace: no hubspotIds row, and above all no
  // `lastSyncError`. Waiting on a rep to link a company is the normal state of
  // a fresh account, not a failure, and counting it as one would put every
  // unlinked account in the admin dashboard's sync-error tripwire and drown the
  // real failures it exists to catch.
  //
  // The resume is `linkTenantCompanyAction`, which calls back into here the
  // moment the link is made.
  if (!tenantCompanyId(app)) return { status: "skipped", reason: "awaiting_tenant_link" };

  // ── Claim the build ───────────────────────────────────────────────────────
  // A read-then-write check cannot stop two CONCURRENT builds: both read
  // quoteId: null and both POST a quote, and the second one is unpublishable
  // litter at best. The conditional claim (PHASE-E-SPEC.md §5.6) makes exactly
  // one of them the winner at the database.
  //
  // Two concurrent PUBLISHES need no such lock: HubSpot answers the second PATCH
  // 400 LOCKED, which publishQuote reports as alreadyPublished — one publish and
  // one no-op, never two.
  const claimedAt = new Date();
  const [claimed] = await db
    .update(merchantApplications)
    .set({ hubspotIds: { ...EMPTY_HUBSPOT_IDS, syncedAt: claimedAt.toISOString() }, updatedAt: claimedAt })
    .where(and(eq(merchantApplications.id, app.id), isNull(merchantApplications.hubspotIds)))
    .returning();

  let ids: HubspotIds = { ...EMPTY_HUBSPOT_IDS, syncedAt: claimedAt.toISOString() };
  if (!claimed) {
    // Losing the claim means the row already carries a hubspotIds — either a
    // build running right now, or the wreckage of one that failed. Re-read
    // rather than assume, because the two need opposite treatment.
    const [row] = await db
      .select({ hubspotIds: merchantApplications.hubspotIds })
      .from(merchantApplications)
      .where(eq(merchantApplications.id, app.id))
      .limit(1);
    const existing = row?.hubspotIds;
    if (!existing) return { status: "failed", step: "contact", error: `Application ${app.id} no longer exists` };
    if (existing.publishedAt) return { status: "skipped", reason: "already_published" };

    // In-progress = claimed recently, nothing to show for it yet, and no
    // recorded failure. A failure clears the lease immediately (there is
    // nothing still running), and the lease expires anyway so a function killed
    // mid-build can't wedge the account forever.
    const claimAge = existing.syncedAt ? Date.now() - new Date(existing.syncedAt).getTime() : Infinity;
    const untouched = !existing.contactId && !existing.quoteId && !existing.lineItemIds?.length;
    if (untouched && !existing.lastSyncError && claimAge < BUILD_LEASE_MS) {
      return { status: "skipped", reason: "build_in_progress" };
    }
    ids = existing;
  }

  // ── Preconditions ─────────────────────────────────────────────────────────
  // Resolved here rather than inside the pure checker so every branch of it
  // stays testable without a DB or a network.
  let senderResolved: SenderResolution = { ok: false, code: "no_rep_email" };
  let templateId: string | null = null;
  let catalog: Awaited<ReturnType<typeof listProducts>> = [];
  let maxDiscountPercent = DEFAULT_MAX_DISCOUNT_PERCENT;
  try {
    // listProducts() rather than listQuotableProductsAction(): that action
    // requires a rep/admin session and the trigger here is an unauthenticated
    // acceptance POST. The catalog is needed unfiltered anyway — the derived
    // platform product is one the picker hides.
    [senderResolved, templateId, catalog, maxDiscountPercent] = await Promise.all([
      resolveSender(app.ownerUserId),
      getQuoteTemplatePolicy().then(policy => policy[quoteTypeOf(app.quoteType)]),
      listProducts(),
      getMaxDiscountPercent(),
    ]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await persistSyncError(app.id, ids, `preflight failed: could not load the catalog, sender or template policy: ${detail}`);
    return { status: "failed", step: "contact", error: detail };
  }

  const signer = resolveSigner(app);
  const decision = canPublishBillingQuote({
    app: { ...app, hubspotIds: ids },
    catalog,
    sender: senderResolved,
    signerEmail: signer?.email ?? null,
    templateId,
    maxDiscountPercent,
  });
  if (!decision.ok) {
    if (decision.alreadyPublished) return { status: "skipped", reason: "already_published" };
    // Persisted, not just returned: nobody is watching this call, and a refusal
    // the rep can't see is a merchant who silently never gets billed.
    await persistSyncError(
      app.id, ids,
      `refused before any HubSpot write — ${decision.reasons.map(r => r.message).join(" ")}`
    );
    return { status: "refused", reasons: decision.reasons };
  }

  // Narrowed past the precondition gate, which refuses every sender that did
  // not resolve to a live HubSpot user.
  const sender = senderResolved as Extract<SenderResolution, { ok: true }>;

  console.log(
    `[billing] publishing quote for ${app.id} from ${sender.email} (HubSpot owner ${sender.ownerId}): ` +
    `${decision.lineCount} line(s), ` +
    `one-time $${decision.totals.oneTime.toFixed(2)}, ` +
    `recurring ${decision.totals.recurring.map(r => `$${r.amount.toFixed(2)}/${r.frequency}`).join(" + ") || "none"}, ` +
    `~$${decision.totals.monthlyEquivalent.toFixed(2)}/mo equivalent`
  );

  // Non-null past the precondition gate.
  const dealId = app.hubspotDealId!;
  const template = templateId!;

  // ── The graph, persisting after every step that yields an id ──────────────
  // NOT the Adyen adapter's build-everything-then-persist-once shape
  // (adyen.ts:114-183). A duplicated Adyen legal entity is recoverable; a
  // duplicated PUBLISHED quote is not — it cannot be edited, deleted or voided
  // through the API, and the merchant may already have signed one of them.
  let step: BillingStep = "contact";
  try {
    // 1. Contact. Searched by email first, so a rerun finds the one it already
    //    made instead of mailing the merchant a second e-signature request.
    if (!ids.contactId) {
      const contactId = await ensureQuoteContact({
        firstName: signer!.firstName,
        lastName: signer!.lastName,
        email: signer!.email,
        phone: signer!.phone,
      });
      ids = { ...ids, contactId };
      await persist(app.id, ids);
    }

    // 2. Line items. Reconciled rather than recreated, so a rerun after a
    //    partial create tops up the missing tail instead of duplicating a $999
    //    install. `previousLines` is the same set as `nextLines` here: nothing
    //    edits the quote between acceptance and publish, so the only difference
    //    reconciliation ever sees is a short id list.
    step = "line_items";
    const plan = planLineItemReconciliation(ids.lineItemIds, lines, lines);
    if (plan.create.length > 0 || plan.delete.length > 0) {
      for (const staleId of plan.delete) await deleteQuoteLineItem(staleId);
      const createdIds = await createQuoteLineItems(plan.create.map(c => c.line));
      const byIndex = new Map<number, string>(plan.keep.map(k => [k.nextIndex, k.lineItemId]));
      plan.create.forEach((c, i) => byIndex.set(c.nextIndex, createdIds[i]));
      ids = { ...ids, lineItemIds: lines.map((_, i) => byIndex.get(i)!) };
      await persist(app.id, ids);
    }

    // 3. The draft quote.
    step = "draft_quote";
    if (!ids.quoteId) {
      const expiry = new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000);
      const { quoteId } = await createDraftQuote(
        draftQuoteProperties({ title: quoteTitle(app), expirationDate: isoDate(expiry) })
      );
      ids = { ...ids, quoteId, quoteTemplateId: template };
      await persist(app.id, ids);
    }
    // Deliberately NOT re-PATCHed on a resume. `publishedAt` being null does not
    // prove the quote is still a draft — a crash between HubSpot accepting the
    // publish and the DB write landing leaves exactly that state — and
    // updateDraftQuote would then 400 LOCKED and block the very recovery path
    // publishQuote's LOCKED-means-published rule exists to provide.

    // 4. Associations. All five, every time: the v4 PUT is idempotent, so
    //    re-running a half-finished build simply no-ops the ones already there.
    step = "associations";
    const assocs: QuoteAssociation[] = [
      ...(ids.lineItemIds ?? []).map(id => ({
        toObjectType: "line_items" as const, toObjectId: id, associationTypeId: QUOTE_TO_LINE_ITEM,
      })),
      { toObjectType: "deals", toObjectId: dealId, associationTypeId: QUOTE_TO_DEAL },
      { toObjectType: "contacts", toObjectId: ids.contactId!, associationTypeId: QUOTE_TO_CONTACT },
      // 702 is the signer pair specifically, and it is mandatory because
      // hs_acceptance_method is forced to `esignature` (print_and_sign is
      // incompatible with hs_payment_enabled).
      { toObjectType: "contacts", toObjectId: ids.contactId!, associationTypeId: QUOTE_TO_SIGNER_CONTACT },
      { toObjectType: "quote_template", toObjectId: template, associationTypeId: QUOTE_TO_TEMPLATE },
    ];
    await associateQuote(ids.quoteId!, assocs);
    // CRM tidiness, and best-effort inside the adapter: a deal whose quote has a
    // signer the deal itself doesn't list is confusing to work.
    await associateDealToContact(dealId, ids.contactId!);

    // 5. THE ONE-WAY DOOR.
    //
    //    Awaited inline, never fire-and-forget. An un-awaited promise in a
    //    serverless function can be killed the moment the response is returned,
    //    and for an IRREVERSIBLE publish that leaves the worst state there is:
    //    HubSpot may or may not have published, the DB says draft, and nobody
    //    knows which. Holding the acceptance request open for a few seconds is
    //    a trivially better trade — and the caller has already sent the
    //    customer's login email by this point, so nobody is waiting on it.
    step = "publish";
    const published = await publishQuote(ids.quoteId!, {
      email: sender.email, firstName: sender.firstName, lastName: sender.lastName,
    });
    ids = {
      ...ids,
      publishedAt: new Date().toISOString(),
      quoteLink: published.quoteLink,
      paymentStatus: published.paymentStatus,
      syncedAt: new Date().toISOString(),
      lastSyncError: null,
      lastSyncErrorAt: null,
    };
    await persist(app.id, ids);

    return {
      status: "published",
      quoteId: ids.quoteId!,
      quoteLink: published.quoteLink,
      alreadyPublished: published.alreadyPublished,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await persistSyncError(app.id, ids, stepFailure(ids, step, detail));
    return { status: "failed", step, error: detail };
  }
}
