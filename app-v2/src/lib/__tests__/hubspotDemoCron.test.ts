import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DemoState } from "@/types/merchant";

// /api/cron/hubspot-demo-sync, exercised as a route handler. Same hand-rolled
// chainable db stub as hubspotBillingCron.test.ts — the real `and`/`isNotNull`/
// `notInArray`/`sql` builders still run over the real schema columns, so a
// rename of hubspot_deal_id/stage/demo would break the build rather than pass
// silently. deriveDemoState is mocked: its own rules are exhaustively covered
// by demo.test.ts, so this suite only exercises the cron's plumbing around it
// (which rows are candidates, the row cap, and what gets written).

const getDealById = vi.fn();
const listMeetingsForDeal = vi.fn();
const listDemoMeetingsForCompany = vi.fn();
const deriveDemoState = vi.fn();

vi.mock("@/lib/adapters/hubspot", () => ({ getDealById, listMeetingsForDeal, listDemoMeetingsForCompany }));
vi.mock("@/lib/demo", () => ({ deriveDemoState }));

type Row = {
  id: string;
  hubspotDealId: string | null;
  tenantLink: { hubspotCompanyId: string } | null;
  demo: DemoState | null;
};

let selectRows: Row[] = [];
let limitArg: number | undefined;
const updates: Array<Record<string, unknown>> = [];
let updateThrows = false;

const db = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async (n: number) => {
          limitArg = n;
          return selectRows;
        },
      }),
    }),
  }),
  update: () => ({
    set: (patch: Record<string, unknown>) => ({
      where: async () => {
        if (updateThrows) throw new Error("db down");
        updates.push(patch);
      },
    }),
  }),
};

vi.mock("@/lib/db/client", () => ({ db }));

const { GET } = await import("@/app/api/cron/hubspot-demo-sync/route");

const SECRET = "cron-secret";

const EMPTY_DEMO: DemoState = {
  bookedAt: null, heldAt: null, source: null,
  meetingId: null, meetingTitle: null, outcome: null,
  markedByUserId: null, checkedAt: null,
  lastSyncError: null, lastSyncErrorAt: null,
};

const demoState = (overrides: Partial<DemoState> = {}): DemoState => ({ ...EMPTY_DEMO, ...overrides });

const row = (overrides: Partial<Row> = {}): Row => ({
  id: "app-1",
  hubspotDealId: "deal-1",
  tenantLink: null,
  demo: null,
  ...overrides,
});

const get = (authorization: string | null = `Bearer ${SECRET}`) =>
  GET({ headers: { get: () => authorization } } as never);

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const m of [getDealById, listMeetingsForDeal, listDemoMeetingsForCompany, deriveDemoState]) m.mockReset();
  updates.length = 0;
  selectRows = [];
  updateThrows = false;
  limitArg = undefined;
  process.env.CRON_SECRET = SECRET;
  getDealById.mockResolvedValue({ id: "deal-1", createdAt: "2026-08-01T00:00:00.000Z" });
  listMeetingsForDeal.mockResolvedValue([]);
  listDemoMeetingsForCompany.mockResolvedValue([]);
  deriveDemoState.mockReturnValue(demoState());
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  process.env.CRON_SECRET = SECRET;
});

describe("the demo cron's auth", () => {
  it("401s when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const res = await get();
    expect(res.status).toBe(401);
    expect(getDealById).not.toHaveBeenCalled();
  });

  it("401s on a wrong bearer token", async () => {
    const res = await get("Bearer nope");
    expect(res.status).toBe(401);
  });
});

