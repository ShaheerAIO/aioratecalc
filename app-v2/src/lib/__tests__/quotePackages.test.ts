import { describe, it, expect, afterEach } from "vitest";
import {
  PACKAGES,
  PRODUCT_PARTS,
  SHEET_ITEMS,
  coverageLabel,
  decomposePackages,
  kitFor,
  kitPicks,
  kitProductIds,
  sheetMsrpOf,
  type QuotePackage,
} from "@/lib/quotePackages";
import {
  adjustmentBlockers,
  adjustmentsFromQuoteLines,
  buildQuote,
  isAllowedForQuoteType,
  isPickable,
  KIT_REPLACEMENT_PRODUCT,
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
  wifi:      "338690209525", // AIO Wifi Network Package - Unifi
  mpos:      "223511653101", // mPOS — in no sheet row, so the kit never covers it
  tablet:    "276751313619", // Orders Hub Tablet — the partial-ordering kit's order tablet
  install:   "223452690133", // Onsite Installation — $999, charged since 2026-10-18
  training:  "223152695032", // System Onboarding and Training — $499, charged since 2026-10-18
  platform:  "335283119838", // All-in-One Platform, $399/mo
  swapFee:   "339236587251", // Free Kit Replacement Item — the retired $400 swap charge
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
  p(ID.wifi,      "AIO Wifi Network Package - Unifi", 698, "one_time", "inventory"),
  p(ID.mpos,      "mPOS", 599, "one_time", "inventory"),
  p(ID.tablet,    "Orders Hub Tablet", 199, "one_time", "inventory"),
  p(ID.install,   "Onsite Installation", 999, "one_time", "Service"),
  p(ID.training,  "System Onboarding and Training", 499, "one_time", "Service"),
  p(ID.platform,  "All-in-One Platform", 399, "monthly", ""),
  p("343582047937", "AIO Marketing Partial Ordering", 299, "monthly", "Software"),
  p("343374665412", "Online Ordering", 0, "monthly", "Software"),
  p(ID.swapFee,   "Free Kit Replacement Item", 400, "one_time", "inventory"),
  // $0 rate disclosure — on every quote AIO processes for since 2026-10-14.
  p("260559288040", "AIO Processing Two Tiered Rate", 0, "one_time", "AIO Payment Processing"),
];

const product = (id: string) => CATALOG.find(c => c.hubspotProductId === id)!;
const line = (id: string, qty = 1): QuoteLine => toQuoteLine(product(id), qty);

const run = (lines: QuoteLine[], over: { quoteType?: QuoteType; packages?: QuotePackage[] } = {}) =>
  decomposePackages({ lines, quoteType: over.quoteType ?? "all_in_one", packages: over.packages });

const KIT = PACKAGES[0];
const PARTIAL_KIT = PACKAGES[1];
const listOf = (lines: QuoteLine[]) => lines.reduce((n, l) => n + l.unitPrice * l.qty, 0);
const covered = (lines: QuoteLine[]) => lines.filter(l => l.coveredByPackage);
const qtyOf = (lines: QuoteLine[], id: string) =>
  lines.filter(l => l.hubspotProductId === id).reduce((n, l) => n + l.qty, 0);
const slotsFilled = (out: ReturnType<typeof run>) => out.filled.map(f => f.slot);

// One POS + its terminal and the rest of the kit. This is the cart the kit was
// specified against, less the kiosk, which left it 2026-10-29.
const FULL = () => [
  line(ID.pos), line(ID.ams1), line(ID.cfd), line(ID.kds),
  line(ID.printer), line(ID.drawer), line(ID.menuboard), line(ID.wifi),
];

