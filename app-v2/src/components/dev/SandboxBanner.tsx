// DEBUG-SANDBOX: debug-only, for the team preview deployment (branch
// debug/team-preview). NEVER MERGE — see MERGE_NOTES.md at the repo root.
// Only mounted when DEBUG_SANDBOX=true (checked in app/layout.tsx). Pinned to
// the bottom edge, not the top, so it never sits over the sticky nav pill.
import styles from "./SandboxBanner.module.css";

export const SANDBOX_BANNER_TEXT =
  "DEBUG PREVIEW · SANDBOX — emails, HubSpot and provisioning are disabled; edits save to the LIVE database";

export default function SandboxBanner() {
  return (
    <>
      {/* Keeps the last of the page clear of the fixed bar. */}
      <div className={styles.spacer} aria-hidden="true" />
      <div className={styles.banner} role="status">
        {SANDBOX_BANNER_TEXT}
      </div>
    </>
  );
}
