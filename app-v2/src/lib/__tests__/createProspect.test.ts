import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BusinessInfo, MerchantApplication, OwnerContact } from "@/types/merchant";
import type { HubspotDeal } from "@/lib/adapters/hubspot";

// createProspectAction — the "Company & Deal" + "Review What We Know" write
// path. Under test: the hard blocks (company, deal, legalName, owner email,
// malformed-but-not-merely-missing fields), that a deal refusal saves nothing,
// and that a successful resolution persists the picked deal id plus the rep's
// own reviewed business/owner/processing verbatim (no server-side re-merge —
// see the comment on this in prospects.ts).

const getEffectiveRole = vi.fn();
const saveApplication = vi.fn();
const getCompanyProfile = vi.fn();
const listCompanyContacts = vi.fn();
const updateCompanyMerchantDetails = vi.fn();
const ensureQuoteContact = vi.fn();
const getContactById = vi.fn();
const updateContactDetails = vi.fn();
const resolveDealForCompany = vi.fn();
const sendLeadLinkEmail = vi.fn();
const sendLeadLinkSms = vi.fn();
const listQuotableProductsAction = vi.fn();
const buildAndPublishBillingQuote = vi.fn();
const resolveSender = vi.fn();

vi.mock("@/lib/auth/getEffectiveRole", () => ({ getEffectiveRole }));
vi.mock("@/lib/storage/postgresAdapter", () => ({ postgresStorage: { saveApplication } }));
vi.mock("@/lib/adapters/hubspot", () => ({
  getCompanyProfile, listCompanyContacts, updateCompanyMerchantDetails,
  ensureQuoteContact, getContactById, updateContactDetails,
}));
// The Company & Deal picker's resolution service — mocked so the real module
// (which pulls in the server-only db client) is never loaded here.
vi.mock("@/lib/hubspotDeal", () => ({ resolveDealForCompany }));
vi.mock("@/lib/adapters/email", () => ({ sendLeadLinkEmail }));
vi.mock("@/lib/adapters/sms", () => ({ sendLeadLinkSms }));
vi.mock("@/lib/actions/catalog", () => ({ listQuotableProductsAction }));
// The publish-at-send orchestrator (10/13) — mocked so the real module (which
// pulls in the server-only db client) is never loaded here. See the
// "publish at send time" describe block below for what's actually under test.
// `resolveSender` (also 10/13, "can the email go through the sales rep?") is
// defaulted to a clean refusal so every pre-existing test reads exactly as it
// did before that feature existed — see the dedicated describe block below.
vi.mock("@/lib/billing/publishBillingQuote", () => ({ buildAndPublishBillingQuote, resolveSender }));
const PADDING = { paddingPct: 0.5, paddingMinMrrAdd: 0, paddingAdyenCostHide: true };
vi.mock("@/lib/actions/pricing", () => ({
  getActivePaddingPolicy: vi.fn().mockResolvedValue(PADDING),
  getMaxDiscountPercent: vi.fn().mockResolvedValue(50),
  getQuoteLimits: vi.fn().mockResolvedValue({ unitCaps: {}, maxBillingDelayDays: 90 }),
  // Same thin re-implementation saveQuoteConfiguration.test.ts uses — see its
  // comment. createProspectAction now calls the real getPricingPreviewAction
  // too (assertRateAboveFloor in prospects.ts), and this suite's own
  // margin-floor tests below need the REAL margin math against the SAME
  // padding this mock returns above.
  getPricingPreviewAction: vi.fn(async (input: {
    analysis?: unknown; quoteConfig?: unknown; quoteRates?: unknown; pricingModel: string; feeOverrides: unknown; activeTier: unknown;
  }) => {
    const { analysisFromQuoteConfig, derivePricingForRole } = await import("@/lib/pricing");
    const effective = await getEffectiveRole();
    const analysis = input.analysis ?? (input.quoteConfig ? analysisFromQuoteConfig(input.quoteConfig as never) : null);
    if (!analysis) throw new Error("A statement or a volume and ticket is needed to price a quote.");
    return derivePricingForRole(
      analysis as never, input.quoteRates as never, input.pricingModel, input.feeOverrides as never,
      effective.role, input.activeTier as never, PADDING
    );
  }),
}));

