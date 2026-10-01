"use client";

import type { ReactNode } from "react";
import styles from "./AccountsDashboard.module.css";

/**
 * The two primitives every block of the rep/admin account detail panel is
 * built from. Extracted here rather than exported from AccountsDashboard so
 * BillingPanel can use them without an import cycle (AccountsDashboard renders
 * BillingPanel).
 *
 * Before this, the panel was one eighteen-field grid followed by four blocks
 * that each hand-rolled `style={{ borderTop: "1px solid rgba(255,255,255,0.08)",
 * paddingTop: 16 }}` — a dark-theme rule left over from before the light
 * redesign, so those separators were rendering invisible. Anything added to the
 * panel goes in a Section, and gets the same rule, label and spacing as the
 * rest for free.
 */

export function Section({
  label,
  action,
  children,
}: {
  label: string;
  /** A single control belonging to this section, right-aligned in its header. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionLabel}>{label}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * A labelled value, with an optional secondary line under it.
 *
 * `meta` is what keeps the grid short: a rep's email under their name, a
 * merchant's email and phone under theirs. Each of those used to be its own
 * top-level field, which is most of how the old grid reached eighteen rows.
 */
export function Field({
  label,
  value,
  meta,
}: {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div>
      <div className={styles.detailFieldLabel}>{label}</div>
      <div className={styles.detailFieldValue}>{value}</div>
      {meta ? <div className={styles.detailMeta}>{meta}</div> : null}
    </div>
  );
}
