// The one-time invoice (2026-10-22, product owner).
//
// Hardware, installation and training used to sit on the HubSpot quote and be
// collected at checkout. They now go on a HubSpot INVOICE, built right after
// acceptance is detected, due on receipt, ACH only, and its pay link emailed to
// the billing contact. The quote keeps the recurring lines plus the $0.50
// pre-auth (`splitQuoteLines`).
//
// Graph:
//   Invoice ──409──▶ line items (its own; a line item has exactly one parent)
//      ├──177──▶ Contact (the quote's signer)
//      ├──179──▶ Company (the tenant company)
//      └──175──▶ Deal
//
// Same shape as buildAndPublishBillingQuote, for the same reason: an open
// invoice is treated as a one-way door, so the build claims the row, persists
// after every step that yields an id, and resumes from those ids rather than
// building a second invoice. State lives in its OWN column, `hubspot_invoice`,
// which only this file writes — see HubspotInvoice.
//
// Never gates onboarding: acceptance and provisioning still gate on the
// subscription alone (`hasBillingCompleted`). An unpaid invoice is a
// collections question, not a reason to hold a merchant who has signed.
//
// Server-side only, and no "server-only" marker of its own for the same reason
// as publishBillingQuote.ts: it imports lib/db/client, which carries one.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications } from "@/lib/db/schema";
import { sendOneTimeInvoiceEmail } from "@/lib/adapters/email";
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
} from "@/lib/adapters/hubspot";
import { MIN_CHECKOUT_AMOUNT, lineNetAmount, splitQuoteLines } from "@/lib/quoting";
import { EMPTY_HUBSPOT_INVOICE, type HubspotInvoice, type MerchantApplication } from "@/types/merchant";

// Same lease as the quote build: a handful of HubSpot calls, so two minutes is
// generous, and past it a retry resumes rather than refusing forever.
const BUILD_LEASE_MS = 2 * 60 * 1000;

export type InvoiceStep = "preflight" | "line_items" | "draft_invoice" | "associations" | "open" | "email";

export type OneTimeInvoiceResult =
  | { status: "sent"; invoiceId: string; invoiceLink: string }
  /**
   *  - `not_accepted`: nothing is invoiced before acceptance.
   *  - `not_split`: the quote was published before split billing, so its
   *    one-time lines are on the quote already. Invoicing them would bill twice.
   *  - `nothing_to_invoice`: no one-time lines, or every one is comped.
   *  - `already_sent`: built, opened and emailed.
   *  - `build_in_progress`: another request holds the lease.
   */
  | {
      status: "skipped";
      reason: "not_accepted" | "not_split" | "nothing_to_invoice" | "already_sent" | "build_in_progress";
    }
  | { status: "failed"; step: InvoiceStep; error: string };

function money(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The billing contact if the merchant named one, otherwise the owner. */
function invoiceRecipient(app: MerchantApplication): string | null {
  return app.billingContact?.email?.trim() || app.ownerContact?.email?.trim() || null;
}

function merchantName(app: MerchantApplication): string | undefined {
  return app.business?.dba?.trim() || app.business?.legalName?.trim() || undefined;
}

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
    console.error("buildAndSendOneTimeInvoice: could not persist the failure state", applicationId, err);
  }
}

function progressSummary(inv: HubspotInvoice): string {
  const done: string[] = [];
  if (inv.lineItemIds?.length) done.push(`${inv.lineItemIds.length} line item(s) created`);
  if (inv.invoiceId) done.push(`draft invoice ${inv.invoiceId} created`);
  if (inv.openedAt) done.push(`invoice opened ${inv.openedAt}`);
  return done.length ? done.join(", ") : "nothing created yet";
}

/** What the invoice will bill: the invoiced lines and their net total. */
export function invoiceLinesFor(app: MerchantApplication) {
  const { invoiceLines } = splitQuoteLines(app.quoteLines ?? []);
  const total = Math.round(invoiceLines.reduce((n, l) => n + lineNetAmount(l), 0) * 100) / 100;
  return { invoiceLines, total };
}

/**
 * Build, open and email this application's one-time invoice. Idempotent: every
 * call after the first either resumes an unfinished build or does nothing.
 */
