import { describe, it, expect } from "vitest";
import { withSignInOverride } from "@/components/customer/OnboardingChecklistPanel";
import type { OnboardingModule } from "@/lib/onboardingModules";

// The one piece of host-aware logic the shared checklist renderer adds on top
// of the dumb ModuleChecklist row renderer: on the public /lead/[token] host,
// any unlocked module other than quote can't use its own href (billing,
// Adyen, payroll, and Foodbuy are all session-only), so it's swapped for a
// "Sign in to continue" CTA instead. quote/locked rows are untouched.

const mod = (over: Partial<OnboardingModule> = {}): OnboardingModule => ({
  key: "billing", label: "Billing", status: "in_progress", description: "…",
  href: "/customer/applications/app-1/billing", ctaLabel: "Finish Signing",
  ...over,
});

describe("withSignInOverride", () => {
  it("passes modules through unchanged when no signInHref is given (the authenticated host)", () => {
    const modules = [mod()];
    expect(withSignInOverride(modules)).toBe(modules);
  });

  it("swaps an unlocked non-quote module's href for the sign-in link", () => {
    const [result] = withSignInOverride([mod()], "/customer/login");
    expect(result.href).toBe("/customer/login");
    expect(result.ctaLabel).toBe("Sign in to continue");
  });

  it("leaves the quote module's href alone — it's a route the token host itself serves", () => {
    const quote = mod({ key: "quote", label: "Quote", href: "/lead/tok-1/quote", ctaLabel: "Review & Sign" });
    const [result] = withSignInOverride([quote], "/customer/login");
    expect(result.href).toBe("/lead/tok-1/quote");
  });

  it("leaves a locked module alone — it already has no usable href", () => {
    const locked = mod({ locked: { reason: "quote", message: "Available after your quote is signed" } });
    const [result] = withSignInOverride([locked], "/customer/login");
    expect(result.href).toBe("/customer/applications/app-1/billing");
    expect(result.locked).toEqual({ reason: "quote", message: "Available after your quote is signed" });
  });

  it("leaves a module with no href alone", () => {
    const noHref = mod({ href: undefined, ctaLabel: undefined });
    const [result] = withSignInOverride([noHref], "/customer/login");
    expect(result.href).toBeUndefined();
  });
});
