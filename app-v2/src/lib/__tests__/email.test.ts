import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// sendLeadLinkEmail — item 3 of the 10/13 list ("make sure the quote email
// sends"). There is no explicit "send quote" endpoint in HubSpot's v3/v4
// Quotes API (verified 2026-10-13 against HubSpot's own docs — see the
// comment on PublishBillingQuoteResult's "published" branch in
// publishBillingQuote.ts), so the merchant's copy of a published quote has
// always depended entirely on HubSpot's own implicit e-signature-request
// email. This is the mitigation: `sendLeadLinkEmail` now also carries
// `hs_quote_link`, when one exists, as a second path EasyOB itself controls.
//
// Neither Graph nor Resend credentials exist in this environment, so these
// tests force the Resend path with a stubbed env var and a mocked `fetch`,
// and assert on what was actually rendered into the HTML body — the only way
// to observe `render()`'s output, since the template isn't exported.

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("RESEND_API_KEY", "test-resend-key");
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function sentHtml(): Promise<string> {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://api.resend.com/emails");
  const body = JSON.parse(init.body as string) as { html: string };
  return body.html;
}

describe("sendLeadLinkEmail — the quote-link secondary path (10/13)", () => {
  it("sends successfully with no quote link, same as before this change", async () => {
    const { sendLeadLinkEmail } = await import("@/lib/adapters/email");
    const result = await sendLeadLinkEmail("ana@tortapalace.com", "http://localhost:3000/lead/tok-1", "Torta Palace");
    expect(result).toEqual({ sent: true, devUrl: null });
    const html = await sentHtml();
    expect(html).toContain("http://localhost:3000/lead/tok-1");
    expect(html).not.toContain("Go straight to billing");
  });

  // The "go straight to billing" CTA is GONE (2026-10-15). It carried
  // HubSpot's hs_quote_link, which only existed because the rep's link-send
  // published the quote; the merchant now confirms their details first, so at
  // the moment this email is written there is no document to link to — and a
  // route that skipped the confirmation step would defeat the point of it.
  it("offers exactly one way in — the lead link — and never a direct billing link", async () => {
    const { sendLeadLinkEmail } = await import("@/lib/adapters/email");
    await sendLeadLinkEmail(
      "ana@tortapalace.com", "http://localhost:3000/lead/tok-1", "Torta Palace"
    );
    const html = await sentHtml();
    expect(html).not.toContain("Go straight to billing");
    expect(html).not.toContain("customers.aioapp.com");
    expect(html).toContain("http://localhost:3000/lead/tok-1");
    expect(html).toContain("View your quote");
  });
});

// "can the email go through the sales rep?" (2026-10-13). NOT a true send-as
// — see ReplyToRep's own comment in email.ts for why that's impossible
// without a tenant-admin change. What's actually under test: the rep's
// VERIFIED email becomes the reply-to address (Resend's `reply_to`), the
// display name changes, and the footer names them — all while `from` stays
// the shared mailbox/address, unchanged.
describe("sendLeadLinkEmail — reply-to rep, not send-as (10/13)", () => {
  async function sentBody(): Promise<{ from: string; reply_to?: string; html: string }> {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(init.body as string);
  }

  it("with no rep resolved, behaves exactly as before — no reply_to, generic from/footer", async () => {
    const { sendLeadLinkEmail } = await import("@/lib/adapters/email");
    await sendLeadLinkEmail("ana@tortapalace.com", "http://localhost:3000/lead/tok-1", "Torta Palace");
    const body = await sentBody();
    expect(body.reply_to).toBeUndefined();
    expect(body.from).toBe("AIO Payments <onboarding@resend.dev>");
    expect(body.html).toContain("one of our representatives");
  });

  it("with a verified rep, sets reply_to to the rep's address and the display name to their name", async () => {
    const { sendLeadLinkEmail } = await import("@/lib/adapters/email");
    await sendLeadLinkEmail(
      "ana@tortapalace.com", "http://localhost:3000/lead/tok-1", "Torta Palace",
      { email: "rita@aioapp.com", name: "Rita Rep" }
    );
    const body = await sentBody();
    expect(body.reply_to).toBe("rita@aioapp.com");
    // The ADDRESS is unchanged (still the shared sending identity) — only the
    // display name varies. This is the whole point: no SendAs is used.
    expect(body.from).toBe("Rita Rep (AIO Payments) <onboarding@resend.dev>");
    expect(body.html).toContain("on behalf of Rita Rep");
    expect(body.html).not.toContain("one of our representatives");
  });

  it("a rep with no name still sets reply_to, but the footer and display name fall back to generic", async () => {
    const { sendLeadLinkEmail } = await import("@/lib/adapters/email");
    await sendLeadLinkEmail(
      "ana@tortapalace.com", "http://localhost:3000/lead/tok-1", "Torta Palace",
      { email: "rita@aioapp.com" }
    );
    const body = await sentBody();
    expect(body.reply_to).toBe("rita@aioapp.com");
    expect(body.from).toBe("AIO Payments <onboarding@resend.dev>");
    expect(body.html).toContain("one of our representatives");
  });
});

describe("sendFoodbuyEnrollmentEmail (2026-10-26)", () => {
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

  async function sentBody() {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(init.body as string) as {
      to: string; from: string; html: string; reply_to?: string;
      attachments?: { filename: string; content: string }[];
    };
  }

  it("attaches the PDF, replies to the merchant, and keeps the generic sender name", async () => {
    const { sendFoodbuyEnrollmentEmail } = await import("@/lib/adapters/email");
    const result = await sendFoodbuyEnrollmentEmail({
      to: "rep@foodbuy.com", pdf: PDF, fileName: "AIO-Foodbuy-Enrollment-Torta-Palace.pdf",
      businessName: "Torta Palace", contact: { name: "Ana Ruiz", email: "ana@tortapalace.com", phone: "555-0100" },
    });
    expect(result).toEqual({ sent: true });
    const body = await sentBody();
    expect(body.to).toBe("rep@foodbuy.com");
    expect(body.reply_to).toBe("ana@tortapalace.com");
    expect(body.from).not.toContain("Ana Ruiz");
    expect(body.attachments).toEqual([
      { filename: "AIO-Foodbuy-Enrollment-Torta-Palace.pdf", content: Buffer.from(PDF).toString("base64") },
    ]);
    expect(body.html).toContain("Torta Palace");
    expect(body.html).toContain("ana@tortapalace.com");
    // No link, so no button and no "paste this" fallback.
    expect(body.html).not.toContain("Button not working");
    expect(body.html).not.toContain("<a href");
  });

  it("with no merchant email, sets no reply-to and says so", async () => {
    const { sendFoodbuyEnrollmentEmail } = await import("@/lib/adapters/email");
    await sendFoodbuyEnrollmentEmail({ to: "rep@foodbuy.com", pdf: PDF, fileName: "f.pdf", businessName: "Torta Palace", contact: null });
    const body = await sentBody();
    expect(body.reply_to).toBeUndefined();
    expect(body.html).toContain("reaches AIO instead");
  });

  it("reports not sent when every transport fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, text: async () => "nope" });
    const { sendFoodbuyEnrollmentEmail } = await import("@/lib/adapters/email");
    const result = await sendFoodbuyEnrollmentEmail({ to: "rep@foodbuy.com", pdf: PDF, fileName: "f.pdf", businessName: "X" });
    expect(result).toEqual({ sent: false });
  });
});