describe("the sheet", () => {
  it("prices a whole HubSpot product as the sum of what it is made of", () => {
    expect(sheetMsrpOf(ID.pos)).toBe(949);
    expect(sheetMsrpOf(ID.posCfd)).toBe(949 + 299);
    // One part since 2026-10-27 — see PRODUCT_PARTS.
    expect(sheetMsrpOf(ID.kiosk27)).toBe(999);
    expect(sheetMsrpOf(ID.kioskMini)).toBe(799);
    expect(sheetMsrpOf(ID.mpos)).toBeNull();
  });

  it("lets nothing take a slot that isn't its own — swaps are gone (2026-10-27)", () => {
    // Three of everything: each lands only in its own slot (or the one it is
    // named as the alternative for), and the rest stays a charged line.
    const extras = [ID.cfd, ID.ams1, ID.drawer, ID.menuboard, ID.wifi, ID.printer, ID.tableside, ID.mega, ID.kds, ID.kioskMini];
    const out = run([line(ID.pos, 3), ...extras.map(id => line(id, 3))]);
    for (const f of out.filled) {
      const accepts = KIT.slots.find(s => s.item === f.slot)!;
      expect([accepts.item, ...(accepts.or ?? [])], f.part).toContain(f.part);
    }
    expect(qtyOf(covered(out.lines), ID.pos)).toBe(1);
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
        for (const alt of s.or ?? []) expect(SHEET_ITEMS[alt]).toBeDefined();
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

  it("is worth $3,851 of sheet MSRP since the kiosk left it", () => {
    // $5,200 until 2026-10-27, less the kiosk's terminal seat ($350): the
    // kiosk SKU is one part now, terminal and all. Less the 27" kiosk ($999)
    // since 2026-10-29: the first kiosk is a discount, not a kit slot.
    expect(KIT.slots.reduce((n, s) => n + SHEET_ITEMS[s.item].msrp * s.qty, 0)).toBe(3851);
  });

  it("is on for Order & Pay and All-in-One only, and one per quote", () => {
    expect(KIT.active).toBe(true);
    expect(KIT.plans).toEqual(["order_pay_only", "all_in_one"]);
    expect(KIT.maxPerQuote).toBe(1);
  });

  it("holds no kiosk slot, but goes WITH a kiosk (2026-10-29)", () => {
    for (const pkg of PACKAGES) {
      for (const s of pkg.slots) {
        expect([s.item, ...(s.or ?? [])]).not.toContain("kiosk27");
        expect([s.item, ...(s.or ?? [])]).not.toContain("kiosk156");
      }
      expect(pkg.appliesWith).toEqual(["kiosk27", "kiosk156"]);
    }
  });

  it("gives Marketing Partial Ordering its own kit: the order tablet, and a KDS or a printer", () => {
    expect(PARTIAL_KIT).toMatchObject({ active: true, plans: ["marketing_partial"], maxPerQuote: 1 });
    expect(PARTIAL_KIT.slots).toEqual([
      { item: "tablet", qty: 1 },
      { item: "kds", qty: 1, or: ["printer"] },
    ]);
  });
});

describe("decomposePackages — what is covered", () => {
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
    expect(out.coveredListAmount).toBe(749 + 698);
  });

  it("does not apply without an ordering device: a lone WiFi package and a printer are not a system", () => {
    const lines = [line(ID.wifi), line(ID.printer), line(ID.drawer)];
    const out = run(lines);
    expect(out.applied).toEqual([]);
    expect(out.lines).toBe(lines);
  });

  it("does not apply on a plan the kit isn't part of", () => {
    const lines = FULL();
    for (const quoteType of ["marketing_only"] as const) {
      expect(run(lines, { quoteType }).lines).toBe(lines);
    }
  });

  it("does nothing when the kit is switched off", () => {
    const lines = FULL();
    expect(run(lines, { packages: [{ ...KIT, active: false }] }).lines).toBe(lines);
  });

  it("splits a partly-covered line rather than blending the discount", () => {
    // Four POS: one takes the pos slot, the other three are charged.
    const out = run([line(ID.pos, 4)]);
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toMatchObject({ qty: 1, discountPercent: 100, coveredByPackage: "QSR Kit" });
    expect(out.lines[1]).toMatchObject({ qty: 3 });
    expect(out.lines[1].discountPercent).toBeUndefined();
    expect(out.lines[1].coveredByPackage).toBeUndefined();
  });

  it("never covers a recurring line, even of a product the sheet knows", () => {
    const recurring: QuoteLine = { ...line(ID.pos), billingFrequency: "monthly" };
    const out = run([recurring, line(ID.wifi)]);
    expect(out.applied).toEqual([]);
  });

  it("never covers off-sheet hardware — it is added at its price (2026-10-18)", () => {
    // mPOS has no sheet row. It used to swap into the open KDS slot at its
    // HubSpot price; nothing swaps now.
    const out = run([line(ID.pos), line(ID.mpos)]);
    expect(covered(out.lines).map(l => l.hubspotProductId)).toEqual([ID.pos]);
    expect(out.filled.some(f => f.hubspotProductId === ID.mpos)).toBe(false);
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
    // One kit holds one POS and one terminal.
    const cart = () => [line(ID.pos, 3), line(ID.ams1, 3)];

    const one = run(cart());
    expect(one.applied[0].count).toBe(1);
    expect(qtyOf(covered(one.lines), ID.pos)).toBe(1);

    const two = run(cart(), { packages: [{ ...KIT, maxPerQuote: 2 }] });
    expect(two.applied[0].count).toBe(2);
    expect(qtyOf(covered(two.lines), ID.pos)).toBe(2);
    expect(qtyOf(covered(two.lines), ID.ams1)).toBe(2);
  });
});