describe("the demo cron's candidate query and row cap", () => {
  it("caps the query at 200 rows", async () => {
    selectRows = [];
    await get();
    expect(limitArg).toBe(200);
  });

  it("returns an empty summary without touching HubSpot when there are no candidates", async () => {
    selectRows = [];
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidates: 0, updated: 0, failed: [] });
    expect(getDealById).not.toHaveBeenCalled();
  });

  it("reads the deal and its meetings for each candidate", async () => {
    selectRows = [row({ id: "app-1", hubspotDealId: "deal-1" })];
    await get();
    expect(getDealById).toHaveBeenCalledWith("deal-1");
    expect(listMeetingsForDeal).toHaveBeenCalledWith("deal-1");
    // No tenant link on this row — the company fallback must not be read.
    expect(listDemoMeetingsForCompany).not.toHaveBeenCalled();
  });

  it("falls back to the company's meetings when the row carries a tenant link", async () => {
    selectRows = [row({ tenantLink: { hubspotCompanyId: "co-1" } })];
    await get();
    expect(listDemoMeetingsForCompany).toHaveBeenCalledWith("co-1");
  });
});

describe("the demo cron writes only what changed", () => {
  it("leaves an unchanged row completely alone", async () => {
    const stable = demoState({ bookedAt: "2026-09-25T00:00:00.000Z" });
    selectRows = [row({ demo: stable })];
    deriveDemoState.mockReturnValue({ ...stable, checkedAt: "2026-09-21T00:00:00.000Z" }); // checkedAt always differs
    const res = await get();
    const body = await res.json();
    expect(body.updated).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("writes a row whose demo state actually moved", async () => {
    selectRows = [row({ demo: demoState({ bookedAt: null }) })];
    deriveDemoState.mockReturnValue(demoState({ bookedAt: "2026-09-25T00:00:00.000Z" }));
    const res = await get();
    const body = await res.json();
    expect(body.updated).toBe(1);
    expect(updates).toHaveLength(1);
    expect((updates[0].demo as DemoState).bookedAt).toBe("2026-09-25T00:00:00.000Z");
  });

  it("writes a row that newly comes back held", async () => {
    selectRows = [row({ demo: demoState({ bookedAt: "2026-09-25T00:00:00.000Z" }) })];
    deriveDemoState.mockReturnValue(demoState({ heldAt: "2026-09-20T15:00:00.000Z", source: "hubspot_meeting" }));
    const res = await get();
    expect((await res.json()).updated).toBe(1);
    expect((updates[0].demo as DemoState).heldAt).toBe("2026-09-20T15:00:00.000Z");
  });
});

describe("the demo cron on a partial failure", () => {
  it("non-2xxs, names the application, and persists its error without throwing", async () => {
    selectRows = [row({ id: "app-1" }), row({ id: "app-2", hubspotDealId: "deal-2" })];
    getDealById.mockImplementation(async (id: string) => {
      if (id === "deal-1") throw new Error("HubSpot deal deal-1 fetch failed (500)");
      return { id, createdAt: null };
    });

    const res = await get();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.failed).toEqual([{ applicationId: "app-1", error: "HubSpot deal deal-1 fetch failed (500)" }]);

    const errorWrite = updates.find(u => (u.demo as DemoState).lastSyncError !== null)!;
    expect((errorWrite.demo as DemoState).lastSyncError).toContain("500");
    expect((errorWrite.demo as DemoState).lastSyncErrorAt).toBeTruthy();
  });

  it("still processes the remaining rows after one fails", async () => {
    selectRows = [row({ id: "app-1" }), row({ id: "app-2", hubspotDealId: "deal-2" })];
    getDealById.mockImplementation(async (id: string) => {
      if (id === "deal-1") throw new Error("boom");
      return { id, createdAt: null };
    });
    deriveDemoState.mockReturnValue(demoState({ bookedAt: "2026-09-25T00:00:00.000Z" }));

    const res = await get();
    const body = await res.json();
    expect(body.failed).toHaveLength(1);
    expect(body.updated).toBe(1);
  });

  it("still reports the failure when the error write also fails", async () => {
    selectRows = [row({ id: "app-1" })];
    getDealById.mockRejectedValue(new Error("503"));
    updateThrows = true;

    const res = await get();
    expect(res.status).toBe(500);
    expect((await res.json()).failed).toHaveLength(1);
  });
});
