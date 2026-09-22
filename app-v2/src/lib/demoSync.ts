// The demo refresh's orchestration: when to re-read HubSpot, when to skip,
// and what to do with a failure — shared by both hosts that can view an
// application (the authenticated customer dashboard and the public
// /lead/[token] checklist). demo.ts stays pure/network-free by design (see its
// header); this is where that derivation actually gets wired to HubSpot.
//
// Extracted out of lib/actions/customer.ts's old `refreshDemoStatus` rather
// than duplicated for the token host: the TTL, the terminal-heldAt skip, the
// always-write-on-success rule, and the swallow-failures-into-lastSyncError
// rule are all settled and tested (demoSync.test.ts, via
// getMyApplicationWithSyncAction) and must not drift between the two hosts.
// Only the PERSISTENCE differs — a customer-session-scoped
// updateApplicationAsCustomer call for the authenticated host, a plain
// token-scoped row update for the public one — so persistence (and the
// HubSpot reads, so this stays unit-testable without mocking the adapter
// module) are injected rather than imported.
import { deriveDemoState } from "@/lib/demo";
import type { MeetingSnapshot, HubspotDeal } from "@/lib/adapters/hubspot";
import type { DemoState, MerchantApplication } from "@/types/merchant";

const EMPTY_DEMO_STATE: DemoState = {
  bookedAt: null, heldAt: null, source: null,
  meetingId: null, meetingTitle: null, outcome: null,
  markedByUserId: null, checkedAt: null,
  lastSyncError: null, lastSyncErrorAt: null,
};

// 5 minutes, not billing's 60 seconds: a demo's scheduled/held date doesn't
// move minute to minute the way a payment the customer is actively watching
// for does, so there's no reason to hammer HubSpot on every page view.
const DEMO_SYNC_TTL_MS = 5 * 60_000;

export type DemoRefreshDeps = {
  getDeal: (dealId: string) => Promise<HubspotDeal | null>;
  listDealMeetings: (dealId: string) => Promise<MeetingSnapshot[]>;
  listCompanyMeetings: (companyId: string) => Promise<MeetingSnapshot[]>;
  // Persists the derived/errored DemoState and returns the resulting
  // application. The one thing that differs between hosts.
  persist: (demo: DemoState) => Promise<MerchantApplication>;
};

/**
 * Refreshes the cached demo-status snapshot on an already-loaded application
 * and returns the latest one (the same one back, if nothing needed writing).
 *
 * Terminal once `demo.heldAt` is set — deriveDemoState's rule 1 means a rep's
 * manual mark (or an already-observed HubSpot COMPLETED meeting) is never
 * revisited by a later poll, so a stale/CANCELED meeting arriving afterward
 * can't un-hold it. That terminal check has to live here too (not just inside
 * deriveDemoState) so a held row skips the HubSpot reads entirely, forever.
 *
 * Failures are swallowed — a HubSpot outage must not break the application
 * (or checklist) page.
 */
export async function refreshDemoStatus(
  app: MerchantApplication,
  deps: DemoRefreshDeps,
): Promise<MerchantApplication> {
  if (!app.hubspotDealId || app.demo?.heldAt) return app;

  const checkedAtMs = app.demo?.checkedAt ? Date.parse(app.demo.checkedAt) : NaN;
  if (!Number.isNaN(checkedAtMs) && Date.now() - checkedAtMs < DEMO_SYNC_TTL_MS) return app;

  try {
    const [deal, dealMeetings] = await Promise.all([
      deps.getDeal(app.hubspotDealId),
      deps.listDealMeetings(app.hubspotDealId),
    ]);
    const companyId = app.tenantLink?.hubspotCompanyId ?? null;
    const companyMeetings = companyId ? await deps.listCompanyMeetings(companyId) : [];

    const demo = deriveDemoState({
      dealMeetings,
      companyMeetings,
      dealCreatedAt: deal?.createdAt ?? null,
      previous: app.demo,
      nowMs: Date.now(),
    });

    // Always written, even when nothing changed — checkedAt IS the TTL, so
    // skipping the write would mean the TTL never engages and every page view
    // re-reads HubSpot.
    return await deps.persist(demo);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("HubSpot demo status refresh failed:", message);
    try {
      return await deps.persist({
        ...(app.demo ?? EMPTY_DEMO_STATE),
        lastSyncError: message,
        lastSyncErrorAt: new Date().toISOString(),
      });
    } catch (writeErr) {
      console.error("Failed to persist demo sync error:", writeErr instanceof Error ? writeErr.message : writeErr);
      return app;
    }
  }
}
