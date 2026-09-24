import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import type { OnboardingModule } from "@/lib/onboardingModules";
import { EMPTY_HUBSPOT_IDS } from "@/types/merchant";

// The token checklist host (/lead/[token]/page.tsx). Exercised as a plain
// async Server Component: called directly, its return value inspected as a
// React element tree (props), never rendered to HTML/DOM — matching this
// suite's module-boundary-mock idiom (leadAccept.test.ts et al.), not a
// DOM-render one.

const hasQuoteBasis = vi.fn();

type Row = Record<string, unknown> & { id: string };
let row: Row | null = null;

// Same minimal chainable drizzle stand-in as leadAccept.test.ts.
const db = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }) }),
};

vi.mock("@/lib/db/client", () => ({ db }));
vi.mock("@/lib/leadQuote", () => ({ hasQuoteBasis }));

const { default: LeadPage } = await import("@/app/lead/[token]/page");

const TOKEN = "tok-1";
const NOW = new Date("2026-08-21T19:49:38.000Z");

// Pinned, like leadAccept.test.ts's own clock note: the fixture rows carry a
// fixed customerLinkExpiresAt, and against a real clock every case here would
// silently read as expired once that date passes.
vi.useFakeTimers({ toFake: ["Date"], now: NOW });

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
  hasQuoteBasis.mockReset();
  hasQuoteBasis.mockReturnValue(true);
  row = baseRow();
});

describe("the quote row", () => {
  it("is not-ready, with no CTA, while the rep hasn't configured a quote", async () => {
    hasQuoteBasis.mockReturnValue(false);
    const el = await page();
    const modules = findModules(el);
    expect(modules).not.toBeNull();
    const quote = moduleFor(modules!, "quote");
    expect(quote.locked).toBeUndefined();
    expect(quote.ctaLabel).toBeUndefined();
    expect(quote.description).toBe("Your rep is preparing your quote.");
  });

  it("offers Review & Sign as soon as a quote exists — there is no gate ahead of it", async () => {
    const el = await page();
    const quote = moduleFor(findModules(el)!, "quote");
    expect(quote.locked).toBeUndefined();
    expect(quote.ctaLabel).toBe("Review & Sign");
  });
});

describe("basePath", () => {
  it("resolves the quote module's href under /lead/{token}/quote, not the checklist route itself", async () => {
    const el = await page("tok-xyz");
    const quote = moduleFor(findModules(el)!, "quote");
    expect(quote.href).toBe("/lead/tok-xyz/quote");
  });

  it("never produces a module href that nests under the quote route", async () => {
    // The original bug: basePath used to be set to the quote route itself
    // (`/lead/{token}/quote`) so quoteModule's href would resolve, which made
    // every OTHER module's `${basePath}/...` href nest under it —
    // `/lead/{token}/quote/billing`, `/lead/{token}/quote/continue`, none of
    // which are real routes. An accepted quote plus a real HubSpot quote
    // unlocks every module so none of their hrefs are hidden behind a lock
    // message, which is what actually exercises this.
    row = baseRow({
      quoteAcceptedAt: new Date("2026-08-10T00:00:00.000Z"),
      hubspotIds: { ...EMPTY_HUBSPOT_IDS, quoteId: "q1", publishedAt: "2026-08-01T00:00:00.000Z", subscriptionStatus: "active" },
      business: { legalName: "Torta Palace LLC", dba: "Torta Palace" },
      ownerContact: { email: "owner@example.com" },
      processing: {},
      agreement: {},
    });
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
