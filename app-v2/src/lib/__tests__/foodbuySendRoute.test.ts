import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MerchantApplication } from "@/types/merchant";
import { BUSINESS, CONTACT, completeForm } from "./foodbuyFixtures";

// api/customer/applications/[id]/foodbuy/send, exercised as a route handler.
// What's pinned: the PDF is rendered here from the answers (never taken from
// the browser), an unchanged resend is a no-op, incomplete answers never reach
// email, and what's kept for next time leaves out the EIN and the signature.

const getCustomerSession = vi.fn();
const getApplicationForCustomer = vi.fn();
const updateApplicationAsCustomer = vi.fn();
const sendFoodbuyEnrollmentEmail = vi.fn();
const getFoodbuyRepEmail = vi.fn();
const uploadHubspotFile = vi.fn();
const attachFileToCompanyNote = vi.fn();

vi.mock("@/lib/auth/getCustomerSession", () => ({ getCustomerSession }));
vi.mock("@/lib/storage/postgresAdapter", () => ({
  postgresStorage: { getApplicationForCustomer, updateApplicationAsCustomer },
}));
vi.mock("@/lib/adapters/email", () => ({ sendFoodbuyEnrollmentEmail }));
vi.mock("@/lib/foodbuyPolicy", () => ({ getFoodbuyRepEmail }));
vi.mock("@/lib/adapters/hubspot", () => ({ uploadHubspotFile, attachFileToCompanyNote }));

const { POST } = await import("@/app/api/customer/applications/[id]/foodbuy/send/route");

const APP = {
  id: "app-1", business: BUSINESS, ownerContact: CONTACT, foodbuyIds: { generatedAt: "2026-10-29T00:00:00Z" },
  aioTenant: { businessId: 764 }, tenantLink: { hubspotCompanyId: "co-1" },
} as unknown as MerchantApplication;

const post = (body: unknown) =>
  POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "app-1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  getCustomerSession.mockResolvedValue({ userId: "cust-1" });
  getApplicationForCustomer.mockResolvedValue(APP);
  updateApplicationAsCustomer.mockResolvedValue(APP);
  getFoodbuyRepEmail.mockResolvedValue("rep@foodbuy.com");
  sendFoodbuyEnrollmentEmail.mockResolvedValue({ sent: true });
  uploadHubspotFile.mockResolvedValue("file-1");
  attachFileToCompanyNote.mockResolvedValue("note-1");
});
afterEach(() => vi.restoreAllMocks());

describe("Foodbuy send route", () => {
  it("renders, emails, records and files the agreement", async () => {
    const res = await (await post(completeForm())).json();
    expect(res.sent).toBe(true);

    const email = sendFoodbuyEnrollmentEmail.mock.calls[0][0];
    expect(email.to).toBe("rep@foodbuy.com");
    expect(String.fromCharCode(...email.pdf.subarray(0, 5))).toBe("%PDF-");

    const saved = updateApplicationAsCustomer.mock.calls[0][2].foodbuyIds;
    expect(saved.sentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(saved.form.locations[0].acct).toBe("168255");
    expect(saved.form.business).not.toHaveProperty("ein");
    expect(saved.form).not.toHaveProperty("signature");
    expect(attachFileToCompanyNote).toHaveBeenCalledWith(expect.objectContaining({ companyId: "co-1", fileId: "file-1" }));
  });

  it("does nothing on an unchanged resend", async () => {
    await post(completeForm());
    const { sentSha256, sentAt } = updateApplicationAsCustomer.mock.calls[0][2].foodbuyIds;
    getApplicationForCustomer.mockResolvedValue({ ...APP, foodbuyIds: { ...APP.foodbuyIds, sentSha256, sentAt } });
    sendFoodbuyEnrollmentEmail.mockClear();

    const res = await (await post(completeForm())).json();
    expect(res).toMatchObject({ sent: true, duplicate: true });
    expect(sendFoodbuyEnrollmentEmail).not.toHaveBeenCalled();
  });

  it("refuses incomplete answers without emailing", async () => {
    const res = await post({ ...completeForm(), signature: "" });
    expect(res.status).toBe(400);
    expect((await res.json()).errors).toHaveProperty("signature");
    expect(sendFoodbuyEnrollmentEmail).not.toHaveBeenCalled();
  });

  it("says so when no Foodbuy rep is configured", async () => {
    getFoodbuyRepEmail.mockResolvedValue(null);
    expect(await (await post(completeForm())).json()).toEqual({ sent: false, reason: "not_configured" });
    expect(sendFoodbuyEnrollmentEmail).not.toHaveBeenCalled();
  });

  it("is the application's own customer only", async () => {
    getCustomerSession.mockResolvedValue(null);
    expect((await post(completeForm())).status).toBe(401);
  });
});
