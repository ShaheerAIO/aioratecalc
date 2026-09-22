// The demo gate: whether a merchant's demo has happened, derived from
// HubSpot meetings and/or a rep's manual mark. Pure and network-free, the way
// leadQuote.ts and customerLink.ts are — nothing here calls HubSpot; callers
// (a later task) fetch MeetingSnapshot[] via the adapter and pass them in.
//
// This module only builds the derivation. The `demo` column now exists on
// MerchantApplication (see DemoState below) and is wired through the storage
// layer, but Server Actions and onboardingModules.ts wiring are still a
// later task.

import type { MeetingSnapshot } from "@/lib/adapters/hubspot";
import type { DemoSource, DemoState } from "@/types/merchant";

// DemoState/DemoSource now live on the canonical domain type
// (src/types/merchant.ts), since MerchantApplication.demo needs the shape —
// re-exported here so nothing importing them from this module breaks.
export type { DemoSource, DemoState };

const EMPTY_DEMO_STATE: DemoState = {
  bookedAt: null, heldAt: null, source: null,
  meetingId: null, meetingTitle: null, outcome: null,
  markedByUserId: null, checkedAt: null,
  lastSyncError: null, lastSyncErrorAt: null,
};

/** Only "Demo"-typed meetings are ever candidates. Portal titles are freeform
 * and unverified ("Demo with Blessed Kitchen", "Canceled: AIO.App Demo Siri
 * Restaurant") — matching on them would be guessing. `hs_activity_type` is a
 * closed enum a rep picks deliberately; title is stored on DemoState only for
 * a human to eyeball, never to classify by. */
function isDemoMeeting(m: MeetingSnapshot): boolean {
  return m.activityType === "Demo";
}

/** ISO-8601 UTC timestamps compare correctly as plain strings (same format
 * this codebase already relies on for `hs_lastmodifieddate` filters) — no
 * Date parsing needed for ordering or the date-gate comparison below. */
function isBefore(a: string, b: string): boolean {
  return a < b;
}

/**
 * Discard any candidate whose start time precedes the deal's `createdate`.
 * A merchant who comes back for a second opportunity has an old demo sitting
 * on their company record, and without this gate a stale demo would silently
 * unlock the new deal's quote. Skipped when `dealCreatedAt` is null (a deal
 * this build can't date, or a caller that hasn't wired it up yet) — nothing
 * to gate against, so nothing is discarded. A candidate with no `startTime`
 * of its own also survives the gate: there's nothing to compare, and it's
 * still eligible to be picked up (or not) by the held/booked rules below.
 */
function applyDateGate(candidates: MeetingSnapshot[], dealCreatedAt: string | null): MeetingSnapshot[] {
  if (!dealCreatedAt) return candidates;
  return candidates.filter(m => !m.startTime || !isBefore(m.startTime, dealCreatedAt));
}

/** The earliest meeting by `startTime` among a non-empty list. Meetings with
 * no `startTime` sort last (a meeting we can't date is the least useful thing
 * to report as "the" demo). */
function earliestBy(meetings: MeetingSnapshot[]): MeetingSnapshot {
  return meetings.reduce((best, m) => {
    if (!m.startTime) return best;
    if (!best.startTime) return m;
    return isBefore(m.startTime, best.startTime) ? m : best;
  });
}

/**
 * Derive the demo state from a fresh read of HubSpot meetings (already
 * fetched by the caller via `listMeetingsForDeal`/`listDemoMeetingsForCompany`)
 * plus whatever was previously stored. Rules, in this exact order:
 *
 * 1. `previous.heldAt` is terminal — bump `checkedAt` and return otherwise
 *    unchanged. This one rule is what makes "a rep's manual mark wins and is
 *    never overwritten by a later poll" true for every source, with no
 *    precedence table anywhere: a `NO_SHOW` arriving after a human marked a
 *    demo held does NOT revert it — a person beat the CRM, and that's the
 *    right tiebreak.
 * 2. Candidate set is deal-first, then company-fallback: if `dealMeetings`
 *    contains any `Demo`-typed meeting, that is the candidate set — stop.
 *    Only if it contains none does `companyMeetings` get used. Deal-only
 *    would miss ~30% of detectable demos (measured live, 2026-09-21); the
 *    company edge alone would risk attributing another deal's demo to this
 *    one, which is why deal takes priority.
 * 3. Date gate, applied to whichever set won: see `applyDateGate`.
 * 4. Held if any surviving candidate has `outcome === "COMPLETED"`.
 *    `"COMPLETED - DM NOT PRESENT"` is deliberately NOT held — the
 *    decision-maker wasn't there, so nothing was demoed to the person who
 *    signs. Never held for `CANCELED`/`NO_SHOW`/anything else.
 * 5. Otherwise `bookedAt` is the earliest surviving candidate whose start
 *    time is still in the future.
 */
export function deriveDemoState(input: {
  dealMeetings: MeetingSnapshot[];
  companyMeetings: MeetingSnapshot[];
  dealCreatedAt: string | null;
  previous: DemoState | null;
  nowMs: number;
}): DemoState {
  const { dealMeetings, companyMeetings, dealCreatedAt, previous, nowMs } = input;
  const nowIso = new Date(nowMs).toISOString();

  // Rule 1.
  if (previous?.heldAt) {
    return { ...previous, checkedAt: nowIso };
  }

  // Rule 2.
  const dealDemos = dealMeetings.filter(isDemoMeeting);
  const candidateSet = dealDemos.length > 0 ? dealDemos : companyMeetings.filter(isDemoMeeting);

  // Rule 3.
  const candidates = applyDateGate(candidateSet, dealCreatedAt);

  // Rule 4.
  const completed = candidates.filter(m => m.outcome === "COMPLETED");
  if (completed.length > 0) {
    const held = earliestBy(completed);
    return {
      bookedAt: null,
      heldAt: held.startTime,
      source: "hubspot_meeting",
      meetingId: held.id,
      meetingTitle: held.title,
      outcome: held.outcome,
      markedByUserId: null,
      checkedAt: nowIso,
      lastSyncError: null,
      lastSyncErrorAt: null,
    };
  }

  // Rule 5.
  const future = candidates.filter(m => !!m.startTime && isBefore(nowIso, m.startTime));
  if (future.length > 0) {
    const next = earliestBy(future);
    return {
      bookedAt: next.startTime,
      heldAt: null,
      source: "hubspot_meeting",
      meetingId: next.id,
      meetingTitle: next.title,
      outcome: next.outcome,
      markedByUserId: null,
      checkedAt: nowIso,
      lastSyncError: null,
      lastSyncErrorAt: null,
    };
  }

  return { ...EMPTY_DEMO_STATE, checkedAt: nowIso };
}

/** Whether the customer is allowed to see their quote — the gate this whole
 * module exists to compute. Null-safe so callers don't need their own guard
 * for a row that has never been synced. */
export function isDemoHeld(demo: DemoState | null): boolean {
  return !!demo?.heldAt;
}
