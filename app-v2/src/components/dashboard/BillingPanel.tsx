"use client";

import { useState } from "react";
import { getApplicationAction } from "@/lib/actions/applications";
import { sendQuoteAction, type SendQuoteResult } from "@/lib/actions/billing";
import type { PublishRefusal } from "@/lib/billing/preconditions";
import {
  billingPanelState,
  canSendQuote,
  hasBillingSyncError,
  hubspotQuoteUrl,
  PAYMENT_STATUS_LAG_DAYS,
  subscriptionMoney,
  subscriptionStatusColor,
} from "@/lib/billingView";
import { fmt$ } from "@/lib/utils";
import type { MerchantApplication } from "@/types/merchant";
import shared from "./AccountsDashboard.module.css";
import styles from "./BillingPanel.module.css";
import { Field, Section } from "./DetailSection";

// Not documented anywhere yet (no HubSpot portal id lives in this codebase
// today) — when unset, the quote id still renders as plain copyable text
// instead of a broken link. Set NEXT_PUBLIC_HUBSPOT_PORTAL_ID to turn it
// into a link to the actual HubSpot record.
const HUBSPOT_PORTAL_ID = process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID;

// hs_quote_esign_status, in rep language. Signing and paying are separate acts
// on one HubSpot page, so SIGNED with no subscription is a real and common
// state (observed live 2026-09-25 on quote 330655913691) — and it was visible
// nowhere on this panel, which reported only the payment half.
const ESIGN_LABELS: Record<string, string> = {
  SIGNED: "Signed",
  PENDING_SIGNATURE: "Awaiting signature",
  NO_ESIGN_STATUS: "Not sent",
};

type Props = {
  app: MerchantApplication;
  /** Owner rep or any admin — same gate AccountsDashboard already applies to
   *  every other mutating affordance on this panel. A customer never reaches
   *  this component at all (it only renders on /rep and /admin). */
  canManage: boolean;
  onUpdated: (app: MerchantApplication) => void;
};

/**
 * The rep/admin HubSpot billing surface (PHASE-E-SPEC.md §5.7 / this task's
 * Deliverable 1). Read-only plus ONE write: Send Quote, which publishes to
 * HubSpot and is how the merchant ever sees a quote to sign.
 *
 * That button is the one-way door. Once `publishedAt` is set nothing below
 * offers edit, unpublish, or void — a published quote can't be changed
 * through the API at all (voiding is HubSpot-UI-only) — and the button itself
 * disappears. A rep who needs to change a published quote is told to do it in
 * HubSpot, not offered a button that implies otherwise.
 */
