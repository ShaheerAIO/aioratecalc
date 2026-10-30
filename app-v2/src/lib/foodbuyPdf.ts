// Renders the Foodbuy participation agreement as a vector PDF that matches
// Foodbuy's own form (AIO_Foodbuy_Enrollment_Form_V1) page for page:
//   1. Participation Agreement — business, contacts, GPO affiliation
//   2. Acknowledgement & Authorization — the terms, signature, business, date
//   3. Distributor Account Number Information — direct manufacturer agreements
//   4. Restaurant Location(s) & Distributor Account Details (repeats every 22 rows)
//   5. Sysco's "Limited Liability Controls" letter of participation
//
// Every coordinate, size and colour below was measured from the content
// streams of a signed copy of the original (Letter, 612×792pt, origin bottom
// left), so the layout is the original's rather than an approximation of it.
// Arial is drawn as Helvetica (same metrics) and the Sysco page's Verdana as
// Helvetica fitted to the same line width.
//
// Deterministic: no creation date or random id, so the same answers always
// produce the same bytes, which the send route's duplicate guard relies on.
import {
  PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix,
  type PDFFont, type PDFImage, type PDFPage, type RGB,
} from "pdf-lib";
import type { FoodbuyFormData } from "@/types/merchant";
import { FOODBUY_LOCATIONS_PER_PAGE, FOODBUY_PROVIDER } from "@/lib/foodbuyForm";
import { FOODBUY_LOGO_JPEG_BASE64 } from "@/lib/foodbuyLogo";
import { FOODBUY_TERMS } from "@/lib/foodbuyTerms";

const W = 612;
const H = 792;

const CORAL = rgb(0.910, 0.376, 0.290);
const INK = rgb(0.102, 0.102, 0.102);
const GRAY = rgb(0.420, 0.447, 0.502);
const GRID = rgb(0.898, 0.906, 0.922);
const BLACK = rgb(0, 0, 0);
const WHITE = rgb(1, 1, 1);
const OFFICE_BG = rgb(1, 0.953, 0.941);
const SYSCO_GREEN_BAR = rgb(0.553, 0.779, 0.239);
const SYSCO_GREEN_TEXT = rgb(0.431, 0.705, 0.247);
const SYSCO_NAVY = rgb(0, 0, 0.502);
const SYSCO_BLUE = rgb(0, 0.510, 0.783);
const SYSCO_HEADER = rgb(0, 0.2, 0.4);
const BOX_STROKE = rgb(0.6, 0.6, 0.6);

const WIN_ANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
/** The standard fonts only encode WinAnsi; anything else would throw mid-render. */
function winAnsi(s: string): string {
  return Array.from(s.normalize("NFC").replace(/\s+/g, " "))
    .map(ch => {
      const c = ch.codePointAt(0)!;
      return (c >= 0x20 && c < 0x7f) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.includes(ch) ? ch : "?";
    })
    .join("");
}

type Ctx = { doc: PDFDocument; regular: PDFFont; bold: PDFFont; logo: PDFImage; signature: PDFImage };
type TextOpts = { font?: PDFFont; size?: number; color?: RGB };

function text(ctx: Ctx, page: PDFPage, s: string, x: number, y: number, o: TextOpts = {}) {
  page.drawText(s, { x, y, font: o.font ?? ctx.regular, size: o.size ?? 9, color: o.color ?? INK });
}

/** A filled-in value: shrunk to fit its blank, and cut with an ellipsis only past a readable size. */
function value(ctx: Ctx, page: PDFPage, raw: string, x: number, y: number, maxW: number, size = 8, font = ctx.regular) {
  let s = winAnsi(raw);
  if (!s) return;
  let sz = size;
  while (sz > 5 && font.widthOfTextAtSize(s, sz) > maxW) sz -= 0.25;
  while (s.length > 1 && font.widthOfTextAtSize(s, sz) > maxW) s = s.slice(0, -2) + "…";
  page.drawText(s, { x, y, font, size: sz, color: BLACK });
}

function centered(ctx: Ctx, page: PDFPage, s: string, cx: number, y: number, o: TextOpts = {}) {
  const font = o.font ?? ctx.regular;
  const size = o.size ?? 9;
  text(ctx, page, s, cx - font.widthOfTextAtSize(s, size) / 2, y, o);
}

