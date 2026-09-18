"use client";

import { useEffect } from "react";
import styles from "@/styles/auth.module.css";

/**
 * Where a popup Entra sign-in lands, so that /rep never renders inside the
 * popup window.
 *
 * Deliberately does NOT call window.close(): the opener (/login) watches for
 * this path and closes the popup itself, and it tells "signed in" from
 * "user cancelled" by whether the window closed before reaching here. Closing
 * ourselves would make a success look like a cancellation.
 */
export default function PopupCompletePage() {
  useEffect(() => {
    // Reached directly rather than as a popup — just go where sign-in goes.
    if (!window.opener) window.location.replace("/rep");
  }, []);

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <p className={styles.subtitle} style={{ margin: 0, textAlign: "center" }}>
          Signing you in…
        </p>
      </div>
    </div>
  );
}
