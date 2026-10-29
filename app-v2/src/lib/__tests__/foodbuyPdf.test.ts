import { describe, it, expect } from "vitest";
import { inflateSync } from "node:zlib";
import { PDFArray, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { renderFoodbuyPdf } from "@/lib/foodbuyPdf";
import { checkFoodbuyPdf, FOODBUY_SEND_MAX_BYTES } from "@/lib/foodbuyUpload";
import { completeForm } from "./foodbuyFixtures";

/** Every string the PDF draws: pdf-lib writes standard-font text as <hex> Tj in Flate content streams. */
async function drawnText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  let raw = "";
  for (const page of doc.getPages()) {
    const contents = doc.context.lookup(page.node.get(PDFName.of("Contents")));
    const streams = contents instanceof PDFArray ? contents.asArray().map(r => doc.context.lookup(r)) : [contents];
    for (const s of streams) {
      if (!(s instanceof PDFRawStream)) continue;
      const data = Buffer.from(s.contents);
      raw += (s.dict.get(PDFName.of("Filter")) ? inflateSync(data) : data).toString("latin1");
    }
  }
  return [...raw.matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map(m => Buffer.from(m[1], "hex").toString("latin1")).join("\n");
}

describe("renderFoodbuyPdf", () => {
  it("renders the five Letter pages of the agreement", async () => {
    const bytes = await renderFoodbuyPdf(completeForm(), { accountNumber: "764" });
    expect(checkFoodbuyPdf(bytes)).toEqual({ ok: true });
    expect(bytes.length).toBeLessThan(FOODBUY_SEND_MAX_BYTES);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(5);
    for (const p of doc.getPages()) expect(p.getSize()).toEqual({ width: 612, height: 792 });
  });

  it("prints the answers, the account number and the fixed Foodbuy contact", async () => {
    const text = await drawnText(await renderFoodbuyPdf(completeForm(), { accountNumber: "764" }));
    for (const s of [
      "Participation Agreement", "Torta Palace LLC", "12-3456789", "Sysco Los Angeles", "168255", "764",
      "Miguel Perez", "08/04/2026", "Jill Rosenhouse", "Limited Liability Controls - SYSCO Corporation",
    ]) expect(text).toContain(s);
  });

  it("is deterministic, so an unchanged resend hashes the same", async () => {
    const a = await renderFoodbuyPdf(completeForm(), { accountNumber: "764" });
    const b = await renderFoodbuyPdf(completeForm(), { accountNumber: "764" });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("adds a locations page per 22 rows", async () => {
    const f = completeForm();
    const bytes = await renderFoodbuyPdf({ ...f, locations: Array.from({ length: 23 }, () => f.locations[0]) }, { accountNumber: "" });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(6);
  });

  it("survives characters the standard fonts can't encode", async () => {
    const f = completeForm();
    const bytes = await renderFoodbuyPdf({ ...f, business: { ...f.business, dba: "Café 🌮 東京" } }, { accountNumber: "" });
    expect(await drawnText(bytes)).toContain("Café ? ??");
  });
});
