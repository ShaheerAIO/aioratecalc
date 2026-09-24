"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { listQuotableProductsAction } from "@/lib/actions/catalog";
import { getMaxDiscountPercent } from "@/lib/actions/pricing";
import {
  DEFAULT_MAX_DISCOUNT_PERCENT,
  MAX_BILLING_DELAY_DAYS,
  ORDER_POINT_CHANNELS,
  PLATFORM_TIER_BOUNDARY,
  QUOTE_TYPES,
  buildQuote,
  groupProducts,
  isAllowedForQuoteType,
  isProcessingQuote,
  lineDiscountAmount,
  lineListAmount,
  lineNetAmount,
  toQuoteLine,
  type BuiltQuote,
} from "@/lib/quoting";
import { fmt$, fmtFrequency, monthlyEquivalent } from "@/lib/utils";
import type {
  BillingStart, CatalogProduct, LineAdjustment, QuoteAdjustments, QuoteLine, QuoteType,
} from "@/types/merchant";
import styles from "./ProductConfigurator.module.css";

/** What the rep picked. Prices and the derived lines are the server's business. */
export type ProductPick = { hubspotProductId: string; qty: number };

// Frozen and module-level on purpose. It is the default for the `adjustments`
// prop and therefore a dependency of the buildQuote memo — an inline `= {}`
// would be a new reference every render, rebuilding the quote and pushing
// fresh derived state up to the parent on each one.
const NO_ADJUSTMENTS: QuoteAdjustments = Object.freeze({});

/**
 * Everything downstream of the picks, recomputed here for the live preview.
 * DISPLAY ONLY — the same derivation (`buildQuote`) runs again server-side
 * against the live catalog, and that result is what gets persisted. The parent
 * gets it so it can gate its own submit on `blockers`.
 */
export type ConfiguredQuote = BuiltQuote;

type Props = {
  quoteType: QuoteType;
  picks: ProductPick[];
  channels: string[];
  onQuoteTypeChange: (quoteType: QuoteType) => void;
  onPicksChange: (picks: ProductPick[]) => void;
  onChannelsChange: (channels: string[]) => void;
  onDerivedChange: (quote: ConfiguredQuote) => void;
  /**
   * Per-line discounts and delayed billing starts, keyed by product id. Held by
   * the caller like the picks are, and sent to the server as-is — the server
   * re-derives the lines and re-applies these against its own copy of the cap.
   */
  adjustments?: QuoteAdjustments;
  onAdjustmentsChange?: (adjustments: QuoteAdjustments) => void;
  /**
   * Which types this caller offers. Defaults to all of them; the proposal
   * wizard passes only the rated ones because it starts from a statement, and a
   * marketing-only quote has no statement behind it.
   */
  selectableTypes?: QuoteType[];
};

// A recurring line always shows BOTH figures: the charge as it actually bills
// and the monthly equivalent. AIO's platform fees bill weekly, so "$99/mo" is
// wrong by 4.33x and "$99" alone is ambiguous.
function priceLabel(unitPrice: number, frequency: QuoteLine["billingFrequency"]) {
  if (frequency === "one_time") return `${fmt$(unitPrice)} one-time`;
  return `${fmt$(unitPrice)}/${fmtFrequency(frequency)} (~${fmt$(monthlyEquivalent(unitPrice, frequency))}/mo)`;
}

/** The default a rep is offered for a custom billing start — what the portal's own delayed lines use. */
function firstOfNextMonth(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth() + 1, 1)).toISOString().slice(0, 10);
}

