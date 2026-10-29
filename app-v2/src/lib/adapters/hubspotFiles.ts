// Filing a document on a HubSpot DEAL (2026-10-29): the accepted quote's
// summary PDF. The company-side twin (the Foodbuy form) lives in hubspot.ts as
// `uploadHubspotFile` + `attachFileToCompanyNote`; this file reuses that
// upload and adds the deal-side note, kept out of hubspot.ts on purpose.
//
// A file shows on a record's attachments only when a NOTE carries it in
// `hs_attachment_ids` and is associated to that record — a bare Files API
// upload is an orphan in the file manager. So: upload, then note.
//
// TOKENS AND SCOPES. The upload goes through `uploadHubspotFile`, i.e. the
// general CRM app (`HUBSPOT_PRIVATE_APP_TOKEN`), which needs the `files`
// scope — NOT granted on either app as of 2026-10-21, so until someone adds it
// the upload 403s, the caller logs it, and nothing is filed. The note uses the
// BILLING app (`HUBSPOT_BILLING_PRIVATE_APP_TOKEN`), because that is the app
// with the deals scope (the general one has none) and the one that carried
// `createDealNote` live on 2026-10-13; it needs `crm.objects.notes.write`.

import { uploadHubspotFile } from "@/lib/adapters/hubspot";

const BASE = "https://api.hubapi.com";

// HUBSPOT_DEFINED note → deal, the same id the old `createDealNote` used.
export const NOTE_TO_DEAL_ASSOCIATION_TYPE_ID = 214;
export const QUOTE_SUMMARY_FOLDER = "/EasyOB/Quote Summaries";

function billingToken(): string {
  const token = process.env.HUBSPOT_BILLING_PRIVATE_APP_TOKEN;
  if (!token) throw new Error("HUBSPOT_BILLING_PRIVATE_APP_TOKEN is not set");
  return token;
}

/** Creates a note on the deal carrying `fileId` as its attachment. Returns the note id. */
export async function attachFileToDealNote(input: { dealId: string; fileId: string; body: string }): Promise<string> {
  const res = await fetch(`${BASE}/crm/v3/objects/notes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${billingToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: {
        hs_timestamp: new Date().toISOString(),
        hs_note_body: input.body,
        hs_attachment_ids: input.fileId,
      },
      associations: [{
        to: { id: input.dealId },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO_DEAL_ASSOCIATION_TYPE_ID }],
      }],
    }),
  });
  if (!res.ok) {
    const hint = res.status === 403 ? " (the billing private app is missing a scope)" : "";
    throw new Error(`HubSpot attachment note failed (deal ${input.dealId}): ${res.status}${hint} ${await res.text()}`.trim());
  }
  const json = (await res.json()) as { id?: string };
  if (!json.id) throw new Error("HubSpot note create returned no id");
  return String(json.id);
}

/** Uploads the PDF privately and attaches it to the deal. Throws on any failure. */
export async function fileDealPdf(input: {
  dealId: string;
  fileName: string;
  bytes: Uint8Array;
  noteBody: string;
}): Promise<{ fileId: string; noteId: string }> {
  const fileId = await uploadHubspotFile({
    fileName: input.fileName,
    bytes: input.bytes,
    contentType: "application/pdf",
    folderPath: QUOTE_SUMMARY_FOLDER,
  });
  const noteId = await attachFileToDealNote({ dealId: input.dealId, fileId, body: input.noteBody });
  return { fileId, noteId };
}
