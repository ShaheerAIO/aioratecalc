"use client";

import { useState } from "react";
import Link from "next/link";
import type { CustomerSafeQuote, MerchantApplication } from "@/types/merchant";
import type { OnboardingModule } from "@/lib/onboardingModules";
import OnboardingChecklistPanel from "@/components/customer/OnboardingChecklistPanel";
import CustomerOnboardStep from "@/components/customer/CustomerOnboardStep";
import { DataGroups } from "@/components/customer/MyDataSection";
import QuoteSummary from "@/components/customer/QuoteSummary";
import styles from "@/app/customer/customer.module.css";
import dataStyles from "@/components/customer/MyDataSection.module.css";

// `quote` is built server-side (leadQuote.ts imports pricing.ts and must never
// reach the browser) and arrives here already projected to CustomerSafeQuote.
// Null when the application has no basis to price from — the tab is then not
// offered at all rather than drawing a table of zeros.
type Props = { app: MerchantApplication; modules: OnboardingModule[]; quote: CustomerSafeQuote | null };

// Segmented "Checklist" / "My Data" / "Your Quote" tabs for a single
// application. My Data starts read-only and switches in-place to the same form
// used at /customer/applications/[id]/edit — so editing never leaves this page.
export default function ApplicationTabs({ app, modules, quote }: Props) {
  const [tab, setTab] = useState<"checklist" | "data" | "quote">("checklist");
  const [editing, setEditing] = useState(false);

  const hasData = Boolean(app.business || app.ownerContact || app.processing);

  return (
    <>
      <div className={styles.tabsRow}>
        <div className={styles.tabs} data-active={tab} data-count={quote ? 3 : 2} role="tablist">
          <button role="tab" aria-selected={tab === "checklist"} className={styles.tab} onClick={() => setTab("checklist")}>
            Checklist
          </button>
          <button role="tab" aria-selected={tab === "data"} className={styles.tab} onClick={() => { setTab("data"); setEditing(false); }}>
            My Data
          </button>
          {quote && (
            <button role="tab" aria-selected={tab === "quote"} className={styles.tab} onClick={() => setTab("quote")}>
              Your Quote
            </button>
          )}
        </div>
      </div>

      {tab === "quote" && quote ? (
        <div className={styles.tabPanel}>
          <QuoteSummary quote={quote} />
          <p className={styles.tabHint}>
            This is the quote AIO prepared for you. Your AIO representative can walk through any of
            it with you.
          </p>
        </div>
      ) : tab === "checklist" ? (
        <div className={styles.tabPanel}>
          <OnboardingChecklistPanel modules={modules} />
        </div>
      ) : (
        <div className={styles.tabPanel}>
          {editing ? (
            <CustomerOnboardStep app={app} />
          ) : (
            <div className={dataStyles.panel}>
              <DataGroups app={app} />
              <button type="button" className={styles.editLink} onClick={() => setEditing(true)}>
                {hasData ? "Edit My Data →" : "Add My Data →"}
              </button>
            </div>
          )}
          {!editing && (
            <p className={styles.tabHint}>
              This is what AIO has on file for this application. It&apos;s reused to autofill other
              AIO services, like payroll and Foodbuy —{" "}
              <Link href="/customer">view across all applications</Link>.
            </p>
          )}
        </div>
      )}
    </>
  );
}
