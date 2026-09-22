import { describe, it, expect } from "vitest";
import { deriveDemoState, isDemoHeld, type DemoState } from "@/lib/demo";
import type { MeetingSnapshot } from "@/lib/adapters/hubspot";

// deriveDemoState — the demo gate a wrong "held" would falsely unlock a
// quote through. Table-driven, one case per rule in its doc comment, plus the
// scenarios the task explicitly calls out.

const NOW_MS = Date.parse("2026-09-21T12:00:00.000Z");
const NOW_ISO = new Date(NOW_MS).toISOString();

function meeting(over: Partial<MeetingSnapshot> = {}): MeetingSnapshot {
  return {
    id: "m-1",
    title: "Demo with Blessed Kitchen", // freeform/unverified on purpose — never matched on
    startTime: "2026-09-20T17:00:00.000Z",
    endTime: "2026-09-20T18:00:00.000Z",
    activityType: "Demo",
    outcome: "COMPLETED",
    ...over,
  };
}

function derive(over: Partial<{
  dealMeetings: MeetingSnapshot[];
  companyMeetings: MeetingSnapshot[];
  dealCreatedAt: string | null;
  previous: DemoState | null;
  nowMs: number;
}> = {}): DemoState {
  return deriveDemoState({
    dealMeetings: [],
    companyMeetings: [],
    dealCreatedAt: "2026-08-01T00:00:00.000Z",
    previous: null,
    nowMs: NOW_MS,
    ...over,
  });
}

describe("deriveDemoState — rule 1: previous.heldAt is terminal", () => {
  it("a manual heldAt survives a later CANCELED meeting — bumps checkedAt only", () => {
    const previous: DemoState = {
      bookedAt: null,
      heldAt: "2026-09-10T18:00:00.000Z",
      source: "manual",
      meetingId: null,
      meetingTitle: null,
      outcome: null,
      markedByUserId: "rep-1",
      checkedAt: "2026-09-15T00:00:00.000Z",
      lastSyncError: null,
      lastSyncErrorAt: null,
    };

    const result = derive({
      previous,
      dealMeetings: [meeting({ id: "m-cancel", outcome: "CANCELED", startTime: "2026-09-20T00:00:00.000Z" })],
    });

    expect(result).toEqual({ ...previous, checkedAt: NOW_ISO });
  });

  it("a HubSpot-detected heldAt is equally terminal — a later NO_SHOW doesn't revert it", () => {
    const previous: DemoState = {
      bookedAt: null,
      heldAt: "2026-09-05T18:00:00.000Z",
      source: "hubspot_meeting",
      meetingId: "m-old",
      meetingTitle: "Old demo",
      outcome: "COMPLETED",
      markedByUserId: null,
      checkedAt: "2026-09-06T00:00:00.000Z",
      lastSyncError: null,
      lastSyncErrorAt: null,
    };

    const result = derive({
      previous,
      dealMeetings: [meeting({ id: "m-noshow", outcome: "NO_SHOW", startTime: "2026-09-19T00:00:00.000Z" })],
    });

    expect(result.heldAt).toBe(previous.heldAt);
    expect(result.checkedAt).toBe(NOW_ISO);
  });
});

describe("deriveDemoState — rule 2: candidate set is deal-first, then company-fallback", () => {
  it("uses the deal's Demo meeting and ignores company meetings entirely when the deal has one", () => {
    const dealDemo = meeting({ id: "deal-demo", outcome: "COMPLETED", startTime: "2026-09-18T00:00:00.000Z" });
    // A company meeting that would otherwise win (earlier + also completed) —
    // must be ignored because the deal already has a candidate.
    const companyDemo = meeting({ id: "company-demo", outcome: "COMPLETED", startTime: "2026-08-15T00:00:00.000Z" });

    const result = derive({ dealMeetings: [dealDemo], companyMeetings: [companyDemo] });

    expect(result.meetingId).toBe("deal-demo");
  });

  it("falls back to company meetings only when the deal has NO Demo-typed meeting", () => {
    // The deal has a meeting, but it's not typed Demo — must not count as "the deal has a candidate".
    const dealMeetings = [meeting({ id: "deal-discovery", activityType: "Discovery Meeting" })];
    const companyDemo = meeting({ id: "company-demo", outcome: "COMPLETED", startTime: "2026-09-18T00:00:00.000Z" });

    const result = derive({ dealMeetings, companyMeetings: [companyDemo] });

    expect(result.meetingId).toBe("company-demo");
  });

  it("does not fall back when the deal has a Demo meeting, even if its outcome doesn't yield a held/booked state", () => {
    // Deal's only Demo meeting is CANCELED (never held); a company Demo exists
    // and is COMPLETED. The candidate SET is still deal-first — company must
    // not be consulted — so the result is the empty state, not a held one.
    const dealMeetings = [meeting({ id: "deal-demo-cancelled", activityType: "Demo", outcome: "CANCELED" })];
    const companyDemo = meeting({ id: "company-demo", outcome: "COMPLETED" });

    const result = derive({ dealMeetings, companyMeetings: [companyDemo] });

    expect(result.heldAt).toBeNull();
    expect(result.meetingId).toBeNull();
  });
});

