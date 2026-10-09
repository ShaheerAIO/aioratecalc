import { describe, it, expect, afterEach } from "vitest";
import {
  PACKAGES,
  PRODUCT_PARTS,
  SHEET_ITEMS,
  coverageLabel,
  decomposePackages,
  kitFor,
  kitPicks,
  sheetMsrpOf,
  type QuotePackage,
} from "@/lib/quotePackages";
import {
  adjustmentBlockers,
  adjustmentsFromQuoteLines,
  buildQuote,
  isAllowedForQuoteType,
  isPickable,
  PLATFORM_PRODUCTS,
  picksFromQuoteLines,
  toQuoteLine,
} from "@/lib/quoting";
import type { CatalogProduct, QuoteLine, QuoteType } from "@/types/merchant";

// Live HubSpot ids, so a fixture that stops matching the portal is a fixture
// someone has to look at. Prices are HubSpot's today; the kit goes by SHEET
// MSRP, which is a different (and higher) number — nothing here may depend on
// the two agreeing.
const ID = {
  pos:       "217445755632", // POS Unit
  posCfd:    "223452690130", // POS Unit - With Customer Facing Display
  cfd:       "318736467644", // Customer Facing Display
  ams1:      "223511653105", // Payment Terminal - AMS1
  kiosk27:   "222497165009", // Kiosk 27" + Payment Terminal (AMS1) and Mount
  kioskMini: "223519571666", // Kiosk Mini 15.6" + Payment Terminal (AMS1) and Mount
  mega:      "260674226888", // Mega Kiosk
  tableside: "335279520447", // AIO Tableside POS
  kds:       "223452690132", // KDS
  printer:   "223511653104", // Thermal Printer
  drawer:    "222497165011", // Cash Drawer
  menuboard: "223511653103", // Menu Board Computer
  wifi:      "281351401209", // AIO WiFi Network Package
  mpos:      "223511653101", // mPOS — in no sheet row, so it can only swap, at its HubSpot price
  install:   "223452690133", // Onsite Installation — comped
  training:  "223152695032", // System Onboarding and Training — comped
  platform:  "335283119838", // All-in-One Platform, $399/mo
};

const p = (
  hubspotProductId: string, name: string, price: number,
  billingFrequency: CatalogProduct["billingFrequency"], productType: string,
): CatalogProduct => ({ hubspotProductId, name, price, billingFrequency, productType });

const CATALOG: CatalogProduct[] = [
  p(ID.pos,       "POS Unit", 749, "one_time", "inventory"),
  p(ID.posCfd,    "POS Unit - With Customer Facing Display", 899, "one_time", "inventory"),
  p(ID.cfd,       "Customer Facing Display", 150, "one_time", "inventory"),
  p(ID.ams1,      "Payment Terminal - AMS1", 300, "one_time", "inventory"),
  p(ID.kiosk27,   "Kiosk 27\" + Payment Terminal (AMS1) and Mount", 999, "one_time", "inventory"),
  p(ID.kioskMini, "Kiosk Mini 15.6\" + Payment Terminal (AMS1) and Mount", 799, "one_time", "inventory"),
  p(ID.mega,      "Mega Kiosk", 2459, "one_time", "inventory"),
  p(ID.tableside, "AIO Tableside POS", 399, "one_time", "inventory"),
  p(ID.kds,       "KDS (Kitchen Display System)", 499, "one_time", "inventory"),
  p(ID.printer,   "Thermal Printer", 249, "one_time", "inventory"),
  p(ID.drawer,    "Cash Drawer", 69, "one_time", "inventory"),
  p(ID.menuboard, "Menu Board Computer", 99, "one_time", "inventory"),
  p(ID.wifi,      "AIO WiFi Network Package", 999, "one_time", "inventory"),
  p(ID.mpos,      "mPOS", 599, "one_time", "inventory"),
  p(ID.install,   "Onsite Installation", 999, "one_time", "Service"),
  p(ID.training,  "System Onboarding and Training", 499, "one_time", "Service"),
  p(ID.platform,  "All-in-One Platform", 399, "monthly", ""),
];

const product = (id: string) => CATALOG.find(c => c.hubspotProductId === id)!;
const line = (id: string, qty = 1): QuoteLine => toQuoteLine(product(id), qty);

