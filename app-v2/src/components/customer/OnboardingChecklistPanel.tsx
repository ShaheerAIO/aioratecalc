import Link from "next/link";
import type { ChecklistNotice, OnboardingModule } from "@/lib/onboardingModules";
import ModuleChecklist from "./ModuleChecklist";
import styles from "./ModuleChecklist.module.css";

type Props = {
  modules: OnboardingModule[];
  /**
   * A banner above the rows, for a state one row can't carry on its own.
   * Built by `checklistNotice` so both hosts say the same thing — see its
   * comment. Null on the ordinary path, which is nearly always.
   */
  notice?: ChecklistNotice | null;
  /**
   * Present only on the public /lead/[token] host. onboardingModules.ts is
   * host-agnostic and hands back real hrefs for Adyen/payroll/Foodbuy once
   * the quote is accepted, but the public token host has no session-scoped
   * route for any of them: Adyen's /continue needs a legal-entity id only a
   * session-gated save produces, and payroll/Foodbuy are session-only too.
   * Building token-scoped twins of those Server Actions would be a second,
   * permanent authorization surface for a window that acceptance already
   * emails a magic link to close — so instead, any such module's CTA is
   * swapped for a plain "Sign in to continue" pointing here.
   *
   * quote is exempt, and must stay exempt: it's the merged quote & billing
   * row, whose CTA is a route this same public host serves itself (see
   * quoteHref/billingHref in the lead page), so it needs no session — and
   * it's the row that asks for the billing details every other row waits on.
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
    !m.locked && m.href && m.key !== "quote"
      ? { ...m, href: signInHref, ctaLabel: "Sign in to continue" }
      : m
  );
}

export default function OnboardingChecklistPanel({ modules, notice, signInHref }: Props) {
  return (
    <>
      {notice && (
        <div className={styles.notice} role="status">
          <div className={styles.noticeTitle}>{notice.title}</div>
          <p className={styles.noticeBody}>{notice.body}</p>
          {notice.href && (
            <Link href={notice.href} className={styles.noticeCta}>
              {notice.ctaLabel || "Continue"}
            </Link>
          )}
        </div>
      )}
      <ModuleChecklist modules={withSignInOverride(modules, signInHref)} />
    </>
  );
}