function rightAligned(ctx: Ctx, page: PDFPage, s: string, right: number, y: number, o: TextOpts = {}) {
  const font = o.font ?? ctx.regular;
  text(ctx, page, s, right - font.widthOfTextAtSize(s, o.size ?? 9), y, o);
}

function rect(page: PDFPage, x: number, y: number, w: number, h: number, color: RGB) {
  page.drawRectangle({ x, y, width: w, height: h, color });
}

/** The form's write-on blank: a run of grey underscores, as the original draws it. */
function blank(ctx: Ctx, page: PDFPage, x: number, y: number, n: number): number {
  text(ctx, page, "_".repeat(n), x, y, { color: GRAY });
  return ctx.regular.widthOfTextAtSize("_".repeat(n), 9);
}

/** Label in bold, its blank after it, and the value written on the blank. */
function labelled(ctx: Ctx, page: PDFPage, label: string, x: number, y: number, blankX: number, n: number, v: string) {
  text(ctx, page, label, x, y, { font: ctx.bold });
  const w = blank(ctx, page, blankX, y, n);
  value(ctx, page, v, blankX + 4, y + 5.85, w - 6);
}

/** The ☐ the original prints in Segoe UI Symbol, drawn as a box, with a tick when checked. */
function checkbox(page: PDFPage, x: number, y: number, color: RGB, checked: boolean) {
  page.drawRectangle({ x: x + 0.6, y: y - 0.4, width: 6.6, height: 6.6, borderColor: color, borderWidth: 0.7 });
  if (!checked) return;
  page.drawLine({ start: { x: x - 0.5, y: y + 3.4 }, end: { x: x + 2.6, y: y - 0.2 }, thickness: 1.3, color: INK });
  page.drawLine({ start: { x: x + 2.6, y: y - 0.2 }, end: { x: x + 8.6, y: y + 8.6 }, thickness: 1.3, color: INK });
}

function logo(ctx: Ctx, page: PDFPage, x: number, y: number, w: number, h: number) {
  page.drawImage(ctx.logo, { x, y, width: w, height: h });
}

/** The drawn signature, scaled to fit the box and sat on its baseline. */
function signature(ctx: Ctx, page: PDFPage, x: number, y: number, w: number, h: number) {
  const img = ctx.signature;
  const scale = Math.min(w / img.width, h / img.height);
  const sw = img.width * scale;
  const sh = img.height * scale;
  page.drawImage(img, { x: x + (w - sw) / 2, y, width: sw, height: sh });
}

function sectionHeading(ctx: Ctx, page: PDFPage, s: string, y: number, ruleY: number) {
  text(ctx, page, s, 54, y, { font: ctx.bold, size: 11.04, color: CORAL });
  rect(page, 52.56, ruleY, 506.98, 0.48, CORAL);
}

/** Coral-header table with light grid lines, as on pages 3 and 4. */
function table(page: PDFPage, cols: number[], headerBottom: number, headerTop: number, rowLines: number[]) {
  const left = cols[0];
  const right = cols[cols.length - 1];
  rect(page, left, headerBottom, right - left, headerTop - headerBottom, CORAL);
  for (const y of [headerTop, ...rowLines]) rect(page, left, y, right - left, 0.12, GRID);
  const bottom = rowLines[rowLines.length - 1];
  for (const x of cols) rect(page, x - 0.12, bottom, 0.12, headerTop - bottom, GRID);
}

// ── Page 1 ───────────────────────────────────────────────────────────────────