const { createProspectAction } = await import("@/lib/actions/prospects");

const BUSINESS: BusinessInfo = {
  legalName: "Torta Palace LLC", dba: "Torta Palace", bizType: "llc",
  address: "1200 Wilshire Blvd", city: "Los Angeles", state: "CA", zip: "90017",
  phone: "", website: "", yearsInBusiness: "", annualRevenue: "",
};
const OWNER: OwnerContact = { firstName: "Ana", lastName: "Reyes", title: "Owner", email: "ana@tortapalace.com", phone: "" };

const DEAL: HubspotDeal = {
  id: "deal-1", name: "Torta Palace / Deal - 1", pipelineId: "default", stageId: "2717103849",
  stageLabel: "Discovery Meeting", amount: 12000, createdAt: "2026-09-01T00:00:00.000Z",
  closed: false, won: false, companyIds: ["334295287484"],
};

const COMPANY_ID = "334295287484";

type Input = Parameters<typeof createProspectAction>[0];

function baseInput(over: Partial<Input> = {}): Input {
  return {
    business: BUSINESS,
    ownerContact: OWNER,
    processing: null,
    pricingModel: "2-tier",
    // A RATE-ONLY processing quote (no picks, no channels) short-circuits
    // deriveQuoteLines before it ever reaches the catalog — this suite is
    // about the company/deal/field gates, not quote derivation. It must not be
    // a marketing plan: those always derive, since an empty marketing picker
    // is a subscription nobody has added hardware to, not a rate-only quote.
    quoteType: "all_in_one",
    picks: [],
    channels: [],
    // A quote has to HAVE something on it before a link can be sent
    // (2026-10-15) — the merchant is being asked to confirm their details so a
    // quote can be built, so there has to be one to build. With no picks, the
    // basis is the rep's own volume + ticket, which keeps this fixture
    // rate-only exactly as the comment above describes.
    quoteConfig: { monthlyVolume: 100000, avgTicket: 30 },
    hubspotCompanyId: COMPANY_ID,
    deal: { mode: "existing", dealId: DEAL.id },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep" });
  getCompanyProfile.mockResolvedValue({ id: COMPANY_ID, name: "Torta Palace", tenantRef: null, adyenAccountHolderId: null });
  resolveDealForCompany.mockResolvedValue({ ok: true, deal: DEAL, created: false });
  sendLeadLinkEmail.mockResolvedValue({ sent: true });
  sendLeadLinkSms.mockResolvedValue({ sent: false });
  updateCompanyMerchantDetails.mockResolvedValue([]);
  // baseInput() builds a rate-only quote by default (no picks, no channels),
  // which is the realistic default outcome of buildAndPublishBillingQuote for
  // a brand-new prospect: nothing to bill yet, so a quiet skip.
  buildAndPublishBillingQuote.mockResolvedValue({ status: "skipped", reason: "nothing_to_bill" });
  resolveSender.mockResolvedValue({ ok: false, code: "no_rep_email" });
});

