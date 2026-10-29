import { describe, it, expect, beforeAll } from "vitest";
import { PACKAGES } from "@/lib/quotePackages";
import { SOFTWARE_LICENSE_PRODUCT, buildQuote, toQuoteLine } from "@/lib/quoting";
import type { CatalogProduct, QuoteAdjustments, QuoteType } from "@/types/merchant";

// Steve's scenario sheet ("AIO pricing scenarios", updated 2026-10-23 with
// Alex Holt), as the product owner mapped it onto the four plans on
// 2026-10-27. One case per scenario: what the merchant pays a month, what
// hardware they pay for once, and how many $19 licenses that takes.
//
// Prices are the live HubSpot catalog's on 2026-10-27, where the sheet quotes
// a different figure the HubSpot price wins (noted on the case). The install
// ($999) and the training ($499) ride on every hardware quote and are not on
// the sheet, so `hardware` is the one-time total less those two.

beforeAll(() => { for (const pkg of PACKAGES) pkg.active = true; });

const p = (
  hubspotProductId: string, name: string, price: number,
  billingFrequency: CatalogProduct["billingFrequency"], productType = "inventory",
): CatalogProduct => ({ hubspotProductId, name, price, billingFrequency, productType });

const CATALOG: CatalogProduct[] = [
  p("332609247965", "AIO Marketing Platform", 199, "monthly", "Software"),
  p("335279520445", "All-in-One (Order & Pay only)", 299, "monthly", ""),
  p("335283119838", "All-in-One Platform", 399, "monthly", ""),
  p("343582047937", "AIO Marketing Partial Ordering", 299, "monthly", "Software"),
  p("343374665412", "Online Ordering", 0, "monthly", "Software"),
  p("333275576048", "Website", 50, "monthly", "Software"),
  p("343373224660", "Mega Kiosk Loaner", 100, "monthly"),
  p("332617109238", "Marketing Kit - Mega Kiosk", 1500, "one_time"),
  p("335280960199", "Additional Software License", 19, "monthly", "Software"),
  p("223511653103", "Menu Board Device", 75, "one_time"),
  p("276751313619", "Orders Hub Tablet", 199, "one_time"),
  p("223452690132", "KDS (Kitchen Display System)", 735, "one_time"),
  p("223511653104", "Thermal Printer", 295, "one_time"),
  p("222497165009", "Kiosk 27\" + Payment Terminal (AMS1) and Mount", 1495, "one_time"),
  p("217445755632", "POS Unit", 749, "one_time"),
  p("223452690130", "POS Unit - With Customer Facing Display", 995, "one_time"),
  p("318736467644", "Customer Facing Display", 299, "one_time", ""),
  p("223511653105", "Payment Terminal - AMS1", 350, "one_time"),
  p("222497165011", "Cash Drawer", 75, "one_time"),
  p("338690209525", "AIO Wifi Network Package - Unifi", 698, "one_time"),
  p("223452690133", "Onsite Installation", 999, "one_time", "Service"),
  p("223152695032", "System Onboarding and Training", 499, "one_time", "Service"),
  p("281354281678", "AIO Pre Auth", 0.5, "one_time", "Service"),
  p("260559288040", "AIO Processing Two Tiered Rate", 0, "one_time", "AIO Payment Processing"),
];

// Install and training are both comped to $0 again since 2026-10-28.
const INSTALL_AND_TRAINING = 0;

// The sheet's "first kiosk free": since 2026-10-29 the first kiosk goes on at
// list and the REP discounts it, so the scenarios carry that discount — one
// 27" unit at 100% (a no-op on a quote with no kiosk).
const FIRST_KIOSK_FREE: QuoteAdjustments = { "222497165009": { discountPercent: 100, discountQty: 1 } };

function quote(plan: QuoteType, picks: Array<[string, number]>, adjustments = FIRST_KIOSK_FREE) {
  const lines = picks.map(([name, qty]) => toQuoteLine(CATALOG.find(c => c.name === name)!, qty));
  const built = buildQuote(plan, lines, [], CATALOG, adjustments);
  const installed = built.includedServices.lines.length > 0;
  return {
    built,
    monthly: built.totals.monthlyEquivalent,
    hardware: built.totals.oneTime - (installed ? INSTALL_AND_TRAINING : 0),
    licenses: built.quoteLines
      .filter(l => l.hubspotProductId === SOFTWARE_LICENSE_PRODUCT.hubspotProductId)
      .reduce((n, l) => n + l.qty, 0),
  };
}

const BOARDS: [string, number] = ["Menu Board Device", 3];
const WEB: [string, number] = ["Website", 1];
const ONLINE: [string, number] = ["Online Ordering", 1];
const LOANER: [string, number] = ["Mega Kiosk Loaner", 1];
const TABLET: [string, number] = ["Orders Hub Tablet", 1];
const KDS: [string, number] = ["KDS (Kitchen Display System)", 1];
const KIOSK: [string, number] = ["Kiosk 27\" + Payment Terminal (AMS1) and Mount", 1];
// The QSR kit as the configurator seeds it, POS terminal included.
const QSR: Array<[string, number]> = [
  ["POS Unit", 1], ["Customer Facing Display", 1], ["Cash Drawer", 1], ["Payment Terminal - AMS1", 1],
  KDS, ["Thermal Printer", 1], ["Menu Board Device", 1], ["AIO Wifi Network Package - Unifi", 1],
];