const run = (lines: QuoteLine[], over: { quoteType?: QuoteType; packages?: QuotePackage[] } = {}) =>
  decomposePackages({ lines, quoteType: over.quoteType ?? "all_in_one", packages: over.packages });

const KIT = PACKAGES[0];
const listOf = (lines: QuoteLine[]) => lines.reduce((n, l) => n + l.unitPrice * l.qty, 0);
const covered = (lines: QuoteLine[]) => lines.filter(l => l.coveredByPackage);
const qtyOf = (lines: QuoteLine[], id: string) =>
  lines.filter(l => l.hubspotProductId === id).reduce((n, l) => n + l.qty, 0);
const slotsFilled = (out: ReturnType<typeof run>) => out.filled.map(f => f.slot);

describe("the sheet", () => {
  it("prices a whole HubSpot product as the sum of what it is made of", () => {
    expect(sheetMsrpOf(ID.pos)).toBe(949);
    expect(sheetMsrpOf(ID.posCfd)).toBe(949 + 299);
    expect(sheetMsrpOf(ID.kiosk27)).toBe(999 + 350);
    expect(sheetMsrpOf(ID.kioskMini)).toBe(799 + 350);
    expect(sheetMsrpOf(ID.mpos)).toBeNull();
  });

  it("locks the items that must never be swapped, whatever their MSRP", () => {
    for (const k of ["cfd", "terminal", "drawer", "menuboard", "wifi"] as const) {
      expect(SHEET_ITEMS[k].swappable).toBe(false);
    }
  });

  it("makes every part of every mapped product a real sheet item", () => {
    for (const parts of Object.values(PRODUCT_PARTS)) {
      for (const k of parts) expect(SHEET_ITEMS[k]).toBeDefined();
    }
  });
});

describe("the shipped kit", () => {
  it("has unique ids, positive slot quantities and real sheet items in every slot", () => {
    expect(new Set(PACKAGES.map(x => x.id)).size).toBe(PACKAGES.length);
    for (const pkg of PACKAGES) {
      expect(pkg.slots.length).toBeGreaterThan(0);
      for (const s of pkg.slots) {
        expect(SHEET_ITEMS[s.item]).toBeDefined();
        expect(Number.isInteger(s.qty) && s.qty > 0).toBe(true);
      }
    }
  });

  it("has a slot an ordering device can fill, or it could never apply", () => {
    for (const pkg of PACKAGES) expect(pkg.slots.some(s => SHEET_ITEMS[s.item].orders)).toBe(true);
  });

  it("can be filled: every slot has at least one HubSpot product that lands in it", () => {
    const reachable = new Set(Object.values(PRODUCT_PARTS).flat());
    for (const s of KIT.slots) expect(reachable.has(s.item)).toBe(true);
  });

  it("is worth the $5,200 of sheet MSRP it was specified as", () => {
    expect(KIT.slots.reduce((n, s) => n + SHEET_ITEMS[s.item].msrp * s.qty, 0)).toBe(5200);
  });

  it("is on for Order & Pay and All-in-One only, and one per quote", () => {
    expect(KIT.active).toBe(true);
    expect(KIT.plans).toEqual(["order_pay_only", "all_in_one"]);
    expect(KIT.maxPerQuote).toBe(1);
  });
});

