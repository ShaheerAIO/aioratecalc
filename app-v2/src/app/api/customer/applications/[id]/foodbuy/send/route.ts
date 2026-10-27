import { NextResponse } from "next/server";
import { getCustomerSession } from "@/lib/auth/getCustomerSession";
import { postgresStorage } from "@/lib/storage/postgresAdapter";
import { sendFoodbuyEnrollmentEmail } from "@/lib/adapters/email";
import { getFoodbuyRepEmail } from "@/lib/foodbuyPolicy";
import { buildFoodbuyFormFileName } from "@/lib/foodbuyForm";
import { checkFoodbuyPdf, sha256Hex, FOODBUY_SEND_MAX_BYTES } from "@/lib/foodbuyUpload";

// POST multipart { file } — the customer's exported Foodbuy PDF, emailed to the
// Foodbuy rep configured at /admin/users. Only on an explicit "Send to
// Foodbuy" press, never on export: an export may be a draft. A route handler
// for the same 1MB server-action body limit the sibling filing route avoids.
//
// Unlike that route this one is NOT silent — the customer pressed a button and
// needs to know whether it went. Reasons are coarse; transport errors stay in
// the server log.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCustomerSession();
  if (!session) return NextResponse.json({ sent: false, reason: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > FOODBUY_SEND_MAX_BYTES + 64 * 1024) {
    return NextResponse.json({ sent: false, reason: "too_large" }, { status: 413 });
  }

  // Only the application's own customer.
  const app = await postgresStorage.getApplicationForCustomer(session.userId, id);
  if (!app || !app.foodbuyIds || !app.business) {
    return NextResponse.json({ sent: false, reason: "not_found" }, { status: 404 });
  }

  let bytes: Uint8Array;
  try {
    const file = (await req.formData()).get("file");
    if (!(file instanceof Blob)) return NextResponse.json({ sent: false, reason: "bad_request" }, { status: 400 });
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return NextResponse.json({ sent: false, reason: "bad_request" }, { status: 400 });
  }
  const check = checkFoodbuyPdf(bytes);
  if (!check.ok) return NextResponse.json({ sent: false, reason: check.reason }, { status: check.reason === "too_large" ? 413 : 400 });
  if (bytes.length > FOODBUY_SEND_MAX_BYTES) return NextResponse.json({ sent: false, reason: "too_large" }, { status: 413 });

  const sha = sha256Hex(bytes);
  if (app.foodbuyIds.sentSha256 === sha) {
    return NextResponse.json({ sent: true, duplicate: true, sentAt: app.foodbuyIds.sentAt });
  }

  const to = await getFoodbuyRepEmail();
  if (!to) return NextResponse.json({ sent: false, reason: "not_configured" });

  const oc = app.ownerContact;
  const { sent } = await sendFoodbuyEnrollmentEmail({
    to,
    pdf: bytes,
    fileName: buildFoodbuyFormFileName(app.business),
    businessName: app.business.dba || app.business.legalName || "",
    contact: oc ? { name: `${oc.firstName} ${oc.lastName}`.trim(), email: oc.email, phone: oc.phone } : null,
  });
  if (!sent) {
    console.error(`Foodbuy enrollment email not sent (application ${id}): no transport delivered it`);
    return NextResponse.json({ sent: false, reason: "send_failed" });
  }

  const sentAt = new Date().toISOString();
  try {
    await postgresStorage.updateApplicationAsCustomer(session.userId, id, {
      foodbuyIds: { ...app.foodbuyIds, sentAt, sentSha256: sha },
    });
  } catch (err) {
    // The email is out; failing to record it only costs the duplicate guard.
    console.error(`Foodbuy send record failed (application ${id}):`, err instanceof Error ? err.message : err);
  }
  return NextResponse.json({ sent: true, sentAt });
}
