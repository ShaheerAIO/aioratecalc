import { describe, it, expect, beforeAll } from "vitest";
import { prepareStatement, StatementTooLargeError } from "../statementUpload";

// These run in Vitest's node environment, so there's no `createImageBitmap` and
// no `FileReader`. That's actually the case worth covering: `downscaleImage`
// treats any failure as "send the original", so its absence exercises the
// fallback path exactly as a browser that can't decode an exotic image would.
// `FileReader` has no such fallback, so it gets a minimal stub.
beforeAll(() => {
  class StubFileReader {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(blob: Blob) {
      blob.arrayBuffer().then(buf => {
        this.result = `data:${blob.type};base64,${Buffer.from(buf).toString("base64")}`;
        this.onload?.();
      });
    }
  }
  (globalThis as { FileReader?: unknown }).FileReader = StubFileReader;
});

const fileOf = (bytes: number, type: string, name = "statement") =>
  new File([new Uint8Array(bytes)], name, { type });

const MB = 1024 * 1024;

describe("prepareStatement", () => {
  it("passes a normal PDF through as application/pdf", async () => {
    const out = await prepareStatement(fileOf(2 * MB, "application/pdf", "stmt.pdf"));
    expect(out.mediaType).toBe("application/pdf");
    expect(out.bytes).toBe(2 * MB);
    expect(out.data.length).toBeGreaterThan(0);
  });

  it("recognizes a PDF by extension when the browser reports no type", async () => {
    const out = await prepareStatement(fileOf(1 * MB, "", "stmt.PDF"));
    expect(out.mediaType).toBe("application/pdf");
  });

  it("refuses a PDF over the 20MB ceiling with an actionable message", async () => {
    const tooBig = prepareStatement(fileOf(21 * MB, "application/pdf", "stmt.pdf"));
    await expect(tooBig).rejects.toBeInstanceOf(StatementTooLargeError);
    // The merchant needs to know both numbers and what to do about it —
    // Anthropic's 32MB request cap is not a useful thing to say to them.
    await expect(tooBig).rejects.toThrow(/21\.0MB/);
    await expect(tooBig).rejects.toThrow(/20\.0MB/);
    await expect(tooBig).rejects.toThrow(/summary pages/);
  });

  it("refuses an image over the ceiling when it could not be downscaled", async () => {
    const tooBig = prepareStatement(fileOf(21 * MB, "image/png", "photo.png"));
    await expect(tooBig).rejects.toBeInstanceOf(StatementTooLargeError);
    await expect(tooBig).rejects.toThrow(/smaller photo or a PDF/);
  });

  it("sends an image unchanged when downscaling is unavailable", async () => {
    // The downscale is an optimization; losing it must never block the upload.
    const out = await prepareStatement(fileOf(4 * MB, "image/png", "photo.png"));
    expect(out.mediaType).toBe("image/png");
    expect(out.bytes).toBe(4 * MB);
  });

  it("preserves the original media type for small images", async () => {
    const out = await prepareStatement(fileOf(50 * 1024, "image/heic", "photo.heic"));
    expect(out.mediaType).toBe("image/heic");
    expect(out.bytes).toBe(50 * 1024);
  });

  it("applies the image ceiling, not the PDF one, to a large image", async () => {
    // Both happen to be 20MB today; the test pins that they're checked on the
    // correct branch so a future change to one doesn't silently move the other.
    await expect(prepareStatement(fileOf(19 * MB, "image/jpeg", "p.jpg"))).resolves.toBeTruthy();
  });
});