describe("decomposePackages — what is covered", () => {
  // One POS + its terminal, a kiosk (which carries its own terminal), and the
  // rest of the kit. This is the cart the kit was specified against.
  const FULL = () => [
    line(ID.pos), line(ID.ams1), line(ID.cfd), line(ID.kiosk27), line(ID.kds),
    line(ID.printer), line(ID.drawer), line(ID.menuboard), line(ID.wifi),
  ];

  it("covers a full kit's worth of hardware at 100%, with no package line of its own", () => {
    const lines = FULL();
    const out = run(lines);

    expect(out.lines).toHaveLength(lines.length);
    expect(out.lines.every(l => l.discountPercent === 100 && l.coveredByPackage === "QSR Kit")).toBe(true);
    // Nothing was added: every output line is one of the inputs.
    expect(out.lines.map(l => l.hubspotProductId)).toEqual(lines.map(l => l.hubspotProductId));
    expect(out.applied).toEqual([{ packageId: "qsr_kit", name: "QSR Kit", count: 1, price: 0 }]);
    expect(out.coveredListAmount).toBe(listOf(lines));
    expect(out.savings).toBe(out.coveredListAmount);
  });

  it("covers what the cart has and leaves the empty slots empty — nothing is credited elsewhere", () => {
    const out = run([line(ID.pos), line(ID.wifi)]);
    expect(covered(out.lines).map(l => l.hubspotProductId)).toEqual([ID.pos, ID.wifi]);
    expect(out.coveredListAmount).toBe(749 + 999);
  });

  it("does not apply without an ordering device: a lone WiFi package and a printer are not a system", () => {
    const lines = [line(ID.wifi), line(ID.printer), line(ID.drawer)];
    const out = run(lines);
    expect(out.applied).toEqual([]);
    expect(out.lines).toBe(lines);
  });

  it("does not apply on a plan the kit isn't part of", () => {
    const lines = FULL();
    for (const quoteType of ["marketing_only", "marketing_term"] as const) {
      expect(run(lines, { quoteType }).lines).toBe(lines);
    }
  });

  it("does nothing when the kit is switched off", () => {
    const lines = FULL();
    expect(run(lines, { packages: [{ ...KIT, active: false }] }).lines).toBe(lines);
  });

  it("splits a partly-covered line rather than blending the discount", () => {
    // Three POS: the pos slot, then a swap into the kiosk slot, then nowhere.
    const out = run([line(ID.pos, 3)]);
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toMatchObject({ qty: 2, discountPercent: 100, coveredByPackage: "QSR Kit" });
    expect(out.lines[1]).toMatchObject({ qty: 1 });
    expect(out.lines[1].discountPercent).toBeUndefined();
    expect(out.lines[1].coveredByPackage).toBeUndefined();
  });

  it("never covers a recurring line, even of a product the sheet knows", () => {
    const recurring: QuoteLine = { ...line(ID.pos), billingFrequency: "monthly" };
    const out = run([recurring, line(ID.wifi)]);
    expect(out.applied).toEqual([]);
  });

  it("swaps off-sheet hardware into an open slot at its HubSpot price", () => {
    // mPOS ($599 in HubSpot) has no sheet row. The POS takes the POS slot;
    // the cheapest slot the mPOS fits is the KDS ($735).
    const out = run([line(ID.pos), line(ID.mpos)]);
    expect(covered(out.lines).map(l => l.hubspotProductId)).toEqual([ID.pos, ID.mpos]);
    expect(out.filled.find(f => f.hubspotProductId === ID.mpos)).toMatchObject({ part: null, slot: "kds", swapped: true });
  });

  it("never counts off-sheet hardware as the ordering device a kit needs", () => {
    const lines = [line(ID.mpos), line(ID.printer)];
    expect(run(lines).applied).toEqual([]);
  });

  it("never covers a service, whatever it costs", () => {
    const out = run([line(ID.pos), line(ID.training)]);
    expect(covered(out.lines).map(l => l.hubspotProductId)).toEqual([ID.pos]);
  });

  it("leaves a line alone that something else already paid for", () => {
    const planned: QuoteLine = { ...line(ID.menuboard, 3), coveredByPackage: "AIO Marketing Platform", discountPercent: 100 };
    const out = run([line(ID.pos), planned]);
    expect(out.lines[1]).toBe(planned);
  });

  it("honours maxPerQuote, and a larger one covers a second kit", () => {
    const cart = () => [line(ID.pos, 4), line(ID.ams1, 4)];

    const one = run(cart());
    expect(one.applied[0].count).toBe(1);
    expect(qtyOf(covered(one.lines), ID.pos)).toBe(2);

    const two = run(cart(), { packages: [{ ...KIT, maxPerQuote: 2 }] });
    expect(two.applied[0].count).toBe(2);
    expect(qtyOf(covered(two.lines), ID.pos)).toBe(4);
    expect(qtyOf(covered(two.lines), ID.ams1)).toBe(4);
  });
});

