"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { listQuotableProductsAction } from "@/lib/actions/catalog";
import { getMaxDiscountPercent } from "@/lib/actions/pricing";
import {
  AMS1_PRODUCT,
  DEFAULT_MAX_DISCOUNT_PERCENT,
  INCLUDED_SCREEN_COUNT,
  MAX_BILLING_DELAY_DAYS,
  ORDER_POINT_CHANNELS,
  PLATFORM_PRODUCTS,
  PROCESSING_DISCLOSURE_PRODUCT,
  PRODUCT_GROUP_LABELS,
  QUOTE_TYPES,
  WIFI_PRODUCT_ID,
  amountDueAtCheckout,
  buildQuote,
  groupProducts,
  isAllowedForQuoteType,
  carriesWebsite,
  isCompedService,
  isPreAuthProduct,
  isMarketingQuote,
  isProcessingQuote,
  lineDiscountAmount,
  lineListAmount,
  lineNetAmount,
  maxQtyFor,
  toQuoteLine,
  unitsFromQuoteLines,
  type BuiltQuote,
} from "@/lib/quoting";
import { kitFor, kitPicks } from "@/lib/quotePackages";
import QuoteReceipt from "@/components/quoting/QuoteReceipt";
import { fmt$, fmtFrequency, monthlyEquivalent } from "@/lib/utils";
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
    const inKit = kitPicks(kit).flatMap(k => byId.get(k.hubspotProductId) ?? []);
    const kitIds = new Set(inKit.map(p => p.hubspotProductId));

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
    () => buildQuote(quoteType, pickedLines, channels, fullCatalog, adjustments, maxDiscountPercent),
    [quoteType, pickedLines, channels, fullCatalog, adjustments, maxDiscountPercent]
  );
  const {
    orderPoints, breakdown, platform, includedServices, planHardware,
    processingDisclosure, packages, totals, quoteLines,
  } = built;

  // Whether the Website is on the quote. `rated` above is the PLAN's answer and
  // stays that way — the install services and the ordering-point count follow
  // the plan, and a website merchant has nothing on site to install and no
  // ordering point we count. This is the other question: does AIO touch their
  // money.
  const websiteOn = carriesWebsite(pickedLines);

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
      if (l.coveredByPackage) map.set(l.hubspotProductId, (map.get(l.hubspotProductId) ?? 0) + l.qty);
    }
    return map;
  }, [packages.lines]);

  // What each package absorbed, for its one-line summary. Built off the
  // covered lines rather than the slot definitions so it describes what the
  // merchant actually got — an order-point slot could have been filled by
  // either a POS or a kiosk.
  const coveredSummary = useMemo(
    () =>
      packages.lines
        .filter(l => l.coveredByPackage)
        .map(l => `${l.qty} × ${l.name.trim()}`)
        .join(", "),
    [packages.lines]
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

  // Switching to a type that forbids something already picked has to drop it,
  // or the rep sends a marketing-only quote with a POS unit they can no longer
  // see. Runs off the catalog rather than the picks so it's a no-op until the
  // catalog has actually loaded.
  const changeType = (next: QuoteType) => {
    onQuoteTypeChange(next);
    setConfirmKitRemove(null);
    if (catalog.length) {
      const allowed = new Set(
        catalog.filter(p => isAllowedForQuoteType(p, next)).map(p => p.hubspotProductId)
      );
      const kept = picks.filter(p => allowed.has(p.hubspotProductId));

      // Choosing a plan that comes with a kit puts the whole kit on the quote.
      // ONLY onto an empty quote: a rep who has already picked hardware has
      // made choices, and swapping between the two kit plans must not pile a
      // second set of everything on top of them. Clicking the plan that is
      // already selected counts — that is how a rep re-applies the kit after
      // clearing it. WiFi isn't a pick (it is derived once there is hardware),
      // but "preselect everything" includes bringing it back if it was removed.
      const kit = kitFor(next);
      if (kit && kept.length === 0) {
        const inKit = new Map(kitPicks(kit).map(k => [k.hubspotProductId, k.qty]));
        const seeded = catalog
          .filter(p => allowed.has(p.hubspotProductId) && inKit.has(p.hubspotProductId))
          .map(p => ({ hubspotProductId: p.hubspotProductId, qty: inKit.get(p.hubspotProductId)! }));
        if (seeded.length) {
          onPicksChange(seeded);
          if (adjustments[WIFI_PRODUCT_ID]?.removed) setAdjustment(WIFI_PRODUCT_ID, { removed: null });
        } else if (picks.length) {
          onPicksChange(kept);
        }
      } else if (kept.length !== picks.length) {
        onPicksChange(kept);
      }
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
  // One shared start, or null when the lines disagree — a rep who delayed a
  // single line by hand must not be told the whole quote is delayed.
  const sharedStart = useMemo(() => {
    if (recurringLines.length === 0) return { mixed: false, start: null as BillingStart | null };
    const first = recurringLines[0].billingStart ?? null;
    const mixed = recurringLines.some(l => startKey(l.billingStart) !== startKey(first));
    return { mixed, start: mixed ? null : first };
  }, [recurringLines]);
  const globalMode = sharedStart.mixed ? "" : (sharedStart.start?.mode ?? "now");

  // ── The quote-wide discount ───────────────────────────────────────────────
  // Every chargeable line EXCEPT the comped services. Those sit at 100% by
  // default, and a rep's typed figure overrides the comp — so sweeping "10%
  // off" across them would quietly put $1,348 of install and training back on.
  // Package-covered lines are already absent from `lineFor`.
  const discountIds = useMemo(
    () => [...lineFor.keys()].filter(id => !isCompedService({ hubspotProductId: id })),
    [lineFor]
  );
  const sharedDiscount = useMemo(() => {
    if (discountIds.length === 0) return { mixed: false, pct: null as number | null };
    const pctOf = (id: string) =>
      adjustments[id]?.discountQty || lineFor.get(id)?.mixedDiscount ? -1 : (lineFor.get(id)?.discountPercent ?? 0);
    const first = pctOf(discountIds[0]);
    const mixed = discountIds.some(id => pctOf(id) !== first);
    return { mixed, pct: mixed || first <= 0 ? null : first };
  }, [discountIds, lineFor, adjustments]);

  const setGlobalDiscount = (raw: string) => {
    const pct = raw.trim() === "" ? null : Number(raw);
    const next = pct === null || Number.isNaN(pct) ? null : Math.min(100, Math.max(0, pct));
    // Whole lines only: a per-line "1 of 3" scope can't be shared across lines
    // with different quantities, so a quote-wide figure replaces it.
    setAdjustments(discountIds, { discountPercent: next || null, discountQty: null });
  };

  // A line's price, struck through and restated when it carries a discount.
  // Lifted verbatim out of the old Discounts panel — now that the adjust
  // control lives on the row, the row is where the discounted figure belongs,
  // and the list price alone would contradict the total in the rail.
  const linePriceLabel = (l: QuoteLine) =>
    (l.discountPercent ?? 0) > 0 ? (
      <>
        <span className={styles.strike}>{fmt$(lineListAmount(l))}</span>{" "}
        <strong>{fmt$(lineNetAmount(l))}</strong>
        {l.billingFrequency !== "one_time" && `/${fmtFrequency(l.billingFrequency)}`}
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

            {!unitMode && (<>
            <label className={styles.adjustField}>
              <span className={styles.adjustLabel}>Discount</span>
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

            {/* One-time charges have no billing schedule to delay. */}
            {l.billingFrequency !== "one_time" && (
              <label className={styles.adjustField}>
                <span className={styles.adjustLabel}>Billing starts</span>
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
              A discount on a recurring line is permanent — {maxDiscountPercent}% off a weekly fee is
              that much off every week, for good. To give something away temporarily, delay when
              billing starts instead.
            </p>
          </div>
        )}
      </div>
    );
  };

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
                <h2 className={styles.sectionTitle}>Whole-Quote Adjustments</h2>
                <p className={styles.sectionNote}>
                  {quoteLines.length === 0
                    ? "Pick products below, then discount or delay billing for the whole quote here."
                    : "Sets every line at once. Use a line's own Adjust button for exceptions."}
                </p>
              </div>

              <div className={styles.globalGrid}>
                <label className={styles.adjustField}>
                  <span className={styles.adjustLabel}>Discount</span>
                  <span className={styles.pctWrap}>
                    <input
                      type="number" min={0} max={100} step={1}
                      className={styles.adjustInput}
                      value={sharedDiscount.pct ?? ""}
                      placeholder={sharedDiscount.mixed ? "Mixed" : "0"}
                      disabled={discountIds.length === 0}
                      onChange={e => setGlobalDiscount(e.target.value)}
                      aria-label="Discount percent for every line on the quote"
                    />
                    <span className={styles.pctSign}>%</span>
                  </span>
                </label>

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

              <p className={styles.adjustNote}>
                The discount skips install and training, which are already comped to $0, and is
                capped at {maxDiscountPercent}%. On a recurring line it is permanent — to give time
                away, delay billing instead. A delay applies to recurring lines only; one-time
                charges always bill at checkout.
              </p>
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
              <div className={styles.groupTitle}>{group.label}</div>              {group.products.map(p => {
                const n = qtyOf(p.hubspotProductId);
                // Capped in the picker AND refused by buildQuote. The cap is
                // the courtesy; the blocker is the authority, since the server
                // re-derives from the picks and never trusts the browser.
                const max = maxQtyFor(p.hubspotProductId);
                const covered = coveredQty.get(p.hubspotProductId) ?? 0;
                const planCovered = planCoveredQty.get(p.hubspotProductId) ?? 0;
                return (
                  <div key={p.hubspotProductId} className={styles.productRow} data-picked={n > 0}>
                    <div className={styles.productMain}>
                      <div className={styles.productName}>{p.name}</div>
                      <div className={styles.productPrice}>{priceLabel(p.price, p.billingFrequency)}</div>
                      {covered > 0 && (
                        <div className={styles.coveredTag}>
                          {covered === n ? "In the package" : `${covered} of ${n} in the package`}
                        </div>
                      )}
                      {planCovered > 0 && (
                        <div className={styles.coveredTag}>
                          {planCovered === n
                            ? "Included in the plan"
                            : `${planCovered} of ${n} included in the plan`}
                        </div>
                      )}
                      {p.hubspotProductId === AMS1_PRODUCT.hubspotProductId && built.requiredTerminals.qty > 0 && (
                        <div className={styles.coveredTag}>
                          {built.requiredTerminals.qty} added automatically with your POS{" "}
                          {built.requiredTerminals.qty === 1 ? "unit" : "units"}
                        </div>
                      )}
                    </div>
                    <div className={styles.stepper}>
                      <button
                        type="button" className={styles.stepBtn} disabled={n === 0}
                        onClick={() =>
                          // Taking off a unit the kit is currently covering
                          // gives hardware back — ask first, since it is
                          // the easiest thing on this screen to do by accident.
                          covered > n - 1
                            ? setConfirmKitRemove(p.hubspotProductId)
                            : setQtyFor(p.hubspotProductId, n - 1)
                        }
                        aria-label={`Remove one ${p.name}`}
                      >−</button>
                      <span className={styles.stepQty}>{n}</span>
                      <button
                        type="button" className={styles.stepBtn}
                        disabled={max != null && n >= max}
                        onClick={() => setQtyFor(p.hubspotProductId, n + 1)}
                        aria-label={`Add one ${p.name}`}
                      >+</button>
                    </div>
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
                    {lineAdjust(p.hubspotProductId)}
                  </div>
                );
              })}
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

        {/* Everything the marketing plan carries that the rep did not pick:
            the hardware it hands over, and the card processing the Website
            turns on. One panel because they are one answer to one question â
            what does this plan come with â and two panels of $0 rows read as
            two unrelated asides.

            No stepper and no adjust control, unlike Always Included: these
            aren't comped services a rep may decide to charge for.

            The payments row renders on EVERY marketing quote, not only the
            ones that have a Website, and is greyed until one is picked: a rep
            is looking at this screen with the merchant, so "add a website and
            you can take card payments" is the conversation. The whole panel
            disappears on a POS quote, where none of this is a question. */}
        {isMarketingQuote(quoteType) && (
          <div className={styles.panel}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Included With This Plan</h2>
              <p className={styles.sectionNote}>
                What {planName} comes with, at no cost and shown at list price so the merchant can
                see what they got. TVs are not supplied or installed by AIO.
                {quoteType === "marketing_term" &&
                  " The kiosk is the Marketing Kit you pick above â the first one is free."}
              </p>
            </div>

            {planHardware.lines.map(l => (
              <div key={l.hubspotProductId} className={styles.includedRow}>
                <div className={styles.productMain}>
                  <div className={styles.productName}>{l.name}</div>
                  <div className={styles.productPrice}>{priceLabel(l.unitPrice, l.billingFrequency)}</div>
                </div>
                <span className={styles.includedTag}>Included ×{l.qty}</span>
              </div>
            ))}

            <div className={styles.includedRow} data-pending={!websiteOn || undefined}>
              <div className={styles.productMain}>
                <div className={styles.productName}>{PROCESSING_DISCLOSURE_PRODUCT.name}</div>
                <div className={styles.productPrice}>
                  {websiteOn
                    ? "Card rates, stated on the quote — bills nothing by itself"
                    : "Add the Website above and AIO processes the card payments it takes"}
                </div>
              </div>
              <span className={styles.includedTag}>
                {websiteOn ? "Included ×1" : "Needs the Website"}
              </span>
            </div>

            {planHardware.missing.length > 0 && (
              <div className={styles.error}>
                <strong>Can&apos;t price what the plan includes.</strong>{" "}
                {planHardware.missing.join(", ")} {planHardware.missing.length === 1 ? "is" : "are"}{" "}
                included with {planName} but missing from the HubSpot catalog (renamed, archived, or
                the catalog didn&apos;t load). Fix that before sending this quote.
              </div>
            )}
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
                . A screen is a POS, KDS, kiosk, menu board or mPOS.
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
