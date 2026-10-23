// The one-time invoice (2026-10-22, product owner).
//
// Hardware, installation and training used to sit on the HubSpot quote and be
// collected at checkout. They now go on a HubSpot INVOICE, built and OPENED
// the moment the quote is published (product owner, 2026-10-23), so the
// merchant has both links side by side: the subscription to sign and pay, and
// the invoice to look at. The quote keeps the recurring lines plus the $0.50
// pre-auth (`splitQuoteLines`).
//
// Opened, never sent: HubSpot emails an invoice only from its own UI, and
// EasyOB sends nothing either. AIO staff charge it in HubSpot when they choose
// ("In hubspot we will just charge them when we please"), against the payment
// method stored at the quote's checkout. The link is real, so the merchant can
// also pay it themselves — accepted. The checklist keeps the Quote & Billing
// row open until HubSpot reports it paid.
//
// Graph:
//   Invoice ──409──▶ line items (its own; a line item has exactly one parent)
//      ├──177──▶ Contact (the quote's signer)
//      ├──179──▶ Company (the tenant company)
//      └──175──▶ Deal
//
// Same claim / persist-every-id / resume shape as buildAndPublishBillingQuote,
// so two observers of one publish build one invoice, not two. An open invoice
// is still editable and voidable (probe, 2026-10-23), so this path opens no
// one-way door. State lives in its OWN
// column, `hubspot_invoice`, which only this file writes — see HubspotInvoice.
//
// Never gates onboarding: acceptance and provisioning still gate on the
// subscription alone (`hasBillingCompleted`).
//
// Server-side only, and no "server-only" marker of its own for the same reason
// as publishBillingQuote.ts: it imports lib/db/client, which carries one.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications } from "@/lib/db/schema";
import { rowToApp } from "@/lib/storage/applicationRow";
import {
  INVOICE_TO_COMPANY,
  INVOICE_TO_CONTACT,
  INVOICE_TO_DEAL,
  INVOICE_TO_LINE_ITEM,
  associateInvoice,
  createDraftInvoice,
  createQuoteLineItems,
  deleteQuoteLineItem,
  draftInvoiceProperties,
  getInvoiceSnapshot,
  openInvoice,
  planLineItemReconciliation,
  tenantCompanyId,
  type InvoiceSnapshot,
} from "@/lib/adapters/hubspot";
import { MIN_CHECKOUT_AMOUNT, lineNetAmount, splitQuoteLines } from "@/lib/quoting";
import { EMPTY_HUBSPOT_INVOICE, type HubspotInvoice, type MerchantApplication } from "@/types/merchant";

// Same lease as the quote build: a handful of HubSpot calls, so two minutes is
// generous, and past it a retry resumes rather than refusing forever.
const BUILD_LEASE_MS = 2 * 60 * 1000;

export type InvoiceStep = "preflight" | "line_items" | "draft_invoice" | "associations" | "open";

export type OneTimeInvoiceResult =
  | { status: "built"; invoiceId: string }
  /**
   *  - `not_published`: nothing is invoiced before the quote is published.
   *  - `not_split`: the quote was published before split billing, so its
   *    one-time lines are on the quote already. Invoicing them would bill twice.
   *  - `nothing_to_invoice`: no one-time lines, or every one is comped.
   *  - `already_built`: the invoice exists, is fully associated and is open.
   *  - `build_in_progress`: another request holds the lease.
   */
  | {
      status: "skipped";
      reason: "not_published" | "not_split" | "nothing_to_invoice" | "already_built" | "build_in_progress";
    }
  | { status: "failed"; step: InvoiceStep; error: string };

async function persist(applicationId: string, inv: HubspotInvoice): Promise<void> {
  await db
    .update(merchantApplications)
    .set({ hubspotInvoice: inv, updatedAt: new Date() })
    .where(eq(merchantApplications.id, applicationId));
}

async function persistError(applicationId: string, inv: HubspotInvoice, message: string): Promise<void> {
  try {
    await persist(applicationId, { ...inv, lastSyncError: message, lastSyncErrorAt: new Date().toISOString() });
  } catch (err) {
    console.error("buildOneTimeInvoice: could not persist the failure state", applicationId, err);
  }
}

function progressSummary(inv: HubspotInvoice): string {
  const done: string[] = [];
  if (inv.lineItemIds?.length) done.push(`${inv.lineItemIds.length} line item(s) created`);
  if (inv.invoiceId) done.push(`draft invoice ${inv.invoiceId} created`);
  if (inv.openedAt) done.push("opened");
  return done.length ? done.join(", ") : "nothing created yet";
}