describe("decomposePackages — composite products", () => {
  it("lets a POS with display fill the POS slot and the display slot together", () => {
    const out = run([line(ID.posCfd)]);
    expect(out.filled.map(f => [f.part, f.slot])).toEqual([["pos", "pos"], ["cfd", "cfd"]]);
    expect(out.lines[0]).toMatchObject({ discountPercent: 100, coveredByPackage: "QSR Kit" });
  });

  it("lets a kiosk carry its own terminal into the terminal slot", () => {
    const out = run([line(ID.kiosk27)]);
    expect(out.filled.map(f => [f.part, f.slot])).toEqual([["kiosk27", "kiosk27"], ["terminal", "terminal"]]);
  });

  it("covers a unit whole or not at all — no credit for part of a POS-with-display", () => {
    // The display slot is locked and takes one display. The second unit's POS
    // would swap into the kiosk slot, but its display has nowhere to go, so
    // the unit is left alone entirely and the kiosk slot stays open.
    const out = run([line(ID.posCfd, 2)]);
    expect(qtyOf(covered(out.lines), ID.posCfd)).toBe(1);
    expect(qtyOf(out.lines.filter(l => !l.coveredByPackage), ID.posCfd)).toBe(1);
    expect(slotsFilled(out)).not.toContain("kiosk27");
  });
});

describe("decomposePackages — swaps", () => {
  it("swaps a device into the cheapest slot it costs no more than", () => {
    // The 15.6" kiosk part ($799) is dearer than the KDS slot ($735), so it
    // fits the POS slot ($949) and the kiosk slot ($999). Cheapest wins.
    const out = run([line(ID.kioskMini)]);
    expect(out.filled.find(f => f.part === "kiosk156")).toMatchObject({ slot: "pos", swapped: true });
    expect(qtyOf(covered(out.lines), ID.kioskMini)).toBe(1);
  });

  it("has no lower bound: a printer can stand in for a KDS", () => {
    // Two printers: one in the printer slot, the second ($336) in the cheapest
    // open swappable slot it fits — the KDS ($735).
    const out = run([line(ID.pos), line(ID.printer, 2)]);
    expect(qtyOf(covered(out.lines), ID.printer)).toBe(2);
    expect(out.filled.filter(f => f.part === "printer").map(f => f.slot)).toEqual(["printer", "kds"]);
  });

  it("falls to the next-nearest slot when the nearest are taken", () => {
    const out = run([line(ID.pos), line(ID.kds), line(ID.kioskMini)]);
    expect(out.filled.find(f => f.part === "kiosk156")).toMatchObject({ slot: "kiosk27", swapped: true });
    expect(qtyOf(covered(out.lines), ID.kioskMini)).toBe(1);
  });

  it("places the most constrained device first, so a flexible one can't take its only seat", () => {
    // The tableside device ($603) can only go in the KDS slot. The kiosk is
    // nearer the KDS slot too, but has other places to go — so it moves over.
    const out = run([line(ID.kioskMini), line(ID.tableside)]);
    expect(out.filled.find(f => f.part === "tableside")).toMatchObject({ slot: "kds" });
    expect(out.filled.find(f => f.part === "kiosk156")).toMatchObject({ slot: "pos" });
    expect(out.lines.every(l => l.coveredByPackage === "QSR Kit")).toBe(true);
  });

  it("swaps a tableside device into the KDS slot when there is no KDS", () => {
    const out = run([line(ID.pos), line(ID.tableside)]);
    expect(out.filled.find(f => f.part === "tableside")).toMatchObject({ slot: "kds", swapped: true });
  });

  it("never swaps in anything dearer than the slot — a Mega Kiosk is not a POS", () => {
    const out = run([line(ID.pos), line(ID.mega)]);
    expect(qtyOf(out.lines.filter(l => !l.coveredByPackage), ID.mega)).toBe(1);
    for (const s of KIT.slots) expect(SHEET_ITEMS.mega.msrp).toBeGreaterThan(SHEET_ITEMS[s.item].msrp);
  });

  it("takes an open dearer slot when the cheaper one is taken", () => {
    // The KDS takes the KDS slot, so the tableside device moves up to the kiosk slot.
    const out = run([line(ID.pos), line(ID.kds), line(ID.tableside)]);
    expect(out.filled.find(f => f.part === "tableside")).toMatchObject({ slot: "kiosk27", swapped: true });
  });

  it("leaves a device uncovered rather than stacking it into a taken slot", () => {
    // Every swappable slot it could fit is filled exactly.
    const out = run([line(ID.pos), line(ID.kiosk27), line(ID.kds), line(ID.printer), line(ID.tableside)]);
    expect(qtyOf(out.lines.filter(l => !l.coveredByPackage), ID.tableside)).toBe(1);
  });

  it("an exact fit always beats a swap, whatever order the lines arrive in", () => {
    const a = run([line(ID.kioskMini), line(ID.pos), line(ID.kds)]);
    const b = run([line(ID.kds), line(ID.pos), line(ID.kioskMini)]);
    for (const out of [a, b]) {
      expect(out.filled.find(f => f.part === "pos")).toMatchObject({ slot: "pos", swapped: false });
      expect(out.filled.find(f => f.part === "kds")).toMatchObject({ slot: "kds", swapped: false });
      expect(out.filled.find(f => f.part === "kiosk156")).toMatchObject({ slot: "kiosk27", swapped: true });
    }
  });
});