function page1(ctx: Ctx, d: FoodbuyFormData, accountNumber: string) {
  const p = ctx.doc.addPage([W, H]);
  logo(ctx, p, 54, 673.9, 100.65, 64.1);
  text(ctx, p, "Participation Agreement", 54, 649.06, { font: ctx.bold, size: 20.04 });
  text(ctx, p, "Foodbuy Foodservice Enrollment", 54, 631.54, { size: 9.96, color: GRAY });
  rect(p, 52.56, 608.86, 506.98, 0.96, CORAL);

  text(ctx, p, "Program Effective Date:", 54, 588.46, { font: ctx.bold });
  const dateW = blank(ctx, p, 156.14, 588.46, 25);
  value(ctx, p, d.signedDate, 163, 591.95, dateW - 8, 10);
  rightAligned(ctx, p, "Account Number:", 414.6, 588.46, { font: ctx.bold });
  const acctW = blank(ctx, p, 417.07, 588.46, 20);
  value(ctx, p, accountNumber, 420, 593.76, acctW - 4);

  const b = d.business;
  sectionHeading(ctx, p, "Business Information", 546.7, 543.94);
  labelled(ctx, p, "Legal Entity Name: ", 54, 513.91, 137.66, 27, b.legalName);
  labelled(ctx, p, "Federal ID #: ", 288.05, 513.91, 344.71, 27, formatEin(b.ein));
  labelled(ctx, p, "DBA (if applicable): ", 54, 497.59, 139.58, 27, b.dba);
  labelled(ctx, p, "Type of Business: ", 288.05, 497.59, 368.23, 27, b.bizType);
  labelled(ctx, p, "Corporate Address: ", 54, 481.27, 141.14, 27, b.address);
  labelled(ctx, p, "Suite #: ", 288.05, 481.27, 323.08, 27, b.suite);
  labelled(ctx, p, "City: ", 54, 464.95, 76.58, 27, b.city);
  labelled(ctx, p, "State: ", 288.05, 464.95, 315.65, 27, b.state);
  labelled(ctx, p, "Zip Code: ", 54, 448.51, 98.06, 35, b.zip);

  sectionHeading(ctx, p, "Contact Information", 408.79, 406.03);
  d.contacts.forEach((c, i) => {
    const y = 390.55 - i * 65.54;
    labelled(ctx, p, "Contact Name: ", 54, y, 120.14, 27, c.name);
    labelled(ctx, p, "Phone: ", 288.05, y, 321.17, 27, c.phone);
    labelled(ctx, p, "Title: ", 54, y - 16.32, 78.14, 27, c.title);
    labelled(ctx, p, "Fax: ", 288.05, y - 16.32, 309.17, 27, c.fax);
    labelled(ctx, p, "Email: ", 54, y - 32.66, 83.66, 35, c.email);
  });

  sectionHeading(ctx, p, "GPO Affiliation", 250.49, 247.73);
  const note = { size: 8.52, color: GRAY };
  checkbox(p, 54, 218.45, CORAL, d.gpo.participates === false);
  text(ctx, p, "NO, WE DO NOT CURRENTLY PARTICIPATE IN GPO OR DIRECT CONTRACT RELATIONSHIPS", 66.86, 218.45, { font: ctx.bold });
  text(ctx, p, "I am not aware of any other GPO food and beverage contracting relationships that are currently in effect. If any other affiliation is", 74.06, 205.37, note);
  text(ctx, p, "in place, those relationships are hereby terminated.", 74.06, 195.53, note);
  checkbox(p, 54, 177.98, CORAL, d.gpo.participates === true);
  text(ctx, p, "YES, WE CURRENTLY PARTICIPATE IN A GPO OR PROCUREMENT SERVICES ORGANIZATION", 66.86, 177.98, { font: ctx.bold });
  text(ctx, p, "List current affiliation below. Participation in more than one Group Purchasing Organization or Procurement Service Organization", 74.06, 164.78, note);
  text(ctx, p, "is strictly prohibited and will disqualify application if other Affiliation is not terminated prior to engaging Foodbuy Foodservice.", 74.07, 154.94, note);
  labelled(ctx, p, "Please list your current GPO/PSO/Buying Group: ", 54, 125.42, 265.73, 35, d.gpo.participates ? d.gpo.name : "");
  text(ctx, p, "If you intend to have your food and beverage purchases qualify for the Foodbuy Foodservice program, please provide Foodbuy", 54, 112.46, note);
  text(ctx, p, "Foodservice with a copy of the termination letter addressed to your existing GPO/PSO/Buying Group.", 54, 102.74, note);
}

function formatEin(ein: string): string {
  const digits = ein.replace(/\D/g, "");
  return digits.length === 9 ? `${digits.slice(0, 2)}-${digits.slice(2)}` : ein;
}

// ── Page 2 ───────────────────────────────────────────────────────────────────

// Where each line of the terms sits, after the first (which follows ACCEPT).
const TERM_YS = [
  569.26, 558.94, 548.62, 538.18, 527.83,
  508.51, 498.19, 487.75, 477.43, 467.11, 456.79, 446.47, 436.03,
  416.71, 406.39, 396.07,
  376.63, 366.31, 355.97, 345.65, 335.21, 324.89, 314.57, 304.25, 293.81, 283.49, 273.17, 262.85, 252.41, 242.09, 231.77,
];

