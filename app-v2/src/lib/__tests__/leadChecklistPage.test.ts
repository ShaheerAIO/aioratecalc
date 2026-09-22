import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import type { OnboardingModule } from "@/lib/onboardingModules";
import { EMPTY_HUBSPOT_IDS } from "@/types/merchant";

// The token checklist host (/lead/[token]/page.tsx) — the data-leak boundary
// this whole task exists to enforce. Exercised as a plain async Server
// Component: called directly, its return value inspected as a React element
// tree (props), never rendered to HTML/DOM — matching this suite's
// module-boundary-mock idiom (leadAccept.test.ts et al.), not a DOM-render one.

const buildCustomerSafeQuote = vi.fn();
const getSettingsAction = vi.fn();

type Row = Record<string, unknown> & { id: string };
let row: Row | null = null;

// Same minimal chainable drizzle stand-in as leadAccept.test.ts. Every fixture
// below has hubspotDealId: null, so lib/demoSync's own first guard short-
// circuits before ever touching HubSpot or writing back through `update` —
// the demo-refresh mechanics themselves are demoSync.test.ts's job, not this
// file's.
const db = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }) }),
  update: () => ({ set: () => ({ where: () => ({ returning: async () => (row ? [{ ...row }] : []) }) }) }),
};

vi.mock("@/lib/db/client", () => ({ db }));
vi.mock("@/lib/leadQuote", () => ({ buildCustomerSafeQuote }));
vi.mock("@/lib/adapters/hubspot", () => ({
  getDealById: vi.fn(), listMeetingsForDeal: vi.fn(), listDemoMeetingsForCompany: vi.fn(),
}));
vi.mock("@/lib/actions/applications", () => ({ getSettingsAction }));

const { default: LeadPage } = await import("@/app/lead/[token]/page");

const TOKEN = "tok-1";
const NOW = new Date("2026-08-21T19:49:38.000Z");

// Pinned, like leadAccept.test.ts's own clock note: the fixture rows carry a
// fixed customerLinkExpiresAt, and against a real clock every case here would
// silently read as expired once that date passes.
vi.useFakeTimers({ toFake: ["Date"], now: NOW });

const HELD_DEMO = {
  bookedAt: null, heldAt: "2026-08-10T18:00:00.000Z", source: "manual" as const,
  meetingId: null, meetingTitle: null, outcome: null,
  markedByUserId: "rep-1", checkedAt: "2026-08-10T18:00:00.000Z",
  lastSyncError: null, lastSyncErrorAt: null,
};

function baseRow(extra: Partial<Row> = {}): Row {
  return {
    id: "app-1",
    ownerUserId: "rep-1",
    customerUserId: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    stage: "quote_sent",
    hubspotDealId: null,
    dealLink: null,
    demo: null,
    tenantLink: null,
    adyenIds: null,
    adyenOnboardingUrl: null,
    checkIds: null,
    foodbuyIds: null,
    hubspotIds: null,
    quoteType: "full_pos",
    quoteConfig: { monthlyVolume: 1000, avgTicket: 100 },
    quoteLines: null,
    orderPoints: null,
    quoteAcceptedAt: null,
    targetMargin: "0.019000",
    pricingModel: "2-tier",
    customerLinkToken: TOKEN,
    customerLinkPurpose: "lead_upload",
    customerLinkSentAt: new Date("2026-08-01T00:00:00.000Z"),
    customerLinkExpiresAt: new Date("2026-09-04T00:00:00.000Z"),
    analysis: null,
    proposal: null,
    business: { legalName: "Torta Palace LLC", dba: "Torta Palace" },
    ownerContact: null,
    processing: null,
    agreement: null,
    ...extra,
  };
}

// Depth-first search through a returned React element tree for the first
// `modules` prop it finds — i.e. OnboardingChecklistPanel's. Walks
// `.props.children`, which may be a single element, an array, or a string.
function findModules(node: unknown): OnboardingModule[] | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findModules(child);
      if (found) return found;
    }
    return null;
  }
  const el = node as { props?: { modules?: OnboardingModule[]; children?: ReactNode } };
  if (el.props?.modules) return el.props.modules;
  if (el.props?.children !== undefined) return findModules(el.props.children);
  return null;
}

function moduleFor(modules: OnboardingModule[], key: string): OnboardingModule {
  const m = modules.find(mod => mod.key === key);
  if (!m) throw new Error(`no module with key "${key}"`);
  return m;
}

const page = (token = TOKEN) => LeadPage({ params: Promise.resolve({ token }) });

beforeEach(() => {
  buildCustomerSafeQuote.mockReset();
  getSettingsAction.mockReset();
  getSettingsAction.mockResolvedValue({ demoBookingUrl: null });
  row = baseRow();
});