describe("decomposePackages — locks", () => {
  it("never puts a locked item into another slot, even when its MSRP fits", () => {
    // Two displays: $299 sits inside the printer slot's band ($252–$420), but
    // the display is locked, so the second one stays a charged line.
    const out = run([line(ID.pos), line(ID.cfd, 2)]);
    expect(qtyOf(covered(out.lines), ID.cfd)).toBe(1);
    expect(qtyOf(out.lines.filter(l => !l.coveredByPackage), ID.cfd)).toBe(1);
    expect(slotsFilled(out)).not.toContain("printer");
  });

  it("never lets a payment terminal take a swappable slot", () => {
    // Three terminals, two terminal slots. $350 is inside the printer band.
    const out = run([line(ID.pos), line(ID.ams1, 3)]);
    expect(qtyOf(covered(out.lines), ID.ams1)).toBe(2);
    expect(slotsFilled(out)).not.toContain("printer");
  });

  it("never lets a swappable device into a locked slot", () => {
    // Every swappable slot is taken, so the extra printer ($336) could only go
    // in the display slot ($299 — too cheap anyway) or the menu board slot
    // ($108); both are locked, so it stays a charged line.
    const out = run([line(ID.pos), line(ID.kiosk27), line(ID.kds), line(ID.printer, 2)]);
    expect(qtyOf(covered(out.lines), ID.printer)).toBe(1);
    expect(slotsFilled(out)).not.toContain("cfd");
    expect(slotsFilled(out)).not.toContain("menuboard");
  });

  it("never lets a cheap device into a locked slot either", () => {
    // A tablet-priced mPOS would fit under the WiFi slot's $999, but WiFi is locked.
    const out = run([line(ID.pos), line(ID.kiosk27), line(ID.kds), line(ID.printer), line(ID.mpos)]);
    expect(qtyOf(out.lines.filter(l => !l.coveredByPackage), ID.mpos)).toBe(1);
  });
});

describe("the retired QSR Kit product", () => {
  // The $0 package SKU from the design this module replaced. The kit is now the
  // individual products at 100% off, so this record must never be offered or
  // sent back as a pick.
  const KIT_SKU = p("333450361558", "QSR Kit", 0, "one_time", "");

  it("is not offered in the picker", () => {
    expect(isPickable(KIT_SKU)).toBe(false);
    expect(isAllowedForQuoteType(KIT_SKU, "all_in_one")).toBe(false);
  });

  it("is dropped when an old quote that carries it is reopened", () => {
    const old = [toQuoteLine(KIT_SKU, 1), line(ID.pos)];
    expect(picksFromQuoteLines(old, "all_in_one")).toEqual([{ hubspotProductId: ID.pos, qty: 1 }]);
  });
});

