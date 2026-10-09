"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listQuotableProductsAction } from "@/lib/actions/catalog";
import { getMaxDiscountPercent, getQuoteLimits } from "@/lib/actions/pricing";
import {
  AMS1_PRODUCT,
  DEFAULT_MAX_DISCOUNT_PERCENT,
  DEFAULT_QUOTE_LIMITS,
  INCLUDED_SCREEN_COUNT,
  INCLUDED_SERVICE_PRODUCTS,
  KIOSK_PRODUCT_IDS,
  MARKETING_INCLUDED_HARDWARE,
  MARKETING_TERM_KIOSK_IDS,
  POS_COMPANIONS,
  MAX_BILLING_DELAY_DAYS,
  ORDER_POINT_CHANNELS,
  PLAN_DEFAULT_BILLING_DELAY_DAYS,
  PLATFORM_PRODUCTS,
  PROCESSING_DISCLOSURE_PRODUCT,
  PRODUCT_GROUP_LABELS,
  QUOTE_TYPES,
  SOFTWARE_LICENSE_PRODUCT,
  WIFI_PRODUCT_ID,
  amountDueAtCheckout,
  buildQuote,
  describeBillingStart,
  groupProducts,
  isAllowedForQuoteType,
  isCompedService,
  isPosRequiringTerminal,
  isPreAuthProduct,
  isMarketingQuote,
  isProcessingQuote,
  lineDiscountAmount,
  lineListAmount,
  lineNetAmount,
  companionsFor,
  maxQtyFor,
  minimumTerminalsFor,
  planDefaultBillingStart,
  planIncludesWebsite,
  toQuoteLine,
  unitsFromQuoteLines,
  websiteTakesOrders,
  WEBSITE_PRODUCT_ID,
  type BuiltQuote,
  type QuoteLimits,
} from "@/lib/quoting";
import { coverageLabel, kitFor, kitPicks } from "@/lib/quotePackages";
import QuoteReceipt from "@/components/quoting/QuoteReceipt";
import { fmt$, fmtCycle, fmtRecurring, monthlyEquivalent } from "@/lib/utils";
import type {
  BillingStart, CatalogProduct, LineAdjustment, QuoteAdjustments, QuoteLine, QuoteType, UnitAdjustment,
} from "@/types/merchant";
import styles from "./ProductConfigurator.module.css";

/** What the rep picked. Prices and the derived lines are the server's business. */
export type ProductPick = { hubspotProductId: string; qty: number };

// Frozen and module-level on purpose. It is the default for the `adjustments`
// prop and therefore a dependency of the buildQuote memo — an inline `= {}`
// would be a new reference every render, rebuilding the quote and pushing
// fresh derived state up to the parent on each one.
const NO_ADJUSTMENTS: QuoteAdjustments = Object.freeze({});

/** A unit's edits with the blanks removed, so an untouched unit is `{}`. */
function cleanUnit(unit: UnitAdjustment): UnitAdjustment {
  const out: UnitAdjustment = {};
  if (unit.discountPercent) out.discountPercent = unit.discountPercent;
  if (unit.billingStart) out.billingStart = unit.billingStart;
  return out;
}

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
  /**
   * Where the totals sit once there is a quote. `gutter` (default) hangs them
   * outside the page measure, in the leftover viewport space to the right, so
   * the catalog keeps its full width. `inline` keeps them under the catalog —
   * for hosts whose column already fills the viewport and have no gutter to
   * hang into (the statement wizard, EditQuotePanel).
   */
  rail?: "gutter" | "inline";
  /**
   * `document` splits the configurator into the decisions (plan, hardware,
   * channels) and a live copy of the quote the merchant will open, where every
   * derived line — platform fee, included services, licenses, packages — sits
   * as a tagged line with its adjust control, instead of a panel of its own.
   * The slots below are the host's own pieces, placed inside that split.
   */
  layout?: "panels" | "document";
  /** document layout: rendered in the build column, under the plan cards. */
  buildSlot?: ReactNode;
  /** document layout: the quote document's heading. */
  documentHeader?: ReactNode;
  /** document layout: the card-rate line, above the charges. */
  documentRate?: ReactNode;
  /** document layout: under the totals — the host's send controls. */
  documentFooter?: ReactNode;
  /**
   * Whether this host is starting a BRAND-NEW quote, in which case the chosen
   * plan brings its own starting point: the hardware kit preselected, and the
   * 60-day billing start the two POS plans open with.
   *
   * Off by default, and every host that REOPENS a saved quote leaves it off.
   * A reopened rate-only quote has no picks and no adjustments either, so
   * "looks empty" is not a safe proxy for "is new" — seeding off that would
   * put a $4,000 kit onto a quote a rep deliberately cleared.
   */
  seedPlanDefaults?: boolean;
};

// Recurring prices read monthly (see fmtRecurring): everything AIO sells bills
// monthly now. A line still on another cycle shows its monthly equivalent AND
// the cycle it really bills on — "$99/mo" for a weekly $99 would be wrong by
// 4.33x, so the true cycle is never dropped.
function priceLabel(unitPrice: number, frequency: QuoteLine["billingFrequency"]) {
  if (frequency === "one_time") return `${fmt$(unitPrice)} one-time`;
  return fmtRecurring(unitPrice, frequency);
}

/** The default a rep is offered for a custom billing start — what the portal's own delayed lines use. */
function firstOfNextMonth(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth() + 1, 1)).toISOString().slice(0, 10);
}

/** Comparable identity for a billing start, so "do these lines agree?" is one `===`. */
function startKey(start: BillingStart | null | undefined): string {
  if (!start) return "now";
  return start.mode === "date" ? `date:${start.date}` : `days:${start.days}`;
}