function page2(ctx: Ctx, d: FoodbuyFormData) {
  const p = ctx.doc.addPage([W, H]);
  logo(ctx, p, 54, 652.5, 134.25, 85.5);
  text(ctx, p, "Acknowledgement & Authorization", 54, 627.7, { font: ctx.bold, size: 20.04 });
  rect(p, 52.56, 602.98, 506.98, 0.96, CORAL);

  checkbox(p, 54, 580.18, CORAL, d.accept);
  text(ctx, p, "ACCEPT", 68.3, 580.18, { font: ctx.bold, size: 9.96, color: CORAL });
  const [lead, ...lines] = FOODBUY_TERMS.flat();
  text(ctx, p, lead, 114.74, 580.18);
  lines.forEach((line, i) => text(ctx, p, line, 54, TERM_YS[i]));

  // Signature and print name/title over the two upper lines.
  signature(ctx, p, 60, 181, 212, 30);
  rect(p, 52.56, 178.82, 226.97, 0.48, INK);
  centered(ctx, p, "Authorized Signature", 166.05, 167.9, { size: 8.52, color: GRAY });
  value(ctx, p, d.printName, 302, 186.76, 115);
  value(ctx, p, d.printTitle, 423, 186.76, 98);
  rect(p, 296.57, 178.82, 226.97, 0.48, INK);
  centered(ctx, p, "Print Name and Title", 410.05, 167.9, { size: 8.52, color: GRAY });

  const businessName = d.business.legalName;
  labelled(ctx, p, "ON BEHALF OF: ", 54, 141.26, 126.98, 35, d.business.dba || businessName);

  const nameW = ctx.regular.widthOfTextAtSize(winAnsi(businessName), 8);
  value(ctx, p, businessName, Math.max(56, 166.05 - nameW / 2), 101.76, 220);
  rect(p, 52.56, 94.34, 226.97, 0.48, INK);
  centered(ctx, p, "[Business Name]", 166.05, 83.42, { size: 8.52, color: GRAY });
  centered(ctx, p, d.signedDate, 410.05, 99.95, { size: 10, color: BLACK });
  rect(p, 296.57, 94.34, 226.97, 0.48, INK);
  centered(ctx, p, "Date", 410.05, 83.42, { size: 8.52, color: GRAY });
}

// ── Page 3 ───────────────────────────────────────────────────────────────────

const DIRECT_COLS = [54, 216.05, 372.07, 447.07, 521.98];
const DIRECT_ROWS = [449.11, 429.43, 409.87, 390.31, 370.63, 351.05, 331.49, 311.81, 292.25];

function page3(ctx: Ctx, d: FoodbuyFormData) {
  const p = ctx.doc.addPage([W, H]);
  logo(ctx, p, 54, 652.5, 134.25, 85.5);
  text(ctx, p, "Distributor Account Number Information", 54, 627.7, { font: ctx.bold, size: 20.04 });
  rect(p, 52.56, 602.98, 506.98, 0.96, CORAL);
  text(ctx, p, "Please provide all location details to your Foodbuy Foodservice Account executive.", 54, 582.46, { color: GRAY });

  sectionHeading(ctx, p, "Direct Manufacturer Agreements", 558.22, 555.58);
  text(ctx, p, "If you or your distributor(s) have direct contracts with manufacturers and you wish to keep those contracts and program", 54, 527.59);
  text(ctx, p, "associations in place, please list them in the table below. Failure to disclose this information will acknowledge that you agree", 54, 517.15);
  text(ctx, p, "to participate in the Foodbuy Foodservice programs with all manufacturers not disclosed. Please update Foodbuy Foodservice", 54, 506.83);
  text(ctx, p, "of any additions or deletions on a regular basis.", 54, 496.39);
  text(ctx, p, "Please List All Direct Agreements with Start and End Dates", 54, 475.63, { font: ctx.bold, size: 9.48, color: CORAL });

  table(p, DIRECT_COLS, 449.23, 467.47, DIRECT_ROWS);
  ["Manufacturer", "Category", "Start Date", "End Date"].forEach((h, i) =>
    text(ctx, p, h, DIRECT_COLS[i] + 6, 455.11, { font: ctx.bold, color: WHITE }));
  d.directAgreements.slice(0, DIRECT_ROWS.length - 1).forEach((a, r) => {
    const y = DIRECT_ROWS[r] - 12.5;
    [a.manufacturer, a.category, a.start, a.end].forEach((v, i) =>
      value(ctx, p, v, DIRECT_COLS[i] + 6, y, DIRECT_COLS[i + 1] - DIRECT_COLS[i] - 10));
  });

  // Office Use Only: Foodbuy's to tick, so it ships blank.
  rect(p, 52.56, 249.89, 506.98, 10.44, OFFICE_BG);
  rect(p, 52.08, 260.33, 507.94, 0.48, CORAL);
  rect(p, 52.08, 249.89, 0.48, 10.44, CORAL);
  rect(p, 559.54, 249.89, 0.48, 10.44, CORAL);
  text(ctx, p, "Office Use Only", 54, 251.81, { font: ctx.bold, color: CORAL });
  const office: [number, number, string][] = [
    [60, 234.17, "Foodbuy Foodservice"], [294.05, 234.17, "Healthcare"],
    [60, 218.21, "Resorts & Gaming"], [294.05, 218.21, "Golf Course"],
    [60, 202.25, "Education"], [294.05, 202.25, "Clubs"],
    [60, 186.14, "Other: _______________________"],
  ];
  for (const [x, y, label] of office) {
    checkbox(p, x, y, INK, false);
    text(ctx, p, label, x + 12.8, y);
  }
}