describe("preselecting the kit", () => {
  const preselected = () =>
    kitPicks(KIT).map(k => toQuoteLine(product(k.hubspotProductId), k.qty));

  it("offers the kit on both kit plans and nowhere else", () => {
    expect(kitFor("order_pay_only")).toBe(KIT);
    expect(kitFor("all_in_one")).toBe(KIT);
    expect(kitFor("marketing_only")).toBeNull();
  });

  it("offers nothing when the kit is switched off", () => {
    const was = KIT.active;
    KIT.active = false;
    try { expect(kitFor("all_in_one")).toBeNull(); } finally { KIT.active = was; }
  });

  it("never picks a derived product by hand — a terminal or WiFi would bill twice", () => {
    const ids = kitPicks(KIT).map(k => k.hubspotProductId);
    expect(ids).not.toContain(ID.ams1);
    expect(ids).not.toContain(ID.wifi);
  });

  it.each(["order_pay_only", "all_in_one"] as const)(
    "fills EVERY slot of the kit on %s, derived terminals and WiFi included",
    quoteType => {
      // The fixture only carries the All-in-One platform product; each plan
      // needs its own, or the quote (rightly) refuses to price.
      const plan = PLATFORM_PRODUCTS[quoteType];
      const catalog = CATALOG.some(c => c.hubspotProductId === plan.hubspotProductId)
        ? CATALOG
        : [...CATALOG, p(plan.hubspotProductId, plan.name, 299, "monthly", "")];
      const built = buildQuote(quoteType, preselected(), [], catalog, {});

      expect(built.packages.applied).toHaveLength(1);
      // Slot by slot: nothing the kit specifies is left open.
      const filled = new Map<string, number>();
      for (const f of built.packages.filled) filled.set(f.slot, (filled.get(f.slot) ?? 0) + 1);
      for (const s of KIT.slots) expect(filled.get(s.item) ?? 0, s.item).toBe(s.qty);

      // And so there is no hardware left over to charge for.
      expect(built.totals.oneTime).toBe(0);
      expect(built.blockers).toEqual([]);
      const wifi = built.quoteLines.find(l => l.hubspotProductId === ID.wifi)!;
      expect(wifi.coveredByPackage).toBe("QSR Kit");
    }
  );

  it("names only products the plan is allowed to carry", () => {
    for (const k of kitPicks(KIT)) expect(CATALOG.some(c => c.hubspotProductId === k.hubspotProductId)).toBe(true);
  });
});

describe("buildQuote with the kit on it", () => {
  let restore: (() => void) | null = null;
  afterEach(() => { restore?.(); restore = null; });

  const withKit = (active: boolean) => {
    // Remember the ORIGINAL value only once: a test that calls this twice
    // (off, then on) would otherwise capture the first call's "off" as what to
    // restore, and leave the kit inactive for every test after it.
    if (!restore) {
      const was = KIT.active;
      restore = () => { KIT.active = was; };
    }
    KIT.active = active;
  };

  const picks = () => [
    line(ID.pos), line(ID.kiosk27), line(ID.kds), line(ID.printer), line(ID.drawer), line(ID.menuboard),
  ];

  const build = (over: QuoteLine[] = picks(), adjustments = {}, quoteType: QuoteType = "all_in_one") =>
    buildQuote(quoteType, over, [], CATALOG, adjustments);

  it("covers the derived AMS1 and WiFi package along with the picks", () => {
    const built = build();

    for (const id of [ID.pos, ID.kiosk27, ID.kds, ID.printer, ID.drawer, ID.menuboard, ID.ams1, ID.wifi]) {
      const l = built.quoteLines.find(x => x.hubspotProductId === id)!;
      expect(l, id).toBeDefined();
      expect(l.coveredByPackage, id).toBe("QSR Kit");
      expect(l.discountPercent, id).toBe(100);
    }
    expect(built.blockers).toEqual([]);
  });

  it("puts no line of its own on the quote", () => {
    const built = build();
    expect(built.quoteLines.some(l => l.name === "QSR Kit")).toBe(false);
  });

  it("leaves the comped install and training as they were — comps, not kit coverage", () => {
    const built = build();
    for (const id of [ID.install, ID.training]) {
      const l = built.quoteLines.find(x => x.hubspotProductId === id)!;
      expect(l.discountPercent).toBe(100);
      expect(l.coveredByPackage).toBeUndefined();
    }
  });

  it("charges only the platform fee when the kit covers all of the hardware", () => {
    const built = build();
    expect(built.totals.oneTime).toBe(0);
    expect(built.totals.recurring).toEqual([{ frequency: "monthly", amount: 399 }]);
  });

  it("charges full price for what the kit doesn't cover", () => {
    const built = build([...picks(), line(ID.mega)]);
    const mega = built.quoteLines.find(l => l.hubspotProductId === ID.mega)!;
    expect(mega.coveredByPackage).toBeUndefined();
    expect(mega.discountPercent).toBeUndefined();
    expect(built.totals.oneTime).toBe(2459);
  });

  it("does not refuse the quote over the 100% on a covered line", () => {
    expect(adjustmentBlockers(build().quoteLines, 50)).toEqual([]);
  });

  it("holds a covered line at 100% when the rep adjusts that product's other half", () => {
    // Three POS: two covered (the pos slot and a swap), one charged. The rep
    // discounts the product — applyLineAdjustment would clear the covered
    // half's 100%, and only applyPackageComp puts it back.
    const built = build([line(ID.pos, 3)], { [ID.pos]: { discountPercent: 25 } });
    const pos = built.quoteLines.filter(l => l.hubspotProductId === ID.pos);

    expect(pos).toHaveLength(2);
    expect(pos[0]).toMatchObject({ qty: 2, discountPercent: 100, coveredByPackage: "QSR Kit" });
    expect(pos[1]).toMatchObject({ qty: 1, discountPercent: 25 });
    expect(pos[1].coveredByPackage).toBeUndefined();
  });

  it("does not move the ordering-point count", () => {
    withKit(false);
    const without = build();
    withKit(true);
    const withKitOn = build();
    expect(withKitOn.orderPoints.total).toBe(without.orderPoints.total);
  });

  it("changes nothing on a quote that is rate-only", () => {
    const built = build([], {});
    expect(built.quoteLines).toEqual([]);
    expect(built.packages.applied).toEqual([]);
  });

  it("changes nothing when the kit is off — the same lines, charged", () => {
    withKit(false);
    const built = build();
    expect(built.packages.applied).toEqual([]);
    expect(built.quoteLines.filter(l => l.coveredByPackage)).toEqual([]);
    expect(built.totals.oneTime).toBeGreaterThan(0);
  });

  it("round-trips through the configurator: picks come back whole, derived lines are dropped", () => {
    const back = picksFromQuoteLines(build().quoteLines, "all_in_one");

    // The POS's AMS1 is a pick like any other now, so it comes back too.
    for (const id of [ID.pos, ID.kiosk27, ID.kds, ID.printer, ID.drawer, ID.menuboard, ID.ams1]) {
      expect(back).toContainEqual({ hubspotProductId: id, qty: 1 });
    }
    expect(back.find(x => x.hubspotProductId === ID.wifi)).toBeUndefined();
  });

  it("round-trips a partly-covered line with its quantity summed back together", () => {
    const back = picksFromQuoteLines(build([line(ID.pos, 3)]).quoteLines, "all_in_one");
    expect(back).toContainEqual({ hubspotProductId: ID.pos, qty: 3 });
  });

  it("does not read a covered line's 100% back as a rep adjustment", () => {
    const reopened = adjustmentsFromQuoteLines(build().quoteLines);
    expect(reopened[ID.pos]).toBeUndefined();
    expect(reopened[ID.wifi]).toBeUndefined();
    expect(reopened[ID.ams1]).toBeUndefined();
    // The standing comps on install and training still come back.
    expect(reopened[ID.install]).toEqual({ discountPercent: 100 });
  });
});