export function BillingPanel({ app, canManage, onUpdated }: Props) {
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendQuoteResult | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  const state = billingPanelState(app);

  if (state === "not_configured") {
    return (
      <Section label="Billing">
        <div className={styles.emptyNote}>
          No quote configured yet — add the products this merchant is buying, then send it.
        </div>
      </Section>
    );
  }

  if (state === "rate_only") {
    return (
      <Section label="Billing">
        <div className={styles.emptyNote}>
          Rate-only quote — there are no billable lines, so no HubSpot quote will ever be built for this
          account. AIO&rsquo;s margin here comes out of Adyen settlement, not HubSpot billing.
        </div>
      </Section>
    );
  }

  if (state === "awaiting_tenant_link") {
    return (
      <Section label="Billing">
        <div className={styles.emptyNote}>
          Waiting on the HubSpot company link. Nothing is created in HubSpot until this account is
          linked to its company — a deal can only be attached to a company when it is created, so one
          made now would never show up on the company record. Link the tenant company above and the
          deal and quote are built automatically.
        </div>
      </Section>
    );
  }

  const hubspotIds = app.hubspotIds;
  const quoteUrl = hubspotIds?.quoteId ? hubspotQuoteUrl(hubspotIds.quoteId, HUBSPOT_PORTAL_ID) : null;
  const subscriptions = hubspotIds?.subscriptions ?? [];
  const errored = hasBillingSyncError(hubspotIds);
  const showSend = canManage && canSendQuote(app);

  const copyLink = () => {
    if (!hubspotIds?.quoteLink) return;
    navigator.clipboard.writeText(hubspotIds.quoteLink);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  const handleSend = async () => {
    setSending(true);
    setResult(null);
    try {
      const outcome = await sendQuoteAction(app.id);
      setResult(outcome);
      // Whatever happened, the row on disk may have changed (a new deal id, a
      // partial line-item set, a persisted lastSyncError) — re-load the full
      // application rather than trying to patch it together from `outcome`,
      // which only carries a quoteLink on success.
      const refreshed = await getApplicationAction(app.id);
      if (refreshed) onUpdated(refreshed);
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : "Could not send the quote" });
    }
    setSending(false);
  };

  return (
    <Section label="Billing">
      {errored && (
        <div className={styles.errorBanner}>
          <div className={styles.errorBannerTitle}>HubSpot sync failed</div>
          <div className={styles.errorBannerMessage}>{hubspotIds!.lastSyncError}</div>
          {hubspotIds!.lastSyncErrorAt && (
            <div className={styles.errorBannerMeta}>{new Date(hubspotIds!.lastSyncErrorAt).toLocaleString()}</div>
          )}
        </div>
      )}

      {/* The HubSpot document only. The deal id lives once, in the HubSpot
          section above, and what the merchant is buying lives once, in the
          Quote section — both used to be repeated here in different words. */}
      <div className={shared.detailGrid}>
        <Field
          label="Quote"
          value={
            hubspotIds?.quoteId
              ? quoteUrl
                ? <a href={quoteUrl} target="_blank" rel="noreferrer">{hubspotIds.quoteId}</a>
                : hubspotIds.quoteId
              : "—"
          }
          meta={hubspotIds?.quoteTemplateId ? `Template ${hubspotIds.quoteTemplateId}` : undefined}
        />
        <Field
          label="Status"
          value={
            hubspotIds?.publishedAt ? (
              <span className={shared.badge} style={{ background: "var(--success-bg)", color: "var(--success)" }}>
                Published {new Date(hubspotIds.publishedAt).toLocaleDateString()}
              </span>
            ) : (
              <span className={shared.badge} style={{ background: "var(--warning-bg)", color: "var(--warning)" }}>
                Draft
              </span>
            )
          }
        />
        <Field
          label="Signature"
          value={
            hubspotIds?.esignStatus
              ? ESIGN_LABELS[hubspotIds.esignStatus] ?? hubspotIds.esignStatus
              : "—"
          }
        />
        <Field
          label="Payment"
          value={hubspotIds?.paymentStatus || "—"}
          meta={hubspotIds?.paymentDate ? `Paid ${new Date(hubspotIds.paymentDate).toLocaleDateString()}` : undefined}
        />
      </div>

      {/* Signed but not paid. Both halves happen on one HubSpot page, so this
          merchant believes they are done and is looking at a locked checklist —
          it is the whole reason their onboarding has stalled, and it was
          previously readable only by cross-referencing two fields. */}
      {hubspotIds?.esignStatus === "SIGNED" && subscriptions.length === 0 && (
        <div className={styles.note}>
          Signed, but checkout was never finished — no subscription exists yet, so nothing is billing.
          The merchant needs to return to their quote link and enter billing details.
        </div>
      )}

      {hubspotIds?.publishedAt && hubspotIds.paymentStatus && hubspotIds.paymentStatus !== "PAID" && (
        <div className={styles.note}>
          ACH settlement is a daily batch, so a paid quote can keep reading &ldquo;{hubspotIds.paymentStatus}&rdquo;
          here for a median of {PAYMENT_STATUS_LAG_DAYS} days after the customer actually checks out. If the
          merchant says they already paid, that is expected — not a sign anything is broken.
        </div>
      )}

      {hubspotIds?.publishedAt && hubspotIds.quoteLink && (
        <div>
          <div className={shared.subLabel}>Customer payment page</div>
          <div className={shared.linkRow}>
            <code className={shared.linkCode}>{hubspotIds.quoteLink}</code>
            <button
              className={shared.btnCopy}
              data-copied={linkCopied}
              onClick={copyLink}
            >
              {linkCopied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
      )}

      <div>
        <div className={shared.subLabel}>
          Subscriptions{subscriptions.length > 0 ? ` (${subscriptions.length})` : ""}
        </div>
        {subscriptions.length === 0 ? (
          <div className={styles.emptyNote}>
            {hubspotIds?.publishedAt
              ? "None yet — HubSpot creates these once the customer finishes checkout."
              : "None yet."}
          </div>
        ) : (
          <div className={styles.subList}>
            {subscriptions.map(sub => {
              const money = subscriptionMoney(sub);
              const color = subscriptionStatusColor(sub.status);
              return (
                <div key={sub.subscriptionId} className={styles.subRow}>
                  <span className={styles.subStatus} style={{ background: color.bg, color: color.fg }}>
                    {(sub.status ?? "unknown").replace(/_/g, " ")}
                  </span>
                  <span className={styles.subMoney}>
                    {money
                      ? `${money.perCycleLabel} ${money.monthlyLabel}`
                      : sub.mrr != null
                        ? `${fmt$(sub.mrr)}/mo`
                        : "—"}
                  </span>
                  <span className={shared.detailMeta}>{sub.paymentMethod || "no payment method"}</span>
                  <div className={styles.subMeta}>
                    {sub.billingStartDate && <span>first charge {sub.billingStartDate}</span>}
                    {sub.lastPaymentStatus && <span>last payment: {sub.lastPaymentStatus}</span>}
                    {sub.completedPayments != null && <span>{sub.completedPayments} completed</span>}
                    {sub.totalCollected != null && sub.totalCollected > 0 && (
                      <span>{fmt$(sub.totalCollected)} collected</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showSend && (
        <div className={styles.retryRow}>
          {/* NOT the normal path any more. The merchant publishes this
              themselves by continuing to billing from their own quote link
              (/api/lead/[token]/checkout) — this is the escape hatch for a rep
              sitting with them or finishing on the phone, and nothing waits on
              it. The irreversibility is stated before the click rather than
              behind a modal: a published quote can't be edited, replaced or
              voided through the API, and the merchant signs an ACH mandate
              against it. */}
          <div className={styles.emptyNote}>
            The merchant can do this themselves from their quote link — you only need this if
            you&rsquo;re finishing the deal with them. Publishing emails them the e-signature
            request, and it can&rsquo;t be edited, replaced or voided afterwards — check the lines
            first.
          </div>
          <button className={shared.btnPrimary} disabled={sending} onClick={handleSend}>
            {sending ? "Publishing…" : "Publish Quote Now"}
          </button>
          {result && !result.ok && result.reasons && result.reasons.length > 0 && (
            <ul className={styles.reasonList}>
              {result.reasons.map((r: PublishRefusal) => <li key={r.code}>{r.message}</li>)}
            </ul>
          )}
          {result && !result.ok && result.error && (
            <div className={styles.errorBannerMessage}>{result.error}</div>
          )}
          {result && result.ok && (
            <div className={styles.emptyNote}>Quote published — the merchant can now sign and pay it.</div>
          )}
        </div>
      )}

      {hubspotIds?.publishedAt && (
        <div className={styles.emptyNote}>
          This quote is published and can&rsquo;t be edited, deleted, or voided from EasyOB — voiding is only
          possible by hand in HubSpot. To change it, do that directly in HubSpot.
        </div>
      )}
    </Section>
  );
}