/** What the invoice will bill: the invoiced lines and their net total. */
export function invoiceLinesFor(app: Pick<MerchantApplication, "quoteLines">) {
  const { invoiceLines } = splitQuoteLines(app.quoteLines ?? []);
  const total = Math.round(invoiceLines.reduce((n, l) => n + lineNetAmount(l), 0) * 100) / 100;
  return { invoiceLines, total };
}

/** Fully built: associated AND opened. A draft built before 2026-10-23 has
 *  `builtAt` but no `openedAt`, and a rerun opens it. */
function isDone(inv: HubspotInvoice | null | undefined): boolean {
  return !!inv?.builtAt && !!inv.openedAt;
}

/**
 * Build this application's one-time invoice and open it. Idempotent: every
 * call after the first either resumes an unfinished build or does nothing.
 */
export async function buildOneTimeInvoice(app: MerchantApplication): Promise<OneTimeInvoiceResult> {
  if (!app.hubspotIds?.publishedAt) return { status: "skipped", reason: "not_published" };
  if (!app.hubspotIds?.splitBilling) return { status: "skipped", reason: "not_split" };

  const { invoiceLines, total } = invoiceLinesFor(app);
  // HubSpot can't take a payment under $0.50 (the quote's own floor), and a
  // fully comped kit owes nothing at all — no invoice is the right answer.
  if (invoiceLines.length === 0 || total < MIN_CHECKOUT_AMOUNT) {
    return { status: "skipped", reason: "nothing_to_invoice" };
  }
  if (isDone(app.hubspotInvoice)) return { status: "skipped", reason: "already_built" };

  // ── Claim the build ───────────────────────────────────────────────────────
  // Same conditional claim as the quote: of two concurrent observers of the
  // same acceptance, exactly one gets to create an invoice.
  const claimedAt = new Date();
  const [claimed] = await db
    .update(merchantApplications)
    .set({ hubspotInvoice: { ...EMPTY_HUBSPOT_INVOICE, amount: total, syncedAt: claimedAt.toISOString() }, updatedAt: claimedAt })
    .where(and(eq(merchantApplications.id, app.id), isNull(merchantApplications.hubspotInvoice)))
    .returning();

  let inv: HubspotInvoice = { ...EMPTY_HUBSPOT_INVOICE, amount: total, syncedAt: claimedAt.toISOString() };
  if (!claimed) {
    const [row] = await db
      .select({ hubspotInvoice: merchantApplications.hubspotInvoice })
      .from(merchantApplications)
      .where(eq(merchantApplications.id, app.id))
      .limit(1);
    const existing = row?.hubspotInvoice;
    if (!existing) return { status: "failed", step: "preflight", error: `Application ${app.id} no longer exists` };
    if (isDone(existing)) return { status: "skipped", reason: "already_built" };
    const claimAge = existing.syncedAt ? Date.now() - new Date(existing.syncedAt).getTime() : Infinity;
    const untouched = !existing.invoiceId && !existing.lineItemIds?.length;
    if (untouched && !existing.lastSyncError && claimAge < BUILD_LEASE_MS) {
      return { status: "skipped", reason: "build_in_progress" };
    }
    inv = existing;
  }

  // ── Preflight ─────────────────────────────────────────────────────────────
  // All three are facts the quote publish already established; missing one on
  // an accepted row is a data problem to fix, and it is said in those words.
  const contactId = app.hubspotIds.contactId;
  const companyId = tenantCompanyId(app);
  const dealId = app.hubspotDealId;
  const missing = [
    !contactId && "the quote's HubSpot contact",
    !companyId && "a linked HubSpot company",
    !dealId && "a HubSpot deal",
  ].filter(Boolean);
  if (missing.length > 0) {
    const error = `one-time invoice refused before any HubSpot write — missing ${missing.join(", ")}.`;
    await persistError(app.id, inv, error);
    return { status: "failed", step: "preflight", error };
  }

  let step: InvoiceStep = "line_items";
  try {
    // 1. Line items, reconciled so a rerun tops up rather than duplicates.
    const plan = planLineItemReconciliation(inv.lineItemIds, invoiceLines, invoiceLines);
    if (plan.create.length > 0 || plan.delete.length > 0) {
      for (const staleId of plan.delete) await deleteQuoteLineItem(staleId);
      const createdIds = await createQuoteLineItems(plan.create.map(c => c.line));
      const byIndex = new Map<number, string>(plan.keep.map(k => [k.nextIndex, k.lineItemId]));
      plan.create.forEach((c, i) => byIndex.set(c.nextIndex, createdIds[i]));
      inv = { ...inv, lineItemIds: invoiceLines.map((_, i) => byIndex.get(i)!) };
      await persist(app.id, inv);
    }

    // 2. The draft invoice.
    step = "draft_invoice";
    if (!inv.invoiceId) {
      const invoiceId = await createDraftInvoice(draftInvoiceProperties(new Date().toISOString().slice(0, 10)));
      inv = { ...inv, invoiceId };
      await persist(app.id, inv);
    }
    const invoiceId = inv.invoiceId!;

    // 3. Associations — idempotent PUTs, so a rerun simply re-asserts them.
    step = "associations";
    await associateInvoice(invoiceId, [
      ...inv.lineItemIds!.map(id => ({
        toObjectType: "line_items" as const, toObjectId: id, associationTypeId: INVOICE_TO_LINE_ITEM,
      })),
      { toObjectType: "contacts", toObjectId: contactId!, associationTypeId: INVOICE_TO_CONTACT },
      { toObjectType: "companies", toObjectId: companyId!, associationTypeId: INVOICE_TO_COMPANY },
      { toObjectType: "deals", toObjectId: dealId!, associationTypeId: INVOICE_TO_DEAL },
    ]);

    // 4. Open it — that is what makes hs_invoice_link a working page. Sends nothing.
    step = "open";
    if (!inv.openedAt) {
      await openInvoice(invoiceId);
      inv = { ...inv, status: "open", openedAt: new Date().toISOString() };
      await persist(app.id, inv);
    }
    const snapshot = await getInvoiceSnapshot(invoiceId);

    inv = {
      ...inv,
      amount: total,
      status: snapshot?.status ?? inv.status,
      paymentStatus: snapshot?.paymentStatus ?? inv.paymentStatus,
      balanceDue: snapshot?.balanceDue ?? inv.balanceDue,
      invoiceLink: snapshot?.invoiceLink ?? inv.invoiceLink,
      builtAt: inv.builtAt ?? new Date().toISOString(),
      lastSyncError: null,
      lastSyncErrorAt: null,
    };
    await persist(app.id, inv);
    console.log(`[invoice] ${app.id}: invoice ${invoiceId} built and opened for $${total.toFixed(2)} — charge it in HubSpot`);
    return { status: "built", invoiceId };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await persistError(app.id, inv, `${progressSummary(inv)}; ${step} failed: ${detail}`);
    return { status: "failed", step, error: detail };
  }
}