describe("createProspectAction — hard blocks", () => {
  it("throws when the legal business name is blank, and saves nothing", async () => {
    await expect(createProspectAction(baseInput({ business: { ...BUSINESS, legalName: "" } })))
      .rejects.toThrow(/legal business name/i);
    expect(saveApplication).not.toHaveBeenCalled();
  });

  it("throws when the owner contact email is blank, and saves nothing", async () => {
    await expect(createProspectAction(baseInput({ ownerContact: { ...OWNER, email: "" } })))
      .rejects.toThrow(/contact email/i);
    expect(saveApplication).not.toHaveBeenCalled();
  });

  it("throws on a malformed field (present but wrong), and saves nothing", async () => {
    await expect(createProspectAction(baseInput({ business: { ...BUSINESS, state: "XX" } })))
      .rejects.toThrow(/state/i);
    expect(saveApplication).not.toHaveBeenCalled();
  });

  it("does NOT block on a merely missing field like a blank street address", async () => {
    // Missing (not malformed) — warn-on-missing territory, not a hard block.
    await createProspectAction(baseInput({ business: { ...BUSINESS, address: "" } }));
    expect(saveApplication).toHaveBeenCalledTimes(1);
  });

  it("throws when the linked HubSpot company can't be read, and saves nothing", async () => {
    getCompanyProfile.mockResolvedValue(null);
    await expect(createProspectAction(baseInput())).rejects.toThrow(/wasn't found/i);
    expect(saveApplication).not.toHaveBeenCalled();
  });

  it("throws the deal resolution's own refusal message, and saves nothing", async () => {
    resolveDealForCompany.mockResolvedValue({ ok: false, code: "closed", message: "Deal is closed and can't be adopted." });
    await expect(createProspectAction(baseInput())).rejects.toThrow("Deal is closed and can't be adopted.");
    expect(saveApplication).not.toHaveBeenCalled();
  });
});

describe("createProspectAction — success", () => {
  it("resolves the deal against the linked company id", async () => {
    await createProspectAction(baseInput());
    expect(resolveDealForCompany).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      choice: { mode: "existing", dealId: DEAL.id },
    });
  });

  it("persists the resolved deal id and the rep-reviewed fields verbatim — no server-side re-merge", async () => {
    await createProspectAction(baseInput());
    expect(saveApplication).toHaveBeenCalledTimes(1);
    const [, app] = saveApplication.mock.calls[0] as [unknown, MerchantApplication];
    expect(app.hubspotDealId).toBe("deal-1");
    expect(app.business).toEqual(BUSINESS);
    expect(app.ownerContact).toEqual(OWNER);
    expect(app.tenantLink?.hubspotCompanyId).toBe(COMPANY_ID);
  });

  it("stamps dealLink with origin 'adopted' when resolveDealForCompany found a pre-existing deal", async () => {
    resolveDealForCompany.mockResolvedValue({ ok: true, deal: DEAL, created: false });
    await createProspectAction(baseInput());
    const [, app] = saveApplication.mock.calls[0] as [unknown, MerchantApplication];
    expect(app.dealLink).toEqual({
      origin: "adopted",
      dealName: DEAL.name,
      pipelineStageAtLink: DEAL.stageId,
      linkedAt: expect.any(String),
      linkedByUserId: "rep-1",
    });
  });

  it("stamps dealLink with origin 'created' when resolveDealForCompany minted a brand-new deal", async () => {
    resolveDealForCompany.mockResolvedValue({ ok: true, deal: DEAL, created: true });
    await createProspectAction(baseInput({ deal: { mode: "create", dealName: "Torta Palace" } }));
    const [, app] = saveApplication.mock.calls[0] as [unknown, MerchantApplication];
    expect(app.dealLink?.origin).toBe("created");
  });

  // The legal address used to reach HubSpot only from the merchant's own
  // onboarding form, which sits behind a customer account — i.e. not until
  // after they'd paid. A rep who already knows it sends it with the link.
  it("pushes the legal address to the Company as soon as the link is created", async () => {
    await createProspectAction(baseInput());
    expect(updateCompanyMerchantDetails).toHaveBeenCalledWith(COMPANY_ID, expect.objectContaining({
      legalName: "Torta Palace LLC",
      legalStreet: "1200 Wilshire Blvd",
      legalCity: "Los Angeles",
    }));
  });

  // 2026-10-18: `average_ticket` was created so the next quote on the company
  // prefills it. The ticket the rate was priced on is what's written.
  it("writes the average ticket to the Company", async () => {
    await createProspectAction(baseInput());
    expect(updateCompanyMerchantDetails).toHaveBeenCalledWith(COMPANY_ID, expect.objectContaining({
      averageTicket: "30",
    }));
  });

  // The rep leaving those fields for the customer is the NORMAL case, and it
  // must not erase an address HubSpot already holds — updateCompanyMerchantDetails
  // leaves blanks out, so what matters here is that we pass them through as
  // blank rather than inventing a value from the operating address.
  it("sends a blank legal address rather than substituting the operating one", async () => {
    await createProspectAction(baseInput({
      business: { ...BUSINESS, address: "", city: "", dbaAddress: "9 Operating Way", dbaCity: "Pasadena" },
    }));
    expect(updateCompanyMerchantDetails).toHaveBeenCalledWith(COMPANY_ID, expect.objectContaining({
      legalStreet: "",
      legalCity: "",
    }));
  });
});