export async function buildAndSendOneTimeInvoice(app: MerchantApplication): Promise<OneTimeInvoiceResult> {
  if (!app.quoteAcceptedAt) return { status: "skipped", reason: "not_accepted" };
  if (!app.hubspotIds?.splitBilling) return { status: "skipped", reason: "not_split" };

  const { invoiceLines, total } = invoiceLinesFor(app);
  // HubSpot can't take a payment under $0.50 (the quote's own floor), and a
  // fully comped kit owes nothing at all — no invoice is the right answer.
  if (invoiceLines.length === 0 || total < MIN_CHECKOUT_AMOUNT) {
    return { status: "skipped", reason: "nothing_to_invoice" };
  }
  if (app.hubspotInvoice?.emailedAt) return { status: "skipped", reason: "already_sent" };

  // ── Claim the build ───────────────────────────────────────────────────────
  // Same conditional claim as the quote: of two concurrent observers of the
  // same acceptance, exactly one gets to create an invoice.
  const claimedAt = new Date();
  const [claimed] = await db
    .update(merchantApplications)
    .set({ hubspotInvoice: { ...EMPTY_HUBSPOT_INVOICE, syncedAt: claimedAt.toISOString() }, updatedAt: claimedAt })
    .where(and(eq(merchantApplications.id, app.id), isNull(merchantApplications.hubspotInvoice)))
    .returning();

  let inv: HubspotInvoice = { ...EMPTY_HUBSPOT_INVOICE, syncedAt: claimedAt.toISOString() };
  if (!claimed) {
    const [row] = await db
      .select({ hubspotInvoice: merchantApplications.hubspotInvoice })
      .from(merchantApplications)
      .where(eq(merchantApplications.id, app.id))
      .limit(1);
    const existing = row?.hubspotInvoice;
    if (!existing) return { status: "failed", step: "preflight", error: `Application ${app.id} no longer exists` };
    if (existing.emailedAt) return { status: "skipped", reason: "already_sent" };
    const claimAge = existing.syncedAt ? Date.now() - new Date(existing.syncedAt).getTime() : Infinity;
    const untouched = !existing.invoiceId && !existing.lineItemIds?.length;
    if (untouched && !existing.lastSyncError && claimAge < BUILD_LEASE_MS) {
      return { status: "skipped", reason: "build_in_progress" };
    }
    inv = existing;
  }

  // ── Preflight ─────────────────────────────────────────────────────────────
  // All four are facts the quote publish already established; missing one on
  // an accepted row is a data problem to fix, and it is said in those words.
  const contactId = app.hubspotIds.contactId;
  const companyId = tenantCompanyId(app);
  const dealId = app.hubspotDealId;
  const recipient = invoiceRecipient(app);
  const missing = [
    !contactId && "the quote's HubSpot contact",
    !companyId && "a linked HubSpot company",
    !dealId && "a HubSpot deal",
    !recipient && "a billing or owner email",
  ].filter(Boolean);
  if (missing.length > 0) {
    const error = `one-time invoice refused before any HubSpot write — missing ${missing.join(", ")}.`;
    await persistError(app.id, inv, error);
    return { status: "failed", step: "preflight", error };
  }

  let step: InvoiceStep = "line_items";
  try {
    // 1. Line items, reconciled so a rerun tops up rather than duplicates.
    //    Only while the invoice is still a draft — an open invoice's lines are
    //    whatever HubSpot already has.
    if (!inv.openedAt) {
      const plan = planLineItemReconciliation(inv.lineItemIds, invoiceLines, invoiceLines);
      if (plan.create.length > 0 || plan.delete.length > 0) {
        for (const staleId of plan.delete) await deleteQuoteLineItem(staleId);
        const createdIds = await createQuoteLineItems(plan.create.map(c => c.line));
        const byIndex = new Map<number, string>(plan.keep.map(k => [k.nextIndex, k.lineItemId]));
        plan.create.forEach((c, i) => byIndex.set(c.nextIndex, createdIds[i]));
        inv = { ...inv, lineItemIds: invoiceLines.map((_, i) => byIndex.get(i)!) };
        await persist(app.id, inv);
      }
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
    if (!inv.openedAt) {
      await associateInvoice(invoiceId, [
        ...inv.lineItemIds!.map(id => ({
          toObjectType: "line_items" as const, toObjectId: id, associationTypeId: INVOICE_TO_LINE_ITEM,
        })),
        { toObjectType: "contacts", toObjectId: contactId!, associationTypeId: INVOICE_TO_CONTACT },
        { toObjectType: "companies", toObjectId: companyId!, associationTypeId: INVOICE_TO_COMPANY },
        { toObjectType: "deals", toObjectId: dealId!, associationTypeId: INVOICE_TO_DEAL },
      ]);
    }

    // 4. Open it. `openInvoice` reads first, so an invoice HubSpot already
    //    opened (crash before our write) is recognised, not reopened.
    step = "open";
    if (!inv.openedAt) {
      const snap = await openInvoice(invoiceId);
      inv = {
        ...inv,
        status: snap.status,
        paymentStatus: snap.paymentStatus,
        balanceDue: snap.balanceDue,
        invoiceLink: snap.invoiceLink,
        openedAt: new Date().toISOString(),
      };
      await persist(app.id, inv);
    }

    // 5. Email the pay link. Marked sent only once it actually went, so a
    //    failure here is retried by the nightly cron and a success never is.
    step = "email";
    if (!inv.invoiceLink) {
      const snap = await getInvoiceSnapshot(invoiceId);
      inv = { ...inv, invoiceLink: snap?.invoiceLink ?? null };
    }
    if (!inv.invoiceLink) throw new Error(`invoice ${invoiceId} is open but HubSpot has no hs_invoice_link for it yet`);
    const invoiceLink = inv.invoiceLink;
    const sent = await sendOneTimeInvoiceEmail(recipient!, invoiceLink, money(total), merchantName(app));
    if (!sent.sent) throw new Error(`no email transport delivered the invoice link to ${recipient}`);

    inv = { ...inv, emailedAt: new Date().toISOString(), lastSyncError: null, lastSyncErrorAt: null };
    await persist(app.id, inv);
    console.log(`[invoice] ${app.id}: invoice ${invoiceId} opened and emailed to ${recipient} (${money(total)})`);
    return { status: "sent", invoiceId, invoiceLink };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await persistError(app.id, inv, `${progressSummary(inv)}; ${step} failed: ${detail}`);
    return { status: "failed", step, error: detail };
  }
}

/**
 * For callers that must never throw — acceptance detection above all, whose
 * own contract is that nothing after the acceptance write can un-accept a
 * merchant. Every failure is already persisted on `hubspotInvoice`.
 */
export async function issueOneTimeInvoiceSafely(app: MerchantApplication): Promise<void> {
  try {
    const result = await buildAndSendOneTimeInvoice(app);
    if (result.status === "failed") {
      console.error(`[invoice] ${app.id}: ${result.step} failed — ${result.error}`);
    }
  } catch (err) {
    console.error(`[invoice] ${app.id}: invoice build threw`, err instanceof Error ? err.message : err);
  }
}