describe("deriveDemoState — rule 3: date gate", () => {
  it("discards a candidate whose start time precedes the deal's createdate", () => {
    const staleDemo = meeting({ id: "stale", outcome: "COMPLETED", startTime: "2026-07-01T00:00:00.000Z" });

    const result = derive({ dealMeetings: [staleDemo], dealCreatedAt: "2026-08-01T00:00:00.000Z" });

    expect(result.heldAt).toBeNull();
    expect(result.meetingId).toBeNull();
  });

  it("keeps a candidate at or after the deal's createdate", () => {
    const demo = meeting({ id: "on-time", outcome: "COMPLETED", startTime: "2026-08-01T00:00:00.000Z" });

    const result = derive({ dealMeetings: [demo], dealCreatedAt: "2026-08-01T00:00:00.000Z" });

    expect(result.heldAt).toBe(demo.startTime);
  });

  it("skips the gate entirely when dealCreatedAt is null", () => {
    const staleDemo = meeting({ id: "stale", outcome: "COMPLETED", startTime: "2026-01-01T00:00:00.000Z" });

    const result = derive({ dealMeetings: [staleDemo], dealCreatedAt: null });

    expect(result.heldAt).toBe(staleDemo.startTime);
  });
});

describe("deriveDemoState — rule 4: held", () => {
  it("COMPLETED counts as held", () => {
    const result = derive({ dealMeetings: [meeting({ outcome: "COMPLETED" })] });
    expect(result.heldAt).not.toBeNull();
    expect(result.source).toBe("hubspot_meeting");
  });

  it("'COMPLETED - DM NOT PRESENT' does NOT count as held — the decision-maker wasn't there", () => {
    const result = derive({
      dealMeetings: [meeting({ outcome: "COMPLETED - DM NOT PRESENT", startTime: "2026-08-10T00:00:00.000Z" })],
    });
    expect(result.heldAt).toBeNull();
  });

  it("CANCELED never counts as held", () => {
    const result = derive({ dealMeetings: [meeting({ outcome: "CANCELED", startTime: "2026-08-10T00:00:00.000Z" })] });
    expect(result.heldAt).toBeNull();
  });

  it("NO_SHOW never counts as held", () => {
    const result = derive({ dealMeetings: [meeting({ outcome: "NO_SHOW", startTime: "2026-08-10T00:00:00.000Z" })] });
    expect(result.heldAt).toBeNull();
  });

  it("only Demo-typed meetings are ever candidates, even with outcome COMPLETED", () => {
    const result = derive({
      dealMeetings: [meeting({ activityType: "Discovery Meeting", outcome: "COMPLETED" })],
    });
    expect(result.heldAt).toBeNull();
  });
});

describe("deriveDemoState — rule 5: booked", () => {
  it("a future meeting yields bookedAt, not heldAt", () => {
    const future = meeting({ id: "future", outcome: "SCHEDULED", startTime: "2026-10-01T00:00:00.000Z" });

    const result = derive({ dealMeetings: [future] });

    expect(result.heldAt).toBeNull();
    expect(result.bookedAt).toBe(future.startTime);
    expect(result.meetingId).toBe("future");
  });

  it("a past, unheld meeting yields neither bookedAt nor heldAt", () => {
    const past = meeting({ id: "past", outcome: "RESCHEDULED", startTime: "2026-09-01T00:00:00.000Z" });

    const result = derive({ dealMeetings: [past] });

    expect(result.heldAt).toBeNull();
    expect(result.bookedAt).toBeNull();
  });

  it("picks the earliest of several future candidates", () => {
    const soon = meeting({ id: "soon", outcome: "SCHEDULED", startTime: "2026-09-25T00:00:00.000Z" });
    const later = meeting({ id: "later", outcome: "SCHEDULED", startTime: "2026-10-05T00:00:00.000Z" });

    const result = derive({ dealMeetings: [later, soon] });

    expect(result.bookedAt).toBe(soon.startTime);
  });

  it("no candidates at all yields the empty state, just with checkedAt stamped", () => {
    const result = derive({ dealMeetings: [], companyMeetings: [] });

    expect(result.heldAt).toBeNull();
    expect(result.bookedAt).toBeNull();
    expect(result.source).toBeNull();
    expect(result.checkedAt).toBe(NOW_ISO);
  });
});

describe("isDemoHeld", () => {
  it("is false for null", () => {
    expect(isDemoHeld(null)).toBe(false);
  });

  it("is false when heldAt is null", () => {
    expect(isDemoHeld({ ...derive() })).toBe(false);
  });

  it("is true once heldAt is set", () => {
    expect(isDemoHeld(derive({ dealMeetings: [meeting({ outcome: "COMPLETED" })] }))).toBe(true);
  });
});