// The server-side mirror of the rep form's own floor check — see
// assertRateAboveFloor / marginFloorBlockers (prospects.ts / pricing.ts) and
// the 2026-10-09 decision ("card rate minimums are needed"). Before this, a
// stale client or a direct Server Action call could create a prospect priced
// under AIO's minimum — the UI's own refusal (rep/prospects/new/page.tsx's
// hardBlocks) was never backed up here.
describe("createProspectAction — the margin floor", () => {
  // $10,000/month, $50 ticket — MARGIN_REQS' first tier (true minMargin
  // 0.0067; padded 50%, ~0.01005). Both rates below assume a 2-tier quote
  // with no per-transaction fee, so interchange alone decides the margin.
  const BASIS = { monthlyVolume: 10000, avgTicket: 50 };

  it("refuses to create a prospect at a rate below AIO's floor, and names no number or admin escape hatch", async () => {
    const attempt = createProspectAction(baseInput({
      quoteConfig: BASIS,
      quoteRates: { cardPresentRate: 0.005, cardNotPresentRate: 0.005, amexCardPresentRate: 0.005, amexCardNotPresentRate: 0.005, perTransactionFee: 0 },
    }));

    // Pinned verbatim — see marginFloorBlockers' doc comment on why the
    // wording must not promise an admin review that doesn't exist (the
    // margin-policy editor was deleted 2026-10-12). Raising the rate is the
    // only recovery, and that's what the message says.
    await expect(attempt).rejects.toThrow(
      "The card rate is below the minimum AIO can process this volume at. Raise the rate to send this quote."
    );
    expect(saveApplication).not.toHaveBeenCalled();

    const message = await attempt.catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(message).not.toMatch(/0\.0067|0\.67\s*%|0\.01005|1\.005\s*%/);
    expect(message).not.toMatch(/admin/i);
  });

  it("does not refuse a rate-only quote with no volume behind it — there is nothing to clear", async () => {
    // baseInput() carries no quoteConfig/analysis at all — the normal shape
    // of a brand-new prospect before a statement or a typed volume exists.
    await createProspectAction(baseInput());
    expect(saveApplication).toHaveBeenCalledTimes(1);
  });
});

// 10/13 — "make quote publish as soon as link is sent" — REVERSES the
// 2026-09-25 decision that only the merchant's own "Continue to Billing"
// click publishes (billing.ts's header, CLAUDE.md's acceptance section).
// createProspectAction now attempts the same build-and-publish
// (buildAndPublishBillingQuote) right after the row is saved, before the
// lead-link email goes out. Under test: it never blocks or fails prospect
// creation regardless of outcome, it passes the saved row (deal/company
// already resolved) to the orchestrator, and a successful publish's
// `hs_quote_link` reaches the lead-link email.
// THE REVERSAL OF THE 10/13 PUBLISH-AT-SEND (2026-10-15, product owner).
//
// `publishAtSend` is gone. Publishing a HubSpot quote is a one-way door — no
// API edit, no delete, no void — so publishing the instant the rep sent the
// link froze whatever the rep had typed about the merchant onto a document
// nobody could amend, and locked the rep out of their own quote at the same
// moment. The merchant now confirms their details first
// (/lead/[token]/confirm), and THAT is what publishes.
//
// This block is what keeps the reversal honest: the whole point is that
// sending a link reaches HubSpot's quote machinery not at all.
describe("createProspectAction — publishes NOTHING at send time", () => {
  it("never touches the publish path", async () => {
    await createProspectAction(baseInput());
    expect(saveApplication).toHaveBeenCalledTimes(1);
    expect(buildAndPublishBillingQuote).not.toHaveBeenCalled();
  });

  it("saves the row unpublished — hubspotIds stays null for the merchant to open", async () => {
    await createProspectAction(baseInput());
    const saved = saveApplication.mock.calls[0][1] as { hubspotIds: unknown; detailsConfirmedAt: unknown };
    expect(saved.hubspotIds).toBeNull();
    // Nothing is confirmed either — the merchant does that themselves, and it
    // is what both public doors gate on.
    expect(saved.detailsConfirmedAt).toBeNull();
  });

  it("emails the lead link and nothing else — never a direct route to billing", async () => {
    const result = await createProspectAction(baseInput());
    expect(result.emailResult).toEqual({ sent: true });
    // The ordinary 3-argument call. The "go straight to billing" CTA carried
    // hs_quote_link, which cannot exist at this point any more.
    expect(sendLeadLinkEmail).toHaveBeenCalledWith(OWNER.email, expect.stringContaining("/lead/"), "Torta Palace");
  });
});

