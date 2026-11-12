"use client";

// DEBUG-ROLE-SWITCHER — see src/lib/auth/debugRole.ts for the removal note.
// Only ever rendered when ENABLE_DEBUG_ROLE_SWITCH=true (checked server-side
// in app/layout.tsx before this component is mounted at all).
//
// DEBUG-AUTO-LOGIN (debug/team-preview only, never merge): a floating Rep/Admin
// pill — one click flips the view and refreshes in place. Staff pages only:
// hidden on the merchant's lead link and the customer portal. "Real session"
// is offered only when auto-login is off, since with auto-login there is no
// real session to fall back to.
import { useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { setDebugRoleAction } from "@/lib/actions/debugRole";
import type { DebugRole } from "@/lib/auth/debugRole";
import styles from "./RoleSwitcher.module.css";

/** Staff surfaces: the app shell, and /login (where a pick gets you in). */
export function isStaffPath(pathname: string): boolean {
  return pathname === "/" || ["/rep", "/admin", "/login"].some(p => pathname === p || pathname.startsWith(`${p}/`));
}

export default function RoleSwitcher({
  current,
  autoLogin = false,
  aboveBanner = false,
}: {
  current: DebugRole | null;
  autoLogin?: boolean;
  /** Lift the pill clear of the sandbox banner pinned to the bottom edge. */
  aboveBanner?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const [pending, startTransition] = useTransition();

  if (!isStaffPath(pathname)) return null;

  const pick = (role: DebugRole | null) => {
    if (role === current) return;
    startTransition(async () => {
      await setDebugRoleAction(role);
      // Stay on the page where the new role can still see it. Off /login (a
      // refresh there only re-renders the form), out of /admin when becoming
      // a rep, and back to /login when dropping to the real session.
      if (role === null) router.push("/login");
      else if (pathname.startsWith("/login")) router.push(role === "admin" ? "/admin" : "/rep");
      else if (role === "rep" && pathname.startsWith("/admin")) router.push("/rep");
      router.refresh();
    });
  };

  return (
    <div
      className={styles.wrap}
      data-above-banner={aboveBanner}
      data-pending={pending}
      role="group"
      aria-label="Debug role"
    >
      <span className={styles.label}>Debug</span>
      {(["rep", "admin"] as const).map(r => (
        <button
          key={r}
          type="button"
          onClick={() => pick(r)}
          disabled={pending}
          aria-pressed={current === r}
          data-active={current === r}
          className={styles.button}
        >
          {r === "rep" ? "Rep" : "Admin"}
        </button>
      ))}
      {!autoLogin && (
        <button
          type="button"
          onClick={() => pick(null)}
          disabled={pending}
          aria-pressed={current === null}
          data-active={current === null}
          className={styles.button}
        >
          Real session
        </button>
      )}
    </div>
  );
}
