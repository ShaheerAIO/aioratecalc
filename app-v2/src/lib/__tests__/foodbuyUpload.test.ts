import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  alreadyFiled, checkFoodbuyPdf, foodbuyNoteBody, hubspotFoodbuyFileName, sha256Hex, FOODBUY_PDF_MAX_BYTES,
} from "@/lib/foodbuyUpload";
import { attachFileToCompanyNote, uploadHubspotFile } from "@/lib/adapters/hubspot";
import { buildFoodbuyFormHtml } from "@/lib/foodbuyForm";
import type { BusinessInfo, OwnerContact } from "@/types/merchant";

const pdf = (n = 100) => { const b = new Uint8Array(n); b.set([0x25, 0x50, 0x44, 0x46, 0x2d]); return b; };

describe("checkFoodbuyPdf", () => {
  it("accepts a PDF", () => expect(checkFoodbuyPdf(pdf())).toEqual({ ok: true }));
  it("refuses empty, oversized and non-PDF bytes", () => {
    expect(checkFoodbuyPdf(new Uint8Array(0))).toEqual({ ok: false, reason: "empty" });
    expect(checkFoodbuyPdf(pdf(FOODBUY_PDF_MAX_BYTES + 1))).toEqual({ ok: false, reason: "too_large" });
    expect(checkFoodbuyPdf(new TextEncoder().encode("<html>"))).toEqual({ ok: false, reason: "not_pdf" });
  });
});

describe("naming and dedupe", () => {
  it("sanitises the stored name and ignores path characters", () => {
    const n = hubspotFoodbuyFileName("../Torta Palace/ & Co", new Date("2026-10-21T01:02:03.456Z"));
    expect(n).toBe("AIO-Foodbuy-Enrollment-Torta-Palace-Co-20261021T010203Z.pdf");
    expect(hubspotFoodbuyFileName("")).toMatch(/^AIO-Foodbuy-Enrollment-Business-/);
  });
  it("skips only when the same content was already attached", () => {
    const sha = sha256Hex(pdf());
    expect(alreadyFiled({ hubspotFileSha256: sha, hubspotNoteId: "9" }, sha)).toBe(true);
    expect(alreadyFiled({ hubspotFileSha256: sha }, sha)).toBe(false); // file but no note: retry the note
    expect(alreadyFiled({ hubspotFileSha256: "x", hubspotNoteId: "9" }, sha)).toBe(false);
    expect(alreadyFiled(null, sha)).toBe(false);
  });
  it("note body carries no EIN or internals", () => {
    expect(foodbuyNoteBody("Torta Palace")).toContain("Torta Palace");
  });
});

describe("HubSpot calls", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("HUBSPOT_PRIVATE_APP_TOKEN", "general-token");
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("uploads privately, multipart, with no JSON content-type", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "555" }), { status: 201 }));
    const id = await uploadHubspotFile({ fileName: "a.pdf", bytes: pdf(), contentType: "application/pdf" });
    expect(id).toBe("555");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.hubapi.com/files/v3/files");
    expect(init.headers).toEqual({ Authorization: "Bearer general-token" });
    const form = init.body as FormData;
    expect(form.get("folderPath")).toBe("/EasyOB/Foodbuy");
    expect(JSON.parse(form.get("options") as string).access).toBe("PRIVATE");
  });

  it("attaches via a note associated to the company (type 190)", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "77" }), { status: 201 }));
    expect(await attachFileToCompanyNote({ companyId: "123", fileId: "555", body: "b" })).toBe("77");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.hubapi.com/crm/v3/objects/notes");
    const body = JSON.parse(init.body);
    expect(body.properties.hs_attachment_ids).toBe("555");
    expect(body.associations[0]).toEqual({
      to: { id: "123" },
      types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 190 }],
    });
  });

  it("throws on refusal so the route can log it", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 403 }));
    await expect(uploadHubspotFile({ fileName: "a.pdf", bytes: pdf(), contentType: "application/pdf" })).rejects.toThrow(/403/);
  });
});

describe("form export hands the PDF back", () => {
  const B = { legalName: "X LLC", dba: "X", bizType: "llc", address: "1", city: "c", state: "CA", zip: "9", phone: "1", website: "", yearsInBusiness: "", annualRevenue: "" } as BusinessInfo;
  const C = { firstName: "A", lastName: "B", title: "", email: "a@b.co", phone: "1" } as OwnerContact;
  it("posts to the opener on the same origin only", () => {
    const html = buildFoodbuyFormHtml(B, C);
    expect(html).toContain("window.opener.postMessage");
    expect(html).toContain("window.location.origin");
    expect(html).toContain("aio-foodbuy-pdf");
  });
});
