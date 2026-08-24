import { describe, it, expect, vi, beforeEach } from "vitest";
import type { QuoteType } from "@/types/merchant";

// Mirrors the pillow margin policy tests in spirit (no equivalent file exists
// yet for pricing.ts, so this follows leadAccept.test.ts / customerOnboardGate.test.ts's
// mocking style instead): stub the DB and the HubSpot adapter, exercise the
// real action code. What matters here is the no-row default, the id
// validation against the live template list, and graceful degradation when
// HubSpot is unreachable — none of which should ever cost a merchant a
// blocked publish.

const getEffectiveRole = vi.fn();
const listQuoteTemplates = vi.fn();

type Row = {
  id: string;
  fullPosTemplateId: string;
  foodTruckTemplateId: string;
  marketingOnlyTemplateId: string;
  updatedByUserId: string | null;
  updatedAt: Date;
  isActive: boolean;
};

let row: Row | null = null;
const inserted: Array<Record<string, unknown>> = [];
const updated: Array<{ id: string; values: Record<string, unknown> }> = [];

const db = {
  select: () => ({
    from: () => ({
      where: () => ({ limit: async () => (row ? [row] : []) }),
    }),
  }),
  insert: () => ({
    values: async (values: Record<string, unknown>) => {
      inserted.push(values);
    },
  }),
  update: () => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        updated.push({ id: row!.id, values });
        row = { ...row!, ...values } as Row;
      },
    }),
  }),
};

vi.mock("@/lib/db/client", () => ({ db }));
vi.mock("@/lib/auth/getEffectiveRole", () => ({ getEffectiveRole }));
vi.mock("@/lib/adapters/hubspot", () => ({ listQuoteTemplates }));

const {
  getQuoteTemplatePolicy,
  updateQuoteTemplatePolicyAction,
  listQuoteTemplatesAction,
} = await import("@/lib/actions/quoteTemplates");

const TEMPLATES = [
  { id: "817263673055", name: "AIO Quote v3", active: true, templateType: "QUOTE" },
  { id: "787244469949", name: "Hardware Addition Quote", active: true, templateType: "QUOTE" },
  { id: "817697352408", name: "Marketing Only Quote", active: true, templateType: "QUOTE" },
  { id: "111111111111", name: "AIO Quote v2 (retired)", active: false, templateType: "QUOTE" },
];

const DEFAULTS: Record<QuoteType, string> = {
  full_pos: "817263673055",
  food_truck: "817263673055",
  marketing_only: "817697352408",
};

beforeEach(() => {
  getEffectiveRole.mockReset();
  listQuoteTemplates.mockReset();
  row = null;
  inserted.length = 0;
  updated.length = 0;
  listQuoteTemplates.mockResolvedValue(TEMPLATES);
});

describe("getQuoteTemplatePolicy", () => {
  it("falls back to the hardcoded defaults when no row exists", async () => {
    const policy = await getQuoteTemplatePolicy();
    expect(policy).toEqual(DEFAULTS);
  });

  it("reads back a saved row when one exists", async () => {
    row = {
      id: "policy-1",
      fullPosTemplateId: "787244469949",
      foodTruckTemplateId: "787244469949",
      marketingOnlyTemplateId: "817697352408",
      updatedByUserId: "admin-1",
      updatedAt: new Date(),
      isActive: true,
    };

    const policy = await getQuoteTemplatePolicy();
    expect(policy).toEqual({
      full_pos: "787244469949",
      food_truck: "787244469949",
      marketing_only: "817697352408",
    });
  });
});

