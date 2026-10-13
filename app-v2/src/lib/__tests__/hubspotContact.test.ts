// getContactById / updateContactDetails — the two calls `syncBillingContact`
// (actions/prospects.ts) uses to "overwrite in HS" an EXISTING billing
// contact (2026-10-13, items 4/5 of the 10/13 list). Same test shape as
// hubspotCompanyWrite.test.ts: stub global `fetch`, exercise the real
// adapter function against it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getContactById, updateContactDetails } from "@/lib/adapters/hubspot";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("HUBSPOT_PRIVATE_APP_TOKEN", "general-token");
  vi.stubEnv("HUBSPOT_BILLING_PRIVATE_APP_TOKEN", "billing-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("getContactById", () => {
  it("reads a contact's current record on the billing token", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: "contact-5",
      properties: { firstname: "Priya", lastname: "Shah", jobtitle: "Controller", email: "priya@tortapalace.com", phone: "555-0199" },
    }), { status: 200 }));

    const contact = await getContactById("contact-5");

    expect(contact).toEqual({
      firstName: "Priya", lastName: "Shah", jobTitle: "Controller", email: "priya@tortapalace.com", phone: "555-0199",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/crm/v3/objects/contacts/contact-5?properties=");
    expect(init.headers.Authorization).toBe("Bearer billing-token");
  });

  it("falls back to mobilephone when phone is blank", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: "contact-5",
      properties: { firstname: null, lastname: null, jobtitle: null, email: "a@b.com", phone: null, mobilephone: "555-7777" },
    }), { status: 200 }));

    const contact = await getContactById("contact-5");
    expect(contact?.phone).toBe("555-7777");
  });

  it("returns null on a 404 — the picked contact no longer exists", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 404 }));
    expect(await getContactById("gone")).toBeNull();
  });

  it("throws on any other HubSpot refusal", async () => {
    fetchMock.mockResolvedValue(new Response('{"message":"nope"}', { status: 403 }));
    await expect(getContactById("contact-5")).rejects.toThrow(/contact contact-5 read failed/);
  });
});

describe("updateContactDetails", () => {
  it("PATCHes only the properties supplied, on the billing token", async () => {
    await updateContactDetails("contact-5", { phone: "555-0199", jobtitle: "Controller" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.hubapi.com/crm/v3/objects/contacts/contact-5");
    expect(init.method).toBe("PATCH");
    expect(init.headers.Authorization).toBe("Bearer billing-token");
    expect(JSON.parse(init.body)).toEqual({ properties: { phone: "555-0199", jobtitle: "Controller" } });
  });

  it("makes no call at all with an empty patch", async () => {
    await updateContactDetails("contact-5", {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a HubSpot refusal so the caller can report it", async () => {
    fetchMock.mockResolvedValue(new Response('{"message":"nope"}', { status: 403 }));
    await expect(updateContactDetails("contact-5", { phone: "555-0199" })).rejects.toThrow(/contact contact-5 update failed/);
  });
});
