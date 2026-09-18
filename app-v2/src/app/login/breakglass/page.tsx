"use client";

// Admin breakglass. Not linked from anywhere — it exists so a broken or
// unreachable Entra tenant can't lock everyone out of /admin. Only admin rows
// with a passwordHash can use it (lib/auth.ts, scope "breakglass").

import { useState, useTransition } from "react";
import { breakglassLoginAction } from "@/lib/actions/auth";
import styles from "@/styles/auth.module.css";

export default function BreakglassLoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleSubmit = (formData: FormData) => {
    setError(null);
    startTransition(async () => {
      const result = await breakglassLoginAction(formData);
      if (result) setError(result);
    });
  };

  return (
    <div className={styles.page}>
      <form action={handleSubmit} className={styles.card}>
        <h1 className={styles.title}>Admin Recovery</h1>
        <p className={styles.subtitle}>
          For use only when Microsoft sign-in is unavailable. Everyone else should
          sign in at <a href="/login">/login</a>.
        </p>

        <label className={styles.label}>Email</label>
        <input
          name="email" type="email" required autoComplete="email"
          className={styles.input}
        />

        <label className={styles.label}>Password</label>
        <input
          name="password" type="password" required autoComplete="current-password"
          className={`${styles.input} ${error ? styles["input--error"] : ""}`}
        />

        {error && <div className={styles.error}>{error}</div>}

        <button type="submit" disabled={pending} className={styles.button}>
          {pending ? "Signing in…" : "Sign In"}
        </button>
      </form>
    </div>
  );
}
