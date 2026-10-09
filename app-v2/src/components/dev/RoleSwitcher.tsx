"use client";

// DEBUG-ROLE-SWITCHER — see src/lib/auth/debugRole.ts for the removal note.
// Only ever rendered when ENABLE_DEBUG_ROLE_SWITCH=true (checked server-side
// in app/layout.tsx before this component is mounted at all).
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setDebugRoleAction } from "@/lib/actions/debugRole";
import type { DebugRole } from "@/lib/auth/debugRole";
import styles from "./RoleSwitcher.module.css";

export default function RoleSwitcher({ current }: { current: DebugRole | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const pick = (role: DebugRole | null) => {
    startTransition(async () => {
      await setDebugRoleAction(role);
      // router.refresh() alone isn't enough here: if we're sitting on /login
      // (middleware redirected us there pre-pick), refreshing just re-renders
      // the login form — it doesn't navigate us into the now-accessible app.
      const dest = role === "admin" ? "/admin" : role === "rep" ? "/rep" : "/login";
      router.push(dest);
      router.refresh();
    });
  };

  return (
    <div className={styles.wrap} style={{ opacity: pending ? 0.6 : 1 }}>
      <span className={styles.label}>Debug Role</span>
      {(["rep", "admin"] as const).map(r => (
        <button key={r} onClick={() => pick(r)} disabled={pending} data-active={current === r} className={styles.button}>{r}</button>
      ))}
      <button onClick={() => pick(null)} disabled={pending} data-active={current === null} className={styles.button}>real session</button>
    </div>
  );
}
