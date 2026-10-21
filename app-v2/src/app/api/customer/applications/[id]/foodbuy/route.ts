import { NextResponse } from "next/server";
import { getCustomerSession } from "@/lib/auth/getCustomerSession";
import { postgresStorage } from "@/lib/storage/postgresAdapter";
import { attachFileToCompanyNote, uploadHubspotFile } from "@/lib/adapters/hubspot";
import {
  alreadyFiled, checkFoodbuyPdf, foodbuyNoteBody, hubspotFoodbuyFileName, sha256Hex, FOODBUY_PDF_MAX_BYTES,
} from "@/lib/foodbuyUpload";

// POST multipart { file } — the customer's exported Foodbuy PDF, filed on their
// HubSpot Company. A route handler rather than a Server Action because server
// actions cap the request body at 1MB and a rendered form is larger.
//
// BEST-EFFORT: the customer already has their download, so every failure here
// answers a neutral { filed:false } and the real reason goes to the server log,
// never to the browser (HubSpot errors name scopes, ids and portal internals).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCustomerSession();
  if (!session) return NextResponse.json({ filed: false, reason: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > FOODBUY_PDF_MAX_BYTES + 64 * 1024) {
    return NextResponse.json({ filed: false, reason: "too_large" }, { status: 413 });
  }

  // Only the application's own customer.
  const app = await postgresStorage.getApplicationForCustomer(session.userId, id);
  if (!app || !app.foodbuyIds) return NextResponse.json({ filed: false, reason: "not_found" }, { status: 404 });

  let bytes: Uint8Array;
  try {
    const file = (await req.formData()).get("file");
    if (!(file instanceof Blob)) return NextResponse.json({ filed: false, reason: "bad_request" }, { status: 400 });
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return NextResponse.json({ filed: false, reason: "bad_request" }, { status: 400 });
  }
  const check = checkFoodbuyPdf(bytes);
  if (!check.ok) return NextResponse.json({ filed: false, reason: check.reason }, { status: check.reason === "too_large" ? 413 : 400 });

  const companyId = app.tenantLink?.hubspotCompanyId;
  if (!companyId) return NextResponse.json({ filed: false, reason: "no_company" });

  const sha = sha256Hex(bytes);
  if (alreadyFiled(app.foodbuyIds, sha)) return NextResponse.json({ filed: true, duplicate: true });

  const businessName = app.business?.dba || app.business?.legalName || "";
  let ids = app.foodbuyIds;
  try {
    // Persist the file id the moment it exists, so a failed note retries
    // without a second upload of identical bytes.
    let fileId = ids.hubspotFileSha256 === sha ? ids.hubspotFileId : undefined;
    if (!fileId) {
      fileId = await uploadHubspotFile({
        fileName: hubspotFoodbuyFileName(businessName),
        bytes,
        contentType: "application/pdf",
      });
      ids = { ...ids, hubspotFileId: fileId, hubspotFileSha256: sha, hubspotNoteId: undefined };
      await postgresStorage.updateApplicationAsCustomer(session.userId, id, { foodbuyIds: ids });
    }
    const noteId = await attachFileToCompanyNote({ companyId, fileId, body: foodbuyNoteBody(businessName) });
    await postgresStorage.updateApplicationAsCustomer(session.userId, id, {
      foodbuyIds: { ...ids, hubspotNoteId: noteId, hubspotUploadedAt: new Date().toISOString() },
    });
    return NextResponse.json({ filed: true });
  } catch (err) {
    console.error(`Foodbuy PDF HubSpot filing failed (application ${id}):`, err instanceof Error ? err.message : err);
    return NextResponse.json({ filed: false, reason: "upload_failed" });
  }
}