describe("decomposePackages — composite products", () => {
  it("lets a POS with display fill the POS slot and the display slot together", () => {
    const out = run([line(ID.posCfd)]);
    expect(out.filled.map(f => [f.part, f.slot])).toEqual([["pos", "pos"], ["cfd", "cfd"]]);
    expect(out.lines[0]).toMatchObject({ discountPercent: 100, coveredByPackage: "QSR Kit" });
  });

  it("covers a unit whole or not at all — no credit for part of a POS-with-display", () => {
    // The second unit's POS and display have nowhere to go, so it is charged
    // whole.
    const out = run([line(ID.posCfd, 2)]);
    expect(qtyOf(covered(out.lines), ID.posCfd)).toBe(1);
    expect(qtyOf(out.lines.filter(l => !l.coveredByPackage), ID.posCfd)).toBe(1);
  });
});

describe("decomposePackages — the kiosk is out of the kit (2026-10-29)", () => {
  it("never covers a kiosk, 27\" or 15.6\", however many", () => {
    for (const id of [ID.kiosk27, ID.kioskMini]) {
      const out = run([line(ID.pos), line(id, 2)]);
      expect(qtyOf(covered(out.lines), id), id).toBe(0);
      expect(out.filled.some(f => f.hubspotProductId === id), id).toBe(false);
    }
  });

  it("still applies with a kiosk as the ordering device: a kiosk and a KDS cover the KDS", () => {
    for (const id of [ID.kiosk27, ID.kioskMini]) {
      const out = run([line(id), line(ID.kds)]);
      expect(out.applied.map(a => a.name), id).toEqual(["QSR Kit"]);
      expect(covered(out.lines).map(l => l.hubspotProductId), id).toEqual([ID.kds]);
    }
  });

  it("covers nothing for a kiosk alone — there is nothing else to cover", () => {
    const lines = [line(ID.kiosk27)];
    expect(run(lines).lines).toBe(lines);
  });

  it("never lets a loose terminal take a kiosk's place when no kiosk is added", () => {
    // Two POS, two AMS1: the kit holds one terminal, the POS's. Before the
    // kiosk was one part, its empty terminal seat comped the second AMS1.
    const out = run([line(ID.pos, 2), line(ID.ams1, 2)]);
    expect(qtyOf(covered(out.lines), ID.ams1)).toBe(1);
  });

  it("goes with the 27\" and 15.6\" only: a Mega Kiosk is not the system the kit goes with", () => {
    const out = run([line(ID.mega), line(ID.kds)]);
    expect(out.applied).toEqual([]);
    expect(qtyOf(run([line(ID.pos), line(ID.mega)]).lines.filter(l => !l.coveredByPackage), ID.mega)).toBe(1);
  });
});