// A LINK WITHOUT A QUOTE IS NOT SENDABLE (2026-10-15, product owner: "there is
// no situation where the rep hasnt made the quote because they cant send the
// initial link without making it"). It was the intent all along and nothing
// enforced it — and it matters more now, because the merchant is being asked
// to confirm their details so that a quote can be built.
describe("createProspectAction — a link needs a quote", () => {
  it("refuses a quote with no picks and no rate basis", async () => {
    // Since 2026-10-18 the volume + ticket requirement refuses this first.
    await expect(createProspectAction(baseInput({ quoteConfig: null })))
      .rejects.toThrow(/average ticket/);
    expect(saveApplication).not.toHaveBeenCalled();
  });

  // 2026-10-18: without a ticket the rate card can't be read, so the merchant
  // was quoted the flat standard rate whatever their size.
  it("refuses a processing quote with a volume but no average ticket", async () => {
    await expect(createProspectAction(baseInput({ quoteConfig: { monthlyVolume: 100000, avgTicket: 0 } })))
      .rejects.toThrow(/monthly volume and average ticket/);
    expect(saveApplication).not.toHaveBeenCalled();
  });

  it("accepts a rate-only quote — a volume and a ticket ARE a quote", async () => {
    await expect(createProspectAction(baseInput())).resolves.toBeTruthy();
    expect(saveApplication).toHaveBeenCalledTimes(1);
  });
});

// 10/13 — "can the email go through the sales rep?" createProspectAction
// resolves the owning rep's VERIFIED identity (resolveSender, reused
// verbatim from the publish path) and carries it onto the lead-link email as
// a reply-to/display-name, never a true send-as — see email.ts's ReplyToRep
// comment for why that's the ceiling.
describe("createProspectAction — reply-to rep (10/13)", () => {
  it("resolves the rep by the APPLICATION's owner, and passes it to the email", async () => {
    resolveSender.mockResolvedValue({ ok: true, email: "rita@aioapp.com", firstName: "Rita", lastName: "Rep", ownerId: "161" });

    await createProspectAction(baseInput());

    expect(resolveSender).toHaveBeenCalledWith("rep-1");
    // The rep is the 4th argument now that the quote link is gone — nothing
    // publishes at send time, so there was never anything to put in front of
    // it. See sendLeadLinkEmailWithOptionalRep's own comment.
    expect(sendLeadLinkEmail).toHaveBeenCalledWith(
      OWNER.email, expect.stringContaining("/lead/"), "Torta Palace",
      { email: "rita@aioapp.com", name: "Rita Rep" },
    );
  });

  it("falls back to the ordinary 3-argument call when the rep can't be verified — never a seeded dev row", async () => {
    // Exactly the hazard CLAUDE.md names for hs_sender_email: a seeded dev
    // row (rep@aioapp.com) is a valid owner_user_id but not a real HubSpot
    // portal user. resolveSender refuses it, and this must refuse it too.
    resolveSender.mockResolvedValue({ ok: false, code: "not_a_portal_owner", repEmail: "rep@aioapp.com" });

    await createProspectAction(baseInput());

    expect(sendLeadLinkEmail).toHaveBeenCalledWith(OWNER.email, expect.stringContaining("/lead/"), "Torta Palace");
  });

  it("never blocks prospect creation when resolveSender itself throws", async () => {
    resolveSender.mockRejectedValue(new Error("crm.objects.owners.read missing"));

    const result = await createProspectAction(baseInput());

    expect(result.linkUrl).toContain("/lead/");
    expect(sendLeadLinkEmail).toHaveBeenCalledWith(OWNER.email, expect.stringContaining("/lead/"), "Torta Palace");
  });
});

