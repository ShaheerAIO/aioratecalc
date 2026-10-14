import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDealNote } from "@/lib/adapters/hubspot";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "note-1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("HUBSPOT_BILLING_PRIVATE_APP_TOKEN", "billing-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// Verified live against portal 244508708 (2026-10-13): hs_at_mentioned_owner_ids
// exists on this portal's NOTE object, is writable, and persists on read-back.
// These tests cover the payload shape only — not live HubSpot behavior.
describe("createDealNote", () => {
  it("sets hubspot_owner_id but no mention property when none is given", async () => {
    await createDealNote("deal-1", "hello");
    const props = JSON.parse(fetchMock.mock.calls[0][1].body).properties;
    expect(props).not.toHaveProperty("hubspot_owner_id");
    expect(props).not.toHaveProperty("hs_at_mentioned_owner_ids");
  });

  it("sets a single mentioned owner id as a bare id, no semicolon", async () => {
    await createDealNote("deal-1", "hello", "161690499", "161690499");
    const props = JSON.parse(fetchMock.mock.calls[0][1].body).properties;
    expect(props.hubspot_owner_id).toBe("161690499");
    expect(props.hs_at_mentioned_owner_ids).toBe("161690499");
  });

  it("joins several mentioned owner ids with semicolons", async () => {
    await createDealNote("deal-1", "hello", "161690499", ["161690499", "222"]);
    const props = JSON.parse(fetchMock.mock.calls[0][1].body).properties;
    expect(props.hs_at_mentioned_owner_ids).toBe("161690499;222");
  });

  it("omits the mention property entirely rather than writing an empty string", async () => {
    await createDealNote("deal-1", "hello", "161690499", []);
    const props = JSON.parse(fetchMock.mock.calls[0][1].body).properties;
    expect(props).not.toHaveProperty("hs_at_mentioned_owner_ids");
  });

  it("throws on a HubSpot refusal", async () => {
    fetchMock.mockResolvedValue(new Response('{"message":"nope"}', { status: 403 }));
    await expect(createDealNote("deal-1", "hello")).rejects.toThrow(/note create failed/);
  });
});
