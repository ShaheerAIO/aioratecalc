"use client";

import { useState } from "react";
import { getApplicationAction } from "@/lib/actions/applications";
import { retryBillingQuoteAction, type RetryBillingQuoteResult } from "@/lib/actions/billing";
import {
  billingPanelState,
  canRetryBillingSync,
  hasBillingSyncError,
  hubspotDealUrl,
  hubspotQuoteUrl,
  PAYMENT_STATUS_LAG_DAYS,
  subscriptionMoney,
  subscriptionStatusColor,
} from "@/lib/billingView";
import { quoteTotals } from "@/lib/quoting";
import { fmt$, fmtFrequency } from "@/lib/utils";
import type { MerchantApplication } from "@/types/merchant";
import shared from "./AccountsDashboard.module.css";
import styles from "./BillingPanel.module.css";

// Not documented anywhere yet (no HubSpot portal id lives in this codebase
// today) — when unset, the Deal/Quote ids still render as plain copyable
// text instead of a broken link. Set NEXT_PUBLIC_HUBSPOT_PORTAL_ID to turn
// them into links to the actual HubSpot records.
const HUBSPOT_PORTAL_ID = process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID;

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
 * Deliverable 1). Read-only plus one retry — auto-publish happens
 * server-side on merchant acceptance, so there is no "Save quote to
 * HubSpot" or "Publish" button here, and once `publishedAt` is set nothing
 * below offers edit, unpublish, or void: a published quote can't be changed
 * through the API at all (voiding is HubSpot-UI-only). A rep who needs to
 * change a published quote is told to do it in HubSpot, not offered a button
 * that implies otherwise.
 */
