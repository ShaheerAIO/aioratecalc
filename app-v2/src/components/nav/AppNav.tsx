"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { parseAdminView, type AdminView } from "@/lib/adminView";
import { logoutAction } from "@/lib/actions/auth";
import styles from "./AppNav.module.css";

type NavRole = "rep" | "admin" | null | undefined;

type MenuId = "create" | "settings" | "account";

export function AppNav({ role, userName }: { role: NavRole; userName?: string }) {
  const pathname = usePathname();
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!openMenu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") setOpenMenu(null);
        return;
      }
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [openMenu]);

  useEffect(() => {
    setOpenMenu(null);
  }, [pathname]);

  const isAdmin = role === "admin";

  return (
    <nav className={isAdmin ? `${styles.nav} ${styles.navAdmin}` : styles.nav} ref={navRef}>
      <div className={styles.navLeft}>
        <Link
          href={isAdmin ? "/admin" : "/rep"}
          className={styles.navWordmark}
          aria-label={isAdmin ? "AIO Admin Console" : undefined}
        >
          <span className={styles.navMark}>A</span>
          AIO
          {!isAdmin && <span className={styles.navSub}>Rate Calculator</span>}
        </Link>
        {isAdmin && (
          <span className={styles.navBadge} aria-hidden="true">Admin</span>
        )}
      </div>
      <div className={styles.navActions}>
        {isAdmin ? (
          <>
            <AdminViewLinks pathname={pathname} />
            <NavDropdown
              id="create"
              label="New Account"
              primary
              open={openMenu === "create"}
              onToggle={() => setOpenMenu(m => (m === "create" ? null : "create"))}
            >
              {/* Two ways into one process — both end with a quote link the
                  merchant opens, accepts, and self-onboards from. */}
              <MenuLink href="/rep/proposals/new" pathname={pathname} desc="You have their statement or numbers">
                Build the quote with them
              </MenuLink>
              <MenuLink href="/rep/prospects/new" pathname={pathname} desc="They fill in whatever you don't have">
                Build the quote for them
              </MenuLink>
            </NavDropdown>
            <NavDropdown
              id="settings"
              label="Settings"
              open={openMenu === "settings"}
              onToggle={() => setOpenMenu(m => (m === "settings" ? null : "settings"))}
            >
              <MenuLink href="/rep/settings" pathname={pathname}>Processors &amp; tiers</MenuLink>
              <MenuLink href="/admin/settings/pillow" pathname={pathname}>Margin padding</MenuLink>
              <MenuLink href="/admin/settings/quote-templates" pathname={pathname}>Quote templates</MenuLink>
              <MenuLink href="/admin/users" pathname={pathname}>Users</MenuLink>
            </NavDropdown>
            <NavDropdown
              id="account"
              label={userName ?? "Account"}
              open={openMenu === "account"}
              onToggle={() => setOpenMenu(m => (m === "account" ? null : "account"))}
            >
              <form action={logoutAction}>
                <button type="submit" className={styles.menuItem}>Sign Out</button>
              </form>
            </NavDropdown>
          </>
        ) : (
          <>
            <NavLink href="/rep" pathname={pathname}>Accounts</NavLink>

            <NavDropdown
              id="create"
              label="New Account"
              primary
              open={openMenu === "create"}
              onToggle={() => setOpenMenu(m => (m === "create" ? null : "create"))}
            >
              {/* Two ways into one process — both end with a quote link the
                  merchant opens, accepts, and self-onboards from. */}
              <MenuLink href="/rep/proposals/new" pathname={pathname} desc="You have their statement or numbers">
                Build the quote with them
              </MenuLink>
              <MenuLink href="/rep/prospects/new" pathname={pathname} desc="They fill in whatever you don't have">
                Build the quote for them
              </MenuLink>
            </NavDropdown>

            <NavLink href="/rep/settings" pathname={pathname}>Settings</NavLink>

            {userName && <span className={styles.navUser}>{userName}</span>}
            <form action={logoutAction}>
              <button type="submit" className={styles.navButton}>Sign Out</button>
            </form>
          </>
        )}
      </div>
    </nav>
  );
}

// Dashboard and Accounts are two views of the same /admin route, so the active
// state has to read ?view= as well as the pathname. useSearchParams needs a
// Suspense boundary above it; the fallback renders the default view's state.
function AdminViewLinks({ pathname }: { pathname: string }) {
  return (
    <Suspense fallback={<AdminViewLinksView pathname={pathname} view="reps" />}>
      <AdminViewLinksInner pathname={pathname} />
    </Suspense>
  );
}

function AdminViewLinksInner({ pathname }: { pathname: string }) {
  const view = parseAdminView(useSearchParams().get("view"));
  return <AdminViewLinksView pathname={pathname} view={view} />;
}

function AdminViewLinksView({ pathname, view }: { pathname: string; view: AdminView }) {
  const onAdmin = pathname === "/admin";
  return (
    <>
      <NavLink href="/admin" pathname={pathname} active={onAdmin && view === "reps"}>
        Dashboard
      </NavLink>
      <NavLink href="/admin?view=accounts" pathname={pathname} active={onAdmin && view !== "reps"}>
        Accounts
      </NavLink>
    </>
  );
}

function NavLink({
  href,
  pathname,
  active,
  children,
}: {
  href: string;
  pathname: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  const isActive = active !== undefined ? active : pathname === href;
  return (
    <Link href={href} className={styles.navLink} aria-current={isActive ? "page" : undefined}>
      {children}
    </Link>
  );
}

function MenuLink({ href, pathname, desc, children }: { href: string; pathname: string; desc?: string; children: React.ReactNode }) {
  return (
    <Link href={href} className={styles.menuItem} aria-current={pathname === href ? "page" : undefined}>
      <span>{children}</span>
      {desc && <span className={styles.menuItemDesc}>{desc}</span>}
    </Link>
  );
}

function NavDropdown({
  label,
  primary,
  open,
  onToggle,
  children,
}: {
  id: MenuId;
  label: string;
  primary?: boolean;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.dropdown}>
      <button
        type="button"
        className={primary ? `${styles.navTrigger} ${styles.navTriggerPrimary}` : styles.navTrigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        {label}
        <span className={styles.chevron} aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          {children}
        </div>
      )}
    </div>
  );
}