export default function ProductConfigurator({
  quoteType, picks, channels,
  onQuoteTypeChange, onPicksChange, onChannelsChange, onDerivedChange,
  adjustments = NO_ADJUSTMENTS, onAdjustmentsChange,
  selectableTypes,
  rail = "gutter",
  layout = "panels",
  buildSlot, documentHeader, documentRate, documentFooter,
  seedPlanDefaults = false,
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
  // Quantity caps and the billing-delay ceiling, same posture as the cap above:
  // display only. The server reads its own copy on every save and publish.
  const [limits, setLimits] = useState<QuoteLimits>(DEFAULT_QUOTE_LIMITS);

  useEffect(() => {
    listQuotableProductsAction()
      .then(res => { setCatalog(res.products); setFullCatalog(res.all); setCatalogError(res.error); })
      .catch(e => setCatalogError(e instanceof Error ? e.message : "Could not load the product catalog"))
      .finally(() => setCatalogLoading(false));
    getMaxDiscountPercent().then(setMaxDiscountPercent).catch(() => {});
    getQuoteLimits().then(setLimits).catch(() => {});
  }, []);

  const types = QUOTE_TYPES.filter(t => !selectableTypes || selectableTypes.includes(t.id));
  const rated = isProcessingQuote(quoteType);

  // The picker only ever shows what this quote type may carry.
  const selectable = useMemo(
    () => catalog.filter(p => isAllowedForQuoteType(p, quoteType)),
    [catalog, quoteType]
  );
  // The kit's products sit together at the top of the ordinary Hardware group,
  // in the kit's own order, with no label of their own. Static on purpose: the
  // order comes from the kit definition, never from what is picked, so a row
  // doesn't jump when its stepper moves and a rep always finds the kit in the
  // same place. A product at zero stays listed — that is how a removed item
  // gets added back.
  const kit = kitFor(quoteType);
  const groups = useMemo(() => {
    if (!kit) return groupProducts(selectable);

    // Pulled from WHEREVER they are, not just the Hardware group: HubSpot
    // carries no product type on the Customer Facing Display, so it would
    // otherwise sit under "Uncategorized", nowhere near the POS it goes with.
    const byId = new Map(selectable.map(p => [p.hubspotProductId, p]));
    const ordered = kitPicks(kit).flatMap(k => byId.get(k.hubspotProductId) ?? []);

    // Each POS's companions sit directly UNDER it — "CFD + cash drawer +
    // adyen should automatically add when adding in a POS and show below them
    // for clarity" (2026-10-09). A row whose quantity moves on its own has to
    // be where the rep can see it move.
    //
    // Done HERE, in the listing, rather than by naming them in the kit: the
    // kit's terminal slots are already filled by the POS's AMS1 and the one
    // inside the kiosk SKU, so adding the terminal to KIT_DEFAULT_PRODUCTS
    // would preselect a second one nobody needs.
    const placed = new Set(ordered.map(p => p.hubspotProductId));
    for (const pos of [...ordered]) {
      for (const companion of companionsFor(pos.hubspotProductId)) {
        const product = byId.get(companion.hubspotProductId);
        if (!product || placed.has(product.hubspotProductId)) continue;
        placed.add(product.hubspotProductId);
        ordered.splice(ordered.indexOf(pos) + 1, 0, product);
      }
    }

    const inKit = ordered;
    const kitIds = placed;

    const rest = groupProducts(selectable.filter(p => !kitIds.has(p.hubspotProductId)));
    if (inKit.length === 0) return rest;

    const hardware = rest.find(g => g.type === "inventory");
    if (hardware) {
      return rest.map(g => (g === hardware ? { ...g, products: [...inKit, ...g.products] } : g));
    }
    // No other hardware at all: the kit still gets its Hardware group, first.
    return [
      { type: "inventory", label: PRODUCT_GROUP_LABELS.inventory, products: inKit },
      ...rest,
    ];
  }, [selectable, kit]);

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
    () => buildQuote(quoteType, pickedLines, channels, fullCatalog, adjustments, maxDiscountPercent, limits),
    [quoteType, pickedLines, channels, fullCatalog, adjustments, maxDiscountPercent, limits]
  );
  const {
    orderPoints, breakdown, platform, includedServices,
    processingDisclosure, packages, totals, quoteLines,
  } = built;

  // Whether the Website takes online orders. `rated` above is the PLAN's answer
  // and stays that way — the install services and the ordering-point count
  // follow the plan, and a website merchant has nothing on site to install and
  // no ordering point we count. This is the other question: does AIO touch
  // their money.
  const websiteOn = websiteTakesOrders(pickedLines, adjustments);

  // Each plan's monthly price, read off the live catalog entry for its
  // platform product rather than written into QUOTE_TYPES. The four notes used
  // to carry the figure in prose, where a HubSpot price change would leave it
  // quietly wrong on the one screen a rep quotes from.
  const planPrice = (id: QuoteType): string | null => {
    const want = PLATFORM_PRODUCTS[id];
    const product =
      fullCatalog.find(c => c.hubspotProductId === want.hubspotProductId) ??
      fullCatalog.find(c => c.name.trim() === want.name);
    return product ? `${fmt$(monthlyEquivalent(product.price, product.billingFrequency))}/mo` : null;
  };

  // What the PLAN hands over at no charge, as opposed to what a package
  // absorbed. Both are expressed the same way — a line at MSRP, 100% off,
  // carrying the name of whatever paid for it — so the covering name is what
  // tells them apart, and the rep needs them worded differently: one is a
  // package they built by picking hardware, the other is what the subscription
  // they chose includes.
  const planName = PLATFORM_PRODUCTS[quoteType].name;
  const planCoveredQty = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of quoteLines) {
      if (l.coveredByPackage === planName) map.set(l.hubspotProductId, (map.get(l.hubspotProductId) ?? 0) + l.qty);
    }
    return map;
  }, [quoteLines, planName]);

  // productId → how many of it a package is already paying for. Lets the
  // picker row and the always-included row say so, instead of the rep having
  // to reconcile the package panel against the list themselves.
  const coveredQty = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of packages.lines) {
      // What the plan includes is counted in planCoveredQty, not here.
      if (l.coveredByPackage && l.coveredByPackage !== planName) {
        map.set(l.hubspotProductId, (map.get(l.hubspotProductId) ?? 0) + l.qty);
      }
    }
    return map;
  }, [packages.lines, planName]);

  // What each package absorbed, for its one-line summary. Built off the
  // covered lines rather than the slot definitions so it describes what the
  // merchant actually got — an order-point slot could have been filled by
  // either a POS or a kiosk.
  const coveredSummary = useMemo(
    () =>
      packages.lines
        .filter(l => l.coveredByPackage && l.coveredByPackage !== planName)
        .map(l => `${l.qty} × ${l.name.trim()}`)
        .join(", "),
    [packages.lines, planName]
  );

  // Summed across billing cycles ON PURPOSE, unlike the totals themselves: this
  // is "what was given away on this quote", a single headline for the rep, not
  // a figure that bills. It is never shown to the customer.
  //
  // Package-covered lines are left out. Their 100% isn't a discount anyone
  // gave — it is how a package is expressed — and counting it here would
  // report the same money twice, once as "package savings" and again, gross,
  // as a discount.
  const totalDiscount = quoteLines.reduce(
    (sum, l) => sum + (l.coveredByPackage ? 0 : lineDiscountAmount(l)),
    0
  );

  // The derived line behind a product id, or undefined when that product isn't
  // on the quote. This is what lets the adjust control live on the row the rep
  // is already looking at: the picker is keyed by CATALOG product, the
  // adjustments are keyed by QUOTE LINE, and this is the join.
  //
  // One entry per PRODUCT, not per line. A product can now be on the quote as
  // two lines — a scoped discount splits it, and so does a package — and the
  // rep edits one row, so the halves are merged back: quantity summed,
  // discount taken from whichever half carries it. A naive Map would keep only
  // the last line, so a rep who discounted 1 of 3 would come back to a row
  // reading "2, no discount".
  //
  // Package-covered lines are left out entirely. They can't be adjusted, and a
  // product that is ONLY covered therefore has no entry, which is exactly how
  // `lineAdjust` knows not to offer a control for it.
  const lineFor = useMemo(() => {
    const map = new Map<string, QuoteLine & { discountAmount: number; mixedDiscount?: boolean }>();
    for (const l of quoteLines) {
      if (l.coveredByPackage) continue;
      // The pre-authorization is not the rep's to adjust, so it gets no entry
      // — which is also what keeps the quote-wide discount and billing-start
      // sweeps from ever naming it.
      if (isPreAuthProduct(l.hubspotProductId, l.name)) continue;
      const prev = map.get(l.hubspotProductId);
      const amount = lineDiscountAmount(l);
      if (!prev) {
        map.set(l.hubspotProductId, { ...l, discountAmount: amount });
        continue;
      }
      map.set(l.hubspotProductId, {
        ...prev,
        qty: prev.qty + l.qty,
        discountPercent: prev.discountPercent ?? l.discountPercent,
        billingStart: prev.billingStart ?? l.billingStart,
        // Summed off the real lines, so the button states what was actually
        // given away rather than the discount as if it hit every unit.
        discountAmount: prev.discountAmount + amount,
        // The halves of a split line disagree about the discount. The quote-
        // wide field reads this to say "Mixed" instead of the first half's figure.
        mixedDiscount: prev.mixedDiscount || (prev.discountPercent ?? 0) !== (l.discountPercent ?? 0),
      });
    }
    return map;
  }, [quoteLines]);

  // Which rows have their adjust drawer open. Local and deliberately not
  // persisted — it is a disclosure, not quote data.
  const [openAdjust, setOpenAdjust] = useState<Set<string>>(new Set());
  // The WiFi remove confirmation. Local, like the adjust drawers: it is a
  // disclosure, and the decision itself lives on the adjustment.
  const [confirmWifi, setConfirmWifi] = useState(false);
  // The "clear the cart?" confirmation. Same kind of local disclosure state,
  // declared here with the others because `changeType` resets it.
  const [confirmClear, setConfirmClear] = useState(false);
  // Same idea for taking a unit the kit is giving away off the quote: the
  // product id whose removal is awaiting a yes. One at a time.
  const [confirmKitRemove, setConfirmKitRemove] = useState<string | null>(null);
  const toggleAdjust = (id: string) =>
    setOpenAdjust(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  // Held in a ref so a caller passing an inline arrow can't turn the push of
  // derived state back up into a render loop.
  const emit = useRef(onDerivedChange);
  useEffect(() => { emit.current = onDerivedChange; });
  useEffect(() => { emit.current(built); }, [built]);

  // ── What a plan opens with ────────────────────────────────────────────────
  // A billing start waiting to be swept across the recurring lines, once there
  // ARE recurring lines. `changeType` can't do it itself: the plan's fee and
  // the kit it just seeded only become lines after `buildQuote` has run again,
  // so there is nothing to apply it to until the next render.
  //
  // Strictly one-shot — cleared the moment it is applied — which is what makes
  // the 60 days an ordinary rep edit from then on. Re-deriving it instead
  // would put it straight back every time a rep set a line to bill at
  // checkout, since clearing an adjustment deletes it.
  const [pendingStart, setPendingStart] = useState<BillingStart | null>(null);

  // A NEW quote opens on a plan nobody clicked — `all_in_one` is the initial
  // state — so the plan's own starting point (its kit, its menu boards, its
  // 60-day start) was never applied, and a rep had to click the plan card that
  // was already selected to get it. That is the "need to reselect for it to
  // pop up" the product owner reported on 2026-10-09.
  //
  // Guarded three ways, because seeding the wrong quote hands over a $4,000
  // kit: only a host that says it is starting a new quote, only once, and only
  // while the quote is genuinely untouched.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !seedPlanDefaults || catalog.length === 0) return;
    if (picks.length > 0 || Object.keys(adjustments).length > 0) return;
    seeded.current = true;
    changeType(quoteType);
    // Deliberately keyed on the catalog arriving. Everything else is read at
    // the moment it fires and must not re-trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, seedPlanDefaults]);

  /**
   * What a plan opens with: its cart, and the billing start it bills from.
   *
   * SWITCHING PLANS CLEARS THE CART, then re-seeds it from the new plan
   * (product owner, 2026-10-09). It used to carry across whatever the new plan
   * also allowed, which meant the kit only appeared on an empty quote and a
   * rep who had touched anything got a half-converted cart — some of the old
   * plan's hardware, none of the new plan's. A plan IS the offer, so changing
   * it starts the offer again.
   *
   * Re-clicking the plan already selected does NOT clear. It re-seeds only an
   * empty cart, which is what makes "Clear cart, then click the plan" the way
   * to get the kit back — and what stops a stray click on the highlighted card
   * throwing away a configured quote.
   */
  const changeType = (next: QuoteType) => {
    const switching = next !== quoteType;
    onQuoteTypeChange(next);
    setConfirmKitRemove(null);
    setConfirmWifi(false);
    setConfirmClear(false);

    // The adjustments go with the cart. They are keyed by product id, so a
    // discount left behind would re-attach itself to whatever the new plan
    // seeds — a comp meant for one quote silently applying to another.
    if (switching) onAdjustmentsChange?.({});

    // The 60-day start the two POS plans bill from. Applied a render later
    // (see `pendingStart`) because the lines it applies to don't exist until
    // `buildQuote` has run against the new plan and its freshly seeded picks.
    if (onAdjustmentsChange) setPendingStart(planDefaultBillingStart(next));

    if (catalog.length) {
      const allowed = new Set(
        catalog.filter(p => isAllowedForQuoteType(p, next)).map(p => p.hubspotProductId)
      );
      // A switch starts from nothing; a re-click keeps what is there.
      const kept = switching ? [] : picks.filter(p => allowed.has(p.hubspotProductId));

      // The hardware kit the two POS plans come with, onto an empty cart —
      // which after a switch is always.
      const kit = kitFor(next);
      const fromKit: ProductPick[] = [];
      if (kit && kept.length === 0) {
        const inKit = new Map(kitPicks(kit).map(k => [k.hubspotProductId, k.qty]));
        // The POS's AMS1, the same as the stepper adds by hand.
        const terminals = minimumTerminalsFor(next, kitPicks(kit));
        if (terminals > 0) inKit.set(AMS1_PRODUCT.hubspotProductId, terminals);
        fromKit.push(
          ...catalog
            .filter(p => allowed.has(p.hubspotProductId) && inKit.has(p.hubspotProductId))
            .map(p => ({ hubspotProductId: p.hubspotProductId, qty: inKit.get(p.hubspotProductId)! }))
        );
      }

      // Everything else the plan includes and the rep would otherwise have to
      // add by hand: the Website on All-in-One, the three Menu Board Computers
      // on either marketing plan. Both are held at $0 by the plan comps, so
      // leaving them off doesn't save the merchant anything — it just omits
      // what they were promised.
      const included: ProductPick[] = [];
      if (planIncludesWebsite(next) && allowed.has(WEBSITE_PRODUCT_ID)) {
        included.push({ hubspotProductId: WEBSITE_PRODUCT_ID, qty: 1 });
      }
      if (isMarketingQuote(next)) {
        included.push(
          ...MARKETING_INCLUDED_HARDWARE
            .filter(h => allowed.has(h.hubspotProductId))
            .map(h => ({ hubspotProductId: h.hubspotProductId, qty: h.qty }))
        );
      }

      const have = new Set([...kept, ...fromKit].map(p => p.hubspotProductId));
      const nextPicks = [...kept, ...fromKit, ...included.filter(p => !have.has(p.hubspotProductId))];
      const unchanged =
        nextPicks.length === picks.length &&
        nextPicks.every(p => picks.some(q => q.hubspotProductId === p.hubspotProductId && q.qty === p.qty));
      if (!unchanged) onPicksChange(nextPicks);
    } else if (switching && picks.length) {
      // The catalog hasn't loaded, so there is nothing to seed — but the old
      // plan's cart still must not survive onto the new one.
      onPicksChange([]);
    }

    if (!isProcessingQuote(next) && channels.length) onChannelsChange([]);
  };

  // Picks are kept in catalog order, so the lines the server is asked to price
  // arrive in the same order the rep sees them listed.
  const qtyOf = (id: string) => picks.find(p => p.hubspotProductId === id)?.qty ?? 0;

  // Every POS ships with an AMS1, so the terminal row can't go below the POS count.
  const terminalFloor = minimumTerminalsFor(quoteType, picks);

  const setQtyFor = (id: string, next: number) => {
    const floor = id === AMS1_PRODUCT.hubspotProductId ? terminalFloor : 0;
    const qty = Math.max(floor, next);
    const wanted = new Map(picks.map(p => [p.hubspotProductId, p.qty]));
    if (qty > 0) wanted.set(id, qty);
    else wanted.delete(id);
    // A POS added or taken off moves its companions with it — the terminal it
    // has to ship with, the customer display and the cash drawer — keeping any
    // extras the rep added on top. Only the terminal has a floor under it
    // (`minimumTerminalsFor`); the other two are a convenience the rep can
    // step straight back down.
    const companions = isProcessingQuote(quoteType) ? companionsFor(id) : [];
    if (companions.length) {
      const delta = qty - qtyOf(id);
      const asPicks = () => [...wanted].map(([hubspotProductId, q]) => ({ hubspotProductId, qty: q }));
      for (const companion of companions) {
        const cid = companion.hubspotProductId;
        const moved = (wanted.get(cid) ?? 0) + delta;
        const n = cid === AMS1_PRODUCT.hubspotProductId
          ? Math.max(moved, minimumTerminalsFor(quoteType, asPicks()))
          : moved;
        if (n > 0) wanted.set(cid, n);
        else wanted.delete(cid);
      }
    }
    onPicksChange(
      selectable
        .filter(p => wanted.has(p.hubspotProductId))
        .map(p => ({ hubspotProductId: p.hubspotProductId, qty: wanted.get(p.hubspotProductId)! }))
    );
    // Re-adding the Website starts it as a plain site again.
    if (id === WEBSITE_PRODUCT_ID && qty === 0 && adjustments[id]?.onlineOrdering) {
      setAdjustment(id, { onlineOrdering: null });
    }
  };

  const toggleChannel = (id: string) =>
    onChannelsChange(channels.includes(id) ? channels.filter(c => c !== id) : [...channels, id]);

  // ── Clearing the cart ─────────────────────────────────────────────────────
  // Starting the hardware over used to mean stepping every row back to zero
  // one press at a time, which on a seeded kit is a dozen rows.
  //
  // It clears the ADJUSTMENTS with the picks, deliberately: they are keyed by
  // product id, so a discount left behind would re-attach itself, silently, to
  // whatever the rep picks next. Behind a confirmation, since it is the one
  // button here that throws work away. The plan, the rates and the declared
  // channels are not the cart and are left alone.
  const clearCart = () => {
    onPicksChange([]);
    onAdjustmentsChange?.({});
    setConfirmClear(false);
    setConfirmKitRemove(null);
    setConfirmWifi(false);
  };

  // An adjustment with nothing left in it is DELETED rather than kept as an
  // empty object, so a rep who sets a discount and clears it again leaves no
  // trace on the saved quote.
  const setAdjustments = (ids: string[], patch: LineAdjustment) => {
    if (!onAdjustmentsChange) return;
    const next: QuoteAdjustments = { ...adjustments };
    for (const id of ids) {
      const merged: LineAdjustment = { ...next[id], ...patch };
      // A line in "adjust each unit" mode answers to its units, so a quote-wide
      // sweep has to reach them or it would change nothing on that line. The
      // patch that SWITCHES a line into unit mode carries `units` itself and
      // must not be rewritten by its own blanks.
      if (Array.isArray(merged.units) && !("units" in patch)) {
        const overlay: UnitAdjustment = {};
        if ("discountPercent" in patch) overlay.discountPercent = patch.discountPercent;
        if ("billingStart" in patch) overlay.billingStart = patch.billingStart;
        if (Object.keys(overlay).length) {
          merged.units = merged.units.map(u => cleanUnit({ ...u, ...overlay }));
        }
      }
      if (!merged.units) delete merged.units;
      if (!merged.discountPercent) delete merged.discountPercent;
      if (!merged.discountQty) delete merged.discountQty;
      if (!merged.billingStart) delete merged.billingStart;
      if (!merged.removed) delete merged.removed;
      if (!merged.onlineOrdering) delete merged.onlineOrdering;
      if (Object.keys(merged).length) next[id] = merged;
      else delete next[id];
    }
    onAdjustmentsChange(next);
  };

  const setAdjustment = (id: string, patch: LineAdjustment) => setAdjustments([id], patch);

  const setDiscount = (id: string, raw: string) => {
    const pct = raw.trim() === "" ? null : Number(raw);
    // CLAMPED here, not merely reported. `adjustmentBlockers` refuses anything
    // over 100 and always will, but a number input accepts typed values past
    // its own max — so without this a rep types 150, watches the preview go
    // negative, and has to work out what they did wrong from a blocker. A
    // discount can't exceed the price; holding the field at 100 says so.
    const next = pct === null || Number.isNaN(pct) ? null : Math.min(100, Math.max(0, pct));
    // Clearing the percent clears the quantity with it. A quantity on its own
    // scopes nothing, and leaving it behind would silently re-scope the next
    // discount the rep types on this row.
    setAdjustment(id, next ? { discountPercent: next } : { discountPercent: null, discountQty: null });
  };

  const setDiscountQty = (id: string, raw: string) => {
    const qty = raw.trim() === "" ? null : Number(raw);
    setAdjustment(id, { discountQty: qty === null || Number.isNaN(qty) ? null : qty });
  };

  // ── Per-unit editing ──────────────────────────────────────────────────────
  // A line with several units can be edited as one ("2 of 3 free") or unit by
  // unit. The rows are shown for `qty` units whatever the stored array's
  // length, since a unit past its end is simply unadjusted.
  const [openUnits, setOpenUnits] = useState<Set<string>>(new Set());

  const unitsOf = (id: string, qty: number): UnitAdjustment[] => {
    const stored = adjustments[id]?.units;
    return Array.from({ length: qty }, (_, i) => cleanUnit(stored?.[i] ?? {}));
  };

  // Switching in seeds every unit from what the line is doing NOW — read off
  // the built lines rather than the line-level fields, so a "1 of 3 free" or a
  // service comp carries over exactly as the rep sees it. Line-level values are
  // cleared: they're ignored in unit mode, and a stale copy left behind would
  // come back, silently, the moment the rep switched out again.
  const enterUnitMode = (id: string, qty: number) => {
    const seed = unitsFromQuoteLines(quoteLines, id).slice(0, qty);
    while (seed.length < qty) seed.push({});
    setOpenUnits(prev => new Set(prev).add(id));
    setAdjustment(id, { units: seed, discountPercent: null, discountQty: null, billingStart: null });
  };

  const leaveUnitMode = (id: string) => {
    setOpenUnits(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setAdjustment(id, { units: null });
  };

  const setUnit = (id: string, qty: number, index: number, patch: UnitAdjustment) => {
    const units = unitsOf(id, qty);
    units[index] = cleanUnit({ ...units[index], ...patch });
    setAdjustment(id, { units });
  };

  const setUnitDiscount = (id: string, qty: number, index: number, raw: string) => {
    const pct = raw.trim() === "" ? null : Number(raw);
    setUnit(id, qty, index, {
      discountPercent: pct === null || Number.isNaN(pct) ? null : Math.min(100, Math.max(0, pct)),
    });
  };

  const setUnitStartMode = (id: string, qty: number, index: number, mode: "now" | "date" | "days") => {
    setUnit(id, qty, index, {
      billingStart:
        mode === "now" ? null
        : mode === "date" ? { mode: "date", date: firstOfNextMonth() }
        : { mode: "days", days: 60 },
    });
  };

  const setStartMode = (ids: string[], mode: "now" | "date" | "days") => {
    if (mode === "now") return setAdjustments(ids, { billingStart: null });
    // Seeded with the values the portal actually uses — the 1st of next month
    // for a date, 60 days for a delay (52 of the 72 day-delayed lines).
    const seed: BillingStart = mode === "date"
      ? { mode: "date", date: firstOfNextMonth() }
      : { mode: "days", days: 60 };
    setAdjustments(ids, { billingStart: seed });
  };

  // ── The quote-wide billing start ──────────────────────────────────────────
  // Delaying billing is nearly always a whole-quote concession ("first month
  // on us"), and doing it a row at a time means opening every drawer and
  // remembering which lines were recurring in the first place.
  //
  // RECURRING LINES ONLY, and that is not a shortcut. A one-time charge has no
  // billing schedule to move: `applyLineAdjustment` strips the property off
  // one, HubSpot has nothing to apply it to, and the charge lands at checkout
  // either way. Sweeping across everything would write adjustments that change
  // nothing and then read back as edits the rep never made.
  const recurringLines = useMemo(
    () => quoteLines.filter(l => l.billingFrequency !== "one_time"),
    [quoteLines]
  );
  const recurringIds = useMemo(
    () => [...new Set(recurringLines.map(l => l.hubspotProductId))],
    [recurringLines]
  );

  // The plan's own billing start, swept across those recurring lines the first
  // render on which there are any. Declared up with the other plan defaults;
  // applied here, where `recurringIds` finally exists.
  useEffect(() => {
    if (!pendingStart || recurringIds.length === 0) return;
    setPendingStart(null);
    setAdjustments(recurringIds, { billingStart: pendingStart });
    // setAdjustments closes over today's adjustments; re-running this on every
    // change would re-apply a start the rep has since cleared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingStart, recurringIds]);
  // One shared start, or null when the lines disagree — a rep who delayed a
  // single line by hand must not be told the whole quote is delayed.
  const sharedStart = useMemo(() => {
    if (recurringLines.length === 0) return { mixed: false, start: null as BillingStart | null };
    const first = recurringLines[0].billingStart ?? null;
    const mixed = recurringLines.some(l => startKey(l.billingStart) !== startKey(first));
    return { mixed, start: mixed ? null : first };
  }, [recurringLines]);
  const globalMode = sharedStart.mixed ? "" : (sharedStart.start?.mode ?? "now");

  // ── No quote-wide discount ────────────────────────────────────────────────
  // There WAS one here, next to the billing start, until 2026-10-09. It is
  // gone at the product owner's request: "they should not be allowed to
  // discount the entire bill, instead only individual line items. Almost no
  // cases where we would have a free quote."
  //
  // A single box that took the whole document to any percentage in one
  // keystroke was the one control on this screen that could give everything
  // away by accident, and it rode onto a quote nobody can amend. Discounting
  // is now a per-line decision taken on the line, where the rep can see what
  // they are giving away — and `quoteSanityBlockers` still refuses a quote
  // that nets to $0 whichever way it got there.

  // A line's price, struck through and restated when it carries a discount.
  // Lifted verbatim out of the old Discounts panel — now that the adjust
  // control lives on the row, the row is where the discounted figure belongs,
  // and the list price alone would contradict the total in the rail.
  const linePriceLabel = (l: QuoteLine) =>
    (l.discountPercent ?? 0) > 0 ? (
      <>
        <span className={styles.strike}>{fmt$(lineListAmount(l))}</span>{" "}
        <strong>{fmt$(lineNetAmount(l))}</strong>
        {l.billingFrequency !== "one_time" && `/${fmtCycle(l.billingFrequency)}`}
      </>
    ) : (
      priceLabel(l.unitPrice, l.billingFrequency)
    );

  // The per-line adjust control, rendered on the row of ANY line that is on the
  // quote — a picked product, one of the always-included services, or the
  // platform fee. It used to be a panel of its own listing every line again,
  // which meant reading the quote twice: once to pick it, once to discount it.
  //
  // It has to reach the DERIVED lines, not just the pickable ones. Comping the
  // install and the onboarding is AIO's single most common discount and both
  // are lines the picker deliberately hides, so attaching this only to catalog
  // rows would have quietly removed the thing it is most used for.
  const lineAdjust = (id: string) => {
    // A product that is only on the quote as package-covered lines has no
    // entry here — applyPackageComp holds those at 100% whatever the rep
    // types, so offering the control would be offering a no-op. The row
    // already says "in the package"; that's the honest answer.
    const l = lineFor.get(id);
    if (!onAdjustmentsChange || !l) return null;

    const open = openAdjust.has(id);
    const start = l.billingStart;
    const mode = start?.mode ?? "now";
    const discounted = (l.discountPercent ?? 0) > 0;
    const delayed = mode !== "now";
    const unitMode = Array.isArray(adjustments[id]?.units) || openUnits.has(id);
    const units = unitMode ? unitsOf(id, l.qty) : [];

    return (
      <div className={styles.adjustWrap}>
        <button
          type="button"
          className={styles.adjustToggle}
          data-active={discounted || delayed || undefined}
          aria-expanded={open}
          onClick={() => toggleAdjust(id)}
        >
          {discounted || delayed ? (
            <>
              {discounted && <span className={styles.savedTag}>−{fmt$(l.discountAmount)}</span>}
              {delayed && <span className={styles.delayTag}>Starts later</span>}
            </>
          ) : (
            "Adjust"
          )}
          <span className={styles.adjustChevron} aria-hidden="true">▾</span>
        </button>

        {open && (
          <div className={styles.adjustDrawer}>
            {unitMode && (
              <div className={styles.unitList}>
                {units.map((u, i) => {
                  const us = u.billingStart;
                  const umode = us?.mode ?? "now";
                  return (
                    <div key={i} className={styles.unitRow}>
                      <span className={styles.unitName}>Unit {i + 1}</span>
                      <label className={styles.adjustField}>
                        <span className={styles.adjustLabel}>Discount</span>
                        <span className={styles.pctWrap}>
                          <input
                            type="number" min={0} max={100} step={1}
                            className={styles.adjustInput}
                            value={u.discountPercent ?? ""}
                            placeholder="0"
                            onChange={e => setUnitDiscount(id, l.qty, i, e.target.value)}
                            aria-label={`Discount percent for unit ${i + 1} of ${l.name}`}
                          />
                          <span className={styles.pctSign}>%</span>
                        </span>
                      </label>
                      {l.billingFrequency !== "one_time" && (
                        <label className={styles.adjustField}>
                          <span className={styles.adjustLabel}>Billing starts</span>
                          <span className={styles.startWrap}>
                            <select
                              className={styles.adjustSelect}
                              value={umode}
                              onChange={e => setUnitStartMode(id, l.qty, i, e.target.value as "now" | "date" | "days")}
                              aria-label={`When billing starts for unit ${i + 1} of ${l.name}`}
                            >
                              <option value="now">At checkout</option>
                              <option value="date">On a date</option>
                              <option value="days">After N days</option>
                            </select>
                            {us?.mode === "date" && (
                              <input
                                type="date"
                                className={styles.adjustInput}
                                value={us.date}
                                onChange={e => setUnit(id, l.qty, i, { billingStart: { mode: "date", date: e.target.value } })}
                                aria-label={`Billing start date for unit ${i + 1} of ${l.name}`}
                              />
                            )}
                            {us?.mode === "days" && (
                              <span className={styles.pctWrap}>
                                <input
                                  type="number" min={1} max={MAX_BILLING_DELAY_DAYS} step={1}
                                  className={styles.adjustInput}
                                  value={us.days}
                                  onChange={e => setUnit(id, l.qty, i, { billingStart: { mode: "days", days: Number(e.target.value) } })}
                                  aria-label={`Billing start delay in days for unit ${i + 1} of ${l.name}`}
                                />
                                <span className={styles.pctSign}>days</span>
                              </span>
                            )}
                          </span>
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Discount and billing start are SEPARATED, each in its own
                titled block (2026-10-09). Side by side in one row they read
                as one control with two halves — "discount 50%, billing starts
                after 60 days" looks like the discount is what starts in 60
                days, which is the opposite of what a delayed start does. */}
            {!unitMode && (<>
            <div className={styles.adjustBlock}>
              <span className={styles.adjustBlockTitle}>Discount</span>
            <label className={styles.adjustField}>
              <span className={styles.adjustLabel}>Percent off</span>
              <span className={styles.pctWrap}>
                <input
                  type="number" min={0} max={100} step={1}
                  className={styles.adjustInput}
                  value={l.discountPercent ?? ""}
                  placeholder="0"
                  onChange={e => setDiscount(id, e.target.value)}
                  aria-label={`Discount percent for ${l.name}`}
                />
                <span className={styles.pctSign}>%</span>
              </span>
            </label>

            {/* Only worth offering on a line with more than one unit — and
                only alongside a discount, since there is nothing to scope
                otherwise. Blank means the whole line, which is the usual case.
                The quote splits into a discounted line and a full-price one
                rather than averaging the discount across the quantity, which
                wouldn't divide evenly. */}
            {l.qty > 1 && discounted && (
              <label className={styles.adjustField}>
                <span className={styles.adjustLabel}>Applies to</span>
                <span className={styles.pctWrap}>
                  <input
                    type="number" min={1} max={l.qty} step={1}
                    className={styles.adjustInput}
                    value={adjustments[id]?.discountQty ?? ""}
                    placeholder={String(l.qty)}
                    onChange={e => setDiscountQty(id, e.target.value)}
                    aria-label={`How many ${l.name} the discount applies to`}
                  />
                  <span className={styles.pctSign}>of {l.qty}</span>
                </span>
              </label>
            )}
            </div>

            {/* One-time charges have no billing schedule to delay. */}
            {l.billingFrequency !== "one_time" && (
              <div className={styles.adjustBlock}>
                <span className={styles.adjustBlockTitle}>When billing starts</span>
              <label className={styles.adjustField}>
                <span className={styles.adjustLabel}>First charge</span>
                <span className={styles.startWrap}>
                  <select
                    className={styles.adjustSelect}
                    value={mode}
                    onChange={e => setStartMode([id], e.target.value as "now" | "date" | "days")}
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
                      onChange={e => setAdjustment(id, { billingStart: { mode: "date", date: e.target.value } })}
                      aria-label={`Billing start date for ${l.name}`}
                    />
                  )}
                  {start?.mode === "days" && (
                    <span className={styles.pctWrap}>
                      <input
                        type="number" min={1} max={MAX_BILLING_DELAY_DAYS} step={1}
                        className={styles.adjustInput}
                        value={start.days}
                        onChange={e => setAdjustment(id, { billingStart: { mode: "days", days: Number(e.target.value) } })}
                        aria-label={`Billing start delay in days for ${l.name}`}
                      />
                      <span className={styles.pctSign}>days</span>
                    </span>
                  )}
                </span>
              </label>
              </div>
            )}
            </>)}

            {/* Several units on one line: the rep may want them treated
                differently — one free, one started later. Offered on any line
                with more than one unit, and always while already in the mode so
                it can be left. */}
            {(l.qty > 1 || unitMode) && (
              <button
                type="button"
                className={styles.linkBtn}
                onClick={() => (unitMode ? leaveUnitMode(id) : enterUnitMode(id, l.qty))}
              >
                {unitMode ? "Use one setting for all units" : `Adjust each of the ${l.qty} units separately`}
              </button>
            )}

            <p className={styles.adjustNote}>
              A discount on a recurring line is permanent — {maxDiscountPercent}% off a monthly fee is
              that much off every month, for good. To give something away temporarily, delay when
              billing starts instead.
            </p>
          </div>
        )}
      </div>
    );
  };

  // Shared by both layouts — the panels host and the document host render
  // the same controls, so neither can drift from the other.
  const planCards = (
    <div className={styles.typeRow}>
      {types.map(t => {
        const price = planPrice(t.id);
        return (
          <button
            key={t.id}
            type="button"
            className={styles.typeCard}
            data-active={quoteType === t.id}
            onClick={() => changeType(t.id)}
          >
            <span className={styles.typeLabel}>{t.label}</span>
            <span className={styles.typeNote}>{t.note}</span>
            {/* Last, and pushed to the bottom edge, so the four prices
                sit on one line however long each note runs. Rendered
                only once the catalog has loaded — a plan whose product
                is missing shows no price rather than a $0 one. */}
            {price && <span className={styles.typePrice}>{price}</span>}
          </button>
        );
      })}
    </div>
  );

  const globalControls = (
    <div className={styles.globalGrid}>
      <label className={styles.adjustField}>
        <span className={styles.adjustLabel}>Billing starts</span>
        <span className={styles.startWrap}>
          <select
            className={styles.adjustSelect}
            value={globalMode}
            disabled={recurringIds.length === 0}
            onChange={e => setStartMode(recurringIds, e.target.value as "now" | "date" | "days")}
            aria-label="When billing starts for every recurring line"
          >
            {sharedStart.mixed && <option value="">Mixed — set all to…</option>}
            <option value="now">At checkout</option>
            <option value="date">On a date</option>
            <option value="days">After N days</option>
          </select>
          {sharedStart.start?.mode === "date" && (
            <input
              type="date"
              className={styles.adjustInput}
              value={sharedStart.start.date}
              onChange={e => setAdjustments(recurringIds, { billingStart: { mode: "date", date: e.target.value } })}
              aria-label="Billing start date for every recurring line"
            />
          )}
          {sharedStart.start?.mode === "days" && (
            <span className={styles.pctWrap}>
              <input
                type="number" min={1} max={MAX_BILLING_DELAY_DAYS} step={1}
                className={styles.adjustInput}
                value={sharedStart.start.days}
                onChange={e => setAdjustments(recurringIds, { billingStart: { mode: "days", days: Number(e.target.value) } })}
                aria-label="Billing start delay in days for every recurring line"
              />
              <span className={styles.pctSign}>days</span>
            </span>
          )}
        </span>
      </label>
    </div>
  );

  // The control itself, shared by both layouts so neither can drift.
  const clearCartControl = picks.length > 0 ? (
    confirmClear ? (
      <span className={styles.clearConfirm}>
        Clear {picks.length} {picks.length === 1 ? "line" : "lines"} and any discounts on them?
        <button type="button" className={styles.linkBtn} onClick={clearCart}>Clear it</button>
        <button type="button" className={styles.linkBtn} onClick={() => setConfirmClear(false)}>Keep</button>
      </span>
    ) : (
      <button type="button" className={styles.linkBtn} onClick={() => setConfirmClear(true)}>
        Clear cart
      </button>
    )
  ) : null;

  const productRow = (p: CatalogProduct, withAdjust: boolean) => {
    const n = qtyOf(p.hubspotProductId);
    // Capped in the picker AND refused by buildQuote. The cap is
    // the courtesy; the blocker is the authority, since the server
    // re-derives from the picks and never trusts the browser.
    const max = maxQtyFor(p.hubspotProductId, limits.unitCaps);
    const covered = coveredQty.get(p.hubspotProductId) ?? 0;
    const planCovered = planCoveredQty.get(p.hubspotProductId) ?? 0;
    // Terminals topped up server-side sit on the quote but not in the
    // stepper. The configurator keeps the stepper at the floor, so this is
    // 0 unless the picks arrived short (a quote saved some other way).
    const toppedUp = p.hubspotProductId === AMS1_PRODUCT.hubspotProductId ? built.requiredTerminals.qty : 0;
    const onQuote = n + toppedUp;
    const min = p.hubspotProductId === AMS1_PRODUCT.hubspotProductId ? terminalFloor : 0;
    // Which POS products, if any, are currently carrying this one along. The
    // rep needs to see that the terminal, the display and the drawer arrived
    // with the POS rather than wondering who added them — and, for the AMS1,
    // that it is not optional. Read off the picks, so it says so only while
    // the POS is actually on the quote.
    const carriedBy = POS_COMPANIONS
      .filter(c => c.hubspotProductId === p.hubspotProductId)
      .flatMap(c => c.withProductIds.filter(id => qtyOf(id) > 0));
    const autoAdded = isProcessingQuote(quoteType) && carriedBy.length > 0;
    // A kiosk SKU ships with its own AMS1, so nothing adds one for it — but a
    // rep selling kiosks for ordering still usually needs a terminal, and
    // might not for a marketing-only kiosk. Hence a reminder on the terminal
    // row rather than a quantity nobody asked for.
    const kioskNeedsTerminal =
      p.hubspotProductId === AMS1_PRODUCT.hubspotProductId &&
      isProcessingQuote(quoteType) &&
      !autoAdded &&
      picks.some(pick => KIOSK_PRODUCT_IDS.includes(pick.hubspotProductId) && pick.qty > 0);
    // The 2-year marketing plan LOANS its kiosk rather than discounting it, so
    // a price under the row reads as a charge the merchant is about to see on
    // the quote (product owner, 2026-10-09). The quote document still shows
    // what any EXTRA one costs, which is where that number belongs.
    const loanedByPlan = quoteType === "marketing_term" && MARKETING_TERM_KIOSK_IDS.includes(p.hubspotProductId);
    return (
      <div key={p.hubspotProductId} className={styles.productRow} data-picked={n > 0}>
        <div className={styles.productMain}>
          <div className={styles.productName}>{p.name}</div>
          <div className={styles.productPrice}>
            {loanedByPlan ? "Included with the 2-year plan" : priceLabel(p.price, p.billingFrequency)}
          </div>
          {autoAdded && (
            <div className={styles.autoTag}>
              {p.hubspotProductId === AMS1_PRODUCT.hubspotProductId
                ? "Added with each POS — one ships with every unit"
                : "Added with the POS — remove it if they don't need it"}
            </div>
          )}
          {kioskNeedsTerminal && (
            <div className={styles.autoTag}>
              Kiosks come with their own terminal. Add one here only if they&apos;re taking payments
              somewhere else too.
            </div>
          )}
          {covered > 0 && (
            <div className={styles.coveredTag}>
              {coverageLabel(covered, onQuote, "the package")}
            </div>
          )}
          {planCovered > 0 && (
            <div className={styles.coveredTag}>
              {planCovered >= onQuote
                ? "Included in the plan"
                : `${planCovered} of ${onQuote} included in the plan`}
            </div>
          )}
        </div>
        <div className={styles.stepper}>
          <button
            type="button" className={styles.stepBtn} disabled={n <= min}
            title={min > 0 && n <= min ? "One per POS unit" : undefined}
            onClick={() =>
              // Taking off a unit the kit is currently covering
              // gives hardware back — ask first, since it is
              // the easiest thing on this screen to do by accident.
              covered > onQuote - 1
                ? setConfirmKitRemove(p.hubspotProductId)
                : setQtyFor(p.hubspotProductId, n - 1)
            }
            aria-label={`Remove one ${p.name}`}
          >−</button>
          {/* A TYPED box, not a read-out (2026-10-09). "Payroll should allow
              type function so you can type 25 employees rather than clicking
              the add button 25 times" — and the same is true of every line a
              multi-site merchant buys. The +/− buttons stay, because one more
              is the common case and the kit's give-it-back confirmation hangs
              off the minus. A box that takes 25 also takes 250, which is what
              the unit caps are for. */}
          <input
            type="number" inputMode="numeric" step={1}
            min={min} max={max ?? undefined}
            className={styles.stepQty}
            value={n}
            onChange={e => {
              const typed = Math.floor(Number(e.target.value));
              setQtyFor(p.hubspotProductId, Number.isFinite(typed) ? Math.max(0, typed) : 0);
            }}
            aria-label={`How many ${p.name}`}
          />
          <button
            type="button" className={styles.stepBtn}
            disabled={max != null && n >= max}
            onClick={() => setQtyFor(p.hubspotProductId, n + 1)}
            aria-label={`Add one ${p.name}`}
          >+</button>
        </div>
        {p.hubspotProductId === WEBSITE_PRODUCT_ID && n > 0 && isMarketingQuote(quoteType) && onAdjustmentsChange && (
          <label className={`${styles.channel} ${styles.fullRow}`} data-on={websiteOn}>
            <input
              type="checkbox"
              className={styles.channelBox}
              checked={websiteOn}
              onChange={e => setAdjustment(WEBSITE_PRODUCT_ID, { onlineOrdering: e.target.checked || null })}
            />
            <span className={styles.channelLabel}>Online ordering</span>
            <span className={styles.channelNote}>
              Optional. When on, the site takes orders and AIO processes the card payments.
            </span>
          </label>
        )}
        {confirmKitRemove === p.hubspotProductId && (
          <div className={styles.confirmBox} role="alertdialog" aria-label={`Remove ${p.name}?`}>
            <p>
              <strong>{p.name}</strong> comes free with the {packages.applied[0]?.name ?? "kit"}.
              Take it off and this merchant won&apos;t get it.
            </p>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.linkBtn}
                onClick={() => {
                  setQtyFor(p.hubspotProductId, n - 1);
                  setConfirmKitRemove(null);
                }}
              >
                Remove it
              </button>
              <button type="button" className={styles.linkBtn} onClick={() => setConfirmKitRemove(null)}>
                Keep it
              </button>
            </div>
          </div>
        )}
        {/* Wraps onto its own line under the row. Returns null
            until the product is actually on the quote. */}
        {withAdjust && lineAdjust(p.hubspotProductId)}
      </div>
    );
  };

  if (layout === "document") {
    // Why a line is on the quote, said once beside the line rather than in a
    // panel of its own. Keyed off ids and `coveredByPackage`, never off object
    // identity: buildQuote rebuilds every line as it adjusts and packs them.
    const docTag = (l: QuoteLine): { tag?: string; why?: string } => {
      if (l.coveredByPackage) {
        return l.coveredByPackage === planName ? { tag: "In plan" } : { tag: "In package", why: l.coveredByPackage };
      }
      if (platform.line && l.hubspotProductId === platform.line.hubspotProductId) return { tag: "Plan" };
      if (isPreAuthProduct(l.hubspotProductId, l.name)) {
        return { tag: "Pre-auth", why: "Nothing else is due at checkout, so the card is pre-authorized. Can't be removed." };
      }
      if (l.hubspotProductId === PROCESSING_DISCLOSURE_PRODUCT.hubspotProductId) return { tag: "Card rates" };
      if (l.hubspotProductId === SOFTWARE_LICENSE_PRODUCT.hubspotProductId) {
        return { tag: "Auto", why: `${built.softwareLicense.screens} screens, ${INCLUDED_SCREEN_COUNT} included in the plan` };
      }
      if (INCLUDED_SERVICE_PRODUCTS.some(s => s.hubspotProductId === l.hubspotProductId)) {
        return { tag: isCompedService(l) && lineNetAmount(l) === 0 ? "Comped" : "Included" };
      }
      return {};
    };

    // A split line (a scoped discount, or a package covering part of it) is
    // two lines of one product; its adjust control belongs on the first only.
    const adjustShown = new Set<string>();
    const docLine = (l: QuoteLine, i: number) => {
      const { tag, why } = docTag(l);
      const list = lineListAmount(l);
      const net = lineNetAmount(l);
      const cycle = l.billingFrequency === "one_time" ? "" : `/${fmtCycle(l.billingFrequency)}`;
      const first = !adjustShown.has(l.hubspotProductId);
      adjustShown.add(l.hubspotProductId);
      const isWifi = l.hubspotProductId === WIFI_PRODUCT_ID && !l.coveredByPackage;
      return (
        <div key={`${l.hubspotProductId}-${i}`} className={styles.docLine}>
          <div className={styles.docLineMain}>
            <div className={styles.docLineName}>
              {l.qty > 1 && <span className={styles.docQty}>{l.qty} ×</span>}
              {l.name.trim()}
              {tag && <span className={styles.docTag} data-tag={tag}>{tag}</span>}
            </div>
            {why && <div className={styles.docWhy}>{why}</div>}
            {l.billingStart && <div className={styles.docWhy}>{describeBillingStart(l.billingStart)}</div>}
          </div>
          <div className={styles.docAmount}>
            {list > net && <span className={styles.strike}>{fmt$(list)}</span>}{" "}
            <strong>{fmt$(net)}</strong>{cycle}
          </div>
          {isWifi && first && onAdjustmentsChange && !confirmWifi && (
            <button type="button" className={styles.linkBtn} onClick={() => setConfirmWifi(true)}>Remove</button>
          )}
          {isWifi && first && confirmWifi && (
            <div className={styles.confirmBox}>
              <p>Remove the WiFi package? This merchant won&apos;t get a network quoted.</p>
              <div className={styles.confirmActions}>
                <button
                  type="button"
                  className={styles.linkBtn}
                  onClick={() => { setAdjustment(WIFI_PRODUCT_ID, { removed: true }); setConfirmWifi(false); }}
                >
                  Remove
                </button>
                <button type="button" className={styles.linkBtn} onClick={() => setConfirmWifi(false)}>Cancel</button>
              </div>
            </div>
          )}
          {first && lineAdjust(l.hubspotProductId)}
        </div>
      );
    };

    const recurringDoc = quoteLines.filter(l => l.billingFrequency !== "one_time");
    // The merchant's own picks first, then what came with them.
    const oneTimeDoc = quoteLines
      .filter(l => l.billingFrequency === "one_time")
      .map((l, i) => ({ l, i, derived: docTag(l).tag ? 1 : 0 }))
      .sort((a, b) => a.derived - b.derived || a.i - b.i)
      .map(x => x.l);

    const missingNames = catalogLoading ? [] : [
      ...(platform.status === "unresolved" ? [platform.productName] : []),
      ...includedServices.missing,
      ...processingDisclosure.missing,
      ...built.softwareLicense.missing,
      ...built.requiredTerminals.missing,
    ];

    return (
      <div className={styles.docLayout}>
        <div className={styles.buildCol}>
          {types.length > 1 && (
            <section>
              <h3 className={styles.buildHead}>Plan</h3>
              {planCards}
            </section>
          )}

          {buildSlot}

          <section>
            <div className={styles.buildHeadRow}>
              <h3 className={styles.buildHead}>{rated ? "Hardware" : "Products"}</h3>
              {rated && built.softwareLicense.screens > 0 && (
                <span className={styles.buildMeta}>
                  {built.softwareLicense.screens} screens · {INCLUDED_SCREEN_COUNT} included
                </span>
              )}
              {clearCartControl}
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
                <div className={styles.tileGrid}>
                  {group.products.map(p => productRow(p, false))}
                </div>
              </div>
            ))}
          </section>

          {rated && (
            <section>
              <div className={styles.buildHeadRow}>
                <h3 className={styles.buildHead}>Ordering channels</h3>
                <span className={styles.buildMeta}>{orderPoints.total} ordering points</span>
              </div>
              <div className={styles.chipRow}>
                {ORDER_POINT_CHANNELS.map(c => (
                  <button
                    key={c.id}
                    type="button"
                    className={styles.chip}
                    data-on={channels.includes(c.id)}
                    aria-pressed={channels.includes(c.id)}
                    title={c.note ?? undefined}
                    onClick={() => toggleChannel(c.id)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
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
            </section>
          )}
        </div>

        <aside className={styles.docCol}>
          <div className={styles.doc}>
            {documentHeader}

            {onAdjustmentsChange && quoteLines.length > 0 && (
              <div className={styles.docControls}>{globalControls}</div>
            )}

            {documentRate}

            {recurringDoc.length > 0 && (
              <div className={styles.docGroup}>
                <div className={styles.docGroupHead}>
                  <span>Monthly</span>
                  <span>{fmt$(totals.monthlyEquivalent)}/mo</span>
                </div>
                {recurringDoc.map(docLine)}
              </div>
            )}

            {(oneTimeDoc.length > 0 || adjustments[WIFI_PRODUCT_ID]?.removed) && (
              <div className={styles.docGroup}>
                <div className={styles.docGroupHead}>
                  <span>One-time</span>
                  <span>{fmt$(totals.oneTime)}</span>
                </div>
                {oneTimeDoc.map(docLine)}
                {adjustments[WIFI_PRODUCT_ID]?.removed && (
                  <div className={styles.docLine} data-pending="true">
                    <div className={styles.docLineMain}>
                      <div className={styles.docLineName}>AIO WiFi Network Package</div>
                      <div className={styles.docWhy}>Removed from this quote</div>
                    </div>
                    <button
                      type="button"
                      className={styles.linkBtn}
                      onClick={() => setAdjustment(WIFI_PRODUCT_ID, { removed: null })}
                    >
                      Add back
                    </button>
                  </div>
                )}
              </div>
            )}

            {isMarketingQuote(quoteType) && !websiteOn && (
              <div className={styles.docLine} data-pending="true">
                <div className={styles.docLineMain}>
                  <div className={styles.docLineName}>{PROCESSING_DISCLOSURE_PRODUCT.name}</div>
                  <div className={styles.docWhy}>Add the Website with online ordering and AIO processes the card payments it takes</div>
                </div>
              </div>
            )}

            {packages.applied.map(a => (
              <p key={a.packageId} className={styles.docWhy}>
                <strong>{a.name}{a.count > 1 && ` ×${a.count}`}</strong> covers {coveredSummary}.
              </p>
            ))}

            {quoteLines.length === 0 && !catalogLoading && (
              <p className={styles.sectionNote}>
                {rated
                  ? "Rate-only so far. Add hardware or an ordering channel and the plan fee, install and training appear here."
                  : "Add a marketing product to start the quote."}
              </p>
            )}

            {missingNames.length > 0 && (
              <div className={styles.error}>
                <strong>Can&apos;t price {missingNames.join(", ")}.</strong> Missing from the HubSpot
                catalog (renamed, archived, or it didn&apos;t load) — this quote can&apos;t be sent until
                that&apos;s fixed.
              </div>
            )}

            {quoteLines.length > 0 && (
              <div className={styles.docTotals}>
                {packages.savings > 0 && (
                  <div className={styles.totalRow}>
                    <span className={styles.totalLabel}>Package savings</span>
                    <span className={styles.totalValue} data-tone="discount">−{fmt$(packages.savings)}</span>
                  </div>
                )}
                {totalDiscount > 0 && (
                  <div className={styles.totalRow}>
                    <span className={styles.totalLabel}>Discounts</span>
                    <span className={styles.totalValue} data-tone="discount">−{fmt$(totalDiscount)}</span>
                  </div>
                )}
                <div className={styles.docTotalGrid}>
                  <div>
                    <div className={styles.docTotalValue}>{fmt$(amountDueAtCheckout(quoteLines))}</div>
                    <div className={styles.docTotalLabel}>Due at checkout</div>
                  </div>
                  {recurringDoc.length > 0 && (
                    <div>
                      <div className={styles.docTotalValue}>{fmt$(totals.monthlyEquivalent)}</div>
                      <div className={styles.docTotalLabel}>Per month</div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {documentFooter}
          </div>
        </aside>
      </div>
    );
  }

  return (
    // One roomy column of decisions. The running total hangs OUTSIDE that
    // column (see .layout) so adding a line never shrinks the catalog. The
    // rail only exists once there is a total to put in it — otherwise an
    // untouched picker would reserve a 17rem gutter of nothing. Hosts with
    // no gutter pass rail="inline" and the totals stay underneath.
    <div
      className={styles.layout}
      data-railed={quoteLines.length > 0 || undefined}
      data-rail={rail === "inline" ? "inline" : undefined}
    >
      <div className={styles.mainCol}>
        {types.length > 1 && (
          <div className={styles.panel}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Quote Type</h2>
              <p className={styles.sectionNote}>
                Pick this first — it decides what can go on the quote, which platform fee applies,
                and whether there&apos;s a processing rate at all.
              </p>
            </div>
            {planCards}
          </div>
        )}

        {/* One lever for the whole quote, because that is how the concession is
            actually given. Sits directly above the product list it applies to
            (moved there 2026-10-08, at the product owner's request — it used to
            be last on the page). Always rendered, so the panels below don't
            reflow when the first line lands; with nothing picked yet its
            controls are disabled. The per-line drawers win for exceptions —
            these write the same `discountPercent` / `billingStart` they do. */}
        {onAdjustmentsChange && (
            <div className={styles.panel}>
              <div className={styles.sectionHead}>
                <h2 className={styles.sectionTitle}>When Billing Starts</h2>
                <p className={styles.sectionNote}>
                  {quoteLines.length === 0
                    ? "Pick products below, then push the first charge out for the whole quote here."
                    : "Sets every recurring line at once. Use a line's own Adjust button for exceptions."}
                </p>
              </div>

              {globalControls}

              <p className={styles.adjustNote}>
                Recurring lines only — a one-time charge has no schedule to move and always bills at
                checkout. All-in-One and Order &amp; Pay quotes start at {PLAN_DEFAULT_BILLING_DELAY_DAYS}{" "}
                days; past {limits.maxBillingDelayDays} an admin has to approve it. Discounts are set
                on the individual lines below, not here.
              </p>
            </div>
        )}

        <div className={styles.panel}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>
              Products &amp; Hardware
              {clearCartControl && <span className={styles.titleAction}>{clearCartControl}</span>}
            </h2>
            <p className={styles.sectionNote}>
              {rated ? (
                <>
                  Priced from the live AIO catalog and snapshotted onto the quote, so a later catalog
                  change never moves what this customer was quoted. The platform fee isn&apos;t in the
                  list — it follows the plan, and is shown below.
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
              {group.products.map(p => productRow(p, true))}
            </div>
          ))}
        </div>

        {/* Derived, exactly like the platform tier: the rep picks the hardware
            and EasyOB works out which pre-made packages that cart adds up to.
            There is nothing to choose here, which is why there is no control. */}
        {packages.applied.length > 0 && (
          <div className={styles.panel}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Packages</h2>
              <p className={styles.sectionNote}>
                What this cart breaks down into. Everything a package covers stays on the quote at
                its list price, discounted to $0, so the customer can see what they got — anything
                left over is billed as additional hardware.
              </p>
            </div>

            {packages.applied.map(a => (
              <div key={a.packageId} className={styles.packageRow}>
                <div className={styles.productMain}>
                  <div className={styles.packageName}>
                    {a.name}{a.count > 1 && ` ×${a.count}`}
                  </div>
                  <div className={styles.packageContents}>{coveredSummary}</div>
                </div>
                <span className={styles.packagePrice}>{fmt$(a.price)}</span>
              </div>
            ))}

            {packages.savings > 0 && (
              <p className={styles.sectionNote}>
                {fmt$(packages.coveredListAmount)} of hardware at list, included at no charge.
              </p>
            )}
          </div>
        )}

        {/* What the marketing plan turns on that the rep did not pick: the card
            processing a Website with online ordering brings with it.

            The hardware the plan hands over used to be listed here as derived
            $0 rows. It is a PICK now (2026-10-09) — three Menu Board Computers
            are included, not compulsory, and a merchant who wants five can buy
            the other two — so it lives in the picker above, where its row
            already says "3 of 5 included in the plan". Listing it again here
            would be the same hardware in two places disagreeing about whether
            it is a choice.

            The payments row renders on EVERY marketing quote, not only the
            ones that have a Website, and is greyed until the Website is picked
            with online ordering on: a rep is looking at this screen with the
            merchant, so "add a website and you can take card payments" is the
            conversation. The whole panel disappears on a POS quote, where none
            of this is a question. */}
        {isMarketingQuote(quoteType) && (
          <div className={styles.panel}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Included With This Plan</h2>
              <p className={styles.sectionNote}>
                What {planName} comes with at no cost. The first{" "}
                {MARKETING_INCLUDED_HARDWARE[0].qty} {MARKETING_INCLUDED_HARDWARE[0].name}s are free
                — set the quantity above, and anything past that bills at list. TVs are not supplied
                or installed by AIO.
                {quoteType === "marketing_term" &&
                  " The kiosk is the Marketing Kit you pick above — the first one is free."}
              </p>
            </div>
            <div className={styles.includedRow} data-pending={!websiteOn || undefined}>
              <div className={styles.productMain}>
                <div className={styles.productName}>{PROCESSING_DISCLOSURE_PRODUCT.name}</div>
                <div className={styles.productPrice}>
                  {websiteOn
                    ? "Card rates, stated on the quote — bills nothing by itself"
                    : "Add the Website above with online ordering and AIO processes the card payments it takes"}
                </div>
              </div>
              <span className={styles.includedTag}>
                {websiteOn ? "Included ×1" : "Needs online ordering"}
              </span>
            </div>

            {processingDisclosure.missing.length > 0 && (
              <div className={styles.error}>
                <strong>Can&apos;t state the card rates.</strong>{" "}
                {processingDisclosure.missing.join(", ")} isn&apos;t in the HubSpot catalog (renamed,
                archived, or the catalog didn&apos;t load). This quote can&apos;t be sent until
                that&apos;s fixed — the merchant would be signed up for card processing with no rates
                written on the document.
              </div>
            )}
          </div>
        )}

        {/* Every quote that puts the system in a restaurant includes these three.
            Shown, priced, and not a decision — hence no stepper. */}
        {rated && (includedServices.lines.length > 0 || includedServices.missing.length > 0 || adjustments[WIFI_PRODUCT_ID]?.removed) && (
          <div className={styles.panel}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Always Included</h2>
              <p className={styles.sectionNote}>
                On every quote that has products on it. The install and the training stay. The WiFi
                package is added too, and can be removed. Take every product off and they come off
                as well, leaving a rate-only quote.
              </p>
            </div>
            {includedServices.lines.map(l => (
              <div key={l.hubspotProductId} className={styles.includedRow}>
                <div className={styles.productMain}>
                  <div className={styles.productName}>{l.name}</div>
                  <div className={styles.productPrice}>{priceLabel(l.unitPrice, l.billingFrequency)}</div>
                </div>
                <span className={styles.includedTag}>
                  {coveredQty.has(l.hubspotProductId) ? "In the package" : "Included ×1"}
                </span>
                {l.hubspotProductId === WIFI_PRODUCT_ID && !confirmWifi && (
                  <button type="button" className={styles.linkBtn} onClick={() => setConfirmWifi(true)}>
                    Remove
                  </button>
                )}
                {l.hubspotProductId === WIFI_PRODUCT_ID && confirmWifi && (
                  <div className={styles.confirmBox}>
                    <p>Remove the WiFi package? This merchant won&apos;t get a network quoted.</p>
                    <div className={styles.confirmActions}>
                      <button
                        type="button"
                        className={styles.linkBtn}
                        onClick={() => {
                          setAdjustment(WIFI_PRODUCT_ID, { removed: true });
                          setConfirmWifi(false);
                        }}
                      >
                        Remove
                      </button>
                      <button type="button" className={styles.linkBtn} onClick={() => setConfirmWifi(false)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {/* The install and the training are the two most-discounted
                    lines in AIO's portal, and the picker hides both — so this
                    is the only place a rep can charge for a re-install. */}
                {lineAdjust(l.hubspotProductId)}
              </div>
            ))}
            {adjustments[WIFI_PRODUCT_ID]?.removed && (
              <div className={styles.includedRow} data-pending="true">
                <div className={styles.productMain}>
                  <div className={styles.productName}>AIO WiFi Network Package</div>
                  <div className={styles.productPrice}>Not on this quote</div>
                </div>
                <span className={styles.includedTag}>Removed</span>
                <button
                  type="button"
                  className={styles.linkBtn}
                  onClick={() => setAdjustment(WIFI_PRODUCT_ID, { removed: null })}
                >
                  Add back
                </button>
              </div>
            )}
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

        {rated && built.softwareLicense.screens > 0 && (
          <div className={styles.panel}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Additional Software</h2>
              <p className={styles.sectionNote}>
                {built.softwareLicense.screens} screens on this quote, {INCLUDED_SCREEN_COUNT} included
                {built.softwareLicense.lines[0]
                  ? `, ${built.softwareLicense.lines[0].qty} × ${fmt$(built.softwareLicense.lines[0].unitPrice)}/mo added`
                  : ", so no additional license is added"}
                . A screen is a POS, KDS, kiosk, menu board, mPOS or tablet.
              </p>
            </div>
            {built.softwareLicense.lines.map(l => (
              <div key={l.hubspotProductId} className={styles.includedRow}>
                <div className={styles.productMain}>
                  <div className={styles.productName}>{l.name}</div>
                  <div className={styles.productPrice}>{priceLabel(l.unitPrice, l.billingFrequency)}</div>
                </div>
                <span className={styles.includedTag}>×{l.qty}</span>
                {lineAdjust(l.hubspotProductId)}
              </div>
            ))}
            {built.softwareLicense.missing.length > 0 && (
              <div className={styles.error}>
                <strong>Can&apos;t price the extra screens.</strong>{" "}
                {built.softwareLicense.missing.join(", ")} isn&apos;t in the HubSpot catalog (renamed,
                archived, or the catalog didn&apos;t load). This quote can&apos;t be sent until that&apos;s fixed.
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
                channels never appear on a hardware list, so they have to be declared here. Reported
                on the deal — the plan above is what sets the platform fee.
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

      </div>

      {/* Hangs in the page gutter on wide hosts; short by construction, so it
          can follow the page down without becoming its own scroll box. */}
      <aside className={styles.sideCol}>
        {/* The plan's platform fee. Its own panel since 2026-10-05: it used to
            live inside Ordering Points because the count selected the tier, and
            leaving it there would keep implying a link that no longer exists —
            and would hide it entirely on a marketing-only quote, which now
            carries one too.

            In the side column with the totals, because that is what it is: the
            largest recurring number on the quote, read alongside the rest of
            the money rather than among the things a rep is picking. */}
        <div className={styles.panel}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Platform Fee</h2>
            <p className={styles.sectionNote}>
              Derived from the plan, not picked. Change it by changing the quote type above.
            </p>
          </div>

          {platform.line ? (
            <div className={styles.tierBox}>
              <div className={styles.tierName}>{platform.line.name}</div>
              <div className={styles.tierPrice}>{linePriceLabel(platform.line)}</div>
              {lineAdjust(platform.line.hubspotProductId)}
            </div>
          ) : platform.status === "none_needed" ? (
            <p className={styles.sectionNote}>
              No platform fee — this is a rate-only quote. Pick a product or declare an ordering
              channel and the plan&apos;s fee is added automatically.
            </p>
          ) : (
            <div className={styles.error}>
              <strong>Platform fee missing.</strong> This quote requires
              &ldquo;{platform.productName}&rdquo;, which isn&apos;t in the HubSpot catalog (renamed,
              archived, or the catalog didn&apos;t load). This quote can&apos;t be sent until
              that&apos;s fixed — sending it would quote no platform fee at all.
            </div>
          )}
        </div>

        {quoteLines.length > 0 && (
          <QuoteReceipt
            lines={quoteLines}
            totals={totals}
            packageSavings={packages.savings}
            discountTotal={totalDiscount}
            dueAtCheckout={amountDueAtCheckout(quoteLines)}
            preAuthAmount={built.preAuth.lines[0]?.unitPrice ?? null}
          />
        )}
      </aside>
    </div>
  );
}
