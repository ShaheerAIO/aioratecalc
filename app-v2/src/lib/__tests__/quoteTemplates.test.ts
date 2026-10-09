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
  allInOneTemplateId: string;
  orderPayOnlyTemplateId: string;
  marketingOnlyTemplateId: string;
  marketingTermTemplateId: string;
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
  resolveQuoteTemplate,
  auditQuoteTemplatePolicy,
} = await import("@/lib/actions/quoteTemplates");

const TEMPLATES = [
  { id: "854670598854", name: "AIO Quote v4", active: true, templateType: "QUOTE" },
  // Retired for v4 on 2026-10-09, and HubSpot stopped accepting it the moment
  // it was — hence the inactive cases below.
  { id: "817263673055", name: "AIO Quote v3", active: false, templateType: "QUOTE" },
  { id: "787244469949", name: "Hardware Addition Quote", active: true, templateType: "QUOTE" },
  { id: "817697352408", name: "Marketing Only Quote", active: true, templateType: "QUOTE" },
  { id: "854671277804", name: "Marketing Only (2-year term) Quote - BAY AREA ONLY", active: true, templateType: "QUOTE" },
  { id: "111111111111", name: "AIO Quote v2 (retired)", active: false, templateType: "QUOTE" },
];

const DEFAULTS: Record<QuoteType, string> = {
  all_in_one: "854670598854",
  order_pay_only: "854670598854",
  marketing_only: "817697352408",
  // Its own document since 2026-10-09 — the 2-year term has a template of its
  // own in HubSpot (two, in fact, split by region).
  marketing_term: "854671277804",
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
      allInOneTemplateId: "787244469949",
      orderPayOnlyTemplateId: "787244469949",
      marketingOnlyTemplateId: "817697352408",
      marketingTermTemplateId: "854671277804",
      updatedByUserId: "admin-1",
      updatedAt: new Date(),
      isActive: true,
    };

    const policy = await getQuoteTemplatePolicy();
    expect(policy).toEqual({
      all_in_one: "787244469949",
      order_pay_only: "787244469949",
      marketing_only: "817697352408",
      marketing_term: "854671277804",
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
      updateQuoteTemplatePolicyAction({ ...DEFAULTS, all_in_one: "999999999999" })
    ).rejects.toThrow(/999999999999/);
    expect(inserted).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  // REVERSED 2026-10-09. An inactive template used to be savable, on the
  // theory that the choice was the admin's. It isn't: HubSpot refuses
  // association 286 to one outright ("Quote template is not active"), so
  // saving it is not a preference, it is a guaranteed failed publish for every
  // quote of that type.
  it("rejects an inactive template id, naming it", async () => {
    getEffectiveRole.mockResolvedValue({ role: "admin", userId: "admin-1", name: "Admin", isDebug: false });

    await expect(
      updateQuoteTemplatePolicyAction({ ...DEFAULTS, all_in_one: "817263673055" })
    ).rejects.toThrow(/AIO Quote v3/);
    expect(inserted).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it("inserts when no row exists yet, and attributes the admin who saved it", async () => {
    getEffectiveRole.mockResolvedValue({ role: "admin", userId: "admin-1", name: "Admin", isDebug: false });

    await updateQuoteTemplatePolicyAction({
      all_in_one: "787244469949", order_pay_only: "787244469949",
      marketing_only: "817697352408", marketing_term: "817697352408",
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      allInOneTemplateId: "787244469949",
      orderPayOnlyTemplateId: "787244469949",
      marketingOnlyTemplateId: "817697352408",
      marketingTermTemplateId: "817697352408",
      updatedByUserId: "admin-1",
    });
  });

  it("updates the existing row in place rather than inserting a second one", async () => {
    row = {
      id: "policy-1",
      allInOneTemplateId: "817263673055",
      orderPayOnlyTemplateId: "817263673055",
      marketingOnlyTemplateId: "817697352408",
      marketingTermTemplateId: "854671277804",
      updatedByUserId: "admin-0",
      updatedAt: new Date("2026-01-01"),
      isActive: true,
    };
    getEffectiveRole.mockResolvedValue({ role: "admin", userId: "admin-2", name: "Admin", isDebug: false });

    await updateQuoteTemplatePolicyAction({ ...DEFAULTS, all_in_one: "787244469949" });

    expect(inserted).toHaveLength(0);
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe("policy-1");
    expect(updated[0].values).toMatchObject({ allInOneTemplateId: "787244469949", updatedByUserId: "admin-2" });
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
  it("resolves the configured template and reports it live", async () => {
    const resolved = await resolveQuoteTemplate("all_in_one");
    expect(resolved).toEqual({ id: "854670598854", active: true });
  });

  // The whole point of resolving activity alongside the id: the publish path
  // refuses on this BEFORE it writes a contact, 13 line items and a draft
  // quote it then can't attach to anything.
  it("reports a deactivated template as inactive rather than hiding it", async () => {
    row = {
      id: "policy-1",
      allInOneTemplateId: "817263673055",
      orderPayOnlyTemplateId: "817263673055",
      marketingOnlyTemplateId: "817697352408",
      marketingTermTemplateId: "854671277804",
      updatedByUserId: null,
      updatedAt: new Date(),
      isActive: true,
    };

    expect(await resolveQuoteTemplate("all_in_one")).toEqual({ id: "817263673055", active: false });
  });

  it("resolves all three quote types from the saved policy", async () => {
    row = {
      id: "policy-1",
      allInOneTemplateId: "817263673055",
      orderPayOnlyTemplateId: "787244469949",
      marketingOnlyTemplateId: "817697352408",
      marketingTermTemplateId: "854671277804",
      updatedByUserId: null,
      updatedAt: new Date(),
      isActive: true,
    };

    const policy = await getQuoteTemplatePolicy();
    const types: QuoteType[] = ["order_pay_only", "all_in_one", "marketing_only"];
    expect(types.map(t => policy[t])).toEqual(["787244469949", "817263673055", "817697352408"]);
  });
});

// The nightly tripwire. Nobody tells EasyOB when AIO retires a template, so
// without this the first thing that notices is a refused publish with a
// merchant waiting on it.
describe("auditQuoteTemplatePolicy", () => {
  it("reports nothing when every configured template is still active", async () => {
    const audit = await auditQuoteTemplatePolicy();
    expect(audit.stale).toEqual([]);
    expect(audit.checked).toBe(4);
  });

  it("names a retired template, the quote type it blocks, and why", async () => {
    row = {
      id: "policy-1",
      allInOneTemplateId: "817263673055",
      orderPayOnlyTemplateId: "854670598854",
      marketingOnlyTemplateId: "817697352408",
      marketingTermTemplateId: "854671277804",
      updatedByUserId: null,
      updatedAt: new Date(),
      isActive: true,
    };

    const audit = await auditQuoteTemplatePolicy();
    expect(audit.stale).toContainEqual({
      quoteType: "all_in_one",
      templateId: "817263673055",
      name: "AIO Quote v3",
      reason: "inactive",
    });
  });

  // A template DELETED from the portal reads as missing, not inactive — the
  // same blocked publish, but a different thing to tell whoever fixes it.
  it("distinguishes a template HubSpot no longer has at all", async () => {
    row = {
      id: "policy-1",
      allInOneTemplateId: "999999999999",
      orderPayOnlyTemplateId: "854670598854",
      marketingOnlyTemplateId: "817697352408",
      marketingTermTemplateId: "854671277804",
      updatedByUserId: null,
      updatedAt: new Date(),
      isActive: true,
    };

    const audit = await auditQuoteTemplatePolicy();
    expect(audit.stale).toContainEqual({
      quoteType: "all_in_one",
      templateId: "999999999999",
      name: null,
      reason: "missing",
    });
  });
});
