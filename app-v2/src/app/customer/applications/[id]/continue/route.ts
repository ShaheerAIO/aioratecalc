import { NextRequest, NextResponse } from "next/server";
import { getCustomerSession } from "@/lib/auth/getCustomerSession";
import { postgresStorage } from "@/lib/storage/postgresAdapter";
import {
  aioDashboardEnabled,
  createAioAdyenOnboardingLink,
  adyenEnvironmentFromOnboardingUrl,
} from "@/lib/adapters/aioDashboard";

// "Continue Verification" target. Adyen hosted-onboarding links are single-use
// and expire in minutes, so we never re-serve the stored one (that lands the
// merchant on Adyen's /uo/error/startup-failed page). Every click mints a
// fresh link and redirects to it.
//
// The link now comes from AIO's own API rather than from Adyen directly:
// EasyOB no longer creates Adyen objects, because doing so produced accounts
// that were misnamed and unlinked from the AIO tenant graph. Same URL, same
// per-click behaviour, different source.
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

  const businessId = app.aioTenant?.businessId;
  const locationId = app.aioTenant?.locationId;
  if (!businessId || !locationId) {
    // Provisioning hasn't happened yet (it waits for billing to be paid).
    // Deliberately NOT /edit: their details are already in and there is
    // nothing for them to fix — the checklist explains the wait.
    return NextResponse.redirect(new URL(`/customer/applications/${id}?notice=provisioning`, req.url));
  }

  if (!aioDashboardEnabled()) {
    return NextResponse.redirect(new URL(`/customer/applications/${id}?error=onboarding_link`, req.url));
  }

  try {
    const link = await createAioAdyenOnboardingLink({ businessId, locationId });
    // Keep the stored URL current for admin visibility; the click always
    // regenerates regardless of what's persisted. Also backfills the legal
    // entity id, which is only obtainable by parsing it out of this URL.
    await postgresStorage.updateApplicationAsCustomer(session.userId, id, {
      adyenOnboardingUrl: link.url,
      adyenIds: {
        ...(app.adyenIds ?? {}),
        legalEntityId: link.legalEntityId ?? app.adyenIds?.legalEntityId ?? null,
        tenantNumber: app.adyenIds?.tenantNumber ?? String(businessId),
        environment: adyenEnvironmentFromOnboardingUrl(link.url),
      } as typeof app.adyenIds,
    });
    return NextResponse.redirect(link.url);
  } catch (err) {
    console.error("Failed to mint AIO Adyen onboarding link:", err instanceof Error ? err.message : err);
    return NextResponse.redirect(new URL(`/customer/applications/${id}?error=onboarding_link`, req.url));
  }
}
