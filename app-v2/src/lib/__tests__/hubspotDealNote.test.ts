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

const MENTION = { ownerId: "161690499", name: "Elizabeth Phillips" };

const propsOf = () => JSON.parse(fetchMock.mock.calls[0][1].body).properties;
const bodyOf = () => propsOf().hs_note_body as string;

// Verified live against portal 244508708 (2026-10-13): hs_at_mentioned_owner_ids
// exists on this portal's NOTE object, is writable, and persists on read-back
// — but it alone does NOT render a working mention chip or notify anyone.
// The chip comes from `data-mention-id`/`data-mention-name` markup inside
// `hs_note_body`, which real UI-created mentions in the portal all carry in
// the same shape (note 406503541481 and others). These tests cover that
// payload shape — not live HubSpot delivery.
describe("createDealNote", () => {
  it("sets hubspot_owner_id but no mention property when none is given", async () => {
    await createDealNote("deal-1", "hello");
    const props = propsOf();
    expect(props).not.toHaveProperty("hubspot_owner_id");
    expect(props).not.toHaveProperty("hs_at_mentioned_owner_ids");
    expect(props.hs_note_body).not.toContain("data-mention-id");
  });

  it("sets a single mentioned owner id as a bare id, no semicolon", async () => {
    await createDealNote("deal-1", "hello", "999", MENTION);
    const props = propsOf();
    expect(props.hubspot_owner_id).toBe("999");
    expect(props.hs_at_mentioned_owner_ids).toBe("161690499");
  });

  it("joins several mentioned owner ids with semicolons", async () => {
    await createDealNote("deal-1", "hello", "999", [MENTION, { ownerId: "222", name: "Joe" }]);
    const props = propsOf();
    expect(props.hs_at_mentioned_owner_ids).toBe("161690499;222");
  });

  it("omits the mention property entirely rather than writing an empty string", async () => {
    await createDealNote("deal-1", "hello", "999", []);
    const props = propsOf();
    expect(props).not.toHaveProperty("hs_at_mentioned_owner_ids");
  });

  it("builds a data-mention-id/data-mention-name span in the exact portal shape", async () => {
    await createDealNote("deal-1", "please look at this one", "999", MENTION);
    const body = bodyOf();
    expect(body).toContain('<div style="" dir="auto" data-top-level="true">');
    expect(body).toContain('<p style="margin:0;">');
    expect(body).toContain(
      '<strong><span data-mention-id="161690499" data-mention-name="Elizabeth Phillips" ' +
      'style="color: #425b76;font-weight: 600;">@Elizabeth Phillips</span></strong>'
    );
    // The mention leads the first paragraph, with the rest of the note text after it.
    expect(body).toMatch(/@Elizabeth Phillips<\/span><\/strong> please look at this one/);
  });

  it("escapes the rep's note text but leaves the trusted mention markup alone", async () => {
    await createDealNote("deal-1", `<script>alert("x")</script> & co`, "999", MENTION);
    const body = bodyOf();
    expect(body).toContain("&lt;script&gt;alert(\"x\")&lt;/script&gt; &amp; co");
    expect(body).not.toContain("<script>");
    // The mention markup's own angle brackets are untouched real tags, not escaped text.
    expect(body).toContain("<strong><span data-mention-id=");
  });

  it("escapes a quote character in a mentioned name so it can't break the attribute", async () => {
    await createDealNote("deal-1", "hi", "999", { ownerId: "5", name: 'Weird "Name"' });
    const body = bodyOf();
    expect(body).toContain('data-mention-name="Weird &quot;Name&quot;"');
  });

  it("renders with no mention at all when none is given", async () => {
    await createDealNote("deal-1", "just a note", "999");
    const body = bodyOf();
    expect(body).not.toContain("data-mention-id");
    expect(body).toContain("just a note");
  });

  it("throws on a HubSpot refusal", async () => {
    fetchMock.mockResolvedValue(new Response('{"message":"nope"}', { status: 403 }));
    await expect(createDealNote("deal-1", "hello")).rejects.toThrow(/note create failed/);
  });
});