describe("pricing scenarios, Oct 23 sheet", () => {
  it.each([
    ["A  marketing only", "marketing_only", [BOARDS], 199, 0, 0],
    ["B  + website", "marketing_only", [BOARDS, WEB], 249, 0, 0],
    ["C  partial ordering: website + online ordering", "marketing_partial", [WEB, ONLINE, TABLET, KDS], 349, 0, 0],
    ["D  C + a Mega on loan (tablet, KDS, Mega = 3 screens)", "marketing_partial", [WEB, ONLINE, TABLET, KDS, LOANER], 449, 0, 0],
    ["E  marketing + Mega on loan", "marketing_only", [BOARDS, LOANER], 299, 0, 0],
    ["F  marketing + website + Mega on loan", "marketing_only", [BOARDS, WEB, LOANER], 349, 0, 0],
    ["G  marketing + Mega bought", "marketing_only", [BOARDS, ["Marketing Kit - Mega Kiosk", 1]], 199, 1500, 0],
    ["H  marketing + website + Mega bought", "marketing_only", [BOARDS, WEB, ["Marketing Kit - Mega Kiosk", 1]], 249, 1500, 0],
    ["I  marketing + 2 Megas on loan", "marketing_only", [BOARDS, ["Mega Kiosk Loaner", 2]], 399, 0, 0],
    ["J  partial ordering: kiosk only, first kiosk free", "marketing_partial", [TABLET, KDS, KIOSK], 299, 0, 0],
    ["K  partial ordering: website + online + kiosk", "marketing_partial", [WEB, ONLINE, TABLET, KDS, KIOSK], 349, 0, 0],
    ["L  kiosk ordering with a printer instead of a KDS", "marketing_partial", [TABLET, ["Thermal Printer", 1], KIOSK], 299, 0, 0],
    ["M  K + a second KDS (4th screen)", "marketing_partial", [WEB, ONLINE, TABLET, ["KDS (Kitchen Display System)", 2], KIOSK], 368, 735, 1],
    // The sheet says $995 "at cost"; HubSpot lists the 27" kiosk at $1,495.
    ["N  K + a second kiosk (4th screen)", "marketing_partial", [WEB, ONLINE, TABLET, KDS, ["Kiosk 27\" + Payment Terminal (AMS1) and Mount", 2]], 368, 1495, 1],
    ["P  all-in-one, kit + the free kiosk", "all_in_one", [...QSR, KIOSK], 399, 0, 0],
    // The sheet's $1,730 is a $995 POS + a $735 KDS. A POS also ships with an
    // AMS1 (one per POS, enforced), and the kit covers only the first POS's.
    ["Q  all-in-one + a POS with display + a KDS (5 screens)", "all_in_one",
      [...QSR, KIOSK, ["POS Unit - With Customer Facing Display", 1], ["KDS (Kitchen Display System)", 1], ["Payment Terminal - AMS1", 1]],
      437, 995 + 735 + 350, 2],
  ] as Array<[string, QuoteType, Array<[string, number]>, number, number, number]>)(
    "%s",
    (_label, plan, picks, monthly, hardware, licenses) => {
      const q = quote(plan, picks);
      expect(q.built.blockers).toEqual([]);
      expect(q.monthly).toBe(monthly);
      expect(q.hardware).toBe(hardware);
      expect(q.licenses).toBe(licenses);
    }
  );

  it("refuses a POS on partial ordering — that's Order & Pay", () => {
    const q = quote("marketing_partial", [TABLET, KDS, KIOSK, ["POS Unit", 1]]);
    expect(q.built.blockers.join(" ")).toContain("ordering without a POS");
  });

  it("refuses partial ordering with no way to take an order", () => {
    const q = quote("marketing_partial", [TABLET, KDS]);
    expect(q.built.blockers.join(" ")).toContain("needs a way to take orders");
  });

  it("charges Order & Pay the same kit and free kiosk, a hundred dollars less", () => {
    const aio = quote("all_in_one", [...QSR, KIOSK]);
    const orderPay = quote("order_pay_only", [...QSR, KIOSK]);
    expect(orderPay.built.blockers).toEqual([]);
    expect(orderPay.hardware).toBe(aio.hardware);
    expect(orderPay.monthly).toBe(299);
  });

  it("puts the kiosk on at list unless the rep discounts it, never in the kit (2026-10-29)", () => {
    for (const [plan, picks] of [["all_in_one", [...QSR, KIOSK]], ["marketing_partial", [TABLET, KDS, KIOSK]]] as const) {
      const listed = quote(plan, [...picks], {}).built.quoteLines.filter(l => l.name === KIOSK[0]);
      expect(listed, plan).toEqual([expect.objectContaining({ qty: 1, unitPrice: 1495, firstKiosk: true })]);
      expect(listed[0].discountPercent, plan).toBeUndefined();
      expect(listed[0].coveredByPackage, plan).toBeUndefined();

      const free = quote(plan, [...picks]);
      expect(free.built.blockers, plan).toEqual([]);
      expect(free.built.quoteLines.filter(l => l.name === KIOSK[0]), plan)
        .toEqual([expect.objectContaining({ qty: 1, discountPercent: 100, firstKiosk: true })]);
    }
  });
});