describe("decomposePackages — the partial-ordering kit", () => {
  const partial = (lines: QuoteLine[]) => run(lines, { quoteType: "marketing_partial" });

  it("covers the order tablet and a KDS, and applies on the tablet alone", () => {
    const out = partial([line(ID.tablet), line(ID.kds)]);
    expect(out.applied).toEqual([{ packageId: "partial_ordering_kit", name: "Partial Ordering Kit", count: 1, price: 0 }]);
    expect(covered(out.lines).map(l => l.hubspotProductId)).toEqual([ID.tablet, ID.kds]);
  });

  it("takes a printer in place of the KDS, and gives the seat to the KDS when it has both", () => {
    const printerOnly = partial([line(ID.tablet), line(ID.printer)]);
    expect(covered(printerOnly.lines).map(l => l.hubspotProductId)).toEqual([ID.tablet, ID.printer]);

    const both = partial([line(ID.tablet), line(ID.printer), line(ID.kds)]);
    expect(qtyOf(covered(both.lines), ID.kds)).toBe(1);
    expect(qtyOf(covered(both.lines), ID.printer)).toBe(0);
  });

  it("charges a second KDS, and covers no kiosk (2026-10-29)", () => {
    const out = partial([line(ID.tablet), line(ID.kds, 2), line(ID.kiosk27, 2)]);
    expect(qtyOf(covered(out.lines), ID.kds)).toBe(1);
    expect(qtyOf(covered(out.lines), ID.kiosk27)).toBe(0);
    expect(qtyOf(out.lines.filter(l => !l.coveredByPackage), ID.kds)).toBe(1);
  });

  it("applies with a kiosk in place of the tablet — the kiosk is an ordering device", () => {
    const out = partial([line(ID.kiosk27), line(ID.kds)]);
    expect(covered(out.lines).map(l => l.hubspotProductId)).toEqual([ID.kds]);
  });

  it("does not apply without an ordering device: a KDS alone is not a system", () => {
    const lines = [line(ID.kds)];
    expect(partial(lines).lines).toBe(lines);
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

  it("never lets a payment terminal take another slot", () => {
    // Three terminals, one terminal slot. $350 is inside the printer band.
    const out = run([line(ID.pos), line(ID.ams1, 3)]);
    expect(qtyOf(covered(out.lines), ID.ams1)).toBe(1);
    expect(slotsFilled(out)).not.toContain("printer");
  });

  it("never lets a second printer into another slot", () => {
    // The extra printer could only go in the display or menu board slot, and
    // neither takes a printer, so it stays a charged line.
    const out = run([line(ID.pos), line(ID.kiosk27), line(ID.kds), line(ID.printer, 2)]);
    expect(qtyOf(covered(out.lines), ID.printer)).toBe(1);
    expect(slotsFilled(out)).not.toContain("cfd");
    expect(slotsFilled(out)).not.toContain("menuboard");
  });

  it("never lets a cheap device into a locked slot either", () => {
    // mPOS would fit under the WiFi slot's $999 on price, but WiFi is locked.
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

  it("offers the partial-ordering kit on Marketing Partial Ordering", () => {
    expect(kitFor("marketing_partial")).toBe(PARTIAL_KIT);
  });

  it("never picks the derived terminal by hand, but DOES preselect the WiFi package (a pick since 2026-10-21)", () => {
    const ids = kitPicks(KIT).map(k => k.hubspotProductId);
    expect(ids).not.toContain(ID.ams1);
    expect(ids).toContain(ID.wifi);
  });

  it("neither lists nor preselects a kiosk — it left the kit 2026-10-29", () => {
    for (const kit of [KIT, PARTIAL_KIT]) {
      expect(kitPicks(kit).map(k => k.hubspotProductId)).not.toContain(ID.kiosk27);
      expect(kitProductIds(kit)).not.toContain(ID.kiosk27);
      expect(kitProductIds(kit)).not.toContain(ID.kioskMini);
    }
  });

  it("preselects the partial kit's tablet and KDS, and lists the printer beside them", () => {
    expect(kitPicks(PARTIAL_KIT)).toEqual([
      { hubspotProductId: ID.tablet, qty: 1 },
      { hubspotProductId: ID.kds, qty: 1 },
    ]);
    expect(kitProductIds(PARTIAL_KIT)).toEqual([ID.tablet, ID.kds, ID.printer]);
  });

  it.each(["order_pay_only", "all_in_one"] as const)(
    "fills every slot of the kit on %s, derived terminal and WiFi pick included",
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

      // And so there is no hardware left over to charge for — only the
      // nothing: install and training are both comped to $0 again (2026-10-28).
      expect(built.totals.oneTime).toBe(0);
      expect(built.blockers).toEqual([]);
      const wifi = built.quoteLines.find(l => l.hubspotProductId === ID.wifi)!;
      expect(wifi.coveredByPackage).toBe("QSR Kit");
    }
  );

  it("names only products the plan is allowed to carry", () => {
    for (const [kit, plan] of [[KIT, "all_in_one"], [PARTIAL_KIT, "marketing_partial"]] as const) {
      for (const id of kitProductIds(kit)) expect(isAllowedForQuoteType(product(id), plan), id).toBe(true);
    }
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
    line(ID.pos), line(ID.kiosk27), line(ID.kds), line(ID.printer), line(ID.drawer), line(ID.menuboard), line(ID.wifi),
  ];

  const build = (over: QuoteLine[] = picks(), adjustments = {}, quoteType: QuoteType = "all_in_one") =>
    buildQuote(quoteType, over, [], CATALOG, adjustments);

  it("covers the derived AMS1 and the picked WiFi package along with the picks", () => {
    const built = build();

    for (const id of [ID.pos, ID.kds, ID.printer, ID.drawer, ID.menuboard, ID.ams1, ID.wifi]) {
      const l = built.quoteLines.find(x => x.hubspotProductId === id)!;
      expect(l, id).toBeDefined();
      expect(l.coveredByPackage, id).toBe("QSR Kit");
      expect(l.discountPercent, id).toBe(100);
    }
    // The kiosk beside them is the first kiosk: 100% off, but not the kit's.
    const kiosk = built.quoteLines.find(x => x.hubspotProductId === ID.kiosk27)!;
    expect(kiosk).toMatchObject({ qty: 1, discountPercent: 100, firstKiosk: true });
    expect(kiosk.coveredByPackage).toBeUndefined();
    expect(built.blockers).toEqual([]);
  });

  it("puts no line of its own on the quote", () => {
    const built = build();
    expect(built.quoteLines.some(l => l.name === "QSR Kit")).toBe(false);
  });

  it("never covers the install and training — not kit hardware; both are the standing service comp", () => {
    const built = build();
    for (const id of [ID.install, ID.training]) {
      const l = built.quoteLines.find(x => x.hubspotProductId === id)!;
      expect(l.discountPercent ?? 0).toBe(100);
      expect(l.coveredByPackage).toBeUndefined();
    }
  });

  it("charges only the platform fee and the services when the kit covers all of the hardware", () => {
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
    // Four POS: one covered, three charged. The rep discounts the product —
    // applyLineAdjustment would clear the covered half's 100%, and only
    // applyPackageComp puts it back.
    const built = build([line(ID.pos, 4)], { [ID.pos]: { discountPercent: 25 } });
    const pos = built.quoteLines.filter(l => l.hubspotProductId === ID.pos);

    expect(pos).toHaveLength(2);
    expect(pos[0]).toMatchObject({ qty: 1, discountPercent: 100, coveredByPackage: "QSR Kit" });
    expect(pos[1]).toMatchObject({ qty: 3, discountPercent: 25 });
    expect(pos[1].coveredByPackage).toBeUndefined();
  });

  // ── Swaps are gone (2026-10-27) ─────────────────────────────────────────

  it("never charges a swap fee or an extra terminal, whatever the cart", () => {
    // Two POS and two kiosks, no KDS: the old kit swapped the second POS into
    // the KDS seat for $400 and charged the second kiosk's terminal.
    const built = build([line(ID.pos, 2), line(ID.kiosk27, 2), line(ID.printer), line(ID.drawer), line(ID.menuboard)]);
    expect(built.quoteLines.find(l => l.hubspotProductId === ID.swapFee)).toBeUndefined();
    expect(built.quoteLines.filter(l => l.derived)).toEqual([]);
    // Charged at list instead: the second POS and the second kiosk (the
    // first is 100% off on its own line).
    expect(qtyOf(built.quoteLines.filter(l => !l.coveredByPackage), ID.pos)).toBe(1);
    expect(built.quoteLines.filter(l => l.hubspotProductId === ID.kiosk27).map(l => [l.qty, l.discountPercent ?? 0]))
      .toEqual([[1, 100], [1, 0]]);
    expect(built.blockers.filter(b => b.includes("Replacement"))).toEqual([]);
  });

  it("drops a saved swap fee and its derived terminal on reopen", () => {
    const saved: QuoteLine[] = [
      line(ID.pos), { ...line(ID.ams1), derived: true }, line(ID.swapFee),
    ];
    expect(picksFromQuoteLines(saved, "all_in_one")).toEqual([{ hubspotProductId: ID.pos, qty: 1 }]);
  });

  it("never offers the old replacement fee in the picker", () => {
    expect(isPickable(product(ID.swapFee))).toBe(false);
    expect(KIT_REPLACEMENT_PRODUCT.hubspotProductId).toBe(ID.swapFee);
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
    // WiFi is a pick since 2026-10-21, so it comes back with the rest.
    expect(back).toContainEqual({ hubspotProductId: ID.wifi, qty: 1 });
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
    // The standing install comp (2026-10-28) comes back, as it did before
    // 2026-10-18; it is re-applied anyway, so nothing changes on rebuild.
    expect(reopened[ID.install]).toEqual({ discountPercent: 100 });
    expect(reopened[ID.training]).toEqual({ discountPercent: 100 });
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