export function BillingPanel({ app, canManage, onUpdated }: Props) {
  const [retrying, setRetrying] = useState(false);
  const [result, setResult] = useState<RetryBillingQuoteResult | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  const state = billingPanelState(app);

  if (state === "not_accepted") {
    return (
      <div className={styles.section}>
        <div className={styles.sectionLabel}>Billing</div>
        <div className={styles.emptyNote}>No quote accepted yet — nothing has been sent to HubSpot.</div>
      </div>
    );
  }

  if (state === "rate_only") {
    return (
      <div className={styles.section}>
        <div className={styles.sectionLabel}>Billing</div>
        <div className={styles.emptyNote}>
          Rate-only quote — there are no billable lines, so no HubSpot quote will ever be built for this
          account. AIO&rsquo;s margin here comes out of Adyen settlement, not HubSpot billing.
        </div>
      </div>
    );
  }

  const hubspotIds = app.hubspotIds;
  const dealUrl = app.hubspotDealId ? hubspotDealUrl(app.hubspotDealId, HUBSPOT_PORTAL_ID) : null;
  const quoteUrl = hubspotIds?.quoteId ? hubspotQuoteUrl(hubspotIds.quoteId, HUBSPOT_PORTAL_ID) : null;
  const subscriptions = hubspotIds?.subscriptions ?? [];
  const errored = hasBillingSyncError(hubspotIds);
  const totals = quoteTotals(app.quoteLines ?? []);
  const showRetry = canManage && canRetryBillingSync(app);

  const copyLink = () => {
    if (!hubspotIds?.quoteLink) return;
    navigator.clipboard.writeText(hubspotIds.quoteLink);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  const handleRetry = async () => {
    setRetrying(true);
    setResult(null);
    try {
      const outcome = await retryBillingQuoteAction(app.id);
      setResult(outcome);
      // Whatever happened, the row on disk may have changed (a new deal id, a
      // partial line-item set, a persisted lastSyncError) — re-load the full
      // application rather than trying to patch it together from `outcome`,
      // which only carries a quoteLink on success.
      const refreshed = await getApplicationAction(app.id);
      if (refreshed) onUpdated(refreshed);
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : "Retry failed" });
    }
    setRetrying(false);
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionLabel}>Billing</div>

      {errored && (
        <div className={styles.errorBanner}>
          <div className={styles.errorBannerTitle}>HubSpot sync failed</div>
          <div className={styles.errorBannerMessage}>{hubspotIds!.lastSyncError}</div>
          {hubspotIds!.lastSyncErrorAt && (
            <div className={styles.errorBannerMeta}>{new Date(hubspotIds!.lastSyncErrorAt).toLocaleString()}</div>
          )}
        </div>
      )}

      <div className={shared.detailGrid}>
        <div>
          <div className={shared.detailFieldLabel}>Deal</div>
          <div className={shared.detailFieldValue}>
            {app.hubspotDealId
              ? dealUrl
                ? <a href={dealUrl} target="_blank" rel="noreferrer">{app.hubspotDealId}</a>
                : app.hubspotDealId
              : "Not synced"}
          </div>
        </div>
        <div>
          <div className={shared.detailFieldLabel}>Quote</div>
          <div className={shared.detailFieldValue}>
            {hubspotIds?.quoteId
              ? quoteUrl
                ? <a href={quoteUrl} target="_blank" rel="noreferrer">{hubspotIds.quoteId}</a>
                : hubspotIds.quoteId
              : "—"}
          </div>
          {hubspotIds?.quoteTemplateId && (
            <div className={shared.detailMeta}>Template {hubspotIds.quoteTemplateId}</div>
          )}
        </div>
        <div>
          <div className={shared.detailFieldLabel}>Status</div>
          <div className={shared.detailFieldValue}>
            {hubspotIds?.publishedAt ? (
              <span className={shared.badge} style={{ background: "var(--success-bg)", color: "var(--success)" }}>
                Published {new Date(hubspotIds.publishedAt).toLocaleDateString()}
              </span>
            ) : (
              <span className={shared.badge} style={{ background: "var(--warning-bg)", color: "var(--warning)" }}>
                Draft
              </span>
            )}
          </div>
        </div>
        <div>
          <div className={shared.detailFieldLabel}>Payment</div>
          <div className={shared.detailFieldValue}>{hubspotIds?.paymentStatus || "—"}</div>
          {hubspotIds?.paymentDate && (
            <div className={shared.detailMeta}>Paid {new Date(hubspotIds.paymentDate).toLocaleDateString()}</div>
          )}
        </div>
      </div>

      {hubspotIds?.publishedAt && hubspotIds.paymentStatus && hubspotIds.paymentStatus !== "PAID" && (
        <div className={styles.note}>
          ACH settlement is a daily batch, so a paid quote can keep reading &ldquo;{hubspotIds.paymentStatus}&rdquo;
          here for a median of {PAYMENT_STATUS_LAG_DAYS} days after the customer actually checks out. If the
          merchant says they already paid, that is expected — not a sign anything is broken.
        </div>
      )}

      {hubspotIds?.publishedAt && hubspotIds.quoteLink && (
        <div>
          <div className={shared.detailFieldLabel} style={{ marginBottom: 8 }}>Customer payment page</div>
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

      {app.quoteLines && app.quoteLines.length > 0 && (
        <div>
          <div className={shared.detailFieldLabel} style={{ marginBottom: 8 }}>Quoted amounts</div>
          <div className={styles.moneyRow}>
            {totals.oneTime > 0 && <span>{fmt$(totals.oneTime)} one-time</span>}
            {totals.recurring.map(r => (
              <span key={r.frequency}>{fmt$(r.amount)}/{fmtFrequency(r.frequency)}</span>
            ))}
            {totals.monthlyEquivalent > 0 && (
              <span className={styles.moneyMeta}>(~{fmt$(totals.monthlyEquivalent)}/mo total)</span>
            )}
          </div>
        </div>
      )}

      <div>
        <div className={shared.detailFieldLabel} style={{ marginBottom: 8 }}>
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

      {showRetry && (
        <div className={styles.retryRow}>
          <button className={shared.btnPrimary} disabled={retrying} onClick={handleRetry}>
            {retrying ? "Retrying…" : "Retry HubSpot sync"}
          </button>
          {result && !result.ok && result.reasons && result.reasons.length > 0 && (
            <ul className={styles.reasonList}>
              {result.reasons.map(r => <li key={r.code}>{r.message}</li>)}
            </ul>
          )}
          {result && !result.ok && result.error && (
            <div className={styles.errorBannerMessage}>{result.error}</div>
          )}
          {result && result.ok && (
            <div className={styles.emptyNote}>Sync succeeded.</div>
          )}
        </div>
      )}

      {hubspotIds?.publishedAt && (
        <div className={styles.emptyNote}>
          This quote is published and can&rsquo;t be edited, deleted, or voided from EasyOB — voiding is only
          possible by hand in HubSpot. To change it, do that directly in HubSpot.
        </div>
      )}
    </div>
  );
}