// ── Page 4 ───────────────────────────────────────────────────────────────────

const LOC_COLS = [36, 121.46, 228.29, 299.35, 348.43, 397.39, 532.66, 565.68];
const LOC_ROWS = [
  614.38, 596.74, 579.19, 561.55, 543.91, 526.39, 508.75, 491.11, 473.59, 455.95, 438.43, 420.77,
  403.13, 385.61, 367.97, 350.33, 332.81, 315.17, 297.53, 279.98, 262.34, 244.7, 227.18,
];
// Header labels, one or two lines, centred in their column.
const LOC_HEADERS: string[][] = [
  ["Restaurant Location", "Name"], ["Location Address"], ["Location City"], ["Location", "State"],
  ["Location", "Zip Code"], ["Distributor Name/Location"], ["Acct.", "#"],
];

function page4(ctx: Ctx, rows: FoodbuyFormData["locations"]) {
  const p = ctx.doc.addPage([W, H]);
  logo(ctx, p, 36, 670.5, 134.25, 85.5);
  text(ctx, p, "Restaurant Location(s) & Distributor Account Details", 181.9, 670.42, { font: ctx.bold, size: 14.04 });
  rect(p, 34.56, 648.94, 543, 0.96, CORAL);

  table(p, LOC_COLS, 614.5, 638.86, LOC_ROWS);
  LOC_HEADERS.forEach((lines, i) => {
    const cx = (LOC_COLS[i] + LOC_COLS[i + 1]) / 2;
    lines.forEach((l, j) => centered(ctx, p, l, cx, 628.42 - j * 9.24, { font: ctx.bold, size: 8.04, color: WHITE }));
  });
  rows.forEach((l, r) => {
    const y = LOC_ROWS[r] - 11.5;
    [l.name, l.address, l.city, l.state, l.zip, l.distributor, l.acct].forEach((v, i) =>
      value(ctx, p, v, LOC_COLS[i] + 2, y, LOC_COLS[i + 1] - LOC_COLS[i] - 4));
  });
}

// ── Page 5 (Sysco) ───────────────────────────────────────────────────────────

/** SVG path for a rounded rectangle w×h with its top-left at the origin (y down). */
function roundedPath(w: number, h: number, r: number, topOnly = false): string {
  const br = topOnly ? 0 : r;
  return `M ${r} 0 L ${w - r} 0 Q ${w} 0 ${w} ${r} L ${w} ${h - br} Q ${w} ${h} ${w - br} ${h} `
    + `L ${br} ${h} Q 0 ${h} 0 ${h - br} L 0 ${r} Q 0 0 ${r} 0 Z`;
}

function inputBox(p: PDFPage, x: number, y: number, w: number, h = 15.84) {
  p.drawSvgPath(roundedPath(w, h, 2.16), { x, y: y + h, color: WHITE, borderColor: BOX_STROKE, borderWidth: 0.5 });
}