/** Whether HubSpot has the invoice paid. Either property can say so first. */
export function isInvoicePaid(inv: HubspotInvoice | null | undefined): boolean {
  return inv?.paymentStatus === "paid" || inv?.status === "paid";
}

/**
 * A stored invoice with a fresh HubSpot read folded in, or null when nothing
 * the merchant could see has moved. The link is never erased by a read that
 * came back without one.
 */
export function mergeInvoiceSnapshot(inv: HubspotInvoice, snap: InvoiceSnapshot): HubspotInvoice | null {
  const invoiceLink = snap.invoiceLink ?? inv.invoiceLink ?? null;
  const moved =
    snap.status !== inv.status || snap.paymentStatus !== inv.paymentStatus ||
    snap.balanceDue !== inv.balanceDue || invoiceLink !== (inv.invoiceLink ?? null);
  if (!moved) return null;
  return {
    ...inv,
    status: snap.status,
    paymentStatus: snap.paymentStatus,
    balanceDue: snap.balanceDue,
    invoiceLink,
    syncedAt: new Date().toISOString(),
  };
}

/**
 * For callers that must never throw — acceptance detection above all, whose
 * own contract is that nothing after the acceptance write can un-accept a
 * merchant. Every failure is already persisted on `hubspotInvoice`.
 */
export async function buildOneTimeInvoiceSafely(app: MerchantApplication): Promise<void> {
  try {
    const result = await buildOneTimeInvoice(app);
    if (result.status === "failed") {
      console.error(`[invoice] ${app.id}: ${result.step} failed — ${result.error}`);
    }
  } catch (err) {
    console.error(`[invoice] ${app.id}: invoice build threw`, err instanceof Error ? err.message : err);
  }
}

/**
 * The same, by id, reading the row fresh — for `after()` callbacks that run
 * once the publish that made the invoice buildable has been written.
 */
export async function buildOneTimeInvoiceForId(applicationId: string): Promise<void> {
  try {
    const [row] = await db.select().from(merchantApplications).where(eq(merchantApplications.id, applicationId)).limit(1);
    if (row) await buildOneTimeInvoiceSafely(rowToApp(row));
  } catch (err) {
    console.error(`[invoice] ${applicationId}: could not load the row to build its invoice`, err instanceof Error ? err.message : err);
  }
}