export default function ProductConfigurator({
  quoteType, picks, channels,
  onQuoteTypeChange, onPicksChange, onChannelsChange, onDerivedChange,
  adjustments = NO_ADJUSTMENTS, onAdjustmentsChange,
  selectableTypes,
}: Props) {
  // The catalog is read from HubSpot server-side and cached there, so this is
  // one call per mount, not one per keystroke. It lives in here rather than in
  // the page because every caller needs exactly the same call, and the derived
  // platform and service lines need the unfiltered `all` list that only this
  // fetch returns.
  const [catalog, setCatalog]         = useState<CatalogProduct[]>([]);
  const [fullCatalog, setFullCatalog] = useState<CatalogProduct[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  // The discount cap, for the live preview only. The server reads its own copy
  // on every save and publish, so a stale or tampered value here can widen
  // nothing — the worst it does is show a blocker a beat late.
  const [maxDiscountPercent, setMaxDiscountPercent] = useState(DEFAULT_MAX_DISCOUNT_PERCENT);

  useEffect(() => {
    listQuotableProductsAction()
      .then(res => { setCatalog(res.products); setFullCatalog(res.all); setCatalogError(res.error); })
      .catch(e => setCatalogError(e instanceof Error ? e.message : "Could not load the product catalog"))
      .finally(() => setCatalogLoading(false));
    getMaxDiscountPercent().then(setMaxDiscountPercent).catch(() => {});
  }, []);

  const types = QUOTE_TYPES.filter(t => !selectableTypes || selectableTypes.includes(t.id));
  const rated = isProcessingQuote(quoteType);

  // The picker only ever shows what this quote type may carry.
  const selectable = useMemo(
    () => catalog.filter(p => isAllowedForQuoteType(p, quoteType)),
    [catalog, quoteType]
  );
  const groups = useMemo(() => groupProducts(selectable), [selectable]);

  // Everything downstream of the picker is derived, never separately stored:
  // the order-point count comes from the lines, the platform tier comes from the
  // count, and the mandatory install lines come from the quote type. The rep
  // changes quantities; the rest follows.
  //
  // This is a PREVIEW. `buildQuote` runs again server-side, against the live
  // catalog, and that result is what gets persisted — the browser only ever
  // sends the picks.
  const pickedLines = useMemo(() => {
    const byId = new Map(selectable.map(p => [p.hubspotProductId, p]));
    return picks.flatMap(pick => {
      const product = byId.get(pick.hubspotProductId);
      return product && pick.qty > 0 ? [toQuoteLine(product, pick.qty)] : [];
    });
  }, [selectable, picks]);

  const built = useMemo(
    () => buildQuote(quoteType, pickedLines, channels, fullCatalog, adjustments, maxDiscountPercent),
    [quoteType, pickedLines, channels, fullCatalog, adjustments, maxDiscountPercent]
  );
  const { orderPoints, breakdown, platform, includedServices, totals, quoteLines } = built;

  // Summed across billing cycles ON PURPOSE, unlike the totals themselves: this
  // is "what was given away on this quote", a single headline for the rep, not
  // a figure that bills. It is never shown to the customer.
  const totalDiscount = quoteLines.reduce((sum, l) => sum + lineDiscountAmount(l), 0);

  // Held in a ref so a caller passing an inline arrow can't turn the push of
  // derived state back up into a render loop.
  const emit = useRef(onDerivedChange);
  useEffect(() => { emit.current = onDerivedChange; });
  useEffect(() => { emit.current(built); }, [built]);

  // Switching to a type that forbids something already picked has to drop it,
  // or the rep sends a marketing-only quote with a POS unit they can no longer
  // see. Runs off the catalog rather than the picks so it's a no-op until the
  // catalog has actually loaded.
  const changeType = (next: QuoteType) => {
    onQuoteTypeChange(next);
    if (catalog.length) {
      const allowed = new Set(
        catalog.filter(p => isAllowedForQuoteType(p, next)).map(p => p.hubspotProductId)
      );
      const kept = picks.filter(p => allowed.has(p.hubspotProductId));
      if (kept.length !== picks.length) onPicksChange(kept);
    }
    if (!isProcessingQuote(next) && channels.length) onChannelsChange([]);
  };

  // Picks are kept in catalog order, so the lines the server is asked to price
  // arrive in the same order the rep sees them listed.
  const qtyOf = (id: string) => picks.find(p => p.hubspotProductId === id)?.qty ?? 0;

  const setQtyFor = (id: string, next: number) => {
    const qty = Math.max(0, next);
    const wanted = new Map(picks.map(p => [p.hubspotProductId, p.qty]));
    if (qty > 0) wanted.set(id, qty);
    else wanted.delete(id);
    onPicksChange(
      selectable
        .filter(p => wanted.has(p.hubspotProductId))
        .map(p => ({ hubspotProductId: p.hubspotProductId, qty: wanted.get(p.hubspotProductId)! }))
    );
  };

  const toggleChannel = (id: string) =>
    onChannelsChange(channels.includes(id) ? channels.filter(c => c !== id) : [...channels, id]);

  // An adjustment with nothing left in it is DELETED rather than kept as an
  // empty object, so a rep who sets a discount and clears it again leaves no
  // trace on the saved quote.
  const setAdjustment = (id: string, patch: LineAdjustment) => {
    if (!onAdjustmentsChange) return;
    const next: QuoteAdjustments = { ...adjustments };
    const merged: LineAdjustment = { ...next[id], ...patch };
    if (!merged.discountPercent) delete merged.discountPercent;
    if (!merged.billingStart) delete merged.billingStart;
    if (Object.keys(merged).length) next[id] = merged;
    else delete next[id];
    onAdjustmentsChange(next);
  };

  const setDiscount = (id: string, raw: string) => {
    const pct = raw.trim() === "" ? null : Number(raw);
    setAdjustment(id, { discountPercent: pct === null || Number.isNaN(pct) ? null : pct });
  };

  const setStartMode = (id: string, mode: "now" | "date" | "days") => {
    if (mode === "now") return setAdjustment(id, { billingStart: null });
    // Seeded with the values the portal actually uses — the 1st of next month
    // for a date, 60 days for a delay (52 of the 72 day-delayed lines).
    const seed: BillingStart = mode === "date"
      ? { mode: "date", date: firstOfNextMonth() }
      : { mode: "days", days: 60 };
    setAdjustment(id, { billingStart: seed });
  };

  return (
    <>
      {types.length > 1 && (
        <div className={styles.panel}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Quote Type</h2>
            <p className={styles.sectionNote}>
              Pick this first — it decides what can go on the quote, which platform fee applies,
              and whether there&apos;s a processing rate at all.
            </p>
          </div>
          <div className={styles.typeRow}>
            {types.map(t => (
              <button
                key={t.id}
                type="button"
                className={styles.typeCard}
                data-active={quoteType === t.id}
                onClick={() => changeType(t.id)}
              >
                <span className={styles.typeLabel}>{t.label}</span>
                <span className={styles.typeNote}>{t.note}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className={styles.panel}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Products &amp; Hardware</h2>
          <p className={styles.sectionNote}>
            {rated ? (
              <>
                Priced from the live AIO catalog and snapshotted onto the quote, so a later catalog
                change never moves what this customer was quoted. The platform fee isn&apos;t in the
                list — it follows the ordering-point count below.
              </>
            ) : (
              <>
                A marketing-only quote carries the marketing products and nothing else — no POS
                hardware, no platform fee, no install. Switch the quote type above to sell those.
              </>
            )}
          </p>
        </div>

        {catalogLoading && <p className={styles.sectionNote}>Loading catalog…</p>}
        {catalogError && (
          <div className={styles.error}>
            Product catalog unavailable ({catalogError}). You can still send the rate quote — add
            hardware later.
          </div>
        )}

        {groups.map(group => (
          <div key={group.type} className={styles.group}>
            <div className={styles.groupTitle}>{group.label}</div>
            {group.products.map(p => {
              const n = qtyOf(p.hubspotProductId);
              return (
                <div key={p.hubspotProductId} className={styles.productRow} data-picked={n > 0}>
                  <div className={styles.productMain}>
                    <div className={styles.productName}>{p.name}</div>
                    <div className={styles.productPrice}>{priceLabel(p.price, p.billingFrequency)}</div>
                  </div>
                  <div className={styles.stepper}>
                    <button
                      type="button" className={styles.stepBtn} disabled={n === 0}
                      onClick={() => setQtyFor(p.hubspotProductId, n - 1)}
                      aria-label={`Remove one ${p.name}`}
                    >−</button>
                    <span className={styles.stepQty}>{n}</span>
                    <button
                      type="button" className={styles.stepBtn}
                      onClick={() => setQtyFor(p.hubspotProductId, n + 1)}
                      aria-label={`Add one ${p.name}`}
                    >+</button>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Every quote that puts the system in a restaurant includes these three.
          Shown, priced, and not a decision — hence no stepper. */}
      {rated && (includedServices.lines.length > 0 || includedServices.missing.length > 0) && (
        <div className={styles.panel}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Always Included</h2>
            <p className={styles.sectionNote}>
              One of each, on every quote that has products on it. Not optional — the system
              doesn&apos;t go live without a network, an install and a training. Remove every product
              above and they come off too, leaving a rate-only quote.
            </p>
          </div>
          {includedServices.lines.map(l => (
            <div key={l.hubspotProductId} className={styles.includedRow}>
              <div className={styles.productMain}>
                <div className={styles.productName}>{l.name}</div>
                <div className={styles.productPrice}>{priceLabel(l.unitPrice, l.billingFrequency)}</div>
              </div>
              <span className={styles.includedTag}>Included ×1</span>
            </div>
          ))}
          {includedServices.missing.length > 0 && (
            <div className={styles.error}>
              <strong>Can&apos;t price a required line.</strong>{" "}
              {includedServices.missing.join(", ")} {includedServices.missing.length === 1 ? "is" : "are"}{" "}
              included on every quote but missing from the HubSpot catalog (renamed, archived, or the
              catalog didn&apos;t load). Fix that before sending this quote.
            </div>
          )}
        </div>
      )}

      {rated && (
        <div className={styles.panel}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Ordering Points</h2>
            <p className={styles.sectionNote}>
              Every place an order can be placed. Hardware is counted from the lines above; these
              channels never appear on a hardware list, so they have to be declared here.
            </p>
          </div>

          <div className={styles.channelGrid}>
            {ORDER_POINT_CHANNELS.map(c => (
              <label key={c.id} className={styles.channel} data-on={channels.includes(c.id)}>
                <input
                  type="checkbox" checked={channels.includes(c.id)}
                  onChange={() => toggleChannel(c.id)} className={styles.channelBox}
                />
                <span className={styles.channelLabel}>{c.label}</span>
                {c.note && <span className={styles.channelNote}>{c.note}</span>}
              </label>
            ))}
          </div>

          <div className={styles.countRow}>
            <span className={styles.countLabel}>Ordering points</span>
            <span className={styles.countValue}>{orderPoints.total}</span>
          </div>

          {platform.line ? (
            <div className={styles.tierBox} data-tier={orderPoints.total > PLATFORM_TIER_BOUNDARY ? "large" : "small"}>
              <div className={styles.tierName}>{platform.line.name}</div>
              <div className={styles.tierPrice}>{priceLabel(platform.line.unitPrice, platform.line.billingFrequency)}</div>
              <div className={styles.tierNote}>
                {quoteType === "food_truck" ? (
                  <>Food-truck platform is priced flat, so the ordering-point count doesn&apos;t move it.</>
                ) : (
                  <>
                    {orderPoints.total} ordering point{orderPoints.total === 1 ? "" : "s"} →{" "}
                    {orderPoints.total > PLATFORM_TIER_BOUNDARY
                      ? `6+ tier. One point fewer would price at the 1–${PLATFORM_TIER_BOUNDARY} tier.`
                      : `1–${PLATFORM_TIER_BOUNDARY} tier. One more point moves this to the 6+ tier.`}
                  </>
                )}
              </div>
            </div>
          ) : platform.status === "none_needed" ? (
            <p className={styles.sectionNote}>
              No platform fee yet — add hardware or a channel and the tier is selected automatically.
            </p>
          ) : (
            <div className={styles.error}>
              <strong>Platform fee missing.</strong> This quote requires
              &ldquo;{platform.productName}&rdquo;, which isn&apos;t in the HubSpot catalog (renamed,
              archived, or the catalog didn&apos;t load). This quote can&apos;t be sent until
              that&apos;s fixed — sending it would quote no platform fee at all.
            </div>
          )}

          {breakdown.needsReview.map(r => (
            <div key={r.name} className={styles.reviewNote}>
              <strong>Needs review:</strong> {r.name} ×{r.qty} — {r.reason} Counted as 0 for now.
            </div>
          ))}
          {breakdown.unclassified.length > 0 && (
            <div className={styles.reviewNote}>
              <strong>Unclassified hardware:</strong>{" "}
              {breakdown.unclassified.map(u => `${u.name} ×${u.qty}`).join(", ")} — not in the
              ordering-point rules, counted as 0. Check before sending.
            </div>
          )}
        </div>
      )}

      {/* Discounts and delayed starts apply to EVERY line, derived ones included
          — comping the install and the onboarding is AIO's single most common
          discount, and both of those are lines the picker deliberately hides. */}
      {onAdjustmentsChange && quoteLines.length > 0 && (
        <div className={styles.panel}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Discounts &amp; Billing Start</h2>
            <p className={styles.sectionNote}>
              A discount on a recurring line is permanent — 50% off a $99/week platform fee is
              $49.50 every week, for good. To give something away temporarily, delay when billing
              starts instead. Discounts are capped at {maxDiscountPercent}%.
            </p>
          </div>

          {quoteLines.map(l => {
            const start = l.billingStart;
            const mode = start?.mode ?? "now";
            const discounted = (l.discountPercent ?? 0) > 0;
            return (
              <div key={l.hubspotProductId} className={styles.adjustRow}>
                <div className={styles.productMain}>
                  <div className={styles.productName}>
                    {l.name}{l.qty > 1 ? ` ×${l.qty}` : ""}
                  </div>
                  <div className={styles.productPrice}>
                    {discounted ? (
                      <>
                        <span className={styles.strike}>{fmt$(lineListAmount(l))}</span>{" "}
                        <strong>{fmt$(lineNetAmount(l))}</strong>
                        {l.billingFrequency !== "one_time" && `/${fmtFrequency(l.billingFrequency)}`}
                        {" "}<span className={styles.savedTag}>−{fmt$(lineDiscountAmount(l))}</span>
                      </>
                    ) : (
                      priceLabel(l.unitPrice, l.billingFrequency)
                    )}
                  </div>
                </div>

                <div className={styles.adjustControls}>
                  <label className={styles.adjustField}>
                    <span className={styles.adjustLabel}>Discount</span>
                    <span className={styles.pctWrap}>
                      <input
                        type="number" min={0} max={100} step={1}
                        className={styles.adjustInput}
                        value={l.discountPercent ?? ""}
                        placeholder="0"
                        onChange={e => setDiscount(l.hubspotProductId, e.target.value)}
                        aria-label={`Discount percent for ${l.name}`}
                      />
                      <span className={styles.pctSign}>%</span>
                    </span>
                  </label>

                  {/* One-time charges have no billing schedule to delay. */}
                  {l.billingFrequency !== "one_time" && (
                    <label className={styles.adjustField}>
                      <span className={styles.adjustLabel}>Billing starts</span>
                      <span className={styles.startWrap}>
                        <select
                          className={styles.adjustSelect}
                          value={mode}
                          onChange={e => setStartMode(l.hubspotProductId, e.target.value as "now" | "date" | "days")}
                          aria-label={`When billing starts for ${l.name}`}
                        >
                          <option value="now">At checkout</option>
                          <option value="date">On a date</option>
                          <option value="days">After N days</option>
                        </select>
                        {start?.mode === "date" && (
                          <input
                            type="date"
                            className={styles.adjustInput}
                            value={start.date}
                            onChange={e => setAdjustment(l.hubspotProductId, {
                              billingStart: { mode: "date", date: e.target.value },
                            })}
                            aria-label={`Billing start date for ${l.name}`}
                          />
                        )}
                        {start?.mode === "days" && (
                          <span className={styles.pctWrap}>
                            <input
                              type="number" min={1} max={MAX_BILLING_DELAY_DAYS} step={1}
                              className={styles.adjustInput}
                              value={start.days}
                              onChange={e => setAdjustment(l.hubspotProductId, {
                                billingStart: { mode: "days", days: Number(e.target.value) },
                              })}
                              aria-label={`Billing start delay in days for ${l.name}`}
                            />
                            <span className={styles.pctSign}>days</span>
                          </span>
                        )}
                      </span>
                    </label>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {quoteLines.length > 0 && (
        <div className={styles.panel}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Quote Totals</h2>
            <p className={styles.sectionNote}>
              Kept apart on purpose — one-time and recurring charges are different units and are
              never added together.
            </p>
          </div>
          {totalDiscount > 0 && (
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Discounts applied</span>
              <span className={styles.totalValue} data-tone="discount">−{fmt$(totalDiscount)}</span>
            </div>
          )}
          <div className={styles.totalRow}>
            <span className={styles.totalLabel}>Due once (hardware &amp; setup)</span>
            <span className={styles.totalValue}>{fmt$(totals.oneTime)}</span>
          </div>
          {totals.recurring.map(r => (
            <div key={r.frequency} className={styles.totalRow}>
              <span className={styles.totalLabel}>Recurring, per {fmtFrequency(r.frequency)}</span>
              <span className={styles.totalValue}>{fmt$(r.amount)}/{fmtFrequency(r.frequency)}</span>
            </div>
          ))}
          <div className={styles.totalRow} data-emphasis="true">
            <span className={styles.totalLabel}>All recurring, monthly equivalent</span>
            <span className={styles.totalValue}>{fmt$(totals.monthlyEquivalent)}/mo</span>
          </div>
        </div>
      )}
    </>
  );
}
