import { NextResponse } from "next/server";
import { getCustomerSession } from "@/lib/auth/getCustomerSession";
import { postgresStorage } from "@/lib/storage/postgresAdapter";
import { parseFoodbuyForm, validateFoodbuyForm } from "@/lib/foodbuyForm";
import { renderFoodbuyPdf } from "@/lib/foodbuyPdf";

// POST JSON FoodbuyFormData → the finished agreement as application/pdf, for
// the customer to review (and download) before sending it. Nothing is sent or
// filed from here. A route handler rather than a Server Action because a
// Server Action can't answer with a binary body.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCustomerSession();
  if (!session) return NextResponse.json({ reason: "unauthorized" }, { status: 401 });
  const { id } = await params;

  // Only the application's own customer.
  const app = await postgresStorage.getApplicationForCustomer(session.userId, id);
  if (!app || !app.business || !app.ownerContact) return NextResponse.json({ reason: "not_found" }, { status: 404 });

  const data = parseFoodbuyForm(await req.json().catch(() => null));
  if (!data) return NextResponse.json({ reason: "bad_request" }, { status: 400 });
  const errors = validateFoodbuyForm(data);
  if (Object.keys(errors).length) return NextResponse.json({ reason: "invalid", errors }, { status: 400 });

  let pdf: Uint8Array;
  try {
    pdf = await renderFoodbuyPdf(data, { accountNumber: app.aioTenant ? String(app.aioTenant.businessId) : "" });
  } catch (err) {
    // Only a signature that isn't a real PNG gets this far.
    console.error(`Foodbuy preview render failed (application ${id}):`, err instanceof Error ? err.message : err);
    return NextResponse.json({ reason: "invalid", errors: { signature: "Clear the signature and sign again" } }, { status: 400 });
  }

  // The checklist counts Foodbuy as started from the first finished preview.
  if (!app.foodbuyIds?.generatedAt) {
    try {
      await postgresStorage.updateApplicationAsCustomer(session.userId, id, {
        foodbuyIds: { ...app.foodbuyIds, generatedAt: new Date().toISOString() },
      });
    } catch (err) {
      console.error(`Foodbuy generatedAt record failed (application ${id}):`, err instanceof Error ? err.message : err);
    }
  }

  return new NextResponse(Buffer.from(pdf), {
    headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store" },
  });
}
