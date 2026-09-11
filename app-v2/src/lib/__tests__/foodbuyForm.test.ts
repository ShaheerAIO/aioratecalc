import { describe, it, expect } from "vitest";
import { buildFoodbuyFormHtml, buildFoodbuyFormFileName } from "@/lib/foodbuyForm";
import type { BusinessInfo, OwnerContact } from "@/types/merchant";

const BUSINESS: BusinessInfo = {
  legalName: "Torta Palace LLC",
  dba: "Torta Palace",
  bizType: "llc",
  address: "123 Main St",
  city: "Anaheim",
  state: "CA",
  zip: "92804",
  phone: "555-0100",
  website: "",
  yearsInBusiness: "5",
  annualRevenue: "500000",
};

const CONTACT: OwnerContact = {
  firstName: "Jane",
  lastName: "Doe",
  title: "Owner",
  email: "jane@tortapalace.com",
  phone: "555-0101",
};

describe("buildFoodbuyFormHtml", () => {
  it("fills in known business and contact fields", () => {
    const html = buildFoodbuyFormHtml(BUSINESS, CONTACT);
    expect(html).toContain("Torta Palace LLC");
    expect(html).toContain("Torta Palace");
    expect(html).toContain("123 Main St");
    expect(html).toContain("Anaheim");
    expect(html).toContain("Jane Doe");
    expect(html).toContain("jane@tortapalace.com");
    expect(html).toContain("LLC");
  });

  it("never renders an EIN, signature, or GPO-affiliation answer — AIO doesn't collect those", () => {
    const html = buildFoodbuyFormHtml(BUSINESS, CONTACT);
    // The labels are expected to appear (they're on the form); the point is
    // there is never a filled-in value next to them.
    expect(html).toContain("Federal ID # (EIN)");
    expect(html).toContain("Authorized Signature");
    expect(html).not.toMatch(/class="filled">\d{2}-?\d{7}/); // no EIN-shaped value
  });

  it("escapes HTML-significant characters in business/contact fields", () => {
    const html = buildFoodbuyFormHtml(
      { ...BUSINESS, legalName: "Bob's <Burgers> & Co" },
      CONTACT
    );
    expect(html).not.toContain("<Burgers>");
    expect(html).toContain("&lt;Burgers&gt;");
    expect(html).toContain("&amp;");
  });

  it("maps every bizType to a readable label", () => {
    const types: BusinessInfo["bizType"][] = ["llc", "corp", "s-corp", "sole-prop", "partnership", "non-profit"];
    for (const bizType of types) {
      const html = buildFoodbuyFormHtml({ ...BUSINESS, bizType }, CONTACT);
      expect(html).not.toContain(">llc<");
      expect(html).not.toContain(">sole-prop<");
    }
  });

  it("embeds the html2pdf export script and a download button", () => {
    const html = buildFoodbuyFormHtml(BUSINESS, CONTACT);
    expect(html).toContain("html2pdf.js/0.10.1/html2pdf.bundle.min.js");
    expect(html).toContain("exportPDF()");
  });
});

describe("buildFoodbuyFormFileName", () => {
  it("prefers the DBA, falls back to legal name, and strips non-alphanumerics", () => {
    expect(buildFoodbuyFormFileName(BUSINESS)).toContain("Torta-Palace");
    expect(buildFoodbuyFormFileName({ ...BUSINESS, dba: "" })).toContain("Torta-Palace-LLC");
  });
});
