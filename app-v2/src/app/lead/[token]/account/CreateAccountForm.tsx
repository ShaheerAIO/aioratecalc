"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { createAccountFromLeadAction } from "@/lib/actions/leadAccount";
import styles from "@/styles/auth.module.css";

type Props = {
  token: string;
  defaultEmail: string;
  /** The application already has an account on it; only its password is missing. */
  emailLocked: boolean;
};

export default function CreateAccountForm({ token, defaultEmail, emailLocked }: Props) {
  const [email, setEmail] = useState(defaultEmail);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createAccountFromLeadAction(token, { email, password });
      if (result) setError(result);
    });
  };

  return (
    <div className={styles.page}>
      <form onSubmit={handleSubmit} className={styles.card}>
        <h1 className={styles.title}>Create Your Account</h1>
        <p className={styles.subtitle}>
          You&apos;re all paid up. Set a password to finish the rest of your setup.
        </p>

        <label className={styles.label} htmlFor="email">Email</label>
        <input
          id="email" type="email" required autoComplete="username" placeholder="you@business.com"
          value={email} onChange={e => setEmail(e.target.value)}
          readOnly={emailLocked}
          className={styles.input}
        />

        <label className={styles.label} htmlFor="password">Password</label>
        <input
          id="password" type="password" required autoComplete="new-password" minLength={8}
          value={password} onChange={e => setPassword(e.target.value)}
          className={styles.input}
        />

        <label className={styles.label} htmlFor="confirm">Confirm Password</label>
        <input
          id="confirm" type="password" required autoComplete="new-password" minLength={8}
          value={confirm} onChange={e => setConfirm(e.target.value)}
          className={`${styles.input} ${error ? styles["input--error"] : ""}`}
        />

        {error && <div className={styles.error} role="alert">{error}</div>}

        <button type="submit" disabled={pending} className={styles.button}>
          {pending ? "Creating account…" : "Create Account"}
        </button>
        <Link href="/customer/login" className={styles.switchLink}>
          Already have an account? Sign in
        </Link>
      </form>
    </div>
  );
}