/** A Sysco section: blue rounded frame from `bottom` up to `top`, with a navy title bar. */
function syscoSection(ctx: Ctx, p: PDFPage, title: string, top: number, bottom: number) {
  const x = 35.95;
  const w = 540;
  p.drawSvgPath(roundedPath(w, top - bottom, 5.67), { x, y: top, borderColor: SYSCO_BLUE, borderWidth: 0.5 });
  p.drawSvgPath(roundedPath(w, 18, 5.67, true), { x, y: top, color: SYSCO_HEADER });
  centered(ctx, p, title, x + w / 2, top - 11.94, { font: ctx.bold, size: 10, color: WHITE });
}

/** Label right-aligned against its box, the box, and the value inside it. */
function boxField(ctx: Ctx, p: PDFPage, label: string, x: number, y: number, w: number, v: string) {
  rightAligned(ctx, p, label, x - 2, y + 5.28);
  inputBox(p, x, y, w);
  value(ctx, p, v, x + 3, y + 4.5, w - 6, 10);
}

/** The Customer/Provider contact block; `dy` is its offset from the Customer block. */
function contactBlock(
  ctx: Ctx, p: PDFPage, dy: number,
  v: { name: string; title: string; company: string; address: string; city: string; state: string; zip: string; cityStateZip?: string; phone: string; fax: string; email: string },
  signed: boolean,
) {
  boxField(ctx, p, "Contact Name:", 117, 299.16 - dy, 198, v.name);
  boxField(ctx, p, "Title:", 117, 281.16 - dy, 198, v.title);
  rightAligned(ctx, p, "Signature:", 367, 304.27 - dy);
  inputBox(p, 369, 278.83 - dy, 198, 36);
  if (signed) signature(ctx, p, 373, 281.5 - dy, 190, 31);
  boxField(ctx, p, "Company Name:", 117, 253.99 - dy, 450, v.company);
  boxField(ctx, p, "Address:", 117, 235.99 - dy, 450, v.address);
  if (v.cityStateZip !== undefined) {
    boxField(ctx, p, "City/State/Zip:", 117, 217.99 - dy, 198, v.cityStateZip);
  } else {
    // Three values in one box, spaced as the original prints them.
    boxField(ctx, p, "City/State/Zip:", 117, 217.99 - dy, 198, "");
    value(ctx, p, v.city, 120, 222.49 - dy, 76, 10);
    value(ctx, p, v.state, 198, 222.49 - dy, 46, 10);
    value(ctx, p, v.zip, 248, 222.49 - dy, 64, 10);
  }
  boxField(ctx, p, "Phone:", 369, 217.99 - dy, 198, v.phone);
  boxField(ctx, p, "email Address:", 117, 199.99 - dy, 198, v.email);
  boxField(ctx, p, "Fax:", 369, 199.99 - dy, 198, v.fax);
}

// The letter's intro, with its bold Customer/Provider runs, line for line.
const LOP_LINES: [number, [string, boolean][]][] = [
  [656.65, [["[Operator or GPO Name] noted as “", false], ["Customer", true], ["”, authorizes [Consultant or GPO Service Provider] noted as", false]]],
  [644.65, [["“", false], ["Provider", true], ["”, to collect transactional purchase data from their distributor partners.  It is understood that", false]]],
  [632.65, [["such data will be utilized for reporting, analysis, and related activities in accordance with the performance", false]]],
  [620.65, [["of value added services provided to ", false], ["Customer", true], [" by ", false], ["Provider.", true]]],
  [596.65, [["Customer", true], ["  represents that the relationship between it and its members or unit locations, including", false]]],
  [584.65, [["franchisees if appropriate, entitles them to collect this data for Provider.", false]]],
  [560.65, [["Provider", true], ["  agrees to maintain the confidentiality and integrity of the information released into its", false]]],
  [548.65, [["possession using such information only for the value added services agreed to with the Customer.", false]]],
];

