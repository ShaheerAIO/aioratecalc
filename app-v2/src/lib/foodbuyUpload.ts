// Pure half of filing the customer's exported Foodbuy PDF on their HubSpot
// Company (the I/O half is the route at
// api/customer/applications/[id]/foodbuy). Kept free of server-only imports so
// the rules are testable on their own.
import { createHash } from "crypto";

/** Vercel's function body limit is 4.5MB; stay under it. */
export const FOODBUY_PDF_MAX_BYTES = 4 * 1024 * 1024;

export type PdfCheck = { ok: true } | { ok: false; reason: "empty" | "too_large" | "not_pdf" };

/** Size and magic-byte check. The client's content-type is never trusted. */
export function checkFoodbuyPdf(bytes: Uint8Array): PdfCheck {
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  if (bytes.length > FOODBUY_PDF_MAX_BYTES) return { ok: false, reason: "too_large" };
  const magic = String.fromCharCode(...bytes.subarray(0, 5));
  if (magic !== "%PDF-") return { ok: false, reason: "not_pdf" };
  return { ok: true };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Name the file is stored under in HubSpot. Derived from the business, never
 * from the client's filename (a path or odd characters from a browser must not
 * reach the portal), plus a timestamp so two exports on one day can't collide.
 */
export function hubspotFoodbuyFileName(businessName: string, now: Date = new Date()): string {
  const safe = (businessName || "Business").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "Business";
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `AIO-Foodbuy-Enrollment-${safe}-${stamp}.pdf`;
}

/** What the note on the company reads. Names no internals. */
export function foodbuyNoteBody(businessName: string): string {
  return `Foodbuy enrollment form exported by the customer (${businessName || "business"}). Attached as a PDF; the customer signs it and sends it to Foodbuy themselves.`;
}

/** Same content already filed: skip, a re-download must not stack duplicates. */
export function alreadyFiled(existing: { hubspotFileSha256?: string; hubspotNoteId?: string } | null | undefined, sha: string): boolean {
  return !!existing?.hubspotNoteId && existing.hubspotFileSha256 === sha;
}
