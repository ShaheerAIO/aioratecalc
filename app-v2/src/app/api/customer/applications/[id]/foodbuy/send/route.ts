import { NextResponse } from "next/server";
import { getCustomerSession } from "@/lib/auth/getCustomerSession";
import { postgresStorage } from "@/lib/storage/postgresAdapter";
import { sendFoodbuyEnrollmentEmail } from "@/lib/adapters/email";
import { attachFileToCompanyNote, uploadHubspotFile } from "@/lib/adapters/hubspot";
import { getFoodbuyRepEmail } from "@/lib/foodbuyPolicy";
import { buildFoodbuyFormFileName, parseFoodbuyForm, toSavedForm, validateFoodbuyForm } from "@/lib/foodbuyForm";
import { renderFoodbuyPdf } from "@/lib/foodbuyPdf";
import { alreadyFiled, foodbuyNoteBody, hubspotFoodbuyFileName, sha256Hex, FOODBUY_SEND_MAX_BYTES } from "@/lib/foodbuyUpload";
import type { FoodbuyIds } from "@/types/merchant";

// POST JSON FoodbuyFormData — renders the agreement HERE, from the answers,
// and emails it to the Foodbuy rep configured at /admin/users. The browser
// never supplies the PDF, so what Foodbuy receives is exactly what this
// renderer prints. Only on an explicit "Send to Foodbuy" press, after the
// customer has reviewed the preview.
//
// Not silent: the customer pressed a button and needs to know whether it
// went. Reasons are coarse; transport errors stay in the server log. Filing
// the sent PDF on the customer's HubSpot Company afterwards IS silent and
// best-effort: a filing failure is nothing the customer can act on.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCustomerSession();
  if (!session) return NextResponse.json({ sent: false, reason: "unauthorized" }, { status: 401 });
  const { id } = await params;

  // Only the application's own customer.
  const app = await postgresStorage.getApplicationForCustomer(session.userId, id);
  if (!app || !app.business || !app.ownerContact) {
    return NextResponse.json({ sent: false, reason: "not_found" }, { status: 404 });
  }

  const data = parseFoodbuyForm(await req.json().catch(() => null));
  if (!data) return NextResponse.json({ sent: false, reason: "bad_request" }, { status: 400 });
  const errors = validateFoodbuyForm(data);
  if (Object.keys(errors).length) return NextResponse.json({ sent: false, reason: "invalid", errors }, { status: 400 });

  let bytes: Uint8Array;
  try {
    bytes = await renderFoodbuyPdf(data, { accountNumber: app.aioTenant ? String(app.aioTenant.businessId) : "" });
  } catch (err) {
    console.error(`Foodbuy send render failed (application ${id}):`, err instanceof Error ? err.message : err);
    return NextResponse.json({ sent: false, reason: "invalid", errors: { signature: "Clear the signature and sign again" } }, { status: 400 });
  }
  if (bytes.length > FOODBUY_SEND_MAX_BYTES) return NextResponse.json({ sent: false, reason: "too_large" }, { status: 413 });

  // The renderer is deterministic, so a second press with unchanged answers
  // hashes the same and is a no-op.
  const sha = sha256Hex(bytes);
  let ids: FoodbuyIds = { ...app.foodbuyIds, generatedAt: app.foodbuyIds?.generatedAt ?? new Date().toISOString() };
  if (ids.sentSha256 === sha) {
    return NextResponse.json({ sent: true, duplicate: true, sentAt: ids.sentAt });
  }

  const to = await getFoodbuyRepEmail();
  if (!to) return NextResponse.json({ sent: false, reason: "not_configured" });

  const oc = app.ownerContact;
  const businessName = app.business.dba || app.business.legalName || "";
  const { sent } = await sendFoodbuyEnrollmentEmail({
    to,
    pdf: bytes,
    fileName: buildFoodbuyFormFileName(app.business),
    businessName,
    contact: { name: `${oc.firstName} ${oc.lastName}`.trim(), email: oc.email, phone: oc.phone },
  });
  if (!sent) {
    console.error(`Foodbuy enrollment email not sent (application ${id}): no transport delivered it`);
    return NextResponse.json({ sent: false, reason: "send_failed" });
  }

  const sentAt = new Date().toISOString();
  ids = { ...ids, sentAt, sentSha256: sha, form: toSavedForm(data) };
  // An EIN first typed here is kept as the business's EIN, so the next visit
  // pre-fills it. Only when none is held: a different one typed here doesn't
  // replace the confirmed EIN (the one on the HubSpot Company).
  const ein = app.business.ein?.trim() ? null : data.business.ein.trim();
  try {
    await postgresStorage.updateApplicationAsCustomer(session.userId, id, {
      foodbuyIds: ids,
      ...(ein ? { business: { ...app.business, ein } } : {}),
    });
  } catch (err) {
    // The email is out; failing to record it only costs the duplicate guard.
    console.error(`Foodbuy send record failed (application ${id}):`, err instanceof Error ? err.message : err);
  }

  await fileOnHubspot(session.userId, id, app.tenantLink?.hubspotCompanyId, businessName, bytes, sha, ids);
  return NextResponse.json({ sent: true, sentAt });
}

// The sent agreement, filed on the customer's HubSpot Company (Files API
// upload + a note carrying it as an attachment). Persists the file id the
// moment it exists, so a failed note retries without a second upload.
async function fileOnHubspot(
  userId: string, id: string, companyId: string | null | undefined, businessName: string,
  bytes: Uint8Array, sha: string, ids: FoodbuyIds,
) {
  if (!companyId || alreadyFiled(ids, sha)) return;
  try {
    let fileId = ids.hubspotFileSha256 === sha ? ids.hubspotFileId : undefined;
    if (!fileId) {
      fileId = await uploadHubspotFile({ fileName: hubspotFoodbuyFileName(businessName), bytes, contentType: "application/pdf" });
      ids = { ...ids, hubspotFileId: fileId, hubspotFileSha256: sha, hubspotNoteId: undefined };
      await postgresStorage.updateApplicationAsCustomer(userId, id, { foodbuyIds: ids });
    }
    const noteId = await attachFileToCompanyNote({ companyId, fileId, body: foodbuyNoteBody(businessName) });
    await postgresStorage.updateApplicationAsCustomer(userId, id, {
      foodbuyIds: { ...ids, hubspotNoteId: noteId, hubspotUploadedAt: new Date().toISOString() },
    });
  } catch (err) {
    console.error(`Foodbuy PDF HubSpot filing failed (application ${id}):`, err instanceof Error ? err.message : err);
  }
}
