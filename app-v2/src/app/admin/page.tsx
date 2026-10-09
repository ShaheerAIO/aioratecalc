import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import { AdminDashboard } from "@/components/dashboard/AdminDashboard";
import { isBillingBypassEnabled } from "@/lib/debug/billingBypass";

// /admin is the single admin surface: org-wide metrics on top, then one of
// three views chosen by ?view= — the per-rep breakdown (default), all accounts,
// or leads. The latter two embed AccountsDashboard (role="admin"), the same
// component /rep renders, so there is only ever one accounts table in the app.
// Route access is enforced by middleware.ts (admin-only), like every /admin/*.
export default async function AdminPage() {
  const effective = await getEffectiveRole();
  return <AdminDashboard userId={effective?.userId ?? ""} debugBillingBypass={isBillingBypassEnabled()} />;
}
