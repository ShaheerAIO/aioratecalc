import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import { AccountsDashboard } from "@/components/dashboard/AccountsDashboard";
import { isBillingBypassEnabled } from "@/lib/debug/billingBypass";

// Single role-aware dashboard: reps see their own accounts; admins see every
// rep's accounts plus a Leads sub-view. There is no separate admin dashboard —
// /admin redirects here, and role scoping is enforced server-side in the actions.
export default async function DashboardPage() {
  const effective = await getEffectiveRole();
  return (
    <AccountsDashboard
      role={effective?.role === "admin" ? "admin" : "rep"}
      userId={effective?.userId ?? ""}
      debugBillingBypass={isBillingBypassEnabled()}
    />
  );
}