describe("coverageLabel — the picker row's coverage tag", () => {
  it("never prints 'N of 0' when an AMS1 was topped up rather than picked", () => {
    // Picks that arrive short of one AMS1 per POS: the server tops one up, the
    // kit covers it, and the row's stepper (the rep's own picks) reads 0.
    const built = buildQuote("all_in_one", [toQuoteLine(product(ID.pos), 1)], [], CATALOG, {});
    const covered = built.packages.lines
      .filter(l => l.hubspotProductId === ID.ams1 && l.coveredByPackage)
      .reduce((n, l) => n + l.qty, 0);
    expect(covered).toBeGreaterThan(0);
    expect(built.requiredTerminals.qty).toBe(1);
    expect(coverageLabel(covered, 0, "the package")).toBe("In the package");
    expect(coverageLabel(covered, 0 + built.requiredTerminals.qty, "the package")).toBe("In the package");
  });

  it("tops up nothing when the AMS1 is picked alongside the POS", () => {
    const built = buildQuote(
      "all_in_one", [toQuoteLine(product(ID.pos), 1), toQuoteLine(product(ID.ams1), 1)], [], CATALOG, {}
    );
    expect(built.requiredTerminals.qty).toBe(0);
    expect(qtyOf(built.quoteLines, ID.ams1)).toBe(1);
  });

  it("says 'N of M' only for a real partial cover, and nothing when none is", () => {
    expect(coverageLabel(1, 3, "the package")).toBe("1 of 3 in the package");
    expect(coverageLabel(3, 3, "the package")).toBe("In the package");
    expect(coverageLabel(0, 3, "the package")).toBeNull();
  });
});