function page5(ctx: Ctx, d: FoodbuyFormData) {
  const p = ctx.doc.addPage([W, H]);
  rect(p, 0, 774, W, 18, SYSCO_GREEN_BAR);

  // The original's Helvetica Condensed Black, as Helvetica Bold squeezed to its width.
  const title = "Limited Liability Controls - SYSCO Corporation";
  const squeeze = 335 / ctx.bold.widthOfTextAtSize(title, 20);
  p.pushOperators(pushGraphicsState(), concatTransformationMatrix(squeeze, 0, 0, 1, 138.34, 738.64));
  p.drawText(title, { x: 0, y: 0, font: ctx.bold, size: 20, color: SYSCO_NAVY });
  p.pushOperators(popGraphicsState());
  centered(ctx, p, "Third Party Data Tracking", W / 2, 716.16, { font: ctx.bold, size: 14, color: SYSCO_GREEN_TEXT });
  p.drawLine({ start: { x: 27, y: 702 }, end: { x: 585, y: 702 }, thickness: 1.22, color: SYSCO_BLUE });
  centered(ctx, p, "Letter of Participation (LoP) Content Requirements", W / 2, 681.92, { font: ctx.bold, size: 12, color: SYSCO_BLUE });

  // Fit the intro to the original's measure: Verdana runs wider than Helvetica.
  const lineWidth = (segs: [string, boolean][], size: number) =>
    segs.reduce((w, [s, b]) => w + (b ? ctx.bold : ctx.regular).widthOfTextAtSize(s, size), 0);
  const introSize = Math.min(11, 537 / Math.max(...LOP_LINES.map(([, segs]) => lineWidth(segs, 1))));
  for (const [y, segs] of LOP_LINES) {
    let x = 37.42;
    for (const [s, b] of segs) {
      text(ctx, p, s, x, y, { font: b ? ctx.bold : ctx.regular, size: introSize, color: BLACK });
      x += (b ? ctx.bold : ctx.regular).widthOfTextAtSize(s, introSize);
    }
  }

  syscoSection(ctx, p, "Date References", 531, 441.35);
  boxField(ctx, p, "LoP Agreement Date:", 234, 488.51, 144, d.signedDate);
  boxField(ctx, p, "Effective Date for Data Exchange:", 234, 470.51, 144, d.signedDate);
  boxField(ctx, p, "Termination Date of Data Exchange:", 234, 452.51, 144, "");
  centered(ctx, p, "OPEN", 306, 457.46, { size: 10, color: BLACK });

  syscoSection(ctx, p, "Primary Sysco Contact", 432, 359.68);
  boxField(ctx, p, "Contact Name:", 117, 389.16, 450, d.sysco.name);
  boxField(ctx, p, "Phone:", 117, 371.16, 117, d.sysco.phone);
  boxField(ctx, p, "Email Address:", 324, 371.16, 243, d.sysco.email);

  const c = d.contacts[0];
  const b = d.business;
  syscoSection(ctx, p, "“Customer” Authorization Signature and Contact Information", 342, 188.8);
  contactBlock(ctx, p, 0, {
    name: c.name, title: c.title, company: b.legalName,
    address: [b.address, b.suite].filter(Boolean).join(", "),
    city: b.city, state: b.state, zip: b.zip, phone: c.phone, fax: c.fax, email: c.email,
  }, true);

  syscoSection(ctx, p, "“Provider” Contact Information", 171, 17.8);
  const f = FOODBUY_PROVIDER;
  contactBlock(ctx, p, 171, {
    name: f.name, title: f.title, company: f.company, address: f.address,
    city: "", state: "", zip: "", cityStateZip: f.cityStateZip, phone: f.phone, fax: "", email: f.email,
  }, false);
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * The finished agreement. `accountNumber` is the AIO tenant number, blank
 * until the account is provisioned. Throws if the signature isn't a PNG.
 */
export async function renderFoodbuyPdf(data: FoodbuyFormData, opts: { accountNumber: string }): Promise<Uint8Array> {
  // updateMetadata:false keeps pdf-lib from stamping the current time into
  // the file (see the header: same answers, same bytes).
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle("Foodbuy Foodservice Enrollment — Participation Agreement");
  const ctx: Ctx = {
    doc,
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    logo: await doc.embedJpg(FOODBUY_LOGO_JPEG_BASE64),
    signature: await doc.embedPng(data.signature.replace(/^data:image\/png;base64,/, "")),
  };

  page1(ctx, data, opts.accountNumber);
  page2(ctx, data);
  page3(ctx, data);
  for (let i = 0; i < Math.max(1, data.locations.length); i += FOODBUY_LOCATIONS_PER_PAGE) {
    page4(ctx, data.locations.slice(i, i + FOODBUY_LOCATIONS_PER_PAGE));
  }
  page5(ctx, data);

  return doc.save();
}