// 10/13 — "add billing contact" / "...dropdown for existing or make a new
// one add to hs" / "overwrite the billing contact in hs". Under test:
// billingContact is persisted on the row regardless of the HubSpot outcome
// (best-effort, same posture as syncCompanyDetails), a NEW address
// find-or-creates via the same ensureQuoteContact the signer contact uses,
// and an EXISTING contact id gets a narrow PATCH of only the changed,
// non-blank fields — never email, never a blanket overwrite.
describe("createProspectAction — billing contact (10/13)", () => {
  const BILLING: OwnerContact = { firstName: "Priya", lastName: "Shah", title: "Controller", email: "priya@tortapalace.com", phone: "555-0199" };

  it("is null on the saved row when the rep never adds one", async () => {
    await createProspectAction(baseInput());
    const saved = saveApplication.mock.calls[0][1] as MerchantApplication;
    expect(saved.billingContact).toBeNull();
    expect(ensureQuoteContact).not.toHaveBeenCalled();
    expect(getContactById).not.toHaveBeenCalled();
  });

  it("persists the billing contact on the row and find-or-creates it in HubSpot when it's a new address", async () => {
    ensureQuoteContact.mockResolvedValue("contact-99");

    await createProspectAction(baseInput({ billingContact: BILLING }));

    const saved = saveApplication.mock.calls[0][1] as MerchantApplication;
    expect(saved.billingContact).toEqual(BILLING);
    expect(ensureQuoteContact).toHaveBeenCalledWith({
      firstName: "Priya", lastName: "Shah", email: "priya@tortapalace.com", phone: "555-0199",
    });
    expect(getContactById).not.toHaveBeenCalled();
    expect(updateContactDetails).not.toHaveBeenCalled();
  });

  it("PATCHes only the changed, non-blank fields onto an EXISTING contact — never email", async () => {
    getContactById.mockResolvedValue({
      firstName: "Priya", lastName: "Shah", jobTitle: "Owner", email: "priya@tortapalace.com", phone: "555-0000",
    });

    // Same email, same names — only the phone and title actually changed.
    await createProspectAction(baseInput({ billingContact: BILLING, billingContactId: "contact-5" }));

    expect(getContactById).toHaveBeenCalledWith("contact-5");
    expect(updateContactDetails).toHaveBeenCalledWith("contact-5", { jobtitle: "Controller", phone: "555-0199" });
    expect(ensureQuoteContact).not.toHaveBeenCalled();
  });

  it("sends an EMPTY patch (no call reaches HubSpot with a body) when nothing actually changed", async () => {
    getContactById.mockResolvedValue({
      firstName: "Priya", lastName: "Shah", jobTitle: "Controller", email: "priya@tortapalace.com", phone: "555-0199",
    });

    await createProspectAction(baseInput({ billingContact: BILLING, billingContactId: "contact-5" }));

    expect(updateContactDetails).toHaveBeenCalledWith("contact-5", {});
  });

  it("falls back to find-or-create when the picked contact id no longer resolves", async () => {
    getContactById.mockResolvedValue(null);
    ensureQuoteContact.mockResolvedValue("contact-100");

    await createProspectAction(baseInput({ billingContact: BILLING, billingContactId: "contact-stale" }));

    expect(updateContactDetails).not.toHaveBeenCalled();
    expect(ensureQuoteContact).toHaveBeenCalledWith({
      firstName: "Priya", lastName: "Shah", email: "priya@tortapalace.com", phone: "555-0199",
    });
  });

  it("never blocks or undoes prospect creation when the HubSpot sync fails", async () => {
    ensureQuoteContact.mockRejectedValue(new Error("HubSpot down"));

    const result = await createProspectAction(baseInput({ billingContact: BILLING }));

    expect(result.linkUrl).toContain("/lead/");
    const saved = saveApplication.mock.calls[0][1] as MerchantApplication;
    expect(saved.billingContact).toEqual(BILLING);
  });
});
