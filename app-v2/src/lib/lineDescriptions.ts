// One customer-facing sentence per product, shown under each line on the
// merchant's quote preview (product owner, 2026-10-18: "add descriptions for
// all line items").
//
// Written HERE rather than read from HubSpot on purpose (product owner, same
// day): 17 active products carry no HubSpot description at all, and the ones
// that do are written for the signed quote document — multi-paragraph, or
// internal ("Charged per app: POS, KDS, Kiosk, mPos, etc."). This does NOT
// reach HubSpot; the published quote still prints the catalog's own text.
//
// Keyed by product id, like ORDER_POINT_RULES, so a rename in HubSpot can't
// silently drop a description. A product missing from this map simply shows
// no description — add the row when the product is added to the catalog.
// Pure and client-safe: QuoteSummary imports it.

export const LINE_DESCRIPTIONS: Record<string, string> = {
  // ── Plans ────────────────────────────────────────────────────────────────
  "335283119838": "The AIO platform: online and in-store ordering, payments, marketing and staff tools.", // All-in-One Platform
  "335279520445": "The AIO platform for ordering and payments. Marketing is not included.", // All-in-One (Order & Pay only)
  "343582047937": "Online and kiosk ordering with payments, alongside the point of sale you already have.", // AIO Marketing Partial Ordering
  "332609247965": "Social media management (3 posts and 1 reel a week), content creation, review and newsletter management, and a brand book.", // AIO Marketing Platform
  "332927902454": "The AIO Marketing Platform on a 2-year term, with a 27\" kiosk and three menu board computers included.", // AIO Marketing Platform (2-year term) - BAY AREA
  "334139877086": "The AIO Marketing Platform on a 2-year term, with a 27\" kiosk and three menu board computers included.", // AIO Marketing Platform (2-year term)

  // ── Software ─────────────────────────────────────────────────────────────
  "335280960199": "Software for each device running an AIO app beyond the three your plan includes.", // Additional Software License
  "333275576048": "Your restaurant's website, built and hosted by AIO.", // Website
  "343374665412": "Online ordering for your customers, with payments processed by AIO.", // Online Ordering
  "343579168455": "AIO's marketing services, included with your ordering plan.", // Marketing (Partial Ordering)
  "223152695998": "Payroll for your team, priced per employee each month.", // Payroll - AIO Platform (Per Person)
  "260559288040": "Card processing at the rates AIO has quoted you.", // AIO Processing Two Tiered Rate

  // ── Services ─────────────────────────────────────────────────────────────
  "223452690133": "An AIO engineer installs and mounts your hardware on site and sets up a dedicated, secure Wi-Fi network for it.", // Onsite Installation
  "223152695032": "We build your menu and configure your system, then train your staff and hand it over ready for service.", // System Onboarding and Training
  "339236587251": "A flat fee for each item swapped out of your included hardware kit.", // Free Kit Replacement Item
  "281354281678": "A small charge at checkout that confirms your payment method.", // AIO Pre Auth

  // ── Point of sale ────────────────────────────────────────────────────────
  "217445755632": "A countertop point-of-sale station for taking orders and payments.", // POS Unit
  "223452690130": "A countertop point-of-sale station with a second screen facing your customer.", // POS Unit - With Customer Facing Display
  "339229355762": "A dual-screen countertop point-of-sale station with a card terminal included.", // POS (Dual Screen) + Payment Terminal
  "223511653101": "A handheld point of sale for taking orders and payments anywhere in the restaurant.", // mPOS
  "335279520447": "A handheld device your staff use to take orders and payments at the table.", // AIO Tableside POS
  "318736467644": "A screen at the counter that shows customers their order and total.", // Customer Facing Display
  "223511653105": "A card terminal for chip, tap and swipe payments.", // Payment Terminal - AMS1
  "222497165011": "A locking cash drawer that opens from your point of sale.", // Cash Drawer
  "223511653104": "Prints receipts and kitchen tickets.", // Thermal Printer
  "250458906315": "Prints sticky labels for takeout and delivery orders.", // Epson Sticky Printer

  // ── Kiosks and screens ───────────────────────────────────────────────────
  "222497165009": "A 27\" self-ordering kiosk with a built-in card terminal and a wall or floor mount.", // Kiosk 27" + Payment Terminal (AMS1) and Mount
  "223519571666": "A compact 15.6\" self-ordering kiosk with a built-in card terminal and mount.", // Kiosk Mini 15.6" + Payment Terminal (AMS1) and Mount
  "260674226888": "A 65\" interactive kiosk for self-ordering and on-screen promotion.", // Mega Kiosk
  "332617109238": "A 65\" Mega Kiosk that displays your marketing content in store.", // Marketing Kit - Mega Kiosk
  "332793212658": "A 27\" kiosk that displays your marketing content in store.", // Marketing Kit - 27" Kiosk
  "343373224660": "A 65\" Mega Kiosk on loan that displays your marketing content in store, on a 2-year term.", // Mega Kiosk Loaner
  "223452690132": "A kitchen screen that shows your staff incoming orders.", // KDS (Kitchen Display System)
  "223511653103": "Runs your digital menu board. The TV is not supplied or installed by AIO.", // Menu Board Computer
  "276751313619": "A tablet that brings your online and delivery orders into one place.", // Orders Hub Tablet
  "276754193118": "A tablet your staff use to clock in and out.", // Clock in Tablet

  // ── Network ──────────────────────────────────────────────────────────────
  "338690209525": "A dedicated, secure Wi-Fi network for your point of sale and payments, with LTE backup.", // AIO Wifi Network Package - Unifi
  "338691650250": "A dedicated, secure Wi-Fi network for your point of sale and payments, with LTE backup.", // AIO Wifi Network Package - Pronto
  "281351401209": "A dedicated, secure Wi-Fi network for your point of sale and payments.", // AIO WiFi Network Package (retired; saved quotes)
  "338693809894": "The router at the heart of your restaurant's network.", // Unifi Router
  "338690930367": "The router at the heart of your restaurant's network, with LTE backup.", // Pronto Router + LTE Backup
  "338693090009": "Connects your wired devices to the network.", // Unifi 8 Port Switch
  "338690209526": "Connects your wired devices to the network.", // Pronto 8 Port Switch
  "338616220368": "Wi-Fi coverage for your devices across the restaurant.", // Unifi Access Point
  "338615500489": "Keeps you online over cellular if your internet goes down.", // Unifi U-LTE Backup Pro
};

export function lineDescription(hubspotProductId: string): string | null {
  return LINE_DESCRIPTIONS[hubspotProductId] ?? null;
}
