import type { OnboardingModule } from "@/lib/onboardingModules";
import ModuleChecklist from "./ModuleChecklist";

type Props = {
  modules: OnboardingModule[];
  /**
   * Present only on the public /lead/[token] host. onboardingModules.ts is
   * host-agnostic (and frozen — see its own header) and hands back real hrefs
   * for billing/Adyen/payroll/Foodbuy once the quote is accepted, but the
   * public token host has no session-scoped route for any of them: billing
   * can't exist pre-acceptance-published-quote lookups without a session,
   * Adyen's /continue needs a legal-entity id only a session-gated save
   * produces, and payroll/Foodbuy are session-only too. Building token-scoped
   * twins of those Server Actions would be a second, permanent authorization
   * surface for a window that acceptance already emails a magic link to
   * close — so instead, any such module's CTA is swapped for a plain
   * "Sign in to continue" pointing here.
   *
   * demo and quote are exempt: demo's CTA is always the external booking URL
   * (or none), and quote's CTA is a route this same public host actually
   * serves (see basePath in the lead pages) — neither needs a session.
   * Locked modules are also exempt (they already show a lock message instead
   * of a CTA), so this only ever touches an unlocked, otherwise-actionable
   * row.
   */
  signInHref?: string;
};

// Exported (not just inlined) so it's unit-testable as a pure function,
// matching the rest of this codebase's pure-function-over-DOM-render test
// idiom — see OnboardingChecklistPanel.test.ts.
export function withSignInOverride(modules: OnboardingModule[], signInHref?: string): OnboardingModule[] {
  if (!signInHref) return modules;
  return modules.map(m =>
    !m.locked && m.href && m.key !== "demo" && m.key !== "quote"
      ? { ...m, href: signInHref, ctaLabel: "Sign in to continue" }
      : m
  );
}

export default function OnboardingChecklistPanel({ modules, signInHref }: Props) {
  return <ModuleChecklist modules={withSignInOverride(modules, signInHref)} />;
}
