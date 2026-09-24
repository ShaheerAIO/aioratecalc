import { NextRequest, NextResponse } from "next/server";
import { getCustomerSession } from "@/lib/auth/getCustomerSession";
import { postgresStorage } from "@/lib/storage/postgresAdapter";
import { createCheckOnboardLink } from "@/lib/adapters/check";

// "Continue Payroll Setup" target. Check onboard links are one-time use and
// expire after 24h, so the stored one is never re-served — every click mints a
// fresh link for the app's existing Check company and redirects to it. Mirrors
// the Adyen continue route one directory up.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getCustomerSession();
  if (!session) {
    return NextResponse.redirect(new URL("/customer/login", req.url));
  }

  const app = await postgresStorage.getApplicationForCustomer(session.userId, id);
  if (!app) {
    return NextResponse.redirect(new URL("/customer", req.url));
  }

  if (!app.checkIds?.companyId) {
    // Never opted in — send them to the payroll signup form.
    return NextResponse.redirect(new URL(`/customer/applications/${id}/payroll`, req.url));
  }

  try {
    const url = await createCheckOnboardLink(app.checkIds.companyId, app.checkIds.signer);
    return NextResponse.redirect(url);
  } catch (err) {
    console.error("Failed to generate Check onboard link:", err instanceof Error ? err.message : err);
    return NextResponse.redirect(new URL(`/customer/applications/${id}?error=payroll_link`, req.url));
  }
}