describe("updateQuoteTemplatePolicyAction", () => {
  it("rejects a non-admin caller before touching the DB or HubSpot", async () => {
    getEffectiveRole.mockResolvedValue({ role: "rep", userId: "rep-1", name: "Rep", isDebug: false });

    await expect(updateQuoteTemplatePolicyAction(DEFAULTS)).rejects.toThrow("Admin only");
    expect(listQuoteTemplates).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it("rejects an id that isn't in the live template list", async () => {
    getEffectiveRole.mockResolvedValue({ role: "admin", userId: "admin-1", name: "Admin", isDebug: false });

    await expect(
      updateQuoteTemplatePolicyAction({ ...DEFAULTS, full_pos: "999999999999" })
    ).rejects.toThrow(/999999999999/);
    expect(inserted).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it("accepts an inactive template id — inactive templates are still selectable", async () => {
    getEffectiveRole.mockResolvedValue({ role: "admin", userId: "admin-1", name: "Admin", isDebug: false });

    await updateQuoteTemplatePolicyAction({ ...DEFAULTS, full_pos: "111111111111" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].fullPosTemplateId).toBe("111111111111");
  });

  it("inserts when no row exists yet, and attributes the admin who saved it", async () => {
    getEffectiveRole.mockResolvedValue({ role: "admin", userId: "admin-1", name: "Admin", isDebug: false });

    await updateQuoteTemplatePolicyAction({
      full_pos: "787244469949", food_truck: "787244469949", marketing_only: "817697352408",
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      fullPosTemplateId: "787244469949",
      foodTruckTemplateId: "787244469949",
      marketingOnlyTemplateId: "817697352408",
      updatedByUserId: "admin-1",
    });
  });

  it("updates the existing row in place rather than inserting a second one", async () => {
    row = {
      id: "policy-1",
      fullPosTemplateId: "817263673055",
      foodTruckTemplateId: "817263673055",
      marketingOnlyTemplateId: "817697352408",
      updatedByUserId: "admin-0",
      updatedAt: new Date("2026-01-01"),
      isActive: true,
    };
    getEffectiveRole.mockResolvedValue({ role: "admin", userId: "admin-2", name: "Admin", isDebug: false });

    await updateQuoteTemplatePolicyAction({ ...DEFAULTS, full_pos: "787244469949" });

    expect(inserted).toHaveLength(0);
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe("policy-1");
    expect(updated[0].values).toMatchObject({ fullPosTemplateId: "787244469949", updatedByUserId: "admin-2" });
  });
});

describe("listQuoteTemplatesAction", () => {
  it("is admin-only", async () => {
    getEffectiveRole.mockResolvedValue({ role: "rep", userId: "rep-1", name: "Rep", isDebug: false });
    await expect(listQuoteTemplatesAction()).rejects.toThrow("Admin only");
  });

  // Runs before the "succeeds" case below on purpose: listQuoteTemplatesAction
  // sits behind a module-level TTL cache (catalog.ts's pattern), so a prior
  // successful call in this file would otherwise mask a live failure.
  it("degrades gracefully — empty list plus an error — when HubSpot is unreachable", async () => {
    getEffectiveRole.mockResolvedValue({ role: "admin", userId: "admin-1", name: "Admin", isDebug: false });
    listQuoteTemplates.mockRejectedValue(new Error("HUBSPOT_PRIVATE_APP_TOKEN not set"));

    const result = await listQuoteTemplatesAction();
    expect(result.templates).toEqual([]);
    expect(result.error).toBe("HUBSPOT_PRIVATE_APP_TOKEN not set");
  });

  it("returns the live list with no error when HubSpot succeeds", async () => {
    getEffectiveRole.mockResolvedValue({ role: "admin", userId: "admin-1", name: "Admin", isDebug: false });

    const result = await listQuoteTemplatesAction();
    expect(result.error).toBeNull();
    expect(result.templates).toEqual(TEMPLATES);
  });
});

describe("QuoteType → template resolution", () => {
  it("resolves all three quote types from the saved policy", async () => {
    row = {
      id: "policy-1",
      fullPosTemplateId: "817263673055",
      foodTruckTemplateId: "787244469949",
      marketingOnlyTemplateId: "817697352408",
      updatedByUserId: null,
      updatedAt: new Date(),
      isActive: true,
    };

    const policy = await getQuoteTemplatePolicy();
    const types: QuoteType[] = ["full_pos", "food_truck", "marketing_only"];
    expect(types.map(t => policy[t])).toEqual(["817263673055", "787244469949", "817697352408"]);
  });
});