describe("the pre-demo withholding", () => {
  it("never calls buildCustomerSafeQuote before the demo is held", async () => {
    row = baseRow({ demo: null });
    await page();
    expect(buildCustomerSafeQuote).not.toHaveBeenCalled();
  });

  it("shows the quote row as not-ready, never leaking that a quote is actually prepared", async () => {
    // Even though quoteConfig alone would be a real basis (buildCustomerSafeQuote
    // would return non-null if it were ever called), the caller must not learn
    // that — hasQuote is forced false without the function ever running.
    row = baseRow({ demo: null });
    const el = await page();
    const modules = findModules(el);
    expect(modules).not.toBeNull();
    const quote = moduleFor(modules!, "quote");
    expect(quote.locked).toEqual({ reason: "demo", message: "Available after your demo" });
    expect(quote.description).toBe("Your rep is preparing your quote.");
  });
});

describe("once the demo is held", () => {
  it("calls buildCustomerSafeQuote exactly once", async () => {
    row = baseRow({ demo: HELD_DEMO });
    buildCustomerSafeQuote.mockReturnValue({ basis: "config", monthlyVolume: 1000 });
    await page();
    expect(buildCustomerSafeQuote).toHaveBeenCalledTimes(1);
  });

  it("unlocks the quote row and offers Review & Sign when a quote exists", async () => {
    row = baseRow({ demo: HELD_DEMO });
    buildCustomerSafeQuote.mockReturnValue({ basis: "config", monthlyVolume: 1000 });
    const el = await page();
    const quote = moduleFor(findModules(el)!, "quote");
    expect(quote.locked).toBeUndefined();
    expect(quote.ctaLabel).toBe("Review & Sign");
  });
});

describe("basePath", () => {
  it("resolves the quote module's href under /lead/{token}/quote, not the checklist route itself", async () => {
    row = baseRow({ demo: HELD_DEMO });
    buildCustomerSafeQuote.mockReturnValue({ basis: "config", monthlyVolume: 1000 });
    const el = await page("tok-xyz");
    const quote = moduleFor(findModules(el)!, "quote");
    expect(quote.href).toBe("/lead/tok-xyz/quote");
  });

  it("links the demo module's CTA straight to the external booking URL, same as the authenticated host", async () => {
    getSettingsAction.mockResolvedValue({ demoBookingUrl: "https://meetings.hubspot.com/aio" });
    row = baseRow({ demo: null });
    const el = await page("tok-xyz");
    const demo = moduleFor(findModules(el)!, "demo");
    expect(demo.href).toBe("https://meetings.hubspot.com/aio");
  });

  it("never produces a module href that nests under the quote route", async () => {
    // The original bug: basePath used to be set to the quote route itself
    // (`/lead/{token}/quote`) so quoteModule's href would resolve, which made
    // every OTHER module's `${basePath}/...` href nest under it —
    // `/lead/{token}/quote/billing`, `/lead/{token}/quote/continue`, none of
    // which are real routes. Demo held + quote accepted + a real HubSpot
    // quote unlocks every module so none of their hrefs are hidden behind a
    // lock message, which is what actually exercises this.
    row = baseRow({
      demo: HELD_DEMO,
      quoteAcceptedAt: new Date("2026-08-10T00:00:00.000Z"),
      hubspotIds: { ...EMPTY_HUBSPOT_IDS, quoteId: "q1", publishedAt: "2026-08-01T00:00:00.000Z", subscriptionStatus: "active" },
      business: { legalName: "Torta Palace LLC", dba: "Torta Palace" },
      ownerContact: { email: "owner@example.com" },
      processing: {},
      agreement: {},
    });
    buildCustomerSafeQuote.mockReturnValue({ basis: "config", monthlyVolume: 1000 });
    const el = await page("tok-xyz");
    const modules = findModules(el)!;
    const quoteRoute = "/lead/tok-xyz/quote";
    for (const m of modules) {
      if (!m.href) continue; // absent is fine
      if (m.key === "quote") {
        expect(m.href).toBe(quoteRoute);
        continue;
      }
      if (m.href === "/customer/login") continue; // explicit sign-in override is fine
      expect(m.href.startsWith(quoteRoute)).toBe(false);
    }
  });
});

describe("invalid / expired links", () => {
  it("shows Invalid Link for an unknown token", async () => {
    row = null;
    const el = await page();
    expect(JSON.stringify(el)).toContain("Invalid Link");
  });

  it("shows Link Expired for an expired token", async () => {
    row = baseRow({ customerLinkExpiresAt: new Date("2020-01-01T00:00:00.000Z") });
    const el = await page();
    expect(JSON.stringify(el)).toContain("Link Expired");
  });
});
